// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IStrainCard} from "../interfaces/IHesoyam.sol";

/**
 * @title StakingVault
 * @notice Holds staked HESOYAM, computes weight, and distributes the settlement-token
 *         rewards the router hands it. Principal and rewards are different tokens in
 *         the same contract, which keeps INV-2 checkable with a single balance read.
 *
 * INV-1  `totalDistributed` can never exceed `totalNotified`. Rewards are only ever
 *        credited from funds the router actually transferred in.
 * INV-2  The HESOYAM balance of this contract is always at least `totalPrincipal`.
 * INV-4  `emergencyWithdraw` has no pause, no owner gate and no external call other
 *        than returning the user's own HESOYAM.
 * INV-13 Weight contributed by cards is capped at MAX_CARD_BONUS_BPS per wallet.
 */
contract StakingVault is Ownable2Step, ReentrancyGuard, ERC721Holder {
    using SafeERC20 for IERC20;

    // 1e30 rather than 1e18. The reward token has 6 decimals and weight has 18,
    // so 1e18 left the quotient rounding to zero once total weight passed about
    // 1e26. The remainder is carried as well, but the headroom matters too.
    uint256 private constant ACC_PRECISION = 1e30;

    /// @notice Weight must be at risk this long before an exit avoids the penalty.
    /// @dev Kills the flash-stake capture: with no minimum hold, tier 0 has
    ///      lockSeconds 0, so unlockAt equals the stake timestamp and a same block
    ///      stake, distribute, claim, unstake sequence paid no penalty at all.
    uint32 public constant MIN_HOLD_SECONDS = 1 hours;

    /// @notice Hard ceiling on any lock tier, so no tier can be added that
    ///         dilutes existing stakers beyond what was published.
    uint16 public constant MAX_TIER_MULTIPLIER_BPS = 30_000;
    uint16 private constant BPS = 10_000;

    /// @notice 4% of principal, charged only when leaving before the lock expires.
    uint16 public constant EARLY_EXIT_PENALTY_BPS = 400;
    uint16 public constant MAX_CARD_BONUS_BPS = 4200; // caps total multiplier at 1.42x
    uint8 public constant MAX_EQUIPPED_CARDS = 5;

    struct Tier {
        uint32 lockSeconds;
        uint16 multiplierBps;
        bool enabled;
    }

    struct Position {
        uint128 amount;
        uint64 unlockAt;
        uint16 multiplierBps;
        bool closed;
    }

    IERC20 public immutable hesoyam;
    IERC20 public immutable settlement;
    IStrainCard public strainCard;
    address public rewardNotifier; // RevenueRouter
    address public penaltyReceiver; // RevenueRouter

    Tier[] public tiers;

    mapping(address => Position[]) public positions;
    mapping(address => uint256) public baseWeight; // amount * tier multiplier
    mapping(address => uint256) public weightOf; // baseWeight * card multiplier
    mapping(address => uint256) public rewardDebt;
    mapping(address => uint256) public accrued;
    mapping(address => uint256) public cardBonusBps;
    mapping(address => uint256[]) public equippedCards;
    mapping(uint256 => address) public cardDepositor;

    uint256 public totalWeight;
    uint256 public totalPrincipal;
    uint256 public accPerWeight;
    uint256 public undistributed; // arrives while totalWeight == 0
    uint256 public totalNotified;
    uint256 public totalDistributed;

    event TierAdded(uint256 indexed tierId, uint32 lockSeconds, uint16 multiplierBps);
    event TierEnabled(uint256 indexed tierId, bool enabled);
    event Staked(address indexed user, uint256 indexed positionId, uint256 amount, uint256 tierId, uint64 unlockAt);
    event Unstaked(address indexed user, uint256 indexed positionId, uint256 returned, uint256 penalty);
    event EmergencyWithdrawn(address indexed user, uint256 indexed positionId, uint256 returned, uint256 penalty);
    event RewardNotified(uint256 amount, uint256 accPerWeight);
    event Claimed(address indexed user, uint256 amount);
    event CardEquipped(address indexed user, uint256 indexed tokenId, uint16 weightBps);
    event CardUnequipped(address indexed user, uint256 indexed tokenId);
    event ConfigSet(address strainCard, address rewardNotifier, address penaltyReceiver);

    error ZeroAddress();
    error ZeroAmount();
    error BadTier();
    error NotNotifier();
    error PositionClosed();
    error TooManyCards();
    error NotCardOwner();
    error NothingToClaim();
    error CardNotEquipped();

    constructor(address initialOwner, IERC20 hesoyam_, IERC20 settlement_) Ownable(initialOwner) {
        if (address(hesoyam_) == address(0) || address(settlement_) == address(0)) revert ZeroAddress();
        hesoyam = hesoyam_;
        settlement = settlement_;

        // Seedling, Vegetative, Flowering, Canopy.
        tiers.push(Tier({lockSeconds: MIN_HOLD_SECONDS, multiplierBps: 10_000, enabled: true}));
        tiers.push(Tier({lockSeconds: 30 days, multiplierBps: 13_000, enabled: true}));
        tiers.push(Tier({lockSeconds: 60 days, multiplierBps: 18_000, enabled: true}));
        tiers.push(Tier({lockSeconds: 90 days, multiplierBps: 25_000, enabled: true}));
    }

    // --- configuration -------------------------------------------------------

    function setConfig(IStrainCard strainCard_, address rewardNotifier_, address penaltyReceiver_)
        external
        onlyOwner
    {
        if (rewardNotifier_ == address(0) || penaltyReceiver_ == address(0)) revert ZeroAddress();
        strainCard = strainCard_;
        rewardNotifier = rewardNotifier_;
        penaltyReceiver = penaltyReceiver_;
        emit ConfigSet(address(strainCard_), rewardNotifier_, penaltyReceiver_);
    }

    /// @dev multiplierBps is bounded. Unbounded, an owner could add a tier that
    ///      dilutes every existing staker in a single transaction.
    function addTier(uint32 lockSeconds, uint16 multiplierBps) external onlyOwner returns (uint256 tierId) {
        if (multiplierBps < BPS || multiplierBps > MAX_TIER_MULTIPLIER_BPS) revert BadTier();
        tierId = tiers.length;
        tiers.push(Tier({lockSeconds: lockSeconds, multiplierBps: multiplierBps, enabled: true}));
        emit TierAdded(tierId, lockSeconds, multiplierBps);
    }

    function setTierEnabled(uint256 tierId, bool enabled) external onlyOwner {
        tiers[tierId].enabled = enabled;
        emit TierEnabled(tierId, enabled);
    }

    function tierCount() external view returns (uint256) {
        return tiers.length;
    }

    function positionCount(address user) external view returns (uint256) {
        return positions[user].length;
    }

    function equippedCardCount(address user) external view returns (uint256) {
        return equippedCards[user].length;
    }

    // --- reward accounting ---------------------------------------------------

    function pendingReward(address user) public view returns (uint256) {
        uint256 w = weightOf[user];
        uint256 owed = (w * accPerWeight) / ACC_PRECISION;
        uint256 debt = rewardDebt[user];
        return accrued[user] + (owed > debt ? owed - debt : 0);
    }

    function _settle(address user) internal {
        uint256 w = weightOf[user];
        if (w > 0) {
            uint256 owed = (w * accPerWeight) / ACC_PRECISION;
            uint256 debt = rewardDebt[user];
            if (owed > debt) accrued[user] += owed - debt;
        }
    }

    function _syncDebt(address user) internal {
        rewardDebt[user] = (weightOf[user] * accPerWeight) / ACC_PRECISION;
    }

    function _recomputeWeight(address user) internal {
        uint256 newWeight = (baseWeight[user] * (BPS + cardBonusBps[user])) / BPS;
        totalWeight = totalWeight - weightOf[user] + newWeight;
        weightOf[user] = newWeight;
    }

    /// @notice Router hands over the staker share of realized revenue.
    function notifyReward(uint256 amount) external nonReentrant {
        if (msg.sender != rewardNotifier) revert NotNotifier();
        if (amount == 0) revert ZeroAmount();
        settlement.safeTransferFrom(msg.sender, address(this), amount);
        totalNotified += amount;

        uint256 pool = amount + undistributed;
        if (totalWeight == 0) {
            undistributed = pool;
        } else {
            // Settlement is 6 decimals and weight is 18, so at a realistic stake
            // level this quotient could round to zero outright. Writing
            // `undistributed = 0` regardless used to destroy the whole
            // distribution, permanently and silently, with no rescue path.
            //
            // Carry it only when it would otherwise be lost in full. Carrying the
            // exact remainder every time looks tidier but is wrong: rewards are
            // read as floor(weight * accPerWeight), and the floor of a running
            // sum can exceed the sum of the per-notify floors by one unit, which
            // lets the last claimant take a unit the vault does not hold.
            //
            // With ACC_PRECISION at 1e30 the discarded remainder is under one
            // unit of a 6 decimal token, and it stays in the contract rather than
            // being credited, so it can never cause a shortfall.
            uint256 delta = (pool * ACC_PRECISION) / totalWeight;
            if (delta == 0) {
                undistributed = pool;
            } else {
                accPerWeight += delta;
                undistributed = 0;
            }
        }
        emit RewardNotified(amount, accPerWeight);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        _settle(msg.sender);
        _syncDebt(msg.sender);
        amount = accrued[msg.sender];
        if (amount == 0) revert NothingToClaim();
        accrued[msg.sender] = 0;
        totalDistributed += amount;
        settlement.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // --- staking -------------------------------------------------------------

    function stake(uint256 amount, uint256 tierId) external nonReentrant returns (uint256 positionId) {
        if (amount == 0) revert ZeroAmount();
        if (tierId >= tiers.length || !tiers[tierId].enabled) revert BadTier();
        Tier memory t = tiers[tierId];

        // HESOYAM is tax exempt for this contract, so received == amount. The balance
        // delta is measured anyway so an exemption mistake surfaces as a smaller
        // credited stake rather than an accounting hole.
        uint256 before = hesoyam.balanceOf(address(this));
        hesoyam.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = hesoyam.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        _settle(msg.sender);

        positionId = positions[msg.sender].length;
        positions[msg.sender].push(
            Position({
                amount: uint128(received),
                unlockAt: uint64(block.timestamp + t.lockSeconds),
                multiplierBps: t.multiplierBps,
                closed: false
            })
        );

        baseWeight[msg.sender] += (received * t.multiplierBps) / BPS;
        totalPrincipal += received;
        _recomputeWeight(msg.sender);
        _syncDebt(msg.sender);

        emit Staked(msg.sender, positionId, received, tierId, uint64(block.timestamp + t.lockSeconds));
    }

    function unstake(uint256 positionId) external nonReentrant returns (uint256 returned) {
        Position storage p = positions[msg.sender][positionId];
        if (p.closed) revert PositionClosed();

        _settle(msg.sender);

        uint256 amount = p.amount;
        uint256 penalty = block.timestamp < p.unlockAt ? (amount * EARLY_EXIT_PENALTY_BPS) / BPS : 0;
        returned = amount - penalty;

        p.closed = true;
        baseWeight[msg.sender] -= (amount * p.multiplierBps) / BPS;
        totalPrincipal -= amount;
        _recomputeWeight(msg.sender);
        _syncDebt(msg.sender);

        if (penalty > 0) hesoyam.safeTransfer(penaltyReceiver, penalty);
        hesoyam.safeTransfer(msg.sender, returned);
        emit Unstaked(msg.sender, positionId, returned, penalty);
    }

    /**
     * @notice Always-open exit. Returns principal, applies the same lock penalty, and
     *         forfeits any unclaimed rewards on purpose so this path can never depend
     *         on reward solvency.
     */
    function emergencyWithdraw(uint256 positionId) external nonReentrant returns (uint256 returned) {
        Position storage p = positions[msg.sender][positionId];
        if (p.closed) revert PositionClosed();

        uint256 amount = p.amount;
        uint256 penalty = block.timestamp < p.unlockAt ? (amount * EARLY_EXIT_PENALTY_BPS) / BPS : 0;
        returned = amount - penalty;

        p.closed = true;
        baseWeight[msg.sender] -= (amount * p.multiplierBps) / BPS;
        totalPrincipal -= amount;
        _recomputeWeight(msg.sender);
        _syncDebt(msg.sender); // forfeits pending rewards for this user

        if (penalty > 0) hesoyam.safeTransfer(penaltyReceiver, penalty);
        hesoyam.safeTransfer(msg.sender, returned);
        emit EmergencyWithdrawn(msg.sender, positionId, returned, penalty);
    }

    // --- strain cards --------------------------------------------------------

    function equipCard(uint256 tokenId) external nonReentrant {
        if (address(strainCard) == address(0)) revert ZeroAddress();
        if (equippedCards[msg.sender].length >= MAX_EQUIPPED_CARDS) revert TooManyCards();
        if (IERC721(address(strainCard)).ownerOf(tokenId) != msg.sender) revert NotCardOwner();

        uint16 weightBps = strainCard.weightBpsOf(tokenId);
        uint256 bonus = weightBps > BPS ? weightBps - BPS : 0;

        _settle(msg.sender);

        IERC721(address(strainCard)).safeTransferFrom(msg.sender, address(this), tokenId);
        equippedCards[msg.sender].push(tokenId);
        cardDepositor[tokenId] = msg.sender;

        uint256 newBonus = cardBonusBps[msg.sender] + bonus;
        cardBonusBps[msg.sender] = newBonus > MAX_CARD_BONUS_BPS ? MAX_CARD_BONUS_BPS : newBonus;

        _recomputeWeight(msg.sender);
        _syncDebt(msg.sender);
        emit CardEquipped(msg.sender, tokenId, weightBps);
    }

    function unequipCard(uint256 tokenId) external nonReentrant {
        if (cardDepositor[tokenId] != msg.sender) revert CardNotEquipped();

        _settle(msg.sender);

        uint256[] storage list = equippedCards[msg.sender];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; ++i) {
            if (list[i] == tokenId) {
                list[i] = list[len - 1];
                list.pop();
                break;
            }
        }
        delete cardDepositor[tokenId];

        // Recompute the bonus from what is still equipped, because the cap may have
        // clipped the running total when this card was added.
        uint256 bonus;
        uint256 remaining = list.length;
        for (uint256 i = 0; i < remaining; ++i) {
            uint16 w = strainCard.weightBpsOf(list[i]);
            if (w > BPS) bonus += w - BPS;
        }
        cardBonusBps[msg.sender] = bonus > MAX_CARD_BONUS_BPS ? MAX_CARD_BONUS_BPS : bonus;

        _recomputeWeight(msg.sender);
        _syncDebt(msg.sender);

        IERC721(address(strainCard)).safeTransferFrom(address(this), msg.sender, tokenId);
        emit CardUnequipped(msg.sender, tokenId);
    }
}
