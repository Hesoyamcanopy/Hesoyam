# Security review

Two independent reviews were run before launch: one over the Solidity, one over
the web app, indexer, auth and CI. Both were told to prefer silence over
manufactured findings, and both reported areas that were genuinely solid as well
as areas that were not.

**Status: every finding from both reviews is fixed, and each has a regression
test.** What remains is not a known bug: it is the operational work no code
change can substitute for, listed at the bottom.

---

## Fixed, with a regression test

Every one of these has a test in `packages/contracts/test/audit.test.js` that was
originally written to assert the *broken* behaviour. Each now asserts the fix, so
reintroducing the bug turns the suite red.

| | Severity | What was wrong | Fix |
|---|---|---|---|
| H-1 | High | `StakingVault` divided by total weight at 1e18 precision with a 6 decimal reward token, then discarded the remainder. Above ~1e26 total weight a whole distribution rounded to zero and was destroyed, permanently and silently, with no rescue path. | Precision raised to 1e30, and a distribution too small to move the accumulator is carried instead of zeroed. |
| H-2 | High | Tier 0 had `lockSeconds: 0`, so `unlockAt` equalled the stake time and the early exit penalty could never fire. With a permissionless `distribute()`, a flash loan could stake, trigger a distribution, claim and unstake in one block, taking the staker rail for free. | Tier 0 now carries a one hour minimum hold. A flash loan cannot hold the position, so it cannot avoid the 4 percent penalty, which exceeds any single reward. |
| H-3 | High | `fundEpoch` restarted the Dutch auction clock, and `distribute()` is permissionless and reads a live balance. Anyone could donate dust to the router to bounce the bid back to the 115 percent ceiling, so the auction never discovered a price. | The clock now restarts only when the budget is exhausted. A top up adds money without rewinding the price. |
| H-5 | High | `Plot.site()` took no price cap. A plot owner could watch the mempool, raise the day rate to the maximum, and charge a tenant 200x the quote against their open allowance. | `site()` takes `maxTotal` and reverts with `PriceMoved` if the price moved. |
| H-8 | High | `setGuards` had no bounds at all: an owner could set an unlimited sweep and a zero cooldown, then drain the router in one transaction. `addTier` had no multiplier ceiling. `Plot.protocolBps` could be set to 100 percent. | Hard bounds on all three: sweep ceiling, one hour minimum cooldown, 10 percent maximum deviation, 3x tier ceiling, 50 percent protocol cut ceiling. |
| M-2 | Medium | `site()` never checked bench ownership. Anyone could bind a stranger's bench to their own plot, locking it out for 90 days and recovering 70 percent of the rent from themselves. | The caller must own the bench, and it must exist. |
| M-3 | Medium | `fuse` took the higher of the two tiers, so a top tier plot cost four plots rather than the eight the economics assume. | Both plots must be the same tier. |
| WEB-1 | **Critical** | `plots/page.tsx` passed contract-supplied SVG to `dangerouslySetInnerHTML`. A hostile `tokenURI` executed script on our origin, and this origin holds every grow's commit reveal salt in `localStorage`. Four lines would have exfiltrated every salt, making every harvest on that wallet unclaimable. | The art is rendered through `img src="data:..."`, which is script inert. Confirmed by exhaustive search to have been the only HTML injection sink in shipped code. |
| WEB-4 | High | The indexer's `GrowGame.Collected` handler matched on grower alone, so a player curing two harvests had both marked collected by one event and both stamped with the same id and tier. The second harvest silently vanished. Any player could trigger it by accident. | Scoped to exactly one row. |
| WEB-9 | Medium | No CSP and no security headers of any kind, which is what turned WEB-1 from a nuisance into silent exfiltration. | CSP plus `nosniff`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy` and HSTS. Report-Only until the wallet paths have been observed; set `CSP_ENFORCE=1` to enforce. |
| Config | High | `dotenv` resolved relative to the contracts package rather than the repo root, so hardhat found no signer and every live deployment would have run with no account. | Path resolved explicitly. |

## Randomness, which was the last blocker

**H-4, M-1 and H-7 are fixed by `core/RandomBeacon.sol`.**

Every earlier version derived outcomes from values the player already knew when
they committed: their own salt, the previous block hash, the timestamp. Two
tests proved the consequence. One ground a commit until no pest event ever
fired, avoiding every treatment fee and the whole risk layer. One waited for a
favourable block and forced the maximum quality roll.

Chainlink VRF is the usual answer and it is **not deployed on Robinhood Chain**,
which was checked against Chainlink's own supported-networks list: nine chains,
no Orbit chains at all. So the fix had to work without an oracle.

The beacon is a hash chain. The operator hashes a secret N times offline and
publishes the final hash once, as `head`. Each round they reveal one step back
down the chain, and anyone verifies it by hashing forward.

Neither side can cheat. The operator cannot grind, because the chain was fixed
before any player committed and exactly one preimage is accepted for a given
head. A player cannot grind, because they bind to a round that has not been
revealed, so there is nothing to search against.

`commitChain` is one shot on purpose. If the owner could replace the head mid
flight they could pick a new chain after seeing what players committed to, which
is the whole attack again.

Both exploit tests now assert the fix instead:

- **F-7** plants, confirms `seedReady` is false and `seedFor` is zero, confirms
  `harvest` reverts `BeaconNotReady` rather than treating an absent seed as "no
  events fired", then reveals and confirms the schedule settles.
- **F-8** reads `previewOutcome` across 25 mined blocks and asserts the quality
  and units never move, then harvests and asserts the event matches the preview.

**The liveness cost is real and must be operated.** If the revealer stops,
rounds stop and planted grows cannot resolve. Harvests wait rather than
resolving wrongly, which is the safe failure, and `abandon` always frees a
bench. Run the revealer from a keeper on a timer, hold the operator key in a
multisig, and watch `isStalled()`.

## Checked and found solid

Worth recording, because it is the other half of an honest review.

- Reentrancy: `nonReentrant` on every state changing entry point that makes an
  external call, and checks-effects-interactions respected throughout. No path
  found.
- Fee on transfer: handled correctly everywhere except one place that fails
  closed. Contracts that take fees pass them straight through to the router and
  never hold a balance, and the two that do hold one measure the balance delta.
- `HesoyamToken`: fixed supply, no mint path, one way tax switch, correct split
  arithmetic.
- ERC-20 approvals in the client are exact amounts, never unlimited, at all four
  call sites.
- RLS covers all 19 mirror tables, select only, with the service role correctly
  kept out of the client. RLS is framed as a write boundary rather than a value
  boundary, which is the right model.
- No SQL injection is reachable: every query is parameterised, and the two
  interpolated statements draw only from hardcoded module level arrays.
- No committed secrets, and `.gitignore` covers the non-obvious cases.
- Of 25 dependency advisories, only `next` is reachable and should be upgraded.
  The rest are behind a webpack alias, browser-native APIs, or build-time only.

## What is left before mainnet

None of these are code defects. They are the things code cannot do for you.

1. **Fund the deployer** and deploy. Testnet 46630 first, then mainnet 4663.
2. **Commit the beacon chain and start the revealer.** Planting reverts without
   it. This is now a launch-blocking operational step, not a nice to have.
3. **Point the Pons token tax at the RevenueRouter** address from the deploy.
4. **Set a swap adapter**, seed Dispensary reference prices, open the Plot mint.
5. **Transfer every contract to a timelock or multisig.** The bounds added in
   this review cap a compromised owner's blast radius but do not delay it.
6. **A third party audit.** Neither review here replaces one, and both were run
   by the same author as the code.
