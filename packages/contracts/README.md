# HESOYAM CANOPY

On-chain cannabis growing, trading and staking. Every reward is funded by revenue the
protocol actually collected, never by a new deposit and never by minting.

Two documents describe the design:

- **Protocol blueprint**: architecture, invariants, phased launch plan
- **Grow loop**: game and economy design, faucet-and-sink ledger

This repository is the contract implementation of both.

---

## Status

Twelve contracts, compiling on Solidity 0.8.24 (`paris` EVM target) and covered by
**44 passing tests**, including randomized property tests that re-check every
invariant after each action.

```
npm install          # from the repo root
npm run contracts:compile
npm run contracts:test
npm run deploy -w @hesoyam/contracts
```

---

## What is implemented

| Contract | Role |
| --- | --- |
| `HesoyamToken` | Fixed-supply ERC-20, 3% tax split 1% platform / 2% router. No mint path exists. |
| `RevenueRouter` | The single tap. Converts HESOYAM, splits realized revenue by published allocation. |
| `StakingVault` | Lock tiers, weights, card multipliers, reward accumulator, penalties, always-open exit. |
| `Flower` | ERC-1155 commodity. Token id packs strain and quality tier. |
| `StrainCard` | ERC-721 genetics with a capped staking weight multiplier. |
| `GrowBench` | ERC-721 capacity, sold in capped tranches, price is 100% revenue. |
| `StrainRegistry` | Genetics table. All balance parameters live here. |
| `GrowGame` | Plant, feed, treat, harvest, cure, collect. Lazy growth, no per-block ticking. |
| `CardCrafter` | Burns Flower into cards using future-block randomness. |
| `Marketplace` | Player-to-player Flower trading with a 4% take. |
| `Dispensary` | Budget-capped descending auction that buys and burns Flower. |
| `MockUSDC`, `MockSwapAdapter` | Test and testnet stand-ins behind real interfaces. |

### The loop, end to end

1. Buy a bench, buy a seed by planting, commit a salt.
2. Feed inside three windows, treat pest events inside their response windows.
3. Harvest after the cycle. Care score (0–100) sets yield across a 1.8x skill band;
   genetics, care and a committed roll set quality.
4. Cure for 48 hours to add up to 12 quality points, or mint immediately.
5. Sell to another player (4% take) or into the Dispensary bid.
6. Someone burns 400 Flower into a Strain Card, equips it in the vault, and their
   share of the settlement rewards goes up.

Every fee in that loop lands in `RevenueRouter`, which splits it 50% to stakers,
28% to the Dispensary budget, 12% liquidity, 8% operations, 2% reserve.

---

## Invariants, and where they are proven

| ID | Property | Test |
| --- | --- | --- |
| INV-1 | Rewards distributed never exceed rewards received | `protocol.test.js`, `invariants.test.js` |
| INV-2 | Vault HESOYAM balance always covers staked principal | `protocol.test.js`, `invariants.test.js` |
| INV-3 | Total supply is constant, no mint path exists | `protocol.test.js`, `invariants.test.js` |
| INV-4 | `emergencyWithdraw` is never pausable and always returns principal | `protocol.test.js` |
| INV-6 | Router holds no approval on the vault and cannot pull from it | by construction, no such function |
| INV-7 | Conversions are rate limited and TWAP guarded | `protocol.test.js` |
| INV-9 | Dispensary spend never exceeds Dispensary funding | `market.test.js`, `invariants.test.js` |
| INV-10 | No asset mints without a fee in the same transaction | `game.test.js` |
| INV-11 | No guaranteed floor price for Flower | `market.test.js` |
| INV-12 | Burned Flower is gone, cards cannot be un-crafted | `game.test.js` |
| INV-13 | Card weight is capped at 1.42x per wallet | `invariants.test.js` |

`invariants.test.js` also runs a 60-step randomized action sequence and re-checks
INV-1, INV-2, INV-3, INV-9, INV-13, reward solvency, the weight formula and
`totalWeight` consistency after every single step.

---

## Not built yet, deliberately

These are Phase 05 items from the blueprint. They are absent rather than stubbed,
because a half-built economic mechanic is worse than a missing one.

- **Tokenized equity rail.** Rewards settle in a 6-decimal settlement token today.
  The equity distribution needs a permissioned ERC-3643 asset and a redemption gate
  that checks an identity registry, which needs the supplier contract to exist first.
- **Bench rental and labor contracts.** Both need a delegation role with spend caps.
- **Co-op grow rooms**, breeding, dispensary licences, cosmetics, seasons.
- **Frontend.** The 3D grow room already exists as a separate prototype.
- **Timelock and multisig ownership.** Contracts deploy owner-controlled; transferring
  to a 48-hour timelock is a deployment step, not a code change.

---

## Calibration notes, read before mainnet

**Sweep cooldown must be at least the auction duration.** `RevenueRouter.sweep`
calls `Dispensary.fundEpoch`, which restarts the descending auction at its 115%
ceiling. With a 6-hour cooldown and a 24-hour auction the bid would never reach the
floor. `scripts/deploy.js` sets the cooldown to 24 hours for this reason.

**Randomness is priced, not perfect.** The grow event schedule is fixed at planting
from the player's commit hash mixed with the previous block hash. A player can read
their own schedule, which is intended, because responding to a known pest window is skill.
Rerolling means abandoning the grow and buying another seed, so grinding costs money
rather than being free. Card crafting, where the value per roll is much higher, uses
the hash of a block that did not exist at request time, and finalization is
permissionless so nobody can sit on a roll they dislike. Both sit behind seams that
Chainlink VRF replaces without touching game logic.

**Every number in `StrainRegistry` and the fee setters is a guess** until testnet
players push real volume through the ledger. They are all settable.

**`evmVersion` is pinned to `paris`.** Arbitrum Orbit chains have historically lagged
on PUSH0 and MCOPY, which is also why OpenZeppelin is pinned to 5.0.2. Confirm the
target chain's ArbOS version before bumping either.

---

## Layout

```
contracts/
  interfaces/IHesoyam.sol      shared seams: swap adapter, reward sink, asset surfaces
  token/                      HesoyamToken, Flower, StrainCard, GrowBench
  core/                       RevenueRouter, StakingVault
  game/                       StrainRegistry, GrowGame, CardCrafter
  market/                     Marketplace, Dispensary
  mocks/                      MockUSDC, MockSwapAdapter
test/
  fixture.js                  deploys and wires the whole system
  protocol.test.js            token, router, staking
  game.test.js                bench, grow loop, crafting
  market.test.js              marketplace, dispensary auction
  invariants.test.js          randomized property tests
scripts/deploy.js             ordered deployment, tax enabled last
```
