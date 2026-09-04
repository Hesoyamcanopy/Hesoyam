// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Faucet
 * @notice Hands out a fixed amount of HESOYAM to anyone, on a per-address cooldown.
 *
 * This exists because a fresh deployment mints the whole supply to the deployer.
 * Without it, a tester who connects a wallet and gets testnet ETH from a public
 * faucet still cannot do anything in the game that costs HESOYAM, which is
 * everything past looking at the room. This closes that gap without asking
 * anyone to message the deployer for tokens by hand.
 *
 * It is deliberately not part of HesoyamToken or the deploy script's normal
 * path. The token contract may be the one Pons deploys on a real launch, not
 * ours, so a faucet baked into it would be dead code there at best. Keeping it
 * a separate, optional contract means it is simply never deployed on a chain
 * where it would matter, rather than a runtime flag guarding a code path that
 * would otherwise ship live.
 *
 * The chain check in the constructor is a second lock on the same door: it
 * refuses to deploy at all on Robinhood Chain mainnet, so a mistaken deploy
 * script invocation cannot hand out real HESOYAM for free.
 */
contract Faucet is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Robinhood Chain mainnet. This faucet refuses to exist there.
    uint256 public constant MAINNET_CHAIN_ID = 4663;

    IERC20 public immutable token;
    uint256 public immutable amountPerClaim;
    uint256 public immutable cooldown;

    mapping(address => uint256) public lastClaimAt;

    event Claimed(address indexed to, uint256 amount);

    error WrongChain();
    error TooSoon(uint256 nextClaimAt);
    error Dry();

    constructor(address token_, uint256 amountPerClaim_, uint256 cooldown_) {
        if (block.chainid == MAINNET_CHAIN_ID) revert WrongChain();
        token = IERC20(token_);
        amountPerClaim = amountPerClaim_;
        cooldown = cooldown_;
    }

    /// @notice Sends `amountPerClaim` to the caller, if their cooldown has passed
    ///         and the faucet holds enough. Anyone may call this for themselves.
    function claim() external nonReentrant {
        uint256 next = lastClaimAt[msg.sender] + cooldown;
        if (block.timestamp < next) revert TooSoon(next);
        if (token.balanceOf(address(this)) < amountPerClaim) revert Dry();

        // Set before the transfer, standard checks-effects-interactions, though
        // the token here is never one this contract also mints or controls.
        lastClaimAt[msg.sender] = block.timestamp;
        token.safeTransfer(msg.sender, amountPerClaim);
        emit Claimed(msg.sender, amountPerClaim);
    }

    /// @notice When `account` can next claim. May be in the past.
    function nextClaimAt(address account) external view returns (uint256) {
        return lastClaimAt[account] + cooldown;
    }

    /// @notice Whether `account` could successfully call claim() right now.
    function canClaim(address account) external view returns (bool) {
        return block.timestamp >= lastClaimAt[account] + cooldown
            && token.balanceOf(address(this)) >= amountPerClaim;
    }
}
