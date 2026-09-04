// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IGrowBench} from "../interfaces/IHesoyam.sol";
import {PixelArt} from "./PixelArt.sol";

/**
 * @notice Ground you can own, and the rent a grower pays to use it.
 *
 * The economics, because this is the part that decides whether the collection is
 * an asset or a chain letter:
 *
 * A plot earns only when a bench is sited on it. Siting is a service a grower
 * buys, at a price the plot owner sets, and the payment splits between the owner
 * and the RevenueRouter. Nothing here mints a token to pay anyone, and no part of
 * a later buyer's purchase price reaches an earlier buyer. A plot nobody wants to
 * grow on earns exactly zero, forever, and that is the honest floor.
 *
 * Supply is capped at MAX_SUPPLY and can never exceed it. Two paths create a
 * plot: `mintTo`, owner only, for the initial allocation, and `mint`, public and
 * paid, which sends the whole price to the RevenueRouter. Both count against the
 * same cap. The only path that changes supply afterwards is `fuse`, which burns
 * two and mints one, so supply is monotonically non increasing once the cap is
 * reached.
 *
 * Rent is credited to the owner's address at the moment of siting rather than
 * accrued against the token. If it accrued against the token, selling a plot mid
 * lease would hand the buyer rent the seller had already earned.
 */
contract Plot is ERC721Enumerable, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    uint16 public constant MAX_SUPPLY = 256;
    uint8 public constant MAX_TIER = 3;
    uint16 private constant BPS = 10000;

    struct Info {
        uint8 district;
        uint8 tier;
        uint64 seed;
    }

    struct Lease {
        address tenant;
        uint256 benchId;
        uint64 until;
    }

    IERC20 public immutable hesoyam;
    IGrowBench public immutable growBench;
    address public revenueRouter;

    mapping(uint256 => Info) public info;
    mapping(uint256 => Lease) public leaseOf;
    mapping(uint256 => uint256) public plotOfBench;
    mapping(address => uint256) public rentOwed;

    /// @dev Only ever increases, so a fused id is never handed out again.
    uint256 public nextId = 1;
    uint16 public minted;

    /// @notice Price per day a grower pays, set per plot by its owner.
    mapping(uint256 => uint256) public dayRate;
    uint256 public defaultDayRate = 25e18;
    uint256 public maxDayRate = 5_000e18;
    uint16 public constant MAX_PROTOCOL_BPS = 5000;
    uint16 public protocolBps = 3000;
    uint256 public fuseFee = 500e18;
    uint16 public maxLeaseDays = 90;

    /// @notice Public mint. Closed until the owner opens it.
    bool public mintOpen;
    uint256 public mintPrice = 5_000e18;
    uint16 public maxPerWallet = 5;
    mapping(address => uint16) public mintedBy;

    uint256 public totalRentPaid;
    uint256 public totalToProtocol;

    event Minted(uint256 indexed plotId, address indexed to, uint8 district, uint8 tier);
    event Sited(uint256 indexed plotId, uint256 indexed benchId, address indexed tenant, uint64 until, uint256 paid);
    event RentClaimed(address indexed owner, uint256 amount);
    event Fused(uint256 indexed burnedA, uint256 indexed burnedB, uint256 indexed mintedId, uint8 tier);
    event DayRateSet(uint256 indexed plotId, uint256 rate);
    event ParamsSet(
        uint256 defaultDayRate, uint256 maxDayRate, uint16 protocolBps, uint256 fuseFee, uint16 maxLeaseDays
    );
    event RouterSet(address router);
    event MintSet(bool open, uint256 price, uint16 perWallet);

    error ZeroAddress();
    error SupplyExhausted();
    error NotPlotOwner();
    error PlotOccupied();
    error BenchAlreadySited();
    error BadDuration();
    error RateTooHigh();
    error NothingOwed();
    error SameToken();
    error DifferentDistrict();
    error TierMaxed();
    error LeaseActive();
    error BadAllocation();
    error UnknownPlot();
    error UnknownBench();
    error NotBenchOwner();
    error PriceMoved();
    error TierMismatch();
    error MintClosed();
    error BadCount();
    error WalletCapReached();

    constructor(address initialOwner, IERC20 hesoyam_, IGrowBench growBench_, address revenueRouter_)
        ERC721("Hesoyam Canopy Plot", "PLOT")
        Ownable(initialOwner)
    {
        if (address(hesoyam_) == address(0) || revenueRouter_ == address(0)) revert ZeroAddress();
        if (address(growBench_) == address(0)) revert ZeroAddress();
        hesoyam = hesoyam_;
        growBench = growBench_;
        revenueRouter = revenueRouter_;
    }

    // ---------------------------------------------------------------- admin

    function setRouter(address router) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        revenueRouter = router;
        emit RouterSet(router);
    }

    function setParams(
        uint256 defaultDayRate_,
        uint256 maxDayRate_,
        uint16 protocolBps_,
        uint256 fuseFee_,
        uint16 maxLeaseDays_
    ) external onlyOwner {
        // Capped at half. At 10000 a plot owner would earn nothing at all.
        if (protocolBps_ > MAX_PROTOCOL_BPS) revert BadAllocation();
        if (defaultDayRate_ > maxDayRate_ || maxLeaseDays_ == 0) revert BadAllocation();
        defaultDayRate = defaultDayRate_;
        maxDayRate = maxDayRate_;
        protocolBps = protocolBps_;
        fuseFee = fuseFee_;
        maxLeaseDays = maxLeaseDays_;
        emit ParamsSet(defaultDayRate_, maxDayRate_, protocolBps_, fuseFee_, maxLeaseDays_);
    }

    /**
     * @notice The one and only mint path, and it closes at MAX_SUPPLY.
     * @dev Deliberately not callable once minted reaches the cap, so no future
     *      owner can inflate the collection.
     */
    function mintTo(address to, uint8 district, uint64 seed) external onlyOwner returns (uint256 plotId) {
        if (to == address(0)) revert ZeroAddress();
        if (minted >= MAX_SUPPLY) revert SupplyExhausted();
        plotId = nextId++;
        minted++;
        info[plotId] = Info({district: district % 8, tier: 0, seed: seed});
        _safeMint(to, plotId);
        emit Minted(plotId, to, district % 8, 0);
    }

    // ---------------------------------------------------------------- minting

    /**
     * @notice Public mint. The whole price is protocol revenue.
     *
     * `mintTo` above is owner only and exists for the initial allocation. Without
     * this function there was no way for anybody else to ever own a plot, which
     * made the entire rent rail unreachable.
     *
     * Still bounded by MAX_SUPPLY, so this cannot inflate the collection past the
     * cap. The per wallet limit is not a fairness gesture: without it one buyer
     * takes the whole supply and there is no rental market to speak of.
     *
     * District and seed are derived from the minter, the id and the block. That is
     * grindable in principle, by minting from a contract and reverting on an
     * unwanted district. It is deliberately left that way because a district is
     * cosmetic and carries no yield, so the prize is not worth an oracle. Tier is
     * not derived here at all: every mint is tier 0, and the only way up is fusing.
     */
    function mint(uint16 count) external nonReentrant returns (uint256 firstId) {
        if (!mintOpen) revert MintClosed();
        if (count == 0 || count > 10) revert BadCount();
        if (minted + count > MAX_SUPPLY) revert SupplyExhausted();
        if (mintedBy[msg.sender] + count > maxPerWallet) revert WalletCapReached();

        uint256 total = mintPrice * count;
        if (total > 0) hesoyam.safeTransferFrom(msg.sender, revenueRouter, total);

        mintedBy[msg.sender] += count;
        firstId = nextId;

        for (uint16 i = 0; i < count; i++) {
            uint256 plotId = nextId++;
            minted++;
            uint256 h = uint256(
                keccak256(abi.encodePacked(msg.sender, plotId, block.prevrandao, block.timestamp))
            );
            info[plotId] = Info({district: uint8(h % 8), tier: 0, seed: uint64(h >> 8)});
            _safeMint(msg.sender, plotId);
            emit Minted(plotId, msg.sender, uint8(h % 8), 0);
        }
    }

    function setMint(bool open, uint256 price, uint16 perWallet) external onlyOwner {
        if (perWallet == 0) revert BadAllocation();
        mintOpen = open;
        mintPrice = price;
        maxPerWallet = perWallet;
        emit MintSet(open, price, perWallet);
    }

    /// @notice How many more this wallet may mint.
    function mintableBy(address who) external view returns (uint256) {
        if (!mintOpen) return 0;
        uint256 walletLeft = mintedBy[who] >= maxPerWallet ? 0 : maxPerWallet - mintedBy[who];
        uint256 supplyLeft = minted >= MAX_SUPPLY ? 0 : MAX_SUPPLY - minted;
        return walletLeft < supplyLeft ? walletLeft : supplyLeft;
    }

    // ---------------------------------------------------------------- owner

    function setDayRate(uint256 plotId, uint256 rate) external {
        if (_ownerOf(plotId) != msg.sender) revert NotPlotOwner();
        if (rate > maxDayRate) revert RateTooHigh();
        dayRate[plotId] = rate;
        emit DayRateSet(plotId, rate);
    }

    function rateOf(uint256 plotId) public view returns (uint256) {
        uint256 r = dayRate[plotId];
        return r == 0 ? defaultDayRate : r;
    }

    // ---------------------------------------------------------------- siting

    /**
     * @notice Rent a plot for a bench.
     *
     * The whole payment is pulled from the grower. The protocol cut goes straight
     * to the router and becomes ordinary revenue, and the rest is credited to the
     * plot owner. Neither side is paid out of anyone's principal.
     */
    function site(uint256 plotId, uint256 benchId, uint16 daysCount, uint256 maxTotal)
        external
        nonReentrant
    {
        address plotOwner = _ownerOf(plotId);
        if (plotOwner == address(0)) revert UnknownPlot();
        if (daysCount == 0 || daysCount > maxLeaseDays) revert BadDuration();

        // The tenant must own the bench. Without this anyone could site a
        // stranger's bench on their own plot and lock it out for 90 days,
        // recovering 70 percent of the rent from themselves.
        if (benchId == 0 || !growBench.exists(benchId)) revert UnknownBench();
        if (growBench.ownerOf(benchId) != msg.sender) revert NotBenchOwner();

        Lease memory current = leaseOf[plotId];
        if (current.until > block.timestamp) revert PlotOccupied();

        uint256 existing = plotOfBench[benchId];
        if (existing != 0 && leaseOf[existing].until > block.timestamp) revert BenchAlreadySited();

        uint256 total = rateOf(plotId) * daysCount;
        // Pin the price the tenant agreed to. setDayRate takes effect at once,
        // so without this the plot owner can watch the mempool and raise the
        // rate in front of this call, up to maxDayRate.
        if (total > maxTotal) revert PriceMoved();

        // HESOYAM taxes transfers unless both ends are exempt. Splitting the
        // quoted price rather than what actually arrived would promise the plot
        // owner rent this contract does not hold, and the shortfall would only
        // surface later as a failed claim by whoever tried to withdraw last.
        // Measure the delta and split that, so the contract is solvent whether or
        // not it was ever added to the exemption list.
        uint256 before = hesoyam.balanceOf(address(this));
        hesoyam.safeTransferFrom(msg.sender, address(this), total);
        uint256 received = hesoyam.balanceOf(address(this)) - before;

        uint256 toProtocol = (received * protocolBps) / BPS;
        uint256 toOwner = received - toProtocol;

        if (toProtocol > 0) hesoyam.safeTransfer(revenueRouter, toProtocol);
        rentOwed[plotOwner] += toOwner;

        totalRentPaid += received;
        totalToProtocol += toProtocol;

        uint64 until = uint64(block.timestamp + uint256(daysCount) * 1 days);
        leaseOf[plotId] = Lease({tenant: msg.sender, benchId: benchId, until: until});
        plotOfBench[benchId] = plotId;

        emit Sited(plotId, benchId, msg.sender, until, total);
    }

    function claimRent() external nonReentrant returns (uint256 amount) {
        amount = rentOwed[msg.sender];
        if (amount == 0) revert NothingOwed();
        rentOwed[msg.sender] = 0;
        hesoyam.safeTransfer(msg.sender, amount);
        emit RentClaimed(msg.sender, amount);
    }

    /// @notice True while a bench is entitled to grow on the plot it was sited on.
    function isSited(uint256 benchId) external view returns (bool) {
        uint256 plotId = plotOfBench[benchId];
        if (plotId == 0) return false;
        Lease memory lease = leaseOf[plotId];
        return lease.benchId == benchId && lease.until > block.timestamp;
    }

    // ---------------------------------------------------------------- fusing

    /**
     * @notice Burn two plots of the same district to mint one of the next tier.
     *
     * This is the only sink in the collection. Supply strictly falls, the fee is
     * ordinary revenue, and a tier 3 plot therefore costs eight tier 0 plots plus
     * three fees to reach, which is what keeps the top tier scarce.
     */
    function fuse(uint256 a, uint256 b) external nonReentrant returns (uint256 plotId) {
        if (a == b) revert SameToken();
        if (_ownerOf(a) != msg.sender || _ownerOf(b) != msg.sender) revert NotPlotOwner();
        if (leaseOf[a].until > block.timestamp || leaseOf[b].until > block.timestamp) revert LeaseActive();

        Info memory ia = info[a];
        Info memory ib = info[b];
        if (ia.district != ib.district) revert DifferentDistrict();

        // Both plots must be the same tier. Taking the higher of the two let a
        // tier 3 plot be reached with four plots instead of the eight the
        // economics assume, by pairing each result with a throwaway tier 0.
        if (ia.tier != ib.tier) revert TierMismatch();
        uint8 top = ia.tier;
        if (top >= MAX_TIER) revert TierMaxed();

        if (fuseFee > 0) hesoyam.safeTransferFrom(msg.sender, revenueRouter, fuseFee);

        _burn(a);
        _burn(b);
        delete info[a];
        delete info[b];

        plotId = nextId++;
        info[plotId] = Info({district: ia.district, tier: top + 1, seed: ia.seed ^ ib.seed});
        _safeMint(msg.sender, plotId);

        emit Fused(a, b, plotId, top + 1);
    }

    // ---------------------------------------------------------------- metadata

    /// @dev Split from tokenURI so neither half runs out of stack slots.
    function _attributes(uint256 plotId, Info memory i) private view returns (bytes memory) {
        return abi.encodePacked(
            "\"attributes\":[{\"trait_type\":\"District\",\"value\":\"",
            PixelArt.districtName(i.district),
            "\"},{\"trait_type\":\"Tier\",\"value\":\"",
            PixelArt.tierName(i.tier),
            "\"},{\"trait_type\":\"Day rate\",\"value\":",
            (rateOf(plotId) / 1e18).toString(),
            "}]"
        );
    }

    function tokenURI(uint256 plotId) public view override returns (string memory) {
        if (_ownerOf(plotId) == address(0)) revert UnknownPlot();
        Info memory i = info[plotId];

        bytes memory head = abi.encodePacked(
            "{\"name\":\"Plot ",
            plotId.toString(),
            ", ",
            PixelArt.districtName(i.district),
            "\",\"description\":\"Ground in HESOYAM CANOPY. A bench sited here pays its owner rent, "
            "and the art is generated on chain.\","
        );

        bytes memory image = abi.encodePacked(
            ",\"image\":\"data:image/svg+xml;base64,",
            Base64.encode(bytes(PixelArt.render(i.seed, i.district, i.tier))),
            "\"}"
        );

        bytes memory json = abi.encodePacked(head, _attributes(plotId, i), image);
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }
}
