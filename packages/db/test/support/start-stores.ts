/**
 * Start the two stores the test suite needs, and nothing else.
 *
 * `docker compose up -d --wait postgres clickhouse` is the whole of the work.
 * This wrapper exists for one reason, and it is a property of Compose rather
 * than of egma: **Compose interpolates the entire file before it looks at which
 * services you named.** So a variable the api service requires has to resolve
 * even when the command starts neither the api service nor anything that reads
 * it, and a contributor who has never written a `.env` would meet
 * `required variable EGMA_ENCRYPTION_KEY is missing a value` on their way to
 * running the tests.
 *
 * That refusal is the point everywhere else. This deployment's own secrets have
 * no defaults any more — a default is a value every reader of a public
 * repository holds — so `docker compose up` refuses and names what is missing
 * rather than starting a platform sealed with a published key. See
 * `.env.example`, and the deployment test that holds the rule.
 *
 * But starting Postgres and ClickHouse is not starting the platform. Neither
 * container reads one of the values below: they read `POSTGRES_*` and
 * `CLICKHOUSE_*`, which keep their defaults precisely so that a checkout costs
 * a contributor no configuration at all. So the placeholders here satisfy the
 * interpolation and reach nothing — no container is created with one, and none
 * is a value anybody should ever hold.
 *
 * **They are placed under the real environment rather than over it**, so a
 * developer who exported a real one keeps it. A value in a `.env` file does
 * lose to these, and that is harmless for the same reason: the two stores read
 * none of them, and their own configuration — user, password, database, port —
 * is untouched, so this never recreates a container somebody else's worktree is
 * using.
 *
 * If this list ever falls behind the compose file, the symptom is loud and says
 * which variable: Compose refuses and names it.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The repository root, which is where the compose file lives. */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Every variable the deployment description requires, with a value that is
 * obviously not a credential.
 *
 * One string for all of them, because telling them apart would suggest one of
 * them is used. None is.
 */
const NOT_READ_BY_EITHER_STORE = "unused-by-pnpm-db-up";

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

const started = spawnSync(
  "docker",
  ["compose", "up", "-d", "--wait", "postgres", "clickhouse"],
  {
    cwd: ROOT,
    env: { ...BOOTSTRAP_PLACEHOLDERS, ...process.env },
    stdio: "inherit",
  },
);

if (started.error !== undefined) {
  console.error(
    `could not run docker compose: ${started.error.message}\n\n` +
      "The test suite runs against a real Postgres and a real ClickHouse. " +
      "Install Docker with the compose plugin, or point TEST_DATABASE_URL and " +
      "TEST_CLICKHOUSE_URL at stores you already run.",
  );
  process.exit(1);
}

process.exit(started.status ?? 1);
