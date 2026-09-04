# HESOYAM CANOPY roadmap

Eight phases from a finished set of contracts to a live 3D world. Effort is stated in
engineer-weeks because that number does not move with team size. Calendar time does.

Full reasoning behind each phase, including the architecture diagrams and the world
model comparison, lives in the **Hesoyam World Build** document. This file is the
tracking version of it.

**Total to mainnet: 59 engineer-weeks.** Solo is roughly 14 months, two engineers and a
part time artist is roughly 8 months, a team of four with an artist and a designer is
roughly 5 months.

---

## Status right now

| | Phase | Effort | State |
|---|---|---|---|
| | Contracts | done | 12 contracts, 91 tests passing, 98.6% statement coverage |
| | Marketing site | done | Pulled forward, sits outside the numbered phases |
| 00 | Foundations | 3 ew | **Done** |
| 01 | Data spine | 5 ew | **Mostly done**, 5 of 6 items |
| 02 | Playable dApp | 10 ew | **Done**, 6 of 6 items |
| 03 | Frictionless play | 6 ew | **Partly done**, 1 of 5 items |
| 04 | Grow room in 3D | 10 ew | Not started |
| 05 | Shared world | 10 ew | Not started |
| 06 | Depth and retention | 7 ew | Not started |
| 07 | Hardening and launch | 8 ew | Not started |
| 08 | Equity rail | 5 ew | Post launch, supplier gated |

---

## Phase 00: Foundations

**3 engineer-weeks. No player-visible output.**

Turn a contracts folder into a project several people can work in at once.

- [x] Monorepo with npm workspaces, contracts moved to `packages/contracts`
- [x] OpenZeppelin pinned exactly at both levels so the EVM target cannot silently break
- [x] Contract suite still green after the restructure, 91 tests
- [x] CI: lint, compile, test, coverage floor, web build, hygiene, and a deploy plus index integration job
- [x] Ordered deploy script writing `deployments/<network>.json` with a start block, verified end to end on a live node
- [x] Structured logger with redaction, a `captureError` seam, and error and not-found boundaries

**Gate:** a fresh machine can clone, install, compile, test and deploy to testnet with
one command each, and CI proves it.

---

## Phase 01: Data spine

**5 engineer-weeks. Still nothing to look at.**

Nothing can be built on a chain you cannot query. Unglamorous, and everything depends
on it. Supabase carries most of this, which is why the estimate came down from the
original plan.

- [x] 18 tables and 4 views: grows, harvests, listings, fills, positions, claims, distributions, sweeps, cards, benches, strains, crafts, dispensary epochs, reference prices, tax events
- [x] Cold reindex from block zero, confirmation buffer, cursor written per batch, 30 event handlers all idempotent
- [x] One database interface over PGlite locally and Postgres in production, refusing the transaction pooler by port
- [x] 24 policies across 22 tables, verified by applying the migration
- [~] SIWE Edge Function written, with server built messages and single use nonces consumed by conditional update. Not yet run, because it needs a Deno runtime and a Supabase project
- [x] Provenance query joining every claim to the distribution that funded it, exercised in the verification run

**Gate:** a cold reindex reproduces on-chain state exactly for twenty sampled accounts,
and every contract event has a home.

**Where it stands:** `npm run indexer:verify` deploys nothing and assumes a seeded
chain. Against one it replays 113 events from block zero in under a second, applies 31
of them to derived tables, and passes six consistency checks including INV-1. The
remaining work is a real Supabase project to point it at.

---

## Phase 02: The playable dApp

**10 engineer-weeks. The game becomes real.**

The whole economy playable in a browser with no 3D at all. This is the biggest single
phase and the most important one.

- [x] Wallet connect, network switching, `wallet_addEthereumChain` through wagmi switchChain
- [x] Full loop: buy a bench, plant, feed, treat, harvest, cure, collect
- [x] Marketplace, Dispensary, staking, cards
- [x] Treasury page and a live invariants panel reading from contracts
- [x] Transaction UX: pending states, decoded reverts, exact amount approvals
- [x] Landing page CTAs wired to real app routes

**Gate:** a tester who has never seen the code completes a full grow to sale cycle on
testnet without asking a developer anything.

**Where it stands:** eight static routes build clean. Every write path goes through one
`useTx` hook that turns custom errors into sentences, and `useAllowance` approves the
exact amount rather than an unlimited allowance. The client never shows a number the
chain would disagree with: `@hesoyam/game-core` mirrors the Solidity maths and
`packages/game-core/test/parity.test.ts` checks it against a live chain, currently 132
comparisons with zero failures. What is untested is the human half of the gate, which
needs a tester and a testnet rather than more code.

---

## Phase 03: Frictionless play

**6 engineer-weeks. The game stops feeling like a wallet.**

- [ ] Smart accounts with session keys scoped to game contracts, spend capped, time limited
- [ ] Paymaster sponsoring gas, funded from the operations allocation, capped per player per day
- [x] Plain wallet fallback that works if the chain has no bundler
- [ ] Notifications for feed windows, pest events, harvest ready, filled listings
- [ ] Presence, chat and a live event feed over Supabase Realtime

**Gate:** twenty consecutive actions on one signature. Then kill the realtime layer and
confirm every one of them still works.

**Blocker to resolve first:** confirm whether the target chain has bundler and paymaster
infrastructure. If not, this phase ships the fallback only.

**Where it stands:** the fallback is what the dApp runs on today, so the phase degrades
gracefully by construction. The other four items are gated on infrastructure this repo
cannot stand up on its own: a bundler and paymaster on the target chain, and a live
Supabase project for Realtime.

---

## Phase 04: The grow room in 3D

**10 engineer-weeks. Single player interior.**

- [ ] Interior template, character controller, camera, grow room lighting
- [ ] Plant model with five growth stages blended by elapsed time, driven only by indexer data
- [ ] Walk up interactions for feeding, treating and harvesting, each ending in a transaction
- [ ] Asset pipeline: GLTF with Draco, KTX2 textures, instancing, level of detail

**Budget:** under 150 draw calls, under 400k triangles in view, under 8 MB initial
download, 60 fps on a 2020 laptop, 30 fps on mid range mobile.

**Gate:** performance budget met on the reference devices, and killing the realtime
server still leaves the room rendering correctly from the API alone.

---

## Phase 05: The shared world

**10 engineer-weeks. Other people appear.**

Model A, zoned. Shared hub district plus instanced interiors, connected by doors rather
than a seamless streaming world. The comparison table for that decision is in the World
Build document.

- [ ] Zone server on Colyseus, sharding at sixty players, server authoritative positions
- [ ] Interest management so a crowded district does not broadcast everything to everyone
- [ ] Visiting rooms, tipping, emotes, proximity chat
- [ ] Co-op rooms with splits enforced on chain
- [ ] Market floor and Dispensary as physical places

**Gate:** sixty simulated clients in one shard hold a 20 Hz tick with server frame time
under 120 ms at the 95th percentile.

---

## Phase 06: Depth and retention

**7 engineer-weeks.**

- [ ] Twelve week seasons, leaderboards ranked on quality and fees paid rather than volume
- [ ] Cosmetics shop, room customisation, strain naming rights
- [ ] Labor contracts, capped delegation on chain
- [ ] Wash trade filtering in the leaderboard indexer

**Gate:** a full season opens, runs and rolls over on testnet without manual work.

---

## Phase 07: Hardening and launch

**8 engineer-weeks. Mainnet.**

- [ ] Contract audit remediation and a second review pass
- [ ] Penetration test on the API and realtime server
- [ ] Load test at ten times expected peak
- [ ] Closed beta, then recalibrate every economy number from telemetry
- [ ] Bug bounty live before mainnet
- [ ] Timelock takes ownership of every contract

**Gate:** all critical and high findings closed and re-reviewed, economy numbers set from
beta data rather than guesses, timelock owns everything.

---

## Phase 08: The equity rail

**5 engineer-weeks. Post launch, gated on the supplier existing.**

Held back on purpose. Rewards settle in a stable token until the regulated plumbing is
real.

- [ ] Redemption gate against a real identity registry
- [ ] Non-transferable claim units for unverified wallets
- [ ] Stable token settlement path as the alternative
- [ ] Verification status and purchase provenance in the client

**Gate:** one full test purchase settles end to end on mainnet before any player is shown
an equity balance.

---

## The scheduling decision that matters most

The game is fully playable at the end of Phase 02. Everything from Phase 04 onward is the
3D world. That means 3D can slip by months without stopping a launch.

If the calendar comes under pressure, ship the economy, prove people want it, and build
the world for players who already exist.
