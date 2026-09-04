import { createPublicClient, http, parseEventLogs, type PublicClient, type Log } from "viem";
import type { Db } from "./db.ts";
import { watchedContracts, startBlock, type Watched } from "./contracts.ts";
import { HANDLERS, type DecodedEvent } from "./handlers.ts";

export type SyncOptions = {
  chainId: number;
  rpcUrl: string;
  /** Blocks per getLogs call. Lower it if the RPC complains about range size. */
  batchSize?: bigint;
  /** Blocks left unindexed at the head, to ride out shallow reorgs. */
  confirmations?: bigint;
  onProgress?: (info: { from: bigint; to: bigint; events: number }) => void;
};

export type SyncResult = {
  fromBlock: bigint;
  toBlock: bigint;
  eventsWritten: number;
  handled: number;
  skipped: number;
};

/** JSON cannot hold a bigint, so args are stored with numeric values as strings. */
function serialiseArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function makeClient(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl) });
}

async function readCursor(db: Db, chainId: number, fallback: bigint): Promise<bigint> {
  const rows = await db.query<{ last_block: string }>("select last_block from cursor_state where id = 1");
  if (rows.length === 0) {
    await db.query("insert into cursor_state (id, last_block, chain_id) values (1, $1, $2)", [
      Number(fallback),
      chainId,
    ]);
    return fallback;
  }
  return BigInt(rows[0].last_block);
}

async function writeCursor(db: Db, block: bigint): Promise<void> {
  await db.query("update cursor_state set last_block = $1, updated_at = now() where id = 1", [
    Number(block),
  ]);
}

/**
 * Pulls logs from `from` to `to` for every watched contract, writes them to the event
 * mirror, then applies the derived state handlers.
 *
 * Ordering matters. Logs are sorted by block then log index before handlers run, so a
 * fill that follows a listing in the same block is applied in that order.
 */
async function indexRange(
  db: Db,
  client: PublicClient,
  contracts: Watched[],
  from: bigint,
  to: bigint
): Promise<{ written: number; handled: number; skipped: number }> {
  const decoded: DecodedEvent[] = [];

  for (const c of contracts) {
    const logs = (await client.getLogs({ address: c.address, fromBlock: from, toBlock: to })) as Log[];
    if (logs.length === 0) continue;

    const parsed = parseEventLogs({ abi: c.abi, logs, strict: false });
    for (const p of parsed) {
      decoded.push({
        contract: c.name,
        eventName: p.eventName as string,
        address: c.address.toLowerCase(),
        blockNumber: p.blockNumber as bigint,
        blockTime: null,
        txHash: p.transactionHash as string,
        logIndex: Number(p.logIndex),
        args: (p.args ?? {}) as Record<string, unknown>,
      });
    }
  }

  if (decoded.length === 0) return { written: 0, handled: 0, skipped: 0 };

  decoded.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1
  );

  // One timestamp lookup per distinct block rather than per log.
  const times = new Map<bigint, Date>();
  for (const blockNumber of new Set(decoded.map((d) => d.blockNumber))) {
    const block = await client.getBlock({ blockNumber });
    times.set(blockNumber, new Date(Number(block.timestamp) * 1000));
  }
  for (const d of decoded) d.blockTime = times.get(d.blockNumber) ?? null;

  let written = 0;
  let handled = 0;
  let skipped = 0;

  // One transaction for the whole batch. Without it a throw partway through left
  // the earlier events applied, and because the cursor had not advanced the next
  // tick replayed them on top of themselves.
  await db.exec("begin");
  try {
  for (const d of decoded) {
    await db.query(
      `insert into events
         (block_number, block_time, tx_hash, log_index, address, contract, event_name, args)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (tx_hash, log_index) do nothing`,
      [
        Number(d.blockNumber),
        d.blockTime,
        d.txHash,
        d.logIndex,
        d.address,
        d.contract,
        d.eventName,
        serialiseArgs(d.args),
      ]
    );
    written++;

    const handler = HANDLERS[`${d.contract}.${d.eventName}`];
    if (handler) {
      await handler(db, d);
      handled++;
    } else {
      skipped++;
    }
  }
  await db.exec("commit");
  } catch (err) {
    await db.exec("rollback");
    throw err;
  }

  return { written, handled, skipped };
}

/** Catches the database up to the chain head, minus the confirmation buffer. */
export async function sync(db: Db, opts: SyncOptions): Promise<SyncResult> {
  const client = makeClient(opts.rpcUrl);
  const contracts = watchedContracts(opts.chainId);
  if (contracts.length === 0) {
    throw new Error(`No watched contracts for chain ${opts.chainId}. Generate the SDK first.`);
  }

  const batchSize = opts.batchSize ?? 2000n;
  const confirmations = opts.confirmations ?? 2n;

  const head = await client.getBlockNumber();
  const safeHead = head > confirmations ? head - confirmations : 0n;

  const deployedAt = startBlock(opts.chainId);
  const cursor = await readCursor(db, opts.chainId, deployedAt);
  const fromBlock = cursor === deployedAt ? deployedAt : cursor + 1n;

  let eventsWritten = 0;
  let handled = 0;
  let skipped = 0;

  if (fromBlock > safeHead) {
    return { fromBlock, toBlock: safeHead, eventsWritten: 0, handled: 0, skipped: 0 };
  }

  for (let from = fromBlock; from <= safeHead; from += batchSize) {
    const to = from + batchSize - 1n > safeHead ? safeHead : from + batchSize - 1n;
    const res = await indexRange(db, client, contracts, from, to);
    eventsWritten += res.written;
    handled += res.handled;
    skipped += res.skipped;
    await writeCursor(db, to);
    opts.onProgress?.({ from, to, events: res.written });
  }

  return { fromBlock, toBlock: safeHead, eventsWritten, handled, skipped };
}
