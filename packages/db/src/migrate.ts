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
 * One migration reached public main with a PostgreSQL 18-only call before its
 * first hosted application. Production was still at 0039, so 0040 had to be
 * corrected in place for Supabase PostgreSQL 17.6. A developer or self-hoster
 * may still have applied the original file on PostgreSQL 18 during that short
 * window. Accept exactly that recorded hash and promote it to exactly the
 * corrected hash; every other changed migration remains a hard refusal.
 */
export const MIGRATION_HASH_CORRECTIONS = [
  {
    name: "0040_test_suites.sql",
    previouslyRecordedHash:
      "a9f4f6dc7dee1c24d1390d8d28e52af0aaf34e00d434db05cdeb899a5b063945",
    correctedHash:
      "8f4d60aebecda8ca1c6894ab9d8ee09adff1a5d86a111a42488d6390c33313b6",
  },
] as const;

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
  const migrationsByName = new Map(
    migrations.map((migration) => [migration.name, migration] as const),
  );
  const alreadyApplied = new Map<string, string>();

  for (const row of recorded.rows) {
    let hash = row.hash;
    const migration = migrationsByName.get(row.name);
    const correction = MIGRATION_HASH_CORRECTIONS.find(
      (candidate) =>
        candidate.name === row.name &&
        candidate.previouslyRecordedHash === row.hash &&
        candidate.correctedHash === migration?.hash,
    );

    if (correction !== undefined) {
      const promoted = await client.query(
        `update ${BOOKKEEPING_TABLE}
            set hash = $1
          where name = $2 and hash = $3`,
        [
          correction.correctedHash,
          correction.name,
          correction.previouslyRecordedHash,
        ],
      );
      if (promoted.rowCount !== 1) {
        throw new Error(
          `could not reconcile the recorded hash for ${correction.name}`,
        );
      }
      hash = correction.correctedHash;
    }

    alreadyApplied.set(row.name, hash);
  }

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
