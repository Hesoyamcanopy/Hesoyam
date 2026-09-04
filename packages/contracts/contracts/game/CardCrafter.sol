// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFlower, IStrainCard} from "../interfaces/IHesoyam.sol";

/**
 * @title CardCrafter
 * @notice Destroys Flower to create a Strain Card. This is the bridge between the
 *         game and the staking rail: a card raises its holder's weight, so stakers
 *         who never grow anything still need Flower and buy it from growers.
 *
 * Randomness. A craft is requested in one transaction and finalized in another, using
 * the hash of a block that did not exist when the request was made. Finalization is
 * permissionless so a player cannot sit on an unfavourable outcome, and a request left
 * past the 256 block hash window settles at the floor rather than being rerolled.
 *
 * INV-12  Flower burned here is gone. There is no un-craft.
 */
contract CardCrafter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10_000;
    uint256 public constant REVEAL_DELAY = 2; // blocks
    uint256 public constant HASH_WINDOW = 250; // blocks before blockhash expires

    struct Request {
        address player;
        uint32 strainId;
        uint8 tier;
        uint64 revealBlock;
        bool finalized;
    }

    IERC20 public immutable hesoyam;
    IFlower public immutable flower;
    IStrainCard public immutable card;
    address public revenueRouter;

    uint256 public flowerPerCraft = 400;
    uint128 public craftFee = 150e18;

    mapping(uint256 => Request) public requests;
    uint256 public nextRequestId = 1;
    uint256 public totalCrafted;
    uint256 public totalFlowerBurned;

    event CraftRequested(
        uint256 indexed requestId, address indexed player, uint32 strainId, uint8 tier, uint64 revealBlock
    );
    event CraftFinalized(
        uint256 indexed requestId,
        address indexed player,
        uint256 tokenId,
        uint8 rarity,
        uint16 weightBps,
        bool expired
    );
    event CraftParamsSet(uint256 flowerPerCraft, uint128 craftFee);
    event RouterSet(address router);

    error ZeroAddress();
    error BadTier();
    error NotReady();
    error AlreadyFinalized();
    error UnknownRequest();

    constructor(address initialOwner, IERC20 hesoyam_, IFlower flower_, IStrainCard card_, address revenueRouter_)
        Ownable(initialOwner)
    {
        if (
            address(hesoyam_) == address(0) || address(flower_) == address(0) || address(card_) == address(0)
                || revenueRouter_ == address(0)
        ) revert ZeroAddress();
        hesoyam = hesoyam_;
        flower = flower_;
        card = card_;
        revenueRouter = revenueRouter_;
    }

    function setCraftParams(uint256 flowerPerCraft_, uint128 craftFee_) external onlyOwner {
        if (flowerPerCraft_ == 0) revert ZeroAddress();
        flowerPerCraft = flowerPerCraft_;
        craftFee = craftFee_;
        emit CraftParamsSet(flowerPerCraft_, craftFee_);
    }

    function setRouter(address router) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        revenueRouter = router;
        emit RouterSet(router);
    }

    /// @notice Burns Flower and the fee, then queues the roll for a future block.
    function requestCraft(uint32 strainId, uint8 tier) external nonReentrant returns (uint256 requestId) {
        if (tier > 2) revert BadTier();

        uint256 tokenId = uint256(strainId) * 4 + tier;
        flower.burnFrom(msg.sender, tokenId, flowerPerCraft);
        totalFlowerBurned += flowerPerCraft;

        if (craftFee > 0) hesoyam.safeTransferFrom(msg.sender, revenueRouter, craftFee);

        requestId = nextRequestId++;
        requests[requestId] = Request({
            player: msg.sender,
            strainId: strainId,
            tier: tier,
            revealBlock: uint64(block.number + REVEAL_DELAY),
            finalized: false
        });
        emit CraftRequested(requestId, msg.sender, strainId, tier, uint64(block.number + REVEAL_DELAY));
    }

    /**
     * @notice Resolves a queued craft. Anyone may call it, which is what stops a
     *         player from abandoning rolls they can already see.
     */
    function finalizeCraft(uint256 requestId)
        external
        nonReentrant
        returns (uint256 tokenId, uint8 rarity, uint16 weightBps)
    {
        Request storage r = requests[requestId];
        if (r.player == address(0)) revert UnknownRequest();
        if (r.finalized) revert AlreadyFinalized();
        if (block.number <= r.revealBlock) revert NotReady();

        r.finalized = true;

        bytes32 bh = blockhash(r.revealBlock);
        bool expired = bh == bytes32(0);

        if (expired) {
            rarity = 0;
            weightBps = 10_000;
        } else {
            uint256 roll = uint256(keccak256(abi.encode(bh, requestId, r.player)));
            (rarity, weightBps) = _resolve(roll, r.tier);
        }

        tokenId = card.mint(r.player, weightBps, r.strainId, rarity);
        totalCrafted++;
        emit CraftFinalized(requestId, r.player, tokenId, rarity, weightBps, expired);
    }

    /**
     * @dev Odds shift upward with the quality tier of the Flower burned, which is what
     *      makes a cured, premium harvest worth paying more for.
     *      Base: common 62%, uncommon 25%, rare 11%, mythic 2%.
     */
    function _resolve(uint256 roll, uint8 tier) internal pure returns (uint8 rarity, uint16 weightBps) {
        uint256 r = (roll % BPS) + uint256(tier) * 600;
        uint256 within = (roll >> 128) % 1000;

        if (r >= 9_800) {
            rarity = 3;
            weightBps = uint16(12_800 + (within * 1400) / 1000); // 1.28x - 1.42x
        } else if (r >= 8_700) {
            rarity = 2;
            weightBps = uint16(11_600 + (within * 1000) / 1000); // 1.16x - 1.26x
        } else if (r >= 6_200) {
            rarity = 1;
            weightBps = uint16(10_800 + (within * 600) / 1000); // 1.08x - 1.14x
        } else {
            rarity = 0;
            weightBps = uint16(10_000 + (within * 600) / 1000); // 1.00x - 1.06x
        }
    }

    /// @notice Read-only odds table so the client and any auditor can check the maths.
    function oddsFor(uint8 tier)
        external
        pure
        returns (uint16 commonBps, uint16 uncommonBps, uint16 rareBps, uint16 mythicBps)
    {
        uint256 bonus = uint256(tier) * 600;
        uint256 common = 6_200 > bonus ? 6_200 - bonus : 0;
        uint256 uncommonEdge = 8_700 > bonus ? 8_700 - bonus : 0;
        uint256 rareEdge = 9_800 > bonus ? 9_800 - bonus : 0;
        commonBps = uint16(common);
        uncommonBps = uint16(uncommonEdge - common);
        rareBps = uint16(rareEdge - uncommonEdge);
        mythicBps = uint16(BPS - rareEdge);
    }
}
