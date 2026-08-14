import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  seedPlatformSettings,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import { loadConfig, type Config } from "../../src/config.ts";
import type { Email, EmailSender } from "../../src/auth/email.ts";
import type { RateLimit } from "../../src/http/rate-limit.ts";
import { buildApi } from "../../src/server.ts";
import type { Identity } from "../../src/auth/better-auth.ts";
import {
  createMigratedDatabase,
  TEST_ENCRYPTION_KEY,
  type MigratedDatabase,
} from "../../../../packages/db/test/support/database.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "../../../../packages/db/test/support/clickhouse.ts";

/**
 * A running API with a database of its own.
 *
 * These are the flows that never pass through the data-access module's own
 * seam — signing up, the provider's HTTP surface, the adapter under it — so
 * they are driven over HTTP, in process, with no port bound. The database is
 * real, because every guarantee underneath is a Postgres one.
 */

export type TestApi = {
  readonly app: FastifyInstance;
  /** The provider the API was built on, so the seam can be driven directly. */
  readonly identity: Identity;
  readonly config: Config;
  /** Raw SQL, for checking what actually landed rather than asking the API. */
  readonly database: MigratedDatabase;
  /**
   * The trace store, present only for a test that asked for one. Reading it is
   * deliberately raw: the read functions over `spans` are a later ticket's, and
   * what these tests need to know is what the door actually filed.
   */
  readonly traceStore: MigratedTraceStore | undefined;
  /** Everything the email transport was handed, in order. */
  readonly mail: readonly Email[];
  close(): Promise<void>;
};

export type TestApiOptions = {
  readonly singleOrganization?: boolean;
  /**
   * The judge this deployment gives a project that has configured none, as
   * `egma self-host phone setup` supplies one. Absent by default, because most
   * tests are not about grading configuration at all.
   */
  readonly defaultJudge?: Config["defaultJudge"];
  /**
   * Settings this instance starts holding, seeded exactly as a deployment's own
   * environment seeds them — through `seedPlatformSettings`, sealed, into the
   * real table.
   *
   * Absent by default, and absent is the honest default: a deployment nobody
   * has configured is what every egma is on its first morning, and a suite that
   * quietly started every instance phone-ready would never have noticed the run
   * door letting a phone run through.
   *
   * This replaced a `phone` block handed straight to the configuration. The
   * carrier is one of the platform's own settings now, so a test that wants a
   * platform able to dial has to put the settings where the platform keeps
   * them — which is the same path the product takes and no longer a shortcut
   * around it.
   */
  readonly platformSettings?: Config["platformSettings"];
  /**
   * The object store recordings are resolved against. Absent by default, and
   * absent is the honest default: an egma nobody has pointed at a store is
   * every egma before somebody sets one up, and a suite that quietly configured
   * one everywhere would never notice the route failing to say which variable
   * is missing.
   */
  readonly blob?: Config["blob"];
  readonly trustProxy?: boolean;
  /** Whether the transport claims a message actually reaches anybody. */
  readonly emailDelivers?: boolean;
  /** A budget small enough to reach, for the tests about reaching it. */
  readonly rateLimit?: RateLimit;
  /** A sweep cadence short enough to observe, for the tests about the sweep. */
  readonly orphanSweepIntervalMilliseconds?: number;
  /**
   * Whether this API needs a trace store of its own. Off by default: creating
   * and migrating a ClickHouse database costs a second, and only the files
   * about ingest have anything to put in one.
   */
  readonly traceStore?: boolean;
  /**
   * Somewhere to keep the log lines, for a test whose claim is about what is
   * not in them. Off by default: the suite runs silent, and a file that does
   * not read the log has no reason to collect one.
   */
  readonly logTo?: { write(line: string): void };
};

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      DATABASE_URL: "postgres://unused/unused",
      CLICKHOUSE_URL: "http://unused/unused",
      EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
      EGMA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      EGMA_SIMULATOR_SERVICE_TOKEN: "egma_st_held-by-this-test-suite-alone",
      EGMA_BASE_URL: "http://localhost:3101",
    }),
    ...overrides,
  };
}

export async function createApi(
  label: string,
  options: TestApiOptions = {},
): Promise<TestApi> {
  const database = await createMigratedDatabase(label);
  connect({
    databaseUrl: database.url,
    maxConnections: 4,
    encryptionKey: TEST_ENCRYPTION_KEY,
  });

  const traceStore =
    options.traceStore === true
      ? await createMigratedTraceStore(label)
      : undefined;
  if (traceStore !== undefined) {
    connectClickHouse({ clickhouseUrl: traceStore.url, maxOpenConnections: 4 });
  }

  const mail: Email[] = [];
  const emailSender: EmailSender = {
    delivers: options.emailDelivers ?? false,
    async send(email) {
      mail.push(email);
    },
  };

  const config = testConfig({
    databaseUrl: database.url,
    ...(traceStore === undefined ? {} : { clickhouseUrl: traceStore.url }),
    singleOrganization: options.singleOrganization ?? false,
    trustProxy: options.trustProxy ?? false,
    ...(options.blob === undefined ? {} : { blob: options.blob }),
    ...(options.defaultJudge === undefined
      ? {}
      : { defaultJudge: options.defaultJudge }),
  });

  // Through the deployment's own seeding door rather than written straight
  // into the table: what a test then reads back has been sealed and hinted the
  // way the product seals and hints it, and a suite that inserted rows itself
  // would be proving something about rows nothing produces.
  if (options.platformSettings !== undefined) {
    await seedPlatformSettings(options.platformSettings);
  }

  const { app, identity } = buildApi({
    config,
    emailSender,
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    ...(options.logTo === undefined ? {} : { logTo: options.logTo }),
    ...(options.orphanSweepIntervalMilliseconds === undefined
      ? {}
      : {
          orphanSweepIntervalMilliseconds:
            options.orphanSweepIntervalMilliseconds,
        }),
  });
  await app.ready();

  return {
    app,
    identity,
    config,
    database,
    traceStore,
    mail,
    async close() {
      await app.close();
      await disconnect();
      await database.drop();
      if (traceStore !== undefined) {
        await disconnectClickHouse();
        await traceStore.drop();
      }
    },
  };
}

/** The cookie header a browser would send back, given what it was just set. */
export function cookiesFrom(setCookie: string | string[] | undefined): string {
  const all = setCookie === undefined ? [] : [setCookie].flat();
  return all.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}
