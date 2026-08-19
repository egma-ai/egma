import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  seedGraderLibrary,
  seedPlatformSettings,
} from "@egma/db";
import type { FastifyInstance } from "fastify";
import type { Fetch as RetellFetch } from "@egma/retell";

import { loadConfig, type Config } from "../../src/config.ts";
import type { Email, EmailSender } from "../../src/auth/email.ts";
import type { RateLimit } from "../../src/http/rate-limit.ts";
import { buildApi, type ServerOptions } from "../../src/server.ts";
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

/**
 * The judge a test deployment has, unless the test says it has none.
 *
 * The key is nonsense and never reaches a provider: nothing in these tests asks
 * a model anything, and the one door to a plaintext judge key opens only for
 * egma's own grading engine.
 */
const THE_TEST_DEPLOYMENTS_JUDGE = {
  provider: "openai",
  model: "gpt-4o-mini",
  key: "sk-test-deployment-judge",
} as const;

export type TestApiOptions = {
  readonly singleOrganization?: boolean;
  /**
   * The judge this deployment gives a project that has configured none, as
   * `egma self-host setup` supplies one.
   *
   * **A deployment has one unless a test says otherwise**, and that default
   * moved when runs began requiring a judge. Every project is created holding
   * the predefined expected-behaviors copy, which judges by asking a model, so
   * a run planned in a project with no judge is refused before anything is
   * dialed — which would make every test that starts a run fail on a
   * configuration nobody in it is writing about. A real self-hosted deployment
   * is set up with one key that covers the persona's brain, its voice and the
   * default judge, so the configured deployment is the ordinary one and this
   * default says so.
   *
   * Pass `null` for a deployment that configured none. That is the state a
   * project lands in `needs_setup` from, and it is what the run door's refusal
   * is proved against. The refusal is about the plan rather than the project:
   * a project that deleted every grader asking a model starts its runs with no
   * judge at all, which `run-planning.test.ts` in the data-access package
   * proves.
   */
  readonly defaultJudge?: Config["defaultJudge"] | null;
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
   * Somewhere to keep the log lines, for a test whose claim is about what is
   * not in them. Off by default: the suite runs silent, and a file that does
   * not read the log has no reason to collect one.
   */
  readonly logTo?: { write(line: string): void };
  /** Provider-read seam for Retell discovery and legacy dispatch checks. */
  readonly retellFetch?: RetellFetch;
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
      await options.emailSendCompletesOn?.();
    },
  };

  const config = testConfig({
    databaseUrl: database.url,
    ...(traceStore === undefined ? {} : { clickhouseUrl: traceStore.url }),
    singleOrganization: options.singleOrganization ?? false,
    trustProxy: options.trustProxy ?? false,
    ...(options.blob === undefined ? {} : { blob: options.blob }),
    ...(options.defaultJudge === null
      ? {}
      : { defaultJudge: options.defaultJudge ?? THE_TEST_DEPLOYMENTS_JUDGE }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });

  // Through the deployment's own seeding door rather than written straight
  // into the table: what a test then reads back has been sealed and hinted the
  // way the product seals and hints it, and a suite that inserted rows itself
  // would be proving something about rows nothing produces.
  if (options.platformSettings !== undefined) {
    await seedPlatformSettings(options.platformSettings);
  }

  // egma's own graders, unconditionally — no option and no default, because
  // there is none in a real deployment either: the library is written from
  // egma's catalog on every boot, before the first request, with nothing for an
  // operator to configure. A test instance whose shelf were empty would be a
  // shape no egma is ever in.
  await seedGraderLibrary();

  const { app, identity } = buildApi({
    config,
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
    // The production sweep's loop is never wanted in a route test: a suite that
    // wants one drives `runProductionSweep` itself, where it can say when a
    // tick happens instead of waiting for one.
    productionSweepIntervalMilliseconds: 60 * 60_000,
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
