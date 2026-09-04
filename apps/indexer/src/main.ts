import "dotenv/config";
import { openDb, migrate } from "./db.ts";
import { sync } from "./indexer.ts";

/**
 * Long running indexer.
 *
 * Polls rather than subscribes, because a dropped websocket that silently stops
 * delivering logs is far worse than a poll that is a few seconds late. The cursor is
 * written after every batch, so a crash resumes rather than restarts.
 */

const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const POLL_MS = Number(process.env.POLL_MS || 4000);
const CONFIRMATIONS = BigInt(process.env.CONFIRMATIONS || 2);

let stopping = false;

async function main() {
  const db = await openDb();
  const applied = await migrate(db);
  console.log(
    JSON.stringify({
      level: "info",
      scope: "indexer",
      message: "started",
      chainId: CHAIN_ID,
      database: db.kind,
      migrations: applied,
    })
  );

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ level: "info", scope: "indexer", message: "stopping", signal }));
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  while (!stopping) {
    try {
      const result = await sync(db, {
        chainId: CHAIN_ID,
        rpcUrl: RPC_URL,
        confirmations: CONFIRMATIONS,
      });
      if (result.eventsWritten > 0) {
        console.log(
          JSON.stringify({
            level: "info",
            scope: "indexer",
            message: "synced",
            fromBlock: String(result.fromBlock),
            toBlock: String(result.toBlock),
            events: result.eventsWritten,
            handled: result.handled,
            unhandled: result.skipped,
          })
        );
      }
    } catch (error) {
      // A bad batch must not kill the process. The cursor was not advanced, so the
      // next tick retries the same range.
      console.error(
        JSON.stringify({
          level: "error",
          scope: "indexer",
          message: "sync failed, will retry",
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
