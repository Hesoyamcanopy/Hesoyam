// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Marketplace
 * @notice Player to player trading of Flower with a 4% take that goes to revenue.
 *
 * Settlement routes through this contract rather than buyer to seller directly, so
 * the HESOYAM transfer tax is charged once at the pool and not a second time here. The
 * marketplace is tax exempt, which is what makes the 4% take exact.
 */
contract Marketplace is Ownable2Step, ReentrancyGuard, ERC1155Holder {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 1000; // 10% ceiling, governance can never exceed it

    struct Listing {
        address seller;
        uint256 tokenId;
        uint256 amount; // units remaining
        uint256 pricePerUnit; // HESOYAM per unit
        bool active;
    }

    IERC20 public immutable hesoyam;
    IERC1155 public immutable flower;
    address public revenueRouter;
    uint16 public feeBps = 400; // 4%

    mapping(uint256 => Listing) public listings;
    uint256 public nextListingId = 1;
    uint256 public totalFeesCollected;

    event Listed(
        uint256 indexed listingId,
        address indexed seller,
        uint256 indexed tokenId,
        uint256 amount,
        uint256 pricePerUnit
    );
    event Filled(uint256 indexed listingId, address indexed buyer, uint256 amount, uint256 gross, uint256 fee);
    event Cancelled(uint256 indexed listingId);
    event FeeSet(uint16 feeBps);
    event RouterSet(address router);

    error ZeroAddress();
    error ZeroAmount();
    error NotSeller();
    error NotActive();
    error InsufficientListing();
    error FeeTooHigh();

    constructor(address initialOwner, IERC20 hesoyam_, IERC1155 flower_, address revenueRouter_) Ownable(initialOwner) {
        if (address(hesoyam_) == address(0) || address(flower_) == address(0) || revenueRouter_ == address(0)) {
            revert ZeroAddress();
        }
        hesoyam = hesoyam_;
        flower = flower_;
        revenueRouter = revenueRouter_;
    }

    function setFeeBps(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    function setRouter(address router) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        revenueRouter = router;
        emit RouterSet(router);
    }

    function list(uint256 tokenId, uint256 amount, uint256 pricePerUnit)
        external
        nonReentrant
        returns (uint256 listingId)
    {
        if (amount == 0 || pricePerUnit == 0) revert ZeroAmount();
        listingId = nextListingId++;
        listings[listingId] =
            Listing({seller: msg.sender, tokenId: tokenId, amount: amount, pricePerUnit: pricePerUnit, active: true});
        flower.safeTransferFrom(msg.sender, address(this), tokenId, amount, "");
        emit Listed(listingId, msg.sender, tokenId, amount, pricePerUnit);
    }

    function buy(uint256 listingId, uint256 amount) external nonReentrant {
        Listing storage item = listings[listingId];
        if (!item.active) revert NotActive();
        if (amount == 0) revert ZeroAmount();
        if (amount > item.amount) revert InsufficientListing();

        uint256 gross = amount * item.pricePerUnit;
        uint256 fee = (gross * feeBps) / BPS;
        uint256 toSeller = gross - fee;

        item.amount -= amount;
        if (item.amount == 0) item.active = false;
        totalFeesCollected += fee;

        hesoyam.safeTransferFrom(msg.sender, address(this), gross);
        if (fee > 0) hesoyam.safeTransfer(revenueRouter, fee);
        hesoyam.safeTransfer(item.seller, toSeller);
        flower.safeTransferFrom(address(this), msg.sender, item.tokenId, amount, "");

        emit Filled(listingId, msg.sender, amount, gross, fee);
    }

    function cancel(uint256 listingId) external nonReentrant {
        Listing storage item = listings[listingId];
        if (!item.active) revert NotActive();
        if (item.seller != msg.sender) revert NotSeller();
        uint256 remaining = item.amount;
        item.amount = 0;
        item.active = false;
        flower.safeTransferFrom(address(this), msg.sender, item.tokenId, remaining, "");
        emit Cancelled(listingId);
    }
}
