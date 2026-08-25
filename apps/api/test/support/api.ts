import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  reconcileGraderCatalog,
  seedPersonaLibrary,
  seedPlatformSettings,
} from "@egma/db";
import type { FastifyInstance } from "fastify";
import type { Fetch as RetellFetch } from "@egma/retell";
import type { ProviderCredentialSource } from "@egma/provider-credentials";

import { loadConfig, type Config } from "../../src/config.ts";
import type { Email, EmailSender } from "../../src/auth/email.ts";
import type { RateLimit } from "../../src/http/rate-limit.ts";
import { buildApi, type ServerOptions } from "../../src/server.ts";
import type { Identity } from "../../src/auth/better-auth.ts";
import type { IngestionStore } from "../../src/ingestion/object-store.ts";
import { drainPendingEvidence } from "./ingestion.ts";
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
  /**
   * Turn every pending object into rows, the way the deployment does.
   *
   * The door answers on object-store durability and stops there, so a suite
   * whose claim is about what a reader sees calls this between posting and
   * reading. It answers how many objects the pass drained. On an instance that
   * drains on its own, that count is whatever this pass happened to find — the
   * evidence is what to assert on, not the number.
   */
  drainEvidence(): Promise<number>;
  close(): Promise<void>;
};

export type TestApiOptions = {
  readonly singleOrganization?: boolean;
  /** Which deployment surface owns carrier-route writes. */
  readonly carrierSettingsSource?: Config["carrierSettingsSource"];
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
  /**
   * Something the fake transport waits on before its `send` finishes — for the
   * one test whose claim is that **nothing waits for it**. A real transport
   * takes a quarter of a second to reach an SMTP server, and a fake one that
   * returns the instant it is called cannot tell a flow that waits for delivery
   * from one that does not.
   *
   * The message is recorded the moment it is handed over, before the wait, so
   * every other test reads `mail` exactly as it did before. It is asked for
   * once per message, so a test can arm it after the messages it is not about.
   */
  readonly emailSendCompletesOn?: () => Promise<void> | undefined;
  /** Use the server's no-SMTP sender instead of this helper's captured sender. */
  readonly defaultEmailSender?: boolean;
  /** A budget small enough to reach, for the tests about reaching it. */
  readonly rateLimit?: RateLimit;
  /** A sweep cadence short enough to observe, for the tests about the sweep. */
  readonly orphanSweepIntervalMilliseconds?: number;
  /** Where Retell answers. A test stands a Retell-shaped server on loopback. */
  readonly retellReach?: ServerOptions["retellReach"];
  /** The origin the API believes it is reached at, so registration can be seen. */
  readonly baseUrl?: string;
  /**
   * Whether this API needs a trace store of its own. Off by default: creating
   * and migrating a ClickHouse database costs a second, and only the files
   * about ingest have anything to put in one.
   */
  readonly traceStore?: boolean;
  /**
   * The ingestion bucket this instance accepts evidence into, from
   * `startObjectStorage`. Absent leaves the instance with nowhere to make
   * evidence durable, which is what an unconfigured deployment is: the door
   * answers `503` and nothing is staged.
   */
  readonly ingestStore?: IngestionStore;
  /**
   * How long the oldest staged record waits for company before its segment
   * seals. Short here, because a suite posting thirty documents would otherwise
   * spend fifteen seconds waiting out the deployment's own half-second — the
   * timer's *behaviour* is proved where it is the claim.
   */
  readonly ingestionFlushMilliseconds?: number;
  /**
   * How long a request waits for object-store durability before it is answered
   * retryably. Short here for the suites whose claim *is* the bound, so that
   * proving it costs a second rather than the deployment's ten.
   */
  readonly ingestionRequestTimeoutMilliseconds?: number;
  /**
   * What the local log will hold before it refuses. Tiny here for the one suite
   * whose claim is the refusal, so that reaching a bound costs one request
   * rather than half a gigabyte.
   */
  readonly ingestionLogMaxBytes?: number;
  /**
   * How many staged records the local log will hold before it refuses. Zero is
   * a log that is full before anything is staged, which is how the readiness
   * suite reaches the refusal without writing half a gigabyte.
   */
  readonly ingestionLogMaxRecords?: number;
  /**
   * Which halves of ingestion this instance serves. `all` by default, which is
   * what every shipped deployment runs.
   */
  readonly role?: Config["ingestion"]["role"];
  /**
   * Where the local log lives, for the one case that needs two instances to
   * share one: a stop and a start over staged evidence that outlived the
   * process. A directory named here belongs to the caller and is left where it
   * is on close.
   */
  readonly ingestionLogDirectory?: string;
  /**
   * Whether this instance runs the standing drainer. Off by default, so that a
   * suite can look at a sealed segment before anything drains it — the state a
   * deployment passes through in about the time one upload takes.
   *
   * On, the instance behaves as a deployment does: a durable segment is drained
   * without anybody asking. `drainEvidence` then waits for a pass that started
   * after the call, which is what a suite needs instead of a sleep.
   */
  readonly drainsPendingEvidence?: boolean;
  /**
   * Somewhere to keep the log lines, for a test whose claim is about what is
   * not in them. Off by default: the suite runs silent, and a file that does
   * not read the log has no reason to collect one.
   */
  readonly logTo?: { write(line: string): void };
  /** Provider-read seam for Retell discovery and legacy dispatch checks. */
  readonly retellFetch?: RetellFetch;
  /** Current model-provider keys for claim and grader boundary tests. */
  readonly providerCredentials?: ProviderCredentialSource;
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
      EGMA_OPENAI_API_KEY: "openai-key-held-by-this-test-suite",
      EGMA_DEEPGRAM_API_KEY: "deepgram-key-held-by-this-test-suite",
      EGMA_CARTESIA_API_KEY: "cartesia-key-held-by-this-test-suite",
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
      await options.emailSendCompletesOn?.();
    },
  };

  // One directory per instance, on the same terms as the database: a local log
  // is a durable record, and two instances sharing one would each recover the
  // other's staged evidence on the way up.
  const ingestionLogDirectory =
    options.ingestStore === undefined
      ? undefined
      : (options.ingestionLogDirectory ??
        mkdtempSync(path.join(tmpdir(), `egma-ingestion-${label}-`)));

  const base = testConfig({
    databaseUrl: database.url,
    ...(traceStore === undefined ? {} : { clickhouseUrl: traceStore.url }),
    singleOrganization: options.singleOrganization ?? false,
    carrierSettingsSource: options.carrierSettingsSource ?? "platform",
    trustProxy: options.trustProxy ?? false,
    ...(options.blob === undefined ? {} : { blob: options.blob }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.providerCredentials === undefined
      ? {}
      : { providerCredentials: options.providerCredentials }),
  });
  const config: Config =
    options.ingestStore === undefined || ingestionLogDirectory === undefined
      ? base
      : {
          ...base,
          ingestion: {
            ...base.ingestion,
            store: options.ingestStore,
            logDirectory: ingestionLogDirectory,
            flushMilliseconds: options.ingestionFlushMilliseconds ?? 20,
            ...(options.ingestionRequestTimeoutMilliseconds === undefined
              ? {}
              : {
                  requestTimeoutMilliseconds:
                    options.ingestionRequestTimeoutMilliseconds,
                }),
            ...(options.ingestionLogMaxBytes === undefined
              ? {}
              : { logMaxBytes: options.ingestionLogMaxBytes }),
            ...(options.ingestionLogMaxRecords === undefined
              ? {}
              : { logMaxRecords: options.ingestionLogMaxRecords }),
            ...(options.role === undefined ? {} : { role: options.role }),
          },
        };

  // Through the deployment's own seeding door rather than written straight
  // into the table: what a test then reads back has been sealed and hinted the
  // way the product seals and hints it, and a suite that inserted rows itself
  // would be proving something about rows nothing produces.
  if (options.platformSettings !== undefined) {
    await seedPlatformSettings(options.platformSettings);
  }

  // The two fixed-id catalogs the real entry point writes before a project can
  // be created. A new project points directly at the Egma-provided persona, and
  // its project grader points at the predefined catalog, so skipping either
  // would put this instance in a state no deployment serves requests from.
  await seedPersonaLibrary();
  await reconcileGraderCatalog();

  const { app, identity, drainer } = buildApi({
    config,
    drainsPendingEvidence: options.drainsPendingEvidence ?? false,
    ...(options.defaultEmailSender === true ? {} : { emailSender }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    ...(options.logTo === undefined ? {} : { logTo: options.logTo }),
    ...(options.orphanSweepIntervalMilliseconds === undefined
      ? {}
      : {
          orphanSweepIntervalMilliseconds:
            options.orphanSweepIntervalMilliseconds,
        }),
    ...(options.retellFetch === undefined
      ? {}
      : { retellFetch: options.retellFetch }),
    ...(options.retellReach === undefined
      ? {}
      : { retellReach: options.retellReach }),
    // Retell production ingestion is not needed in a route test. Its focused
    // tests drive one ingestion turn directly and choose when that turn runs.
    retellProductionIngestionIntervalMilliseconds: 60 * 60_000,
  });
  await app.ready();

  return {
    app,
    identity,
    config,
    database,
    traceStore,
    mail,
    async drainEvidence() {
      if (options.ingestStore === undefined) return 0;
      // The instance's own drainer where it has one, so a suite that proves the
      // standing behaviour is waiting on the same object it is asserting about.
      const standing = drainer();
      if (standing !== undefined) return standing.drainNow();
      return drainPendingEvidence(options.ingestStore);
    },
    async close() {
      await app.close();
      await disconnect();
      await database.drop();
      if (
        ingestionLogDirectory !== undefined &&
        options.ingestionLogDirectory === undefined
      ) {
        rmSync(ingestionLogDirectory, { recursive: true, force: true });
      }
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
