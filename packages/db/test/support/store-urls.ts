/**
 * Where the two stores are, for everything in the test support folder.
 *
 * Its own module, and deliberately importing nothing: the stale-database sweep
 * runs from `pnpm db:up`, before anything in this repository has been built, so
 * a module it reads these from must not pull in a package that has a `dist/`.
 */

export const MAINTENANCE_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://egma:egma@localhost:5433/egma";

export const MAINTENANCE_CLICKHOUSE_URL =
  process.env.TEST_CLICKHOUSE_URL ?? "http://egma:egma@localhost:8124/egma";

/**
 * What every test database in both stores is named, and what nothing else is.
 * The sweep drops exactly what matches, so a deployment database can never be
 * caught by it.
 */
export const TEST_DATABASE_PREFIX = "egma_test_";
