// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title StrainCard
 * @notice Genetics plus a staking weight multiplier. Cards are only ever created by
 *         the CardCrafter, which destroys Flower to make one. The protocol never
 *         sells cards directly.
 */
contract StrainCard is ERC721Enumerable, Ownable2Step {
    uint16 public constant MIN_WEIGHT_BPS = 10_000; // 1.00x
    uint16 public constant MAX_WEIGHT_BPS = 14_200; // 1.42x

    struct Genetics {
        uint16 weightBps;
        uint32 strainId;
        uint8 rarity; // 0 common, 1 uncommon, 2 rare, 3 mythic
        uint64 mintedAt;
    }

    mapping(uint256 => Genetics) public genetics;
    mapping(address => bool) public isMinter;
    uint256 public nextTokenId = 1;
    string private _base;

    event MinterSet(address indexed account, bool allowed);
    event CardMinted(address indexed to, uint256 indexed tokenId, uint16 weightBps, uint32 strainId, uint8 rarity);

    error NotMinter();
    error WeightOutOfRange();

    constructor(address initialOwner, string memory baseURI_)
        ERC721("Hesoyam Strain Card", "STRAIN")
        Ownable(initialOwner)
    {
        _base = baseURI_;
    }

    function setMinter(address account, bool allowed) external onlyOwner {
        isMinter[account] = allowed;
        emit MinterSet(account, allowed);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _base = baseURI_;
    }

    function _baseURI() internal view override returns (string memory) {
        return _base;
    }

    function mint(address to, uint16 weightBps, uint32 strainId, uint8 rarity) external returns (uint256 tokenId) {
        if (!isMinter[msg.sender]) revert NotMinter();
        if (weightBps < MIN_WEIGHT_BPS || weightBps > MAX_WEIGHT_BPS) revert WeightOutOfRange();
        tokenId = nextTokenId++;
        genetics[tokenId] = Genetics(weightBps, strainId, rarity, uint64(block.timestamp));
        _safeMint(to, tokenId);
        emit CardMinted(to, tokenId, weightBps, strainId, rarity);
    }

    function weightBpsOf(uint256 tokenId) external view returns (uint16) {
        _requireOwned(tokenId);
        return genetics[tokenId].weightBps;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
