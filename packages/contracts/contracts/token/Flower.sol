// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title Flower
 * @notice The harvested commodity. Token id encodes strain and quality tier:
 *         id = strainId * 4 + tier, where tier is 0 bulk, 1 standard, 2 premium.
 *
 * INV-10  Only authorized game contracts can mint, and every mint path they expose
 *         charges a fee in the same transaction.
 * INV-12  Burns are permanent. There is no un-burn.
 */
contract Flower is ERC1155, Ownable2Step {
    uint256 public constant TIERS = 4; // 3 used, 1 reserved so ids stay aligned
    uint8 public constant TIER_BULK = 0;
    uint8 public constant TIER_STANDARD = 1;
    uint8 public constant TIER_PREMIUM = 2;

    mapping(address => bool) public isMinter;
    mapping(address => bool) public isBurner;

    /// @notice Lifetime units minted and burned per id, for supply auditing.
    mapping(uint256 => uint256) public totalMinted;
    mapping(uint256 => uint256) public totalBurned;

    event MinterSet(address indexed account, bool allowed);
    event BurnerSet(address indexed account, bool allowed);

    error NotMinter();
    error NotBurner();
    error NotApproved();
    error BadTier();

    constructor(address initialOwner, string memory uri_) ERC1155(uri_) Ownable(initialOwner) {}

    function setMinter(address account, bool allowed) external onlyOwner {
        isMinter[account] = allowed;
        emit MinterSet(account, allowed);
    }

    function setBurner(address account, bool allowed) external onlyOwner {
        isBurner[account] = allowed;
        emit BurnerSet(account, allowed);
    }

    function setURI(string calldata uri_) external onlyOwner {
        _setURI(uri_);
    }

    /// @notice Packs a strain and quality tier into a token id.
    function idFor(uint32 strainId, uint8 tier) public pure returns (uint256) {
        if (tier > TIER_PREMIUM) revert BadTier();
        return uint256(strainId) * TIERS + tier;
    }

    function strainOf(uint256 id) public pure returns (uint32) {
        return uint32(id / TIERS);
    }

    function tierOf(uint256 id) public pure returns (uint8) {
        return uint8(id % TIERS);
    }

    function mint(address to, uint256 id, uint256 amount) external {
        if (!isMinter[msg.sender]) revert NotMinter();
        totalMinted[id] += amount;
        _mint(to, id, amount, "");
    }

    /**
     * @dev Two gates, deliberately. The caller must be an authorized protocol contract
     *      AND hold the holder's ERC-1155 approval. The role alone would let a single
     *      compromised burner destroy anyone's inventory.
     */
    function burnFrom(address from, uint256 id, uint256 amount) external {
        if (!isBurner[msg.sender]) revert NotBurner();
        if (from != msg.sender && !isApprovedForAll(from, msg.sender)) revert NotApproved();
        totalBurned[id] += amount;
        _burn(from, id, amount);
    }

    /// @notice Holders can always destroy their own units.
    function burn(uint256 id, uint256 amount) external {
        totalBurned[id] += amount;
        _burn(msg.sender, id, amount);
    }
}
