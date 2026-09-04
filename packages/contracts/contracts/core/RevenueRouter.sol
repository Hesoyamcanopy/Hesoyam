// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapAdapter, IRewardSink, IDispensaryFunding} from "../interfaces/IHesoyam.sol";

/**
 * @title RevenueRouter
 * @notice The single tap. Every revenue line in the protocol lands here as HESOYAM or
 *         settlement token, gets converted, and is split by a published allocation.
 *
 * INV-6  This contract holds no approval on the StakingVault and exposes no function
 *        that can move value out of it. Value only ever arrives.
 * INV-7  Conversions are capped per call and guarded against a TWAP deviation, so the
 *        treasury cannot drain the pool it depends on.
 *
 * Nothing here can pay a reward that was not first received. `sweep` distributes the
 * balance it actually holds, which is what makes INV-1 hold downstream.
 */
contract RevenueRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10_000;

    struct Allocation {
        uint16 equityBps; // staker rail
        uint16 dispensaryBps; // grower rail
        uint16 liquidityBps;
        uint16 opsBps;
        uint16 reserveBps;
    }

    IERC20 public immutable hesoyam;
    IERC20 public immutable settlement;

    ISwapAdapter public swapAdapter;
    address public rewardSink; // StakingVault
    address public dispensary;
    address public liquiditySink;
    address public opsSafe;

    Allocation public allocation;

    // INV-7 guards
    /// @notice Ceilings on the guards themselves, so loosening them is bounded.
    uint256 public constant MAX_SWEEP_CEIL = 20_000_000e18;
    uint256 public constant MIN_SWEEP_COOLDOWN = 1 hours;
    uint16 public constant MAX_DEVIATION_CEIL_BPS = 1000; // 10%
    uint16 public constant MAX_SLIPPAGE_CEIL_BPS = 2000; // 20%

    uint256 public maxSweepHesoyam = 2_000_000e18;
    uint256 public sweepCooldown = 6 hours;
    uint16 public maxTwapDeviationBps = 200; // 2%

    /// @notice How far below the TWAP a sweep may execute. Bounds the router's
    ///         own price impact, which the deviation guard cannot observe.
    uint16 public maxSlippageBps = 300; // 3%
    uint256 public lastSweepAt;

    // Lifetime accounting, in settlement-token units.
    uint256 public totalRealized;
    uint256 public totalToEquity;
    uint256 public totalToDispensary;
    uint256 public totalToLiquidity;
    uint256 public totalToOps;
    uint256 public reserveBalance;

    event AllocationSet(uint16 equity, uint16 dispensary, uint16 liquidity, uint16 ops, uint16 reserve);
    event SinksSet(address rewardSink, address dispensary, address liquiditySink, address opsSafe);
    event SwapAdapterSet(address adapter);
    event GuardsSet(uint256 maxSweepHesoyam, uint256 cooldown, uint16 maxTwapDeviationBps);
    event MaxSlippageSet(uint16 bps);
    event Swept(uint256 hesoyamIn, uint256 usdcOut, uint256 distributed);
    event Distributed(uint256 equity, uint256 dispensary, uint256 liquidity, uint256 ops, uint256 reserve);

    error ZeroAddress();
    error BadAllocation();
    error SinksNotSet();
    error CooldownActive();
    error PriceDeviation();
    error SlippageTooHigh();
    error NothingToSweep();

    constructor(address initialOwner, IERC20 hesoyam_, IERC20 settlement_) Ownable(initialOwner) {
        if (address(hesoyam_) == address(0) || address(settlement_) == address(0)) revert ZeroAddress();
        hesoyam = hesoyam_;
        settlement = settlement_;
        allocation = Allocation({
            equityBps: 5000,
            dispensaryBps: 2800,
            liquidityBps: 1200,
            opsBps: 800,
            reserveBps: 200
        });
    }

    // --- configuration -------------------------------------------------------

    function setAllocation(uint16 equity, uint16 dispensary_, uint16 liquidity, uint16 ops, uint16 reserve)
        external
        onlyOwner
    {
        if (uint256(equity) + dispensary_ + liquidity + ops + reserve != BPS) revert BadAllocation();
        allocation = Allocation(equity, dispensary_, liquidity, ops, reserve);
        emit AllocationSet(equity, dispensary_, liquidity, ops, reserve);
    }

    function setSinks(address rewardSink_, address dispensary_, address liquiditySink_, address opsSafe_)
        external
        onlyOwner
    {
        if (
            rewardSink_ == address(0) || dispensary_ == address(0) || liquiditySink_ == address(0)
                || opsSafe_ == address(0)
        ) revert ZeroAddress();
        rewardSink = rewardSink_;
        dispensary = dispensary_;
        liquiditySink = liquiditySink_;
        opsSafe = opsSafe_;
        emit SinksSet(rewardSink_, dispensary_, liquiditySink_, opsSafe_);
    }

    function setSwapAdapter(ISwapAdapter adapter) external onlyOwner {
        if (address(adapter) == address(0)) revert ZeroAddress();
        swapAdapter = adapter;
        emit SwapAdapterSet(address(adapter));
    }

    /// @notice Bounds how far below the TWAP a sweep may execute.
    function setMaxSlippage(uint16 bps) external onlyOwner {
        if (bps > MAX_SLIPPAGE_CEIL_BPS) revert BadAllocation();
        maxSlippageBps = bps;
        emit MaxSlippageSet(bps);
    }

    /// @dev Every guard is bounded. Without bounds these three setters were a
    ///      single transaction path from a compromised owner to an unlimited,
    ///      uncooled, unchecked sweep of the whole router balance.
    function setGuards(uint256 maxSweepHesoyam_, uint256 cooldown_, uint16 maxDeviationBps_) external onlyOwner {
        if (maxDeviationBps_ > MAX_DEVIATION_CEIL_BPS) revert BadAllocation();
        if (maxSweepHesoyam_ == 0 || maxSweepHesoyam_ > MAX_SWEEP_CEIL) revert BadAllocation();
        if (cooldown_ < MIN_SWEEP_COOLDOWN) revert BadAllocation();
        maxSweepHesoyam = maxSweepHesoyam_;
        sweepCooldown = cooldown_;
        maxTwapDeviationBps = maxDeviationBps_;
        emit GuardsSet(maxSweepHesoyam_, cooldown_, maxDeviationBps_);
    }

    // --- operation -----------------------------------------------------------

    /// @notice HESOYAM waiting to be converted on the next sweep.
    function pendingHesoyam() external view returns (uint256) {
        return hesoyam.balanceOf(address(this));
    }

    /// @notice Settlement tokens held that are not part of the retained reserve.
    function distributableSettlement() public view returns (uint256) {
        uint256 bal = settlement.balanceOf(address(this));
        return bal > reserveBalance ? bal - reserveBalance : 0;
    }

    /**
     * @notice Converts held HESOYAM and distributes everything distributable.
     * @dev Permissionless. Anyone may call it once the cooldown has elapsed, so a
     *      dead keeper cannot stop payouts.
     */
    function sweep(uint256 minSettlementOut) external nonReentrant returns (uint256 distributed) {
        if (rewardSink == address(0) || dispensary == address(0)) revert SinksNotSet();
        if (block.timestamp < lastSweepAt + sweepCooldown) revert CooldownActive();

        uint256 hesoyamBal = hesoyam.balanceOf(address(this));
        uint256 swapAmount = hesoyamBal > maxSweepHesoyam ? maxSweepHesoyam : hesoyamBal;

        uint256 received;
        if (swapAmount > 0 && address(swapAdapter) != address(0)) {
            _requirePriceSane();

            // The floor is computed here, from the TWAP, and the caller's value is
            // only ever allowed to raise it.
            //
            // sweep() is permissionless, so trusting the caller's floor meant
            // anyone could call sweep(0): push spot down inside the deviation
            // band, let the router dump up to maxSweepHesoyam with no floor, then
            // buy back. The deviation guard runs before the swap and constrains
            // only the pre-trade gap, never the router's own price impact.
            uint256 floorOut = _twapFloor(swapAmount);
            uint256 minOut = minSettlementOut > floorOut ? minSettlementOut : floorOut;

            uint256 balBefore = settlement.balanceOf(address(this));
            hesoyam.forceApprove(address(swapAdapter), swapAmount);
            swapAdapter.swapHesoyamForUsdc(swapAmount, minOut);
            hesoyam.forceApprove(address(swapAdapter), 0);

            // Measure what actually arrived rather than trusting the adapter's
            // own return value, which it is free to overstate.
            received = settlement.balanceOf(address(this)) - balBefore;
            if (received < minOut) revert SlippageTooHigh();
        }

        lastSweepAt = block.timestamp;
        distributed = _distribute();
        if (distributed == 0 && received == 0) revert NothingToSweep();
        emit Swept(swapAmount, received, distributed);
    }

    /// @notice Distributes settlement tokens without touching HESOYAM. Useful when revenue
    ///         already arrives in settlement token, and not rate limited because no
    ///         market interaction happens.
    function distribute() external nonReentrant returns (uint256) {
        if (rewardSink == address(0) || dispensary == address(0)) revert SinksNotSet();
        uint256 out = _distribute();
        if (out == 0) revert NothingToSweep();
        return out;
    }

    /**
     * @notice The least settlement the router will accept for `amountIn`, derived
     *         from the time weighted price rather than from whoever called sweep.
     * @dev maxSlippageBps is the allowance for the router's own price impact,
     *      which the deviation guard cannot see.
     */
    function _twapFloor(uint256 amountIn) internal view returns (uint256) {
        uint256 twap = swapAdapter.twapUsdcPerHesoyam();
        if (twap == 0) return 0;
        uint256 expected = (amountIn * twap) / 1e18;
        return (expected * (BPS - maxSlippageBps)) / BPS;
    }

    function _requirePriceSane() internal view {
        uint256 twap = swapAdapter.twapUsdcPerHesoyam();
        uint256 spot = swapAdapter.spotUsdcPerHesoyam();
        if (twap == 0 || spot == 0) revert PriceDeviation();
        uint256 diff = spot > twap ? spot - twap : twap - spot;
        if ((diff * BPS) / twap > maxTwapDeviationBps) revert PriceDeviation();
    }

    function _distribute() internal returns (uint256 total) {
        total = distributableSettlement();
        if (total == 0) return 0;

        Allocation memory a = allocation;
        uint256 toEquity = (total * a.equityBps) / BPS;
        uint256 toDispensary = (total * a.dispensaryBps) / BPS;
        uint256 toLiquidity = (total * a.liquidityBps) / BPS;
        uint256 toOps = (total * a.opsBps) / BPS;
        // Remainder lands in reserve so rounding dust is never stranded.
        uint256 toReserve = total - toEquity - toDispensary - toLiquidity - toOps;

        totalRealized += total;
        totalToEquity += toEquity;
        totalToDispensary += toDispensary;
        totalToLiquidity += toLiquidity;
        totalToOps += toOps;
        reserveBalance += toReserve;

        if (toEquity > 0) {
            settlement.forceApprove(rewardSink, toEquity);
            IRewardSink(rewardSink).notifyReward(toEquity);
            settlement.forceApprove(rewardSink, 0);
        }
        if (toDispensary > 0) {
            settlement.forceApprove(dispensary, toDispensary);
            IDispensaryFunding(dispensary).fundEpoch(toDispensary);
            settlement.forceApprove(dispensary, 0);
        }
        if (toLiquidity > 0) settlement.safeTransfer(liquiditySink, toLiquidity);
        if (toOps > 0) settlement.safeTransfer(opsSafe, toOps);

        emit Distributed(toEquity, toDispensary, toLiquidity, toOps, toReserve);
    }

    /**
     * @notice Moves reserve funds out. The reserve exists to cover failed settlements
     *         and oracle gaps, and is deliberately not a reward source.
     */
    function spendReserve(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        reserveBalance -= amount;
        settlement.safeTransfer(to, amount);
    }
}
