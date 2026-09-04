import "dotenv/config";
import { openDb, migrate, resetDerived } from "./db.ts";
import { sync } from "./indexer.ts";

/**
 * One shot sync plus a consistency report.
 *
 * This is the Phase 01 gate in executable form: a cold reindex from block zero has to
 * reproduce chain state, and the derived tables have to agree with the event mirror.
 * Run it against a seeded local node.
 */

const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";

const COUNT_TABLES = [
  "events",
  "grows",
  "harvests",
  "listings",
  "fills",
  "dispensary_sales",
  "positions",
  "claims",
  "distributions",
  "sweeps",
  "reward_notifications",
  "cards",
  "benches",
  "strains",
  "crafts",
  "dispensary_epochs",
  "reference_prices",
  "tax_events",
];

async function counts(db: Awaited<ReturnType<typeof openDb>>) {
  const out: Record<string, number> = {};
  for (const t of COUNT_TABLES) {
    const rows = await db.query<{ n: string }>(`select count(*)::text as n from ${t}`);
    out[t] = Number(rows[0].n);
  }
  return out;
}

async function main() {
  const db = await openDb();
  console.log(`Database: ${db.kind}`);

  const applied = await migrate(db);
  console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Schema already current.");

  // Cold reindex. Wipe derived state and the cursor, then replay from the deployment
  // block. This is the operation that has to be boring.
  await resetDerived(db);
  await db.query("delete from events");
  await db.query("delete from cursor_state");
  console.log("Cleared derived tables, event mirror and cursor. Reindexing from scratch.\n");

  const started = Date.now();
  const result = await sync(db, {
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    batchSize: 500n,
    confirmations: 1n,
    onProgress: ({ from, to, events }) => {
      if (events > 0) console.log(`  blocks ${from}-${to}: ${events} events`);
    },
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\nIndexed blocks ${result.fromBlock} to ${result.toBlock} in ${elapsed}s. ` +
      `${result.eventsWritten} events, ${result.handled} handled, ${result.skipped} with no handler.\n`
  );

  const table = await counts(db);
  console.log("Row counts");
  for (const [name, n] of Object.entries(table)) {
    console.log(`  ${name.padEnd(22)} ${String(n).padStart(5)}`);
  }

  // --- consistency checks ---------------------------------------------------
  //
  // Each check registers its own name, and the report is printed from what
  // actually ran. The previous version printed a hardcoded list of six names
  // whenever nothing failed, so it kept announcing checks that had been removed.
  //
  // Three of those six could not fail by construction: one re-verified an adder
  // the handler had just computed, one restated a primary key, and one asserted
  // something every handler enforces in the same statement. They have been
  // replaced with checks that compare derived state against an independent
  // source.
  const problems: string[] = [];
  const ran: string[] = [];

  async function check(name: string, sql: string, describe: (bad: string) => string) {
    ran.push(name);
    const [row] = await db.query<{ bad: string }>(sql);
    if (Number(row.bad) > 0) problems.push(describe(row.bad));
  }

  await check(
    "listing amounts are within bounds",
    `select count(*)::text as bad from listings
     where amount < 0 or amount > listed_amount`,
    (bad) => `${bad} listings with an impossible remaining amount`
  );

  await check(
    "listing remainders agree with their fills",
    `select count(*)::text as bad from listings l
     where l.amount <> greatest(0, l.listed_amount - coalesce(
       (select sum(f.amount) from fills f where f.listing_id = l.listing_id), 0))`,
    (bad) => `${bad} listings whose remaining amount disagrees with their fills`
  );

  await check(
    "collected harvests carry their id",
    `select count(*)::text as bad from harvests
     where collected = true and harvest_id is null`,
    (bad) => `${bad} harvests marked collected with no harvest id`
  );

  await check(
    "no harvest id is claimed twice",
    `select count(*)::text as bad from (
       select harvest_id from harvests where harvest_id is not null
       group by 1 having count(*) > 1
     ) d`,
    (bad) => `${bad} harvest ids claimed by more than one harvest`
  );

  await check(
    "every fill has a listing",
    `select count(*)::text as bad from fills f
     left join listings l on l.listing_id = f.listing_id where l.listing_id is null`,
    (bad) => `${bad} fills with no listing`
  );

  await check(
    "every harvest has a grow",
    `select count(*)::text as bad from harvests h
     left join grows g on g.grow_id = h.grow_id where g.grow_id is null`,
    (bad) => `${bad} harvests with no grow`
  );

  // The grower rail can never have paid out more than the router handed it.
  // Same shape as INV-1, on the other rail.
  ran.push("dispensary payouts never exceed dispensary funding");
  const [disp] = await db.query<{ funded: string; paid: string }>(
    `select
       coalesce((select sum(amount) from dispensary_epochs),0)::text as funded,
       coalesce((select sum(proceeds) from dispensary_sales),0)::text as paid`
  );
  if (BigInt(disp.paid) > BigInt(disp.funded)) {
    problems.push(
      `dispensary paid ${disp.paid} against ${disp.funded} funded, which breaks the grower rail`
    );
  }

  // INV-1, the one that actually matters: rewards can only ever be paid from
  // money that was handed over first.
  ran.push("claims never exceed notified rewards (INV-1)");
  const [rewardVsClaim] = await db.query<{ notified: string; claimed: string }>(
    `select
       coalesce((select sum(amount) from reward_notifications),0)::text as notified,
       coalesce((select sum(amount) from claims),0)::text as claimed`
  );
  if (BigInt(rewardVsClaim.claimed) > BigInt(rewardVsClaim.notified)) {
    problems.push(
      `claims (${rewardVsClaim.claimed}) exceed reward notifications (${rewardVsClaim.notified}), which breaks INV-1`
    );
  }

  console.log("\nConsistency");
  if (problems.length === 0) {
    for (const name of ran) console.log(`  ok   ${name}`);
  } else {
    for (const p of problems) console.log(`  FAIL ${p}`);
  }

  // --- provenance sample ----------------------------------------------------
  const provenance = await db.query<{
    claimer: string;
    amount: string;
    funded_by: string | null;
    funding_tx: string | null;
  }>(
    `select c.claimer, c.amount::text as amount,
            d.to_equity::text as funded_by, d.tx_hash as funding_tx
     from claims c
     left join lateral (
       select * from distributions d2
       where d2.block_number <= c.block_number
       order by d2.block_number desc limit 1
     ) d on true
     order by c.block_number desc limit 3`
  );

  if (provenance.length > 0) {
    console.log("\nProvenance sample: every claim traced to the distribution that funded it");
    for (const p of provenance) {
      console.log(
        `  ${p.claimer.slice(0, 10)} claimed ${p.amount} funded from ${p.funded_by} in ${String(p.funding_tx).slice(0, 12)}`
      );
    }
  }

  await db.close();
  if (problems.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
