import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, "..", "migrations");

export type Row = Record<string, unknown>;

export interface Db {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs a script that may contain several statements. Never takes parameters. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: "pglite" | "postgres";
}

/**
 * Two backends behind one interface.
 *
 * PGlite is a real Postgres compiled to WASM. It runs with no server, which means the
 * indexer is testable end to end on a laptop and in CI, and the migrations that run
 * against it are the same file that runs against Supabase.
 *
 * Set DATABASE_URL to use a server. Use the direct connection on port 5432, not the
 * transaction pooler on 6543: the pooler does not keep prepared statements or session
 * advisory locks, and reindexing fails in a way that is hard to read.
 */
export async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;

  if (url) {
    if (url.includes(":6543")) {
      throw new Error(
        "DATABASE_URL points at the transaction pooler (port 6543). Use the direct " +
          "connection on 5432 for the indexer, or migrations and reindexing will fail."
      );
    }
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: url, max: 4 });
    return {
      kind: "postgres",
      async query<T = Row>(sql: string, params: unknown[] = []) {
        const res = await pool.query(sql, params);
        return res.rows as T[];
      },
      async exec(sql: string) {
        await pool.query(sql);
      },
      async close() {
        await pool.end();
      },
    };
  }

  const dir = process.env.PGLITE_DIR || path.join(HERE, "..", "data", "pglite");
  mkdirSync(dir, { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = await PGlite.create(dir);
  return {
    kind: "pglite",
    async query<T = Row>(sql: string, params: unknown[] = []) {
      const res = await lite.query(sql, params);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await lite.exec(sql);
    },
    async close() {
      await lite.close();
    },
  };
}

/** Applies every .sql file in migrations/, in name order, exactly once. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const applied = new Set(
    (await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name)
  );

  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const run: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    await db.exec(sql);
    await db.query("insert into schema_migrations (name) values ($1)", [file]);
    run.push(file);
  }
  return run;
}

/** Drops every derived table so `events` can be replayed from scratch. */
export async function resetDerived(db: Db): Promise<void> {
  const tables = [
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
  for (const t of tables) {
    await db.query(`truncate table ${t}`);
  }
}
