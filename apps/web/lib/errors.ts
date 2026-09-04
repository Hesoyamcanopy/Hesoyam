import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";

/**
 * Turns a revert into something a player can act on.
 *
 * The contracts use custom errors rather than strings, so a raw failure reaches the
 * client as `GrowInactive()` and nothing else. Every one of them is mapped here. An
 * unmapped error still shows its name rather than a stack trace, which is ugly but
 * honest, and it tells us we missed one.
 */

const MESSAGES: Record<string, string> = {
  // Shared
  ZeroAddress: "That address is not valid.",
  ZeroAmount: "Enter an amount above zero.",

  // HesoyamToken
  RecipientsNotSet: "The tax recipients have not been configured yet.",
  AlreadyEnabled: "The tax is already switched on and cannot be changed.",

  // RevenueRouter
  BadAllocation: "That split does not add up to 100 percent.",
  SinksNotSet: "The router has not been wired to its destinations yet.",
  CooldownActive: "The last sweep was too recent. Conversions are rate limited on purpose.",
  PriceDeviation: "Spot price has moved too far from the average. The sweep was blocked to protect the pool.",
  NothingToSweep: "There is nothing waiting to be converted or distributed.",

  // StakingVault
  BadTier: "That lock tier is not available.",
  NotNotifier: "Only the revenue router can deliver rewards.",
  PositionClosed: "That position has already been closed.",
  TooManyCards: "You can equip five cards at most.",
  NotCardOwner: "You do not own that card.",
  NothingToClaim: "There is nothing to claim yet.",
  CardNotEquipped: "That card is not equipped.",

  // GrowGame
  StrainInactive: "That strain is not available to plant right now.",
  NotBenchOwner: "You do not own that bench.",
  BenchBusy: "That bench already has something growing on it.",
  NotGrower: "This grow belongs to someone else.",
  GrowInactive: "That grow has already finished.",
  WindowClosed: "This window is not open. Check the schedule on the bench.",
  AlreadyFed: "You have already fed this window.",
  NoEventHere: "Nothing is wrong with the plant in that slot.",
  AlreadyTreated: "You have already treated this event.",
  NotMature: "It is not ready yet.",
  BadCommit: "That is not the salt this grow was planted with.",
  NotCuring: "This harvest is not curing.",
  AlreadyCollected: "You have already collected this harvest.",
  BadSlot: "That slot does not exist.",

  // Flower
  NotMinter: "This contract is not allowed to mint.",
  NotBurner: "This contract is not allowed to burn.",
  NotApproved: "Approve the contract to handle your Flower first.",

  // GrowBench
  TrancheClosedError: "That batch of benches is closed.",
  SoldOut: "That batch is sold out.",

  // Marketplace
  NotSeller: "Only the seller can do that.",
  NotActive: "That listing is no longer active.",
  InsufficientListing: "The listing does not have that many units left.",
  FeeTooHigh: "That fee is above the hard ceiling.",

  // Dispensary
  NotFunder: "Only the revenue router can fund an epoch.",
  NotKeeper: "Only a keeper can set a reference price.",
  BudgetExhausted: "The Dispensary budget is spent for this epoch. Wait for the next one, or sell on the market.",
  NoReference: "There is no reference price for that tier yet, so the Dispensary is not bidding.",
  MoveTooLarge: "That is too large a move for one update.",

  // CardCrafter
  NotReady: "The reveal block has not arrived yet.",
  AlreadyFinalized: "This craft has already been settled.",
  UnknownRequest: "That craft request does not exist.",

  // StrainRegistry
  BadParams: "Those strain parameters are out of range.",
  UnknownStrain: "That strain does not exist.",

  // StrainCard
  WeightOutOfRange: "That weight is outside the allowed range.",

  // OpenZeppelin
  OwnableUnauthorizedAccount: "Only the owner can do that.",
  ERC20InsufficientBalance: "You do not have enough HESOYAM.",
  ERC20InsufficientAllowance: "Approve the contract to spend your HESOYAM first.",
  ERC721InsufficientApproval: "Approve the contract to move that token first.",
  ERC1155InsufficientBalance: "You do not have enough of that item.",
};

export type FriendlyError = {
  title: string;
  detail?: string;
  rejected: boolean;
  raw: string;
};

export function explainError(error: unknown): FriendlyError {
  if (error instanceof BaseError) {
    const rejected = error.walk((e) => e instanceof UserRejectedRequestError);
    if (rejected) {
      return { title: "You cancelled the signature.", rejected: true, raw: "UserRejectedRequest" };
    }

    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? "";
      const mapped = MESSAGES[name];
      if (mapped) return { title: mapped, rejected: false, raw: name };
      if (name) {
        return { title: `The contract refused this: ${name}.`, rejected: false, raw: name };
      }
      const reason = reverted.reason;
      if (reason) return { title: reason, rejected: false, raw: reason };
    }

    return { title: error.shortMessage || "The transaction failed.", rejected: false, raw: error.name };
  }

  if (error instanceof Error) {
    // Custom errors sometimes arrive only as text, so match the name out of it.
    for (const name of Object.keys(MESSAGES)) {
      if (error.message.includes(name)) {
        return { title: MESSAGES[name], rejected: false, raw: name };
      }
    }
    return { title: error.message, rejected: false, raw: error.name };
  }

  return { title: "Something went wrong.", rejected: false, raw: String(error) };
}
