import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import pg from "pg";

/**
 * Migrations apply on boot from numbered plain SQL files. There is no separate
 * migration container and no step for a self-hoster to forget.
 */

export const MIGRATIONS_DIRECTORY = path.join(
  import.meta.dirname,
  "..",
  "migrations",
);

/**
 * Boot takes a Postgres advisory lock around the migration run, so two
 * instances starting at the same moment cannot both apply. The second waits,
 * then finds nothing to do. The key is `egma` read as ASCII, and 1 for the
 * migration runner.
 */
export const MIGRATION_ADVISORY_LOCK = {
  namespace: 0x65676d61,
  id: 1,
} as const;

const { namespace: LOCK_NAMESPACE, id: LOCK_ID } = MIGRATION_ADVISORY_LOCK;

const BOOKKEEPING_SCHEMA = "egma_meta";
const BOOKKEEPING_TABLE = `${BOOKKEEPING_SCHEMA}.migration`;

/**
 * A managed pre-production store may adopt this exact baseline out of band
 * after an operator verifies its old ledger and logical schema. Its recorded
 * hash is the deliberate adoption marker; the filename alone is not proof.
 */
const CURRENT_BASELINE_MIGRATION = "0000_baseline.sql";

export type Migration = {
  readonly name: string;
  readonly sql: string;
  readonly hash: string;
};

export type MigrationResult = {
  /** Applied by this call. Empty on every boot after the first. */
  readonly applied: readonly string[];
  /** Already recorded when this call looked. */
  readonly alreadyApplied: readonly string[];
};

/** The numbered plain SQL files, in the order they must be applied. */
export async function readMigrations(
  directory: string = MIGRATIONS_DIRECTORY,
): Promise<Migration[]> {
  const entries = await readdir(directory);
  const names = entries.filter((name) => name.endsWith(".sql")).sort();

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(directory, name), "utf8");
      return {
        name,
        sql,
        hash: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

/**
 * The migrations not yet recorded, in order.
 *
 * Both stores' runners go through here, because the rule it enforces is the one
 * thing they must never disagree about: **an applied migration is immutable.** A
 * file that changed after it ran is refused rather than quietly skipped, and
 * corrections go in a new file. Written once so that the two runners cannot
 * drift into two answers.
 */
export function pendingMigrations(
  migrations: readonly Migration[],
  alreadyApplied: ReadonlyMap<string, string>,
): Migration[] {
  const knownNames = new Set(migrations.map((migration) => migration.name));
  const unsupported = [...alreadyApplied.keys()]
    .filter((name) => !knownNames.has(name))
    .sort();
  const pending: Migration[] = [];

  for (const migration of migrations) {
    const knownHash = alreadyApplied.get(migration.name);

    if (knownHash === undefined) {
      pending.push(migration);
      continue;
    }

    if (knownHash !== migration.hash) {
      throw new Error(
        `migration ${migration.name} has changed since it was applied; ` +
          `applied migrations are immutable, add a new file instead`,
      );
    }
  }

  // A verified database may adopt a squashed baseline out of band while its
  // old ledger rows remain for rollback. The exact baseline hash is the proof
  // that this was deliberate. Without it, an old store must stop before fresh
  // baseline DDL can run against tables that already exist.
  const baseline = migrations.find(
    (migration) => migration.name === CURRENT_BASELINE_MIGRATION,
  );
  const adoptedBaseline =
    baseline !== undefined &&
    alreadyApplied.get(baseline.name) === baseline.hash;
  if (unsupported.length > 0 && !adoptedBaseline) {
    throw new Error(
      `database records migrations that this build does not contain: ${unsupported.join(", ")}; ` +
        "recreate the database before running this build",
    );
  }

  return pending;
}

export async function runMigrations(
  databaseUrl: string,
  directory: string = MIGRATIONS_DIRECTORY,
): Promise<MigrationResult> {
  const migrations = await readMigrations(directory);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `select pg_advisory_lock(${LOCK_NAMESPACE}, ${LOCK_ID})`,
      );
      try {
        // Read the applied set only after the lock is held: an instance that
        // waited must see everything the instance ahead of it applied.
        return await apply(client, migrations);
      } finally {
        await client.query(
          `select pg_advisory_unlock(${LOCK_NAMESPACE}, ${LOCK_ID})`,
        );
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function apply(
  client: pg.PoolClient,
  migrations: readonly Migration[],
): Promise<MigrationResult> {
  await client.query(`create schema if not exists ${BOOKKEEPING_SCHEMA}`);
  await client.query(`
    create table if not exists ${BOOKKEEPING_TABLE} (
      name       text primary key,
      hash       text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const recorded = await client.query<{ name: string; hash: string }>(
    `select name, hash from ${BOOKKEEPING_TABLE}`,
  );
  const alreadyApplied = new Map(
    recorded.rows.map((row) => [row.name, row.hash] as const),
  );

  const applied: string[] = [];

  for (const migration of pendingMigrations(migrations, alreadyApplied)) {
    await client.query("begin");
    try {
      await client.query(migration.sql);
      await client.query(
        `insert into ${BOOKKEEPING_TABLE} (name, hash) values ($1, $2)`,
        [migration.name, migration.hash],
      );
      await client.query("commit");
    } catch (cause) {
      await client.query("rollback");
      throw new Error(`migration ${migration.name} failed`, { cause });
    }

    applied.push(migration.name);
  }

  return { applied, alreadyApplied: [...alreadyApplied.keys()] };
}
