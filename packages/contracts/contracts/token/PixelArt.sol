// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @notice Renders a 16 by 16 pixel tile as an SVG, entirely on chain.
 *
 * There is no IPFS pin and no metadata server. A Plot's art is a pure function of
 * its district, tier and seed, so it renders identically forever and cannot rot
 * when someone stops paying a hosting bill.
 *
 * Rows are run length encoded before they are emitted. A tile of 256 pixels
 * collapses to roughly 60 rects, which keeps the returned string small enough to
 * be comfortable in a wallet. tokenURI is a view function, so the cost of the
 * loop is paid by the node answering the call rather than by a player.
 */
library PixelArt {
    using Strings for uint256;

    uint256 internal constant SIZE = 16;
    uint256 internal constant SCALE = 24;

    /// @dev Eight districts of seven colours, packed as raw RGB triples.
    ///      Order per district: sky, wall, shade, window, ground, plant, accent.
    bytes internal constant PALETTES =
        hex"3a35246b5f424a4130f5c54252472f9ad34ac9453a"
        hex"2c4a527a8f8a55665ff5e0a36b7a5a9ad34a6ec8d8"
        hex"22262e4a505833383ff5c5423a3f427ab648c9453a"
        hex"2e3a265c6b47414d33f0d98a4a55359ad34af5c542"
        hex"232b2e45524f303a38d8b25a38423f6f9e3f8a9aa5"
        hex"3d30207a6144574531f5c5425e4b338ab83cc9453a"
        hex"2a33205f6b3f43502decd5824d5a329ad34ad8863a"
        hex"251f2e4f4460372f45f5c5423d35489ad34ae05ca8";

    bytes16 private constant HEX = "0123456789abcdef";

    /// @notice The eight district names, used in metadata.
    function districtName(uint8 district) internal pure returns (string memory) {
        string[8] memory names =
            ["Dust", "Bayside", "Downtown", "Ridge", "Docks", "Badlands", "County", "The Strip"];
        return names[district % 8];
    }

    /// @notice The four plot tiers, from bare dirt to a lit greenhouse.
    function tierName(uint8 tier) internal pure returns (string memory) {
        string[4] memory names = ["Lot", "Fenced", "Greenhouse", "Lit"];
        return names[tier % 4];
    }

    function _color(uint8 district, uint256 index) private pure returns (string memory) {
        uint256 o = (uint256(district % 8) * 7 + index) * 3;
        bytes memory out = new bytes(7);
        out[0] = "#";
        for (uint256 i = 0; i < 3; i++) {
            uint8 b = uint8(PALETTES[o + i]);
            out[1 + i * 2] = HEX[b >> 4];
            out[2 + i * 2] = HEX[b & 0x0f];
        }
        return string(out);
    }

    /**
     * @dev Builds the tile as one palette index per pixel.
     *
     * The layout is fixed so every plot reads as the same kind of place: sky at
     * the top, a building whose width and window pattern come from the seed, then
     * the lot itself. Tier is the only thing that changes what is growing on it,
     * which is why a fused plot looks visibly better than the two that made it.
     */
    function _tile(uint64 seed, uint8 tier) private pure returns (bytes memory px) {
        px = new bytes(SIZE * SIZE);

        // Hash the seed before reading bits out of it. Reading raw bits means a
        // small seed leaves the high ones at zero, which showed up as every
        // window in the collection being unlit. Hashing makes the art independent
        // of how large a number the minter happened to pass.
        uint256 m = uint256(keccak256(abi.encodePacked(seed)));

        uint256 left = 2 + (m % 3);
        uint256 right = left + 7 + ((m >> 8) % 3);
        if (right > 13) right = 13;
        uint256 roof = 5;
        uint256 plantSpacing = 5 - (tier > 3 ? 3 : tier);

        for (uint256 y = 0; y < SIZE; y++) {
            for (uint256 x = 0; x < SIZE; x++) {
                uint256 i = y * SIZE + x;
                uint256 c;

                if (y >= 11) {
                    c = 4; // the lot
                } else {
                    c = 0; // sky
                }
                if (y == 15) c = 2; // pavement

                // The building.
                if (y >= roof && y <= 10 && x >= left && x <= right) {
                    c = 1;
                    if (x == right) {
                        c = 2; // shaded edge
                    } else if ((x - left) % 3 == 1 && (y - roof) % 2 == 1) {
                        // A window, lit if its bit in the mixed seed is set.
                        uint256 bit = ((x - left) / 3) + ((y - roof) / 2) * 4;
                        c = ((m >> (32 + (bit % 32))) & 1) == 1 ? 3 : 2;
                    }
                }

                // What is growing on the lot.
                if (y >= 13 && y <= 14 && (x + (m % 4)) % plantSpacing == 0) {
                    c = 5;
                }

                // Each tier adds something you can actually see, so a fused plot
                // is visibly better than the two that made it: a fence, then a
                // sign on the roof line, then a lit kerb.
                if (tier >= 1 && y == 12 && x % 2 == 0) {
                    c = 6;
                }
                if (tier >= 2 && y == roof - 1 && x >= left && x <= right && x % 2 == 0) {
                    c = 6;
                }
                if (tier >= 3 && y == 15 && x % 3 == 1) {
                    c = 6;
                }

                px[i] = bytes1(uint8(c));
            }
        }
    }

    /// @dev Kept as its own function so the encode above stays shallow. Inlining
    ///      it puts the whole rect over the stack limit.
    function _rect(uint256 x, uint256 y, uint256 w, string memory fill) private pure returns (bytes memory) {
        return abi.encodePacked(
            "<rect x=\"",
            x.toString(),
            "\" y=\"",
            y.toString(),
            "\" width=\"",
            w.toString(),
            "\" height=\"",
            SCALE.toString(),
            "\" fill=\"",
            fill,
            "\"/>"
        );
    }

    /// @notice The finished SVG for one plot.
    function render(uint64 seed, uint8 district, uint8 tier) internal pure returns (string memory) {
        bytes memory px = _tile(seed, tier);
        uint256 dim = SIZE * SCALE;

        bytes memory body = abi.encodePacked(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 ",
            dim.toString(),
            " ",
            dim.toString(),
            "\" shape-rendering=\"crispEdges\" width=\"384\" height=\"384\">"
        );

        // Run length encode each row so a flat area costs one rect, not sixteen.
        for (uint256 y = 0; y < SIZE; y++) {
            uint256 x = 0;
            while (x < SIZE) {
                uint256 run = 1;
                while (x + run < SIZE && px[y * SIZE + x + run] == px[y * SIZE + x]) {
                    run++;
                }
                body = abi.encodePacked(
                    body, _rect(x * SCALE, y * SCALE, run * SCALE, _color(district, uint8(px[y * SIZE + x])))
                );
                x += run;
            }
        }

        return string(abi.encodePacked(body, "</svg>"));
    }
}
