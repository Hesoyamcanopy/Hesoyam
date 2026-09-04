# HESOYAM CANOPY

An on-chain grow economy. Plant, cure and sell cannabis on chain. Every fee the protocol
collects buys tokenized stock for stakers and funds the bid that buys harvests from
growers. Nothing is minted to pay a reward, and no deposit ever funds anyone else's
payout.

**Phase plan and progress: [docs/ROADMAP.md](docs/ROADMAP.md)**

---

## Where things stand

| Piece | State |
|---|---|
| Contracts | Done. 12 contracts, 91 tests, 98.6% statements and 70% branches, randomized invariant suite. |
| Marketing site | Done. Next.js, builds static. |
| Monorepo and tooling | Phase 00, done. CI, lint, coverage floor, ordered deploy with recorded addresses. |
| Indexer, API, auth | Phase 01, mostly done. Indexer verified against a live chain. SIWE written, not yet run. |
| Playable dApp | Phase 02, done. Eight routes, the full loop, parity checked against the chain. |
| Gasless play | Phase 03, fallback path only. Bundler and paymaster are chain gated. |
| 3D world | Phases 04 and 05, not started. |

---

## Layout

```
hesoyam/
  apps/
    web/                 Next.js client. Landing page plus the dApp under /app.
    indexer/             Chain to Postgres. 18 tables, 30 event handlers, cold reindex.
  packages/
    contracts/           Hardhat project. 12 contracts, 91 tests. See its own README.
    sdk/                 Generated ABIs and addresses. Never hand copy one.
    game-core/           Grow maths mirrored from Solidity, parity tested against a node.
  supabase/
    migrations/          Row level security, applied with the Supabase CLI.
    functions/siwe/      Wallet sign in, minting a Supabase JWT.
  docs/
    ROADMAP.md           The eight phases, with checkboxes.
```

Planned packages, added as their phases begin:

```
  apps/realtime/         Colyseus server, Phase 05
  packages/ui/           Design system extracted from the web app
```

---

## Commands

Everything runs from the repo root.

```bash
npm install                # installs all workspaces

npm run contracts:test     # 91 tests
npm run contracts:lint     # solhint at zero warnings
npm run contracts:coverage # coverage plus an enforced floor
npm run web:dev            # landing page at localhost:3000
npm run typecheck          # web, sdk and indexer
```

Against a running local chain, in this order:

```bash
npm run chain              # hardhat node on 8545
npm run deploy:local       # writes deployments/localhost.json
npm run seed               # plays a full economic cycle
npm run flywheel           # reads the whole flywheel back and checks it
npm run sdk:generate       # ABIs and addresses from the deployment
npm run indexer:verify     # cold reindex, then consistency checks
```

`npm run flywheel` is the one to run if you only run one. It traces fees in,
the split, both rails paying out, and asserts the anti-Ponzi invariants against
live contract state rather than against anything a test remembered.

The full local pipeline, which is also what the CI integration job runs:

```bash
npm run chain              # terminal 1: a local node
npm run deploy:local       # writes packages/contracts/deployments/localhost.json
npm run seed               # a complete economic cycle on chain
npm run sdk:generate       # ABIs and addresses from that deployment
npm run indexer:verify     # cold reindex from block zero, then consistency checks
```

---

## Two rules that hold everywhere

**Nothing but a contract can move value.** The indexer, the API and the realtime server
are projections and presence. None of them holds a key. If the whole backend were
compromised, an attacker could make avatars teleport and could not take one unit of
Flower from anyone.

**Rewards can only ever be revenue that arrived.** There is no function that moves staked
principal into the reward vault. It is not restricted or guarded, it does not exist. The
invariant tests in `packages/contracts/test/invariants.test.js` re-check this after every
step of a randomized action sequence.

---

## Pinned versions, and why

`@openzeppelin/contracts` is pinned to exactly `5.0.2`, with an `overrides` entry at the
repo root as well as the package. Later versions use `MCOPY`, which needs the Cancun EVM.
The Solidity target is pinned to `paris` because Arbitrum Orbit chains have historically
lagged on `PUSH0` and `MCOPY`.

Confirm the target chain's ArbOS version before bumping either one. They move together.
