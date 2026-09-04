// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFlower} from "../interfaces/IHesoyam.sol";

/**
 * @title Dispensary
 * @notice Buyer of last resort for Flower, funded only by realized revenue. The bid
 *         opens above the market reference and falls to a floor across the epoch.
 *         When the budget is gone the auction is closed, and late sellers keep their
 *         inventory.
 *
 * INV-9   Spend in an epoch can never exceed the epoch's funding. The check is the
 *         budget, not a promise.
 * INV-11  There is no guaranteed floor price. If revenue is zero the budget is zero
 *         and this contract legitimately buys nothing.
 */
contract Dispensary is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10_000;
    uint16 public constant CEIL_BPS = 11_500; // opens at 115% of reference
    uint16 public constant FLOOR_BPS = 6_000; // decays to 60%
    uint16 public constant MAX_REFERENCE_MOVE_BPS = 2_000; // keeper may move a reference 20% per update

    IERC20 public immutable settlement;
    IFlower public immutable flower;
    address public funder; // RevenueRouter

    uint256 public auctionDuration = 24 hours;
    uint256 public referenceUpdateCooldown = 1 hours;

    /// @notice Settlement-token price per Flower unit, per quality tier.
    mapping(uint8 => uint256) public referencePrice;
    mapping(uint8 => uint256) public lastReferenceUpdate;
    mapping(address => bool) public isKeeper;

    uint256 public epochStart;
    uint256 public epochBudget; // funded this epoch
    uint256 public epochSpent;
    uint256 public totalFunded;
    uint256 public totalSpent;
    uint256 public totalUnitsBought;

    event Funded(uint256 amount, uint256 budget, uint256 epochStart);
    event Sold(address indexed seller, uint256 indexed tokenId, uint256 units, uint256 pricePerUnit, uint256 proceeds);
    event ReferenceSet(uint8 indexed tier, uint256 price);
    event KeeperSet(address indexed keeper, bool allowed);
    event ParamsSet(uint256 auctionDuration, uint256 referenceUpdateCooldown);
    event FunderSet(address funder);

    error ZeroAddress();
    error NotFunder();
    error NotKeeper();
    error ZeroAmount();
    error BudgetExhausted();
    error NoReference();
    error MoveTooLarge();
    error CooldownActive();
    error BadTier();

    constructor(address initialOwner, IERC20 settlement_, IFlower flower_, address funder_) Ownable(initialOwner) {
        if (address(settlement_) == address(0) || address(flower_) == address(0) || funder_ == address(0)) {
            revert ZeroAddress();
        }
        settlement = settlement_;
        flower = flower_;
        funder = funder_;
        epochStart = block.timestamp;
    }

    // --- configuration -------------------------------------------------------

    function setFunder(address funder_) external onlyOwner {
        if (funder_ == address(0)) revert ZeroAddress();
        funder = funder_;
        emit FunderSet(funder_);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setParams(uint256 auctionDuration_, uint256 cooldown_) external onlyOwner {
        if (auctionDuration_ == 0) revert ZeroAmount();
        auctionDuration = auctionDuration_;
        referenceUpdateCooldown = cooldown_;
        emit ParamsSet(auctionDuration_, cooldown_);
    }

    /// @notice Owner sets a reference outright. Used at launch and after a halt.
    function setReferenceAdmin(uint8 tier, uint256 price) external onlyOwner {
        if (tier > 2) revert BadTier();
        referencePrice[tier] = price;
        lastReferenceUpdate[tier] = block.timestamp;
        emit ReferenceSet(tier, price);
    }

    /**
     * @notice Keeper tracks the player market. Movement is capped per update and rate
     *         limited, so a manipulated print cannot reprice the whole budget.
     */
    function setReference(uint8 tier, uint256 price) external {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        if (tier > 2) revert BadTier();
        if (price == 0) revert ZeroAmount();

        uint256 current = referencePrice[tier];
        if (current != 0) {
            if (block.timestamp < lastReferenceUpdate[tier] + referenceUpdateCooldown) revert CooldownActive();
            uint256 diff = price > current ? price - current : current - price;
            if ((diff * BPS) / current > MAX_REFERENCE_MOVE_BPS) revert MoveTooLarge();
        }
        referencePrice[tier] = price;
        lastReferenceUpdate[tier] = block.timestamp;
        emit ReferenceSet(tier, price);
    }

    // --- funding and pricing -------------------------------------------------

    function fundEpoch(uint256 amount) external nonReentrant {
        if (msg.sender != funder) revert NotFunder();
        if (amount == 0) revert ZeroAmount();
        settlement.safeTransferFrom(msg.sender, address(this), amount);

        // Unspent budget rolls forward. The clock only restarts once the epoch
        // has actually run its course or the budget is gone.
        //
        // Restarting it on every top-up meant the auction could be reset to the
        // 115 percent ceiling by anyone, at any time, for dust: distribute() is
        // permissionless and reads a live balance, so donating a few units to the
        // router forced a funding call. A seller could hold out for the floor,
        // reset the clock, and sell at the ceiling instead. The auction never
        // discovered a price and the protocol always paid the top.
        uint256 carried = epochBudget - epochSpent;
        epochBudget = carried + amount;
        epochSpent = 0;

        // Only an exhausted budget starts a fresh auction. While money remains,
        // the price stays on the curve it is already on and rests at the floor.
        //
        // Restarting once the duration had merely elapsed was not enough: a
        // seller could simply wait out the clock, poke a funding call, and sell
        // at the ceiling anyway. A Dutch auction that can be rewound is not an
        // auction, it is a ceiling with extra steps.
        if (carried == 0) {
            epochStart = block.timestamp;
        }
        totalFunded += amount;

        emit Funded(amount, epochBudget, epochStart);
    }

    function budgetRemaining() public view returns (uint256) {
        return epochBudget - epochSpent;
    }

    /// @notice Current bid per unit for a quality tier, in settlement-token units.
    function currentPrice(uint8 tier) public view returns (uint256) {
        uint256 refPrice = referencePrice[tier];
        if (refPrice == 0) return 0;
        uint256 elapsed = block.timestamp - epochStart;
        uint256 bps;
        if (elapsed >= auctionDuration) {
            bps = FLOOR_BPS;
        } else {
            bps = CEIL_BPS - ((CEIL_BPS - FLOOR_BPS) * elapsed) / auctionDuration;
        }
        return (refPrice * bps) / BPS;
    }

    /**
     * @notice Sells Flower into the current bid. Units are burned, which is what makes
     *         the Dispensary a real sink rather than a warehouse.
     */
    function sell(uint32 strainId, uint8 tier, uint256 units)
        external
        nonReentrant
        returns (uint256 proceeds, uint256 pricePerUnit)
    {
        if (units == 0) revert ZeroAmount();
        if (tier > 2) revert BadTier();

        pricePerUnit = currentPrice(tier);
        if (pricePerUnit == 0) revert NoReference();

        proceeds = pricePerUnit * units;
        if (proceeds > budgetRemaining()) revert BudgetExhausted();

        epochSpent += proceeds;
        totalSpent += proceeds;
        totalUnitsBought += units;

        uint256 tokenId = uint256(strainId) * 4 + tier;
        flower.burnFrom(msg.sender, tokenId, units);
        settlement.safeTransfer(msg.sender, proceeds);

        emit Sold(msg.sender, tokenId, units, pricePerUnit, proceeds);
    }

    /// @notice Largest number of units the current budget can absorb at the live bid.
    function absorbableUnits(uint8 tier) external view returns (uint256) {
        uint256 price = currentPrice(tier);
        if (price == 0) return 0;
        return budgetRemaining() / price;
    }
}
