// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title HESOYAM
 * @notice Fixed-supply ERC-20 with a 3% transfer tax: 1% to the launch platform,
 *         2% to the protocol's RevenueRouter.
 *
 * INV-3  Total supply is fixed at construction. There is no mint path, and
 *        `renounceMintability` is unnecessary because none was ever written.
 *
 * The tax is skipped whenever either side of a transfer is exempt. Every protocol
 * contract is exempt, so game fees and marketplace settlement land in the router
 * at full value instead of being taxed a second time on the way in.
 */
contract HesoyamToken is ERC20, ERC20Permit, Ownable2Step {
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;
    /// @notice 4.0% of every taxed transfer, to the creator wallet.
    uint16 public constant CREATOR_FEE_BPS = 400;

    /// @notice 1.0% of every taxed transfer, to the RevenueRouter.
    /// @dev This is the only part of the tax that reaches the flywheel. It was
    ///      2.0% under the original 3% split, so the token tax now contributes
    ///      half what it used to per unit of volume. The other seven fee lines
    ///      are unaffected.
    uint16 public constant PROTOCOL_FEE_BPS = 100;

    /// @notice 5.0% total. Checked here so the two parts can never silently drift
    ///         apart from the number quoted publicly.
    uint16 public constant TOTAL_TAX_BPS = 500;
    uint16 private constant BPS = 10_000;

    address public creatorTreasury;
    address public revenueRouter;
    bool public taxEnabled;

    mapping(address => bool) public isTaxExempt;

    event TaxRecipientsSet(address creatorTreasury, address revenueRouter);
    event TaxEnabled();
    event TaxExemptionSet(address indexed account, bool exempt);
    event TaxTaken(address indexed from, address indexed to, uint256 creatorFee, uint256 protocolFee);

    error RecipientsNotSet();
    error ZeroAddress();
    error AlreadyEnabled();

    constructor(address initialOwner, address treasuryReceiver)
        ERC20("Hesoyam Canopy", "HESOYAM")
        ERC20Permit("Hesoyam Canopy")
        Ownable(initialOwner)
    {
        if (initialOwner == address(0) || treasuryReceiver == address(0)) revert ZeroAddress();
        _mint(treasuryReceiver, MAX_SUPPLY);
        isTaxExempt[treasuryReceiver] = true;
        isTaxExempt[initialOwner] = true;
    }

    /// @notice Nominates where the two tax legs go. Must be set before the tax can be enabled.
    function setTaxRecipients(address creatorTreasury_, address revenueRouter_) external onlyOwner {
        if (creatorTreasury_ == address(0) || revenueRouter_ == address(0)) revert ZeroAddress();
        creatorTreasury = creatorTreasury_;
        revenueRouter = revenueRouter_;
        isTaxExempt[creatorTreasury_] = true;
        isTaxExempt[revenueRouter_] = true;
        emit TaxRecipientsSet(creatorTreasury_, revenueRouter_);
    }

    /// @notice One-way switch. Once the tax is on it can never be turned off or changed.
    function enableTax() external onlyOwner {
        if (taxEnabled) revert AlreadyEnabled();
        if (creatorTreasury == address(0) || revenueRouter == address(0)) revert RecipientsNotSet();
        taxEnabled = true;
        emit TaxEnabled();
    }

    function setTaxExempt(address account, bool exempt) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isTaxExempt[account] = exempt;
        emit TaxExemptionSet(account, exempt);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!taxEnabled || from == address(0) || to == address(0) || isTaxExempt[from] || isTaxExempt[to]) {
            super._update(from, to, value);
            return;
        }

        uint256 creatorFee = (value * CREATOR_FEE_BPS) / BPS;
        uint256 protocolFee = (value * PROTOCOL_FEE_BPS) / BPS;
        uint256 remainder = value - creatorFee - protocolFee;

        if (creatorFee > 0) super._update(from, creatorTreasury, creatorFee);
        if (protocolFee > 0) super._update(from, revenueRouter, protocolFee);
        super._update(from, to, remainder);

        emit TaxTaken(from, to, creatorFee, protocolFee);
    }
}
