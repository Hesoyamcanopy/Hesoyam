// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../interfaces/IHesoyam.sol";

/// @notice Six-decimal settlement token standing in for USDC in tests and on testnet.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @notice Deterministic swap adapter for tests and testnet. Holds a USDC float and
 *         exchanges HESOYAM for USDC at a settable rate, with a separate TWAP value so
 *         the router's deviation guard can be exercised.
 *
 * Production replaces this with a real AMM route. The interface is the seam.
 */
contract MockSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable hesoyam;
    IERC20 public immutable usdc;

    uint256 public spot; // USDC (6dp) per 1e18 HESOYAM
    uint256 public twap;

    constructor(IERC20 hesoyam_, IERC20 usdc_, uint256 initialPrice) {
        hesoyam = hesoyam_;
        usdc = usdc_;
        spot = initialPrice;
        twap = initialPrice;
    }

    function setPrices(uint256 spot_, uint256 twap_) external {
        spot = spot_;
        twap = twap_;
    }

    function spotUsdcPerHesoyam() external view returns (uint256) {
        return spot;
    }

    function twapUsdcPerHesoyam() external view returns (uint256) {
        return twap;
    }

    function swapHesoyamForUsdc(uint256 hesoyamIn, uint256 minUsdcOut) external returns (uint256 usdcOut) {
        hesoyam.safeTransferFrom(msg.sender, address(this), hesoyamIn);
        usdcOut = (hesoyamIn * spot) / 1e18;
        require(usdcOut >= minUsdcOut, "MockSwapAdapter: slippage");
        usdc.safeTransfer(msg.sender, usdcOut);
    }
}
