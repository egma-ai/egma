/**
 * Compose resolves required variables before selecting services, even for
 * store-only commands and down. Supply placeholders for application values
 * that PostgreSQL and ClickHouse do not use. Exported environment values
 * override these placeholders; .env values do not.
 * Use this wrapper for test-store operations, not application startup.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The repository root, which is where the compose file lives. */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Non-secret placeholders for required application variables. Neither test
 * store reads these values; they are not valid deployment credentials.
 */
const NOT_READ_BY_EITHER_STORE = "unused-by-the-two-stores";

const BOOTSTRAP_PLACEHOLDERS: Record<string, string> = {
  EGMA_ENCRYPTION_KEY: NOT_READ_BY_EITHER_STORE,
  EGMA_AUTH_SECRET: NOT_READ_BY_EITHER_STORE,
  EGMA_SIMULATOR_SERVICE_TOKEN: `egma_st_${NOT_READ_BY_EITHER_STORE}`,
  EGMA_BASE_URL: "http://localhost:3101",
  EGMA_LIVEKIT_API_KEY: NOT_READ_BY_EITHER_STORE,
  EGMA_LIVEKIT_API_SECRET: NOT_READ_BY_EITHER_STORE,
  EGMA_S3_ACCESS_KEY_ID: NOT_READ_BY_EITHER_STORE,
  EGMA_S3_SECRET_ACCESS_KEY: NOT_READ_BY_EITHER_STORE,
  EGMA_S3_READ_ACCESS_KEY_ID: NOT_READ_BY_EITHER_STORE,
  EGMA_S3_READ_SECRET_ACCESS_KEY: NOT_READ_BY_EITHER_STORE,
};

/**
 * Run one `docker compose` subcommand at the repository root, and exit with
 * whatever it exited with.
 *
 * This never returns: a developer command is what it wraps, and a wrapper that
 * swallowed a non-zero exit would make `pnpm test` run against stores that
 * never came up.
 */
export function composeOrExit(args: readonly string[]): never {
  const ran = spawnSync("docker", ["compose", ...args], {
    cwd: ROOT,
    env: { ...BOOTSTRAP_PLACEHOLDERS, ...process.env },
    stdio: "inherit",
  });

  if (ran.error !== undefined) {
    console.error(
      `could not run docker compose: ${ran.error.message}\n\n` +
        "The test suite runs against a real Postgres and a real ClickHouse. " +
        "Install Docker with the compose plugin, or point TEST_DATABASE_URL and " +
        "TEST_CLICKHOUSE_URL at stores you already run.",
    );
    process.exit(1);
  }

  process.exit(ran.status ?? 1);
}
