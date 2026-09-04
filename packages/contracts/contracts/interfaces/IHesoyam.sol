// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Swaps HESOYAM held by the router into the settlement token.
interface ISwapAdapter {
    /// @param hesoyamIn      Amount of HESOYAM pulled from the caller.
    /// @param minUsdcOut  Slippage floor, enforced by the adapter.
    /// @return usdcOut    Settlement tokens delivered to the caller.
    function swapHesoyamForUsdc(uint256 hesoyamIn, uint256 minUsdcOut) external returns (uint256 usdcOut);

    /// @notice Time-weighted reference used by the router's deviation guard.
    /// @return usdcPerHesoyam Price of 1e18 HESOYAM, in settlement-token decimals.
    function twapUsdcPerHesoyam() external view returns (uint256 usdcPerHesoyam);

    /// @notice Spot price of 1e18 HESOYAM, in settlement-token decimals.
    function spotUsdcPerHesoyam() external view returns (uint256 usdcPerHesoyam);
}

/// @notice Receives the staker share of realized revenue.
interface IRewardSink {
    /// @dev Pulls `amount` of settlement token from msg.sender via transferFrom.
    function notifyReward(uint256 amount) external;
}

/// @notice Receives the grower share of realized revenue.
interface IDispensaryFunding {
    /// @dev Pulls `amount` of settlement token from msg.sender via transferFrom.
    function fundEpoch(uint256 amount) external;
}

/// @notice Minimal mint/burn surface used by game contracts.
interface IFlower {
    function mint(address to, uint256 id, uint256 amount) external;
    function burnFrom(address from, uint256 id, uint256 amount) external;
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

interface IStrainCard {
    function mint(address to, uint16 weightBps, uint32 strainId, uint8 rarity) external returns (uint256);
    function weightBpsOf(uint256 tokenId) external view returns (uint16);
}

interface IRandomBeacon {
    function round() external view returns (uint256);
    function seedOf(uint256 r) external view returns (bytes32);
    function isReady(uint256 r) external view returns (bool);
    function isStalled() external view returns (bool);
}

interface IGrowBench {
    function ownerOf(uint256 tokenId) external view returns (address);
    function tierOf(uint256 tokenId) external view returns (uint8);
    function exists(uint256 tokenId) external view returns (bool);
}
