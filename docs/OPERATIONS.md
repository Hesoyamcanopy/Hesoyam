# Running it

Four services. Only one of them is optional.

| Service | What it does | If it stops |
|---|---|---|
| **Keeper** | Reveals the beacon, one round at a time | **Planted grows stop resolving.** Harvests revert rather than resolving wrongly. Nothing is lost, but the game is paused. |
| **Web** | The Next.js app and the 3D room | Nobody can reach the game. Contracts still work from any other client. |
| **Indexer** | Mirrors chain events into Postgres | Dashboards and history go stale. No value is affected. |
| **Presence** | Positions of other players in the room | The room goes single player. Everything else is unaffected. |

The keeper is the one that matters. Treat it like a database, not a cron job.

---

## 1. Keeper, the required one

### Generate the chain, once, offline

```bash
export KEEPER_SECRET="<at least 32 characters of real entropy>"
export CHAIN_LENGTH=100000
npm run keeper:head
```

Prints only the head. The secret is never printed, because a head is safe to
paste into a terminal and a secret is not.

100,000 links at one reveal every five minutes lasts about **347 days**.

### Commit it

```bash
BEACON_HEAD=0x... REVEALER=<keeper address> \
  npm run beacon:setup -- --network robinhood
```

> `commitChain` is **one shot**. A wrong head permanently bricks the beacon and
> the game with it. The setup script refuses to run against an already committed
> beacon rather than reverting in your face, and the keeper verifies the whole
> chain before it will start.

### Run it

```bash
export RPC_URL=https://rpc.mainnet.chain.robinhood.com
export BEACON_ADDRESS=0x...
export KEEPER_KEY=0x...          # its own key, owning nothing else
export KEEPER_SECRET="..."       # identical to the one above
export CHAIN_LENGTH=100000
export REVEAL_INTERVAL_MS=300000
npm run keeper
```

At boot it rebuilds the chain, verifies it, and checks the link at the current
round equals the head on chain. A mismatched secret fails immediately with both
values printed, instead of reverting every five minutes forever.

### Running it for nothing, on testnet

A hosted keeper is a process somebody pays to keep alive. If there is no budget
yet, run it as a scheduled job instead:

```bash
npm run once -w @hesoyam/keeper   # reveals one round, exits 0
```

`.github/workflows/keeper.yml` does exactly that every five minutes, which is
free on a public repository. Set these five repository secrets and enable the
workflow: `KEEPER_RPC_URL`, `KEEPER_BEACON_ADDRESS`, `KEEPER_KEY`,
`KEEPER_SECRET`, `KEEPER_CHAIN_LENGTH`.

What you give up is punctuality, not correctness. GitHub's scheduler is best
effort, often ten to thirty minutes late, and it drops runs when the repository
is busy. The contract already tolerates that: a grow waits for its round, and a
harvest against an unrevealed round reverts rather than resolving wrongly.
Harvests are late, nothing is lost.

**Do not do this on mainnet.** There, a late reveal is a player facing outage.

### Monitor it

`GET :8788/health` returns 200 while healthy and **503** when not:

```json
{ "ok": true, "round": 412, "remaining": 99587, "stalled": false, "lastError": null }
```

Alert on: non-200, `stalled: true`, or `remaining` under 5000. The keeper warns
in its log below 1000 links, which at five minute intervals is about three days
of warning before it runs dry.

### Rotating the chain

A beacon cannot be re-committed. When links run low, deploy a fresh
`RandomBeacon`, commit a new head from a **new** secret, then point the game at
it with `game.setBeacon(newBeacon)`. Grows already bound to a round on the old
beacon resolve against the old one, so keep the old keeper running until they
have all matured.

---

## 2. Web

```bash
npm run web:build
npm run web:start          # or host apps/web/.next anywhere that runs Node
```

Environment:

```
NEXT_PUBLIC_ROBINHOOD_RPC=          # an Alchemy URL, not the public endpoint
NEXT_PUBLIC_DEFAULT_CHAIN_ID=4663
NEXT_PUBLIC_REALTIME_URL=wss://...  # the presence server
NEXT_PUBLIC_SITE_URL=
CSP_ENFORCE=1                       # flip this on once wallet paths look clean
```

> Never run `web:build` while `web:dev` is running. They share `.next`, and the
> build deletes the dev server's chunks, leaving pages that return 200 with
> every asset 404.

## 3. Indexer

```bash
export DATABASE_URL=postgres://...   # a session pooler, NOT port 6543
export RPC_URL=https://...
npm run indexer:dev
```

It refuses the transaction pooler by port, because a pooler breaks the
transactional batching that keeps replays idempotent. Raise `CONFIRMATIONS`
above the chain's reorg depth before pointing it at mainnet.

`npm run indexer:verify` does a cold reindex and runs eight consistency checks.
Run it after any deploy.

## 4. Presence

```bash
export REALTIME_PORT=8787
export SHARD_CAPACITY=48    # a room fills to this, then opens another shard
export INTEREST_RADIUS=14   # metres; you are only told about people this close
export TICK_MS=100          # ten a second, the client interpolates between
npm run realtime
```

Holds positions and nothing else. No key, no authority over any value. Put it
behind TLS so browsers on an HTTPS page can open a `wss://` socket to it.

### What it actually carries

Measured on one process, with every player crowded into the same few square
metres so interest culling does nothing, which is the worst case:

| Concurrent | Shards | Dropped | Per player |
|---|---|---|---|
| 1,000 | 21 | 0 | 8.7 KB/s |
| 2,000 | 42 | 0 | 13.3 KB/s |

One process holds two thousand. Ten thousand is five processes, which works
without any coordination between them because a shard never spans two servers:
put a load balancer in front and let each instance own the shards it created.

Two things to know before tuning it:

- **Connection rate, not connection count, is the limit.** Two thousand players
  arriving over twenty seconds is fine. The same two thousand arriving in one
  second loses about a third of them to the accept backlog. This only matters if
  you push a link to a large audience at a fixed time.
- **`SHARD_CAPACITY` is quadratic.** Per tick work inside a shard grows with the
  square of this number. Doubling it to make the world feel busier costs four
  times as much, so change it in small steps and watch the process.

---

## The order on launch day

1. Deploy contracts, note the addresses
2. `beacon:setup` with the head, and set the revealer
3. **Start the keeper. Confirm `/health` is 200 and the round is advancing.**
4. Point the Pons token tax at the router
5. Set the swap adapter, seed Dispensary reference prices
6. Start the indexer, run `indexer:verify`
7. Start presence, then the web app
8. Open the Plot mint
9. Transfer every contract to the timelock or multisig

Step 3 before step 8. Opening the game to players while the keeper is down means
they can plant and then find nothing resolves.
