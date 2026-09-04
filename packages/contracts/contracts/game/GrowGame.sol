// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFlower, IGrowBench, IRandomBeacon} from "../interfaces/IHesoyam.sol";
import {StrainRegistry} from "./StrainRegistry.sol";

/**
 * @title GrowGame
 * @notice The grow loop. Nothing ticks on chain: a plant is one struct written at
 *         planting, and everything about its state is a pure function of elapsed
 *         time and the care actions recorded since.
 *
 * Randomness, and its honest limits.
 *   The event schedule is fixed at planting from the player's commit hash mixed with
 *   the previous block hash, so a player can read their own schedule and plan around
 *   it. That is deliberate: responding to a known pest window is skill, not luck.
 *   A player who dislikes a schedule can only reroll by abandoning and buying another
 *   seed, so grinding is priced rather than free.
 *   Final quality mixes in a salt the player committed to before the schedule existed.
 *   Card crafting, where value per roll is much higher, uses future-block randomness
 *   in CardCrafter instead. Chainlink VRF replaces both behind the same seam.
 *
 * INV-10  Every mint path here charges a fee in the same transaction.
 */
contract GrowGame is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10_000;
    uint8 public constant FEED_WINDOWS = 3;
    uint8 public constant EVENT_SLOTS = 3;
    uint256 public constant CURE_SECONDS = 48 hours;
    uint8 public constant CURE_QUALITY_BONUS = 12;
    uint16 public constant DAMAGE_PER_MISSED_EVENT_BPS = 1500;
    uint16 public constant MAX_DAMAGE_BPS = 4500;

    struct Grow {
        address grower;
        uint32 strainId;
        uint32 benchId;
        uint64 plantedAt;
        bytes32 commitHash;
        /// @dev Beacon round this grow resolves against. Not revealed at plant time.
        /// The seed itself is never stored: read it with seedFor(growId).
        uint64 beaconRound;
        uint8 feedMask;
        uint8 treatedMask;
        bool active;
    }

    struct PendingHarvest {
        address grower;
        uint32 strainId;
        uint32 units;
        uint8 quality;
        uint64 readyAt;
        bool collected;
    }

    struct Outcome {
        uint32 units;
        uint8 quality;
        uint8 care;
        uint16 damageBps;
    }

    IERC20 public immutable hesoyam;
    IFlower public immutable flower;
    IGrowBench public immutable bench;

    /// @notice Randomness source. See RandomBeacon for why this is not block data.
    IRandomBeacon public beacon;

    /// @notice How many rounds ahead a grow binds to. One is enough: the round is
    ///         unrevealed at plant time, which is the whole requirement.
    uint64 public constant ROUND_LEAD = 1;
    StrainRegistry public immutable strains;
    address public revenueRouter;

    uint128 public nutrientFee = 15e18; // per feeding window
    uint128 public treatmentFee = 25e18; // per treatment
    uint128 public utilityPerDay = 10e18; // charged at harvest for the whole cycle
    uint128 public cureFee = 25e18;

    mapping(uint256 => Grow) public grows;
    mapping(uint256 => PendingHarvest) public pendingHarvests;
    mapping(uint256 => uint256) public benchBusyWith; // benchId => growId, 0 when free

    uint256 public nextGrowId = 1;
    uint256 public nextHarvestId = 1;
    uint256 public totalPlanted;
    uint256 public totalHarvested;

    event Planted(
        uint256 indexed growId, address indexed grower, uint32 indexed strainId, uint32 benchId, bytes32 eventSeed
    );
    event Fed(uint256 indexed growId, uint8 window, uint256 fee);
    event Treated(uint256 indexed growId, uint8 slot, uint256 fee);
    event Harvested(
        uint256 indexed growId,
        address indexed grower,
        uint32 units,
        uint8 quality,
        uint8 care,
        uint16 damageBps,
        bool curing
    );
    event Collected(uint256 indexed harvestId, address indexed grower, uint256 tokenId, uint32 units, uint8 quality);
    event Abandoned(uint256 indexed growId, address indexed grower);
    event FeesSet(uint128 nutrient, uint128 treatment, uint128 utilityPerDay, uint128 cure);
    event RouterSet(address router);
    event BeaconSet(address beacon);

    error ZeroAddress();
    error StrainInactive();
    error NotBenchOwner();
    error BeaconNotSet();
    error BeaconNotReady();
    error BenchBusy();
    error NotGrower();
    error GrowInactive();
    error WindowClosed();
    error AlreadyFed();
    error NoEventHere();
    error AlreadyTreated();
    error NotMature();
    error BadCommit();
    error NotCuring();
    error AlreadyCollected();
    error BadSlot();

    constructor(
        address initialOwner,
        IERC20 hesoyam_,
        IFlower flower_,
        IGrowBench bench_,
        StrainRegistry strains_,
        address revenueRouter_
    ) Ownable(initialOwner) {
        if (
            address(hesoyam_) == address(0) || address(flower_) == address(0) || address(bench_) == address(0)
                || address(strains_) == address(0) || revenueRouter_ == address(0)
        ) revert ZeroAddress();
        hesoyam = hesoyam_;
        flower = flower_;
        bench = bench_;
        strains = strains_;
        revenueRouter = revenueRouter_;
    }

    // --- configuration -------------------------------------------------------

    function setFees(uint128 nutrient, uint128 treatment, uint128 utilityPerDay_, uint128 cure) external onlyOwner {
        nutrientFee = nutrient;
        treatmentFee = treatment;
        utilityPerDay = utilityPerDay_;
        cureFee = cure;
        emit FeesSet(nutrient, treatment, utilityPerDay_, cure);
    }

    /// @dev The beacon is settable because it is deployed after the game in the
    ///      ordered deploy. Once set and ownership is handed to the timelock, it
    ///      moves only on the timelock's delay.
    function setBeacon(IRandomBeacon beacon_) external onlyOwner {
        if (address(beacon_) == address(0)) revert ZeroAddress();
        beacon = beacon_;
        emit BeaconSet(address(beacon_));
    }

    function setRouter(address router) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        revenueRouter = router;
        emit RouterSet(router);
    }

    // --- schedule maths ------------------------------------------------------

    /// @notice Feed window i is centred at (2i+1)/7 of the cycle and is one seventh wide.
    function feedWindow(uint256 growId, uint8 index) public view returns (uint64 opensAt, uint64 closesAt) {
        uint256 cycle = strains.cycleOf(grows[growId].strainId);
        uint256 centre = uint256(grows[growId].plantedAt) + (cycle * (2 * uint256(index) + 1)) / 7;
        uint256 half = cycle / 14;
        opensAt = uint64(centre - half);
        closesAt = uint64(centre + half);
    }

    /// @notice Event slot i lands at (2i+2)/7 of the cycle, with a one-seventh response window.
    function eventWindow(uint256 growId, uint8 slot) public view returns (uint64 opensAt, uint64 closesAt) {
        uint256 cycle = strains.cycleOf(grows[growId].strainId);
        uint256 at = uint256(grows[growId].plantedAt) + (cycle * (2 * uint256(slot) + 2)) / 7;
        opensAt = uint64(at);
        closesAt = uint64(at + cycle / 7);
    }

    /// @notice Whether the given event slot actually fires for this grow.
    function eventFires(uint256 growId, uint8 slot) public view returns (bool) {
        (,,, uint8 chance,,,) = strains.core(grows[growId].strainId);
        uint8 draw = uint8(uint256(seedFor(growId)) >> (8 * uint256(slot)));
        return draw < chance;
    }

    function maturesAt(uint256 growId) public view returns (uint64) {
        return uint64(uint256(grows[growId].plantedAt) + strains.cycleOf(grows[growId].strainId));
    }

    function _popcount3(uint8 mask) private pure returns (uint8 n) {
        if (mask & 1 != 0) n++;
        if (mask & 2 != 0) n++;
        if (mask & 4 != 0) n++;
    }

    /// @notice Bitmask of which event slots fire for this grow.
    function firedMask(uint256 growId) public view returns (uint8 mask) {
        (,,, uint8 chance,,,) = strains.core(grows[growId].strainId);
        uint256 seed = uint256(seedFor(growId));
        for (uint8 i = 0; i < EVENT_SLOTS; ++i) {
            if (uint8(seed >> (8 * uint256(i))) < chance) mask |= uint8(1) << i;
        }
    }

    /// @notice Care score out of 100: feeding 40, environment 30, event response 30.
    function careScore(uint256 growId) public view returns (uint8 care, uint16 damageBps) {
        Grow storage g = grows[growId];

        uint256 feedPts = (uint256(_popcount3(g.feedMask)) * 40) / FEED_WINDOWS;
        uint256 envPts = uint256(bench.tierOf(g.benchId)) * 15;
        if (envPts > 30) envPts = 30;

        uint8 fires = firedMask(growId);
        uint256 fired = _popcount3(fires);
        uint256 handled = _popcount3(fires & g.treatedMask);

        uint256 eventPts = fired == 0 ? 30 : (handled * 30) / fired;
        uint256 total = feedPts + envPts + eventPts;
        care = uint8(total > 100 ? 100 : total);

        uint256 dmg = (fired - handled) * DAMAGE_PER_MISSED_EVENT_BPS;
        damageBps = uint16(dmg > MAX_DAMAGE_BPS ? MAX_DAMAGE_BPS : dmg);
    }

    // --- player actions ------------------------------------------------------

    /**
     * @param commitHash keccak256(abi.encode(salt)) for a salt the player keeps until harvest.
     */
    function plant(uint32 strainId, uint32 benchId, bytes32 commitHash)
        external
        nonReentrant
        returns (uint256 growId)
    {
        if (address(beacon) == address(0)) revert BeaconNotSet();
        (,,,,, uint128 seedPrice, bool active) = strains.core(strainId);
        if (!active) revert StrainInactive();
        if (bench.ownerOf(uint256(benchId)) != msg.sender) revert NotBenchOwner();
        if (benchBusyWith[benchId] != 0) revert BenchBusy();

        growId = nextGrowId++;

        // Bind to a round that has not happened yet.
        //
        // The old line hashed the player's own commit with the previous block
        // hash and the timestamp, all of which they could see when they sent the
        // transaction. A player could grind salts until the resulting schedule
        // fired no pest events at all, and a contract could do that search inside
        // this very call. Committing to a future beacon round removes the search
        // entirely: there is nothing to grind against, because the value does not
        // exist yet.
        uint64 boundRound = uint64(beacon.round() + ROUND_LEAD);

        grows[growId] = Grow({
            grower: msg.sender,
            strainId: strainId,
            benchId: benchId,
            plantedAt: uint64(block.timestamp),
            commitHash: commitHash,
            beaconRound: boundRound,
            feedMask: 0,
            treatedMask: 0,
            active: true
        });
        benchBusyWith[benchId] = growId;
        totalPlanted++;

        if (seedPrice > 0) hesoyam.safeTransferFrom(msg.sender, revenueRouter, seedPrice);
        emit Planted(growId, msg.sender, strainId, benchId, bytes32(uint256(boundRound)));
    }

    function feed(uint256 growId, uint8 window) external nonReentrant {
        Grow storage g = grows[growId];
        if (!g.active) revert GrowInactive();
        if (g.grower != msg.sender) revert NotGrower();
        if (window >= FEED_WINDOWS) revert BadSlot();
        if (g.feedMask & (uint8(1) << window) != 0) revert AlreadyFed();

        (uint64 opensAt, uint64 closesAt) = feedWindow(growId, window);
        if (block.timestamp < opensAt || block.timestamp > closesAt) revert WindowClosed();

        g.feedMask |= uint8(1) << window;
        if (nutrientFee > 0) hesoyam.safeTransferFrom(msg.sender, revenueRouter, nutrientFee);
        emit Fed(growId, window, nutrientFee);
    }

    function treat(uint256 growId, uint8 slot) external nonReentrant {
        Grow storage g = grows[growId];
        if (!g.active) revert GrowInactive();
        if (g.grower != msg.sender) revert NotGrower();
        if (slot >= EVENT_SLOTS) revert BadSlot();
        if (firedMask(growId) & (uint8(1) << slot) == 0) revert NoEventHere();
        if (g.treatedMask & (uint8(1) << slot) != 0) revert AlreadyTreated();

        (uint64 opensAt, uint64 closesAt) = eventWindow(growId, slot);
        if (block.timestamp < opensAt || block.timestamp > closesAt) revert WindowClosed();

        g.treatedMask |= uint8(1) << slot;
        if (treatmentFee > 0) hesoyam.safeTransferFrom(msg.sender, revenueRouter, treatmentFee);
        emit Treated(growId, slot, treatmentFee);
    }

    /**
     * @notice Resolves the cycle. Pays utilities for the whole run, computes yield and
     *         quality, and either mints immediately or opens a cure.
     * @param salt The pre-image of the commit hash given at planting.
     */
    function harvest(uint256 growId, bytes32 salt, bool startCure)
        external
        nonReentrant
        returns (uint256 idOut, uint32 units, uint8 quality)
    {
        Grow storage g = grows[growId];
        if (!g.active) revert GrowInactive();
        if (g.grower != msg.sender) revert NotGrower();
        if (block.timestamp < maturesAt(growId)) revert NotMature();
        // Never resolve against an unrevealed round. A zero seed fires no events
        // and scores full care, which is the exact outcome a griefer would want.
        if (seedFor(growId) == bytes32(0)) revert BeaconNotReady();
        if (keccak256(abi.encode(salt)) != g.commitHash) revert BadCommit();

        Outcome memory o = _outcome(growId, salt);
        units = o.units;
        quality = o.quality;

        uint32 strainId = g.strainId;
        g.active = false;
        benchBusyWith[g.benchId] = 0;
        totalHarvested++;

        _chargeHarvest(strainId, startCure);
        emit Harvested(growId, msg.sender, o.units, o.quality, o.care, o.damageBps, startCure);

        if (startCure) {
            idOut = nextHarvestId++;
            pendingHarvests[idOut] = PendingHarvest({
                grower: msg.sender,
                strainId: strainId,
                units: o.units,
                quality: o.quality,
                readyAt: uint64(block.timestamp + CURE_SECONDS),
                collected: false
            });
        } else {
            idOut = _mintFlower(msg.sender, strainId, o.units, o.quality);
        }
    }

    /**
     * @notice The resolved seed for a grow, or zero while the beacon round is
     *         still unrevealed.
     *
     * Derived rather than stored, so it cannot be written before the round it
     * depends on exists. Every consumer of randomness in this contract reads it
     * through here.
     */
    function seedFor(uint256 growId) public view returns (bytes32) {
        Grow storage g = grows[growId];
        if (address(beacon) == address(0)) return bytes32(0);
        bytes32 roundSeed = beacon.seedOf(uint256(g.beaconRound));
        if (roundSeed == bytes32(0)) return bytes32(0);
        return keccak256(abi.encode(roundSeed, g.commitHash, g.benchId, growId));
    }

    /// @notice True once this grow's randomness has settled.
    function seedReady(uint256 growId) external view returns (bool) {
        return seedFor(growId) != bytes32(0);
    }

    /**
     * @notice What a harvest would pay right now, for a given salt.
     *
     * The comment below has always claimed a client could preview the outcome,
     * but there was no public way to do it. Now there is, and it is also the
     * cleanest proof that no block data enters the roll: call this across many
     * blocks and it returns the same answer every time.
     */
    function previewOutcome(uint256 growId, bytes32 salt) external view returns (Outcome memory) {
        return _outcome(growId, salt);
    }

    /// @notice Deterministic given the salt, so a client can preview the exact outcome.
    function _outcome(uint256 growId, bytes32 salt) internal view returns (Outcome memory o) {
        (, uint16 baseYield, uint16 geneticsBps,, uint8 geneQuality,,) = strains.core(grows[growId].strainId);
        (uint8 care, uint16 damageBps) = careScore(growId);
        // No block data. The roll comes from the salt the player committed and
        // the beacon round they were bound to, so waiting for a favourable block
        // achieves nothing.
        uint256 roll = uint256(keccak256(abi.encode(salt, seedFor(growId))));

        uint256 y = (uint256(baseYield) * geneticsBps) / BPS;
        y = (y * (5500 + (4500 * uint256(care)) / 100)) / BPS;
        y = (y * (BPS - damageBps)) / BPS;

        uint256 q = 20 + (uint256(care) * 40) / 100 + uint256(geneQuality) + (roll % 21);
        uint256 pen = uint256(damageBps) / 500;
        q = q > pen ? q - pen : 0;
        if (q > 100) q = 100;

        o = Outcome({units: uint32(y), quality: uint8(q), care: care, damageBps: damageBps});
    }

    function _chargeHarvest(uint32 strainId, bool startCure) internal {
        uint256 cycle = strains.cycleOf(strainId);
        uint256 due = (uint256(utilityPerDay) * cycle) / 1 days + (startCure ? uint256(cureFee) : 0);
        if (due > 0) hesoyam.safeTransferFrom(msg.sender, revenueRouter, due);
    }

    /// @notice Collects a cured harvest. The cure is worth up to 12 quality points.
    function collect(uint256 harvestId) external nonReentrant returns (uint256 tokenId, uint8 quality) {
        PendingHarvest storage h = pendingHarvests[harvestId];
        if (h.grower != msg.sender) revert NotGrower();
        if (h.collected) revert AlreadyCollected();
        if (h.readyAt == 0) revert NotCuring();
        if (block.timestamp < h.readyAt) revert NotMature();

        h.collected = true;
        uint256 q = uint256(h.quality) + CURE_QUALITY_BONUS;
        if (q > 100) q = 100;
        quality = uint8(q);

        tokenId = _mintFlower(msg.sender, h.strainId, h.units, quality);
        emit Collected(harvestId, msg.sender, tokenId, h.units, quality);
    }

    /// @notice Gives up on a grow and frees the bench. No refund, no yield.
    function abandon(uint256 growId) external nonReentrant {
        Grow storage g = grows[growId];
        if (!g.active) revert GrowInactive();
        if (g.grower != msg.sender) revert NotGrower();
        g.active = false;
        benchBusyWith[g.benchId] = 0;
        emit Abandoned(growId, msg.sender);
    }

    function _mintFlower(address to, uint32 strainId, uint32 units, uint8 quality) internal returns (uint256 tokenId) {
        uint8 tier = quality >= 80 ? 2 : (quality >= 50 ? 1 : 0);
        tokenId = uint256(strainId) * 4 + tier;
        if (units > 0) flower.mint(to, tokenId, units);
    }

    /// @notice Everything the client needs to draw one bench, in a single call.
    function growView(uint256 growId)
        external
        view
        returns (Grow memory g, uint64 matureAt, uint8 care, uint16 damageBps, uint8 fires)
    {
        g = grows[growId];
        matureAt = maturesAt(growId);
        (care, damageBps) = careScore(growId);
        fires = firedMask(growId);
    }
}
