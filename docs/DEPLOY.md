# Deployment runbook

The order matters. Several steps are irreversible, and two of them are one-way
switches that cannot be undone by anyone, including you.

Read the whole thing before running the first command.

---

## Before you spend anything

| | Check | Why |
|---|---|---|
| 1 | `npm run contracts:test` passes | The baseline. Do not deploy a red suite. |
| 2 | `npm run contracts:coverage` passes its floors | Catches an untested branch before it costs money. |
| 3 | `npm run flywheel` passes on a local chain | Proves the economics end to end, not just that it compiles. |
| 4 | You have read `docs/SECURITY.md` and closed anything critical or high | |
| 5 | The target chain's ArbOS version supports the `paris` EVM target | The build is pinned to `paris` and OpenZeppelin to exactly 5.0.2 for this reason. Bump both together or neither. |
| 6 | You have a timelock or multisig address ready | Step 9 hands it everything. Do not deploy without knowing where ownership lands. |

---

## 1. Make a deployer

```bash
npm run wallet:new
```

Writes a fresh key to `.env` and the mnemonic to `.env.wallet-backup`. Neither is
printed to the terminal and both are gitignored. Back the mnemonic up offline,
then delete `.env.wallet-backup`.

This is a hot key. It exists to sign a deploy and nothing else. Fund it with what
the deploy costs plus a margin, never with treasury money.

> On Windows the file permission bits are advisory. The key is protected by your
> user account and by `.gitignore`, not by the file mode. If this machine is
> shared, generate the key somewhere else.

## 2. Point at a network

Fill in `.env`:

```
TARGET_RPC=https://...
TARGET_CHAIN_ID=...
```

`arbitrumSepolia` is already configured and needs no RPC unless you want your own.

## 3. Pre-flight

```bash
npm run wallet:check -- --network arbitrumSepolia
```

Prints the chain id it actually reached, the deployer address, its balance, live
gas price, and what the deploy will cost. It refuses to say READY until the
balance covers a padded estimate.

Deploy to a testnet first. Every time. There is no exception to this.

## 4. Deploy

```bash
npm run deploy -w @hesoyam/contracts -- --network arbitrumSepolia
```

Deploys 14 contracts in dependency order, wires the roles, and writes
`packages/contracts/deployments/<network>.json` including the start block the
indexer needs. The start block is captured **before** the first deployment, so a
cold reindex cannot miss a deploy event.

Commit the deployments file. It is not a secret and the SDK is generated from it.

## 5. Generate the SDK and reindex

```bash
npm run sdk:generate
npm run indexer:verify
```

`indexer:verify` replays from the start block and asserts the derived tables
agree with the event mirror, including INV-1.

## 6. The things the deploy script deliberately does not do

It prints these at the end because each one needs a human decision:

- Point the Pons v2 token tax at the RevenueRouter address
- `router.setSwapAdapter(<real AMM route>)`. Until this is set, revenue
  accumulates in HESOYAM and cannot be swapped or split. That is the safe
  default.
- Seed Dispensary reference prices with `setReferenceAdmin(tier, price)`
- Mint the Plot collection, or leave it unminted until launch

## 7. Verify the source

```bash
npx hardhat verify --network <net> <address> <constructor args>
```

Do this for every contract. An unverified contract on a public chain is
indistinguishable from a rug to anyone reading it.

## 8. The one-way switch

```solidity
hesoyam.enableTax()
```

**This cannot be undone.** Once the tax is on it can never be turned off or
changed, by anyone, forever. That is deliberate and it is the point. Confirm
before you call it:

- `setTaxRecipients` points at the right creator treasury and the right router
- Every protocol contract is on the exemption list. Check the list against
  `scripts/deploy.js`. A contract that is missed will lose 5 percent on every
  internal transfer, and `Plot.site` is the only one written to survive that.

## 9. Hand over ownership

Every contract is `Ownable2Step`. Transfer each one to the timelock or multisig,
then have that address accept.

```
HesoyamToken, Flower, StrainCard, GrowBench, Plot,
RevenueRouter, StakingVault, StrainRegistry, GrowGame,
CardCrafter, Marketplace, Dispensary
```

Two-step means a typo cannot orphan a contract. Do not skip the accept.

After this, the deployer key has no powers left. Sweep any dust off it and stop
using it.

## 10. Point the client at it

```
NEXT_PUBLIC_TARGET_CHAIN_ID=
NEXT_PUBLIC_TARGET_RPC=
NEXT_PUBLIC_TARGET_CHAIN_NAME=
NEXT_PUBLIC_SITE_URL=
```

Then `npm run web:build`.

> Never run `npm run web:build` while `npm run web:dev` is running. They share
> `.next` and the build will delete the dev server's chunks, leaving pages that
> return 200 with every asset 404.

---

## Rollback

There is none. Contracts are immutable and `enableTax` is permanent.

What you can do:

- Before ownership transfer: deploy a corrected set and point the client at the
  new addresses. The old ones become inert as long as nothing funded them.
- After ownership transfer: whatever the timelock allows, on the timelock's
  delay.
- `StakingVault.emergencyWithdraw` is deliberately not pausable, so players can
  always exit their principal regardless of what else is broken.

Which is the real reason step 3 says deploy to a testnet first.
