/**
 * The beacon revealer.
 *
 * Advances the RandomBeacon one round at a time. Without this running, players
 * can plant but nothing ever resolves: harvests revert with BeaconNotReady by
 * design, because treating an unrevealed round as "no events fired" is exactly
 * the exploit the beacon exists to close.
 *
 * So this is not an optional background job. It is a required service, and it
 * should be monitored like one.
 *
 * It does three things and nothing else: read the round, reveal the next link,
 * expose health. It holds no user funds, signs nothing but reveals, and its key
 * should be separate from the key that owns the contracts.
 */
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createServer } from "node:http";
import { buildChain, verifyChain } from "./chain.ts";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const BEACON = process.env.BEACON_ADDRESS as `0x${string}` | undefined;
const KEY = process.env.KEEPER_KEY as Hex | undefined;
const SECRET = process.env.KEEPER_SECRET;
const CHAIN_LENGTH = Number(process.env.CHAIN_LENGTH ?? 100_000);
const INTERVAL_MS = Number(process.env.REVEAL_INTERVAL_MS ?? 5 * 60_000);
// Railway, and most PaaS hosts, assign a port at deploy time and route their
// public domain and health check to whatever the app actually listens on. A
// service that ignores PORT and listens on a fixed one instead is unreachable
// there even though it starts up clean, which looks exactly like a healthy
// deploy until the first health check fails. PORT wins when the host sets it;
// KEEPER_PORT is the explicit local override, defaulting to 8788.
const PORT = Number(process.env.PORT ?? process.env.KEEPER_PORT ?? 8788);
/** Reveal one round and exit, for cron style hosting. Also set by --once. */
const ONCE = process.env.KEEPER_ONCE === "1" || process.argv.includes("--once");

const ABI = [
  { type: "function", name: "round", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "head", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" },
  { type: "function", name: "isStalled", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "reveal", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
] as const;

type Health = {
  ok: boolean;
  round: number;
  chainLength: number;
  remaining: number;
  stalled: boolean;
  lastRevealAt: string | null;
  lastError: string | null;
};

const health: Health = {
  ok: false,
  round: 0,
  chainLength: CHAIN_LENGTH,
  remaining: CHAIN_LENGTH,
  stalled: true,
  lastRevealAt: null,
  lastError: null,
};

/**
 * Stops with a readable reason and a real exit code.
 *
 * This used to call process.exit() directly, which on Windows aborts libuv while
 * the RPC sockets are still open: the operator got a clear message followed by
 * "Assertion failed", and the exit code came back 3221226505 rather than 1. A
 * scheduled job checking exit codes could not tell a bad secret from a crash.
 * Throwing, and letting the process drain, gives both a clean log and a real 1.
 */
class Fatal extends Error {}

function fail(msg: string): never {
  throw new Fatal(msg);
}

async function main() {
  if (!BEACON) fail("BEACON_ADDRESS is not set.");
  if (!KEY) fail("KEEPER_KEY is not set. Use a key that owns nothing else.");
  if (!SECRET) fail("KEEPER_SECRET is not set.");
  if (SECRET.length < 32) fail("KEEPER_SECRET is too short. Use at least 32 characters of real entropy.");

  // Bound after the guards so the closures below see non-optional values.
  const beacon = BEACON;
  const secret = SECRET;

  console.log("Building the hash chain.");
  const chain = buildChain(secret, CHAIN_LENGTH);

  // Verify before touching the network. A head that does not match the chain
  // bricks the beacon permanently, because commitChain can only be called once.
  if (!verifyChain(chain)) fail("The chain does not verify. Refusing to start.");
  console.log(`Chain of ${CHAIN_LENGTH} links. Head is ${chain[0]}`);

  const account = privateKeyToAccount(KEY);
  const pub = createPublicClient({ transport: http(RPC) });
  const wallet = createWalletClient({ account, transport: http(RPC) });

  const chainId = await pub.getChainId();
  console.log(`Connected to chain ${chainId} as ${account.address}`);

  const onChainHead = (await pub.readContract({
    address: beacon,
    abi: ABI,
    functionName: "head",
  })) as Hex;

  if (onChainHead === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    fail(
      `The beacon has no chain committed yet.\n` +
        `Call commitChain(${chain[0]}) from the owner, then setRevealer(${account.address}, true).`
    );
  }

  const startRound = Number(
    (await pub.readContract({ address: beacon, abi: ABI, functionName: "round" })) as bigint
  );

  // The on chain head must equal the link one step past the current round,
  // otherwise this secret does not belong to this beacon and every reveal will
  // revert. Better to say so now than to fail forever in a loop.
  if (chain[startRound] !== onChainHead) {
    fail(
      `This KEEPER_SECRET does not match the deployed beacon.\n` +
        `  on chain head: ${onChainHead}\n` +
        `  from secret:   ${chain[startRound]}\n` +
        `The beacon is at round ${startRound}. Check the secret and CHAIN_LENGTH.`
    );
  }
  console.log(`Secret matches the deployed head at round ${startRound}.`);

  async function tick() {
    try {
      const round = Number(
        (await pub.readContract({ address: beacon, abi: ABI, functionName: "round" })) as bigint
      );
      health.round = round;
      health.remaining = CHAIN_LENGTH - 1 - round;
      health.stalled = (await pub.readContract({
        address: beacon,
        abi: ABI,
        functionName: "isStalled",
      })) as boolean;

      if (health.remaining <= 0) {
        health.ok = false;
        health.lastError = "chain exhausted";
        console.error("The chain is exhausted. Deploy a new beacon and repoint the game.");
        return;
      }

      // Warn while there is still time to do something about it.
      if (health.remaining < 1000) {
        console.warn(`Only ${health.remaining} links left. Plan a rotation.`);
      }

      const next = chain[round + 1];
      const hash = await wallet.writeContract({
        address: beacon,
        abi: ABI,
        functionName: "reveal",
        args: [next],
        chain: null,
      });
      await pub.waitForTransactionReceipt({ hash });

      health.ok = true;
      health.lastError = null;
      health.lastRevealAt = new Date().toISOString();
      // Move the counters past the reveal that just landed. They were set from
      // the pre reveal read above, so leaving them alone reports a round behind
      // forever, both in the log line and on /health.
      health.round = round + 1;
      health.remaining = CHAIN_LENGTH - 1 - (round + 1);
      console.log(`round ${round + 1} revealed  ${hash}`);
    } catch (err) {
      health.ok = false;
      health.lastError = err instanceof Error ? err.message : String(err);
      // Never exit on a transient RPC failure. The next tick retries, and the
      // contract tolerates a late reveal far better than it tolerates none.
      console.error(`reveal failed: ${health.lastError}`);
    }
  }

  /**
   * One shot mode, for running as a scheduled job rather than a service.
   *
   * A hosted process that sleeps between reveals costs money every month. A
   * cron job that wakes, reveals once and exits can run on a free tier, which
   * is the difference between launching and not launching for somebody who has
   * no budget yet.
   *
   * The trade is punctuality, not correctness. A scheduler that fires late just
   * reveals late, and the contract already tolerates that: a grow bound to a
   * future round waits for it, and a harvest against an unrevealed round
   * reverts rather than resolving wrongly. Nothing is lost, harvests are only
   * delayed. Do not use this on mainnet, where lateness is a player facing
   * outage rather than an inconvenience.
   */
  if (ONCE) {
    await tick();
    if (!health.ok) {
      fail(health.lastError ?? "the reveal did not succeed");
    }
    console.log(`Revealed once. Round ${health.round}, ${health.remaining} links left.`);
    return;
  }

  createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(health.ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(health, null, 2));
      return;
    }
    res.writeHead(404).end();
  }).listen(PORT, () => console.log(`Health on http://127.0.0.1:${PORT}/health`));

  await tick();
  setInterval(() => void tick(), INTERVAL_MS);
  console.log(`Revealing every ${INTERVAL_MS / 1000}s.`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
