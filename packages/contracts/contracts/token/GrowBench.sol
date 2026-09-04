// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title GrowBench
 * @notice One bench runs one plant. Sold in capped tranches for HESOYAM, and every
 *         HESOYAM of the sale price is protocol revenue.
 *
 * Bench tier feeds the environment-control component of care score: tier 0 gives
 * 0 points, tier 1 gives 15, tier 2 gives 30 out of a possible 100.
 */
contract GrowBench is ERC721Enumerable, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Tranche {
        uint128 price; // HESOYAM per bench
        uint32 cap; // benches available in this tranche
        uint32 sold;
        uint8 tier;
        bool open;
    }

    IERC20 public immutable hesoyam;
    address public revenueRouter;

    Tranche[] public tranches;
    mapping(uint256 => uint8) public tierOf;
    uint256 public nextTokenId = 1;
    string private _base;

    event TrancheOpened(uint256 indexed trancheId, uint8 tier, uint128 price, uint32 cap);
    event TrancheClosed(uint256 indexed trancheId);
    event BenchSold(address indexed buyer, uint256 indexed tokenId, uint256 indexed trancheId, uint256 price);
    event RouterSet(address router);

    error TrancheClosedError();
    error SoldOut();
    error ZeroAddress();
    error BadTier();

    constructor(address initialOwner, IERC20 hesoyam_, address revenueRouter_, string memory baseURI_)
        ERC721("Hesoyam Grow Bench", "BENCH")
        Ownable(initialOwner)
    {
        if (address(hesoyam_) == address(0) || revenueRouter_ == address(0)) revert ZeroAddress();
        hesoyam = hesoyam_;
        revenueRouter = revenueRouter_;
        _base = baseURI_;
    }

    function setRouter(address router) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        revenueRouter = router;
        emit RouterSet(router);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _base = baseURI_;
    }

    function _baseURI() internal view override returns (string memory) {
        return _base;
    }

    function openTranche(uint8 tier, uint128 price, uint32 cap) external onlyOwner returns (uint256 trancheId) {
        if (tier > 2) revert BadTier();
        trancheId = tranches.length;
        tranches.push(Tranche({price: price, cap: cap, sold: 0, tier: tier, open: true}));
        emit TrancheOpened(trancheId, tier, price, cap);
    }

    function closeTranche(uint256 trancheId) external onlyOwner {
        tranches[trancheId].open = false;
        emit TrancheClosed(trancheId);
    }

    function trancheCount() external view returns (uint256) {
        return tranches.length;
    }

    /// @notice Buys one bench from an open tranche. Price goes straight to revenue.
    function buy(uint256 trancheId) external nonReentrant returns (uint256 tokenId) {
        Tranche storage t = tranches[trancheId];
        if (!t.open) revert TrancheClosedError();
        if (t.sold >= t.cap) revert SoldOut();

        t.sold += 1;
        tokenId = nextTokenId++;
        tierOf[tokenId] = t.tier;

        if (t.price > 0) {
            hesoyam.safeTransferFrom(msg.sender, revenueRouter, t.price);
        }
        _safeMint(msg.sender, tokenId);
        emit BenchSold(msg.sender, tokenId, trancheId, t.price);
    }

    function exists(uint256 tokenId) external view returns (bool) {
        return _ownerOf(tokenId) != address(0);
    }

    // Required because ERC721Enumerable hooks both of these.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721Enumerable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value) internal override(ERC721Enumerable) {
        super._increaseBalance(account, value);
    }
}
