import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  reconcileGraderCatalog,
  seedPersonaLibrary,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import { loadConfig, type Config } from "../../src/config.ts";
import type { IngestionStore } from "../../src/ingestion/object-store.ts";
import { buildApi, type ServerOptions } from "../../src/server.ts";
import {
  holdWebOutputLock,
  releaseAfter,
  THE_REAL_BROWSER_TEST,
  type WebOutputLock,
} from "../../../web/tools/output-lock.ts";
import {
  createMigratedDatabase,
  TEST_ENCRYPTION_KEY,
  type MigratedDatabase,
} from "../../../../packages/db/test/support/database.ts";
import {
  createEmptyTraceStore,
  createMigratedTraceStore,
  type EmptyTraceStore,
} from "../../../../packages/db/test/support/clickhouse.ts";

/**
 * Start isolated Postgres and ClickHouse databases, the API, and Next with
 * rewrites that expose one browser origin. Choose both ports before configuring
 * either process. Serialize browser instances because Next shares apps/web/.next.
 */

const WEB = path.join(import.meta.dirname, "../../../web");

/** Long, because a development server compiles each page the first time. */
export const SETTLE = 120_000;

export type Instance = {
  /**
   * Where a browser goes. The pages and the API both answer here — or, when
   * the pages were left out, the API alone does.
   */
  readonly origin: string;
  readonly api: FastifyInstance;
  readonly database: MigratedDatabase;
  readonly traceStore: EmptyTraceStore;
  /**
   * Turn every pending object into rows, the way the deployment does. The door
   * answers on object-store durability, so a flow whose claim is about what a
   * page shows carries the evidence the rest of the way with this.
   */
  drainEvidence(): Promise<number>;
  close(): Promise<void>;
};

export type InstanceOptions = {
  /**
   * Whether the trace store gets its schema. Off by default: creating and
   * migrating one costs a second, and a flow that reads no telemetry only needs
   * the store to answer the health check the boot waits on.
   */
  readonly traces?: boolean;
  /**
   * Serve Next by default. API-only tests can disable it and use the API address
   * as the instance origin.
   */
  readonly web?: boolean;
  /**
   * Optional recording store shared by the API signer and browser fixture.
   * Media tests must handle unavailable storage explicitly.
   */
  readonly blob?: Config["blob"];
  /**
   * The ingestion bucket evidence is accepted into, where the caller has a
   * store running. Absent leaves this instance with nowhere to make evidence
   * durable, which is what an unconfigured deployment is: the door answers
   * `503` and nothing is staged.
   */
  readonly ingestStore?: IngestionStore;
  /** Deployment credential required by flows that exercise the phone adapter. */
  readonly carrierRoute?: Config["carrierRoute"];
  /**
   * Every raw HTTP request, before Fastify or authentication can refuse it.
   * Test evidence only: this listener changes no production server.
   */
  readonly observeRequest?: (request: ObservedInstanceRequest) => void;
  /**
   * A test that drives the real CLI can remove RFC 8628's wall-clock wait. The
   * provider, routes, approval, token exchange, and stored key stay real.
   */
  readonly deviceAuthorizationInterval?: ServerOptions["deviceAuthorizationInterval"];
  /** Provider-read seam for the one browser journey that configures Retell. */
  readonly retellFetch?: ServerOptions["retellFetch"];
  /**
   * Test-only API configuration after shipped routes are registered and before
   * Fastify starts listening. A test can add a hook at a real route boundary
   * without changing the production server.
   */
  readonly beforeApiListen?: (
    app: FastifyInstance,
  ) => void | Promise<void>;
};

export type ObservedInstanceRequest = {
  readonly method: string;
  readonly url: string;
  /** The bytes seen so far. The getter holds the complete body after `end`. */
  readonly rawBody: string;
};

/** A port nothing is listening on, so two test files never collide. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not find a free port"));
        return;
      }
      probe.close(() => {
        resolve(address.port);
      });
    });
  });
}

/**
 * Wait for an HTTP response below 500 or a 503 readiness response. Tests
 * without ingestion storage can serve routes while acceptance remains unready.
 * Do not accept 500 as successful startup.
 */
async function answers(
  url: string,
  within: number,
  gaveUp: () => Error | undefined,
): Promise<void> {
  const until = Date.now() + within;
  for (;;) {
    const failed = gaveUp();
    if (failed !== undefined) throw failed;

    try {
      const response = await fetch(url);
      if (response.status < 500 || response.status === 503) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > until) throw new Error(`nothing answered at ${url}`);
    await new Promise((resume) => setTimeout(resume, 250));
  }
}

export async function startInstance(
  label: string,
  options: InstanceOptions = {},
): Promise<Instance> {
  const database = await createMigratedDatabase(label);
  const traceStore =
    options.traces === true
      ? await createMigratedTraceStore(label)
      : await createEmptyTraceStore(label);

  connect({
    databaseUrl: database.url,
    maxConnections: 4,
    encryptionKey: TEST_ENCRYPTION_KEY,
  });
  connectClickHouse({ clickhouseUrl: traceStore.url, maxOpenConnections: 4 });

  // The fixed-id persona and grader catalogs, on their shelves before anything
  // can point at them — what the real entry point writes after migrations and
  // before it serves a request.
  await seedPersonaLibrary();
  await reconcileGraderCatalog();

  const withPages = options.web ?? true;
  const apiPort = await freePort();
  const webPort = withPages ? await freePort() : apiPort;
  const origin = `http://127.0.0.1:${webPort}`;

  // One directory per instance, on the same terms as the database: a local log
  // is a durable record, and two instances sharing one would each recover the
  // other's staged evidence on the way up.
  const ingestionLogDirectory =
    options.ingestStore === undefined
      ? undefined
      : mkdtempSync(path.join(tmpdir(), `egma-ingestion-${label}-`));

  const base: Config = {
    ...loadConfig({
      DATABASE_URL: database.url,
      CLICKHOUSE_URL: traceStore.url,
      EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
      EGMA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      EGMA_SIMULATOR_SERVICE_TOKEN: "egma_st_held-by-this-test-suite-alone",
      EGMA_BASE_URL: origin,
      EGMA_SINGLE_ORGANIZATION: "false",
      // A self-host test deployment with one explicit key per provider
      // account. They are nonsense and never reach a provider. Claim tests
      // still exercise the real selection-to-credential path.
      EGMA_OPENAI_API_KEY: "openai-key-held-by-this-test-instance",
      EGMA_DEEPGRAM_API_KEY: "deepgram-key-held-by-this-test-instance",
      EGMA_CARTESIA_API_KEY: "cartesia-key-held-by-this-test-instance",
    }),
    ...(options.blob === undefined ? {} : { blob: options.blob }),
    ...(options.carrierRoute === undefined
      ? {}
      : { carrierRoute: options.carrierRoute }),
  };

  const { app, drainer } = buildApi({
    config:
      options.ingestStore === undefined || ingestionLogDirectory === undefined
        ? base
        : {
            ...base,
            ingestion: {
              ...base.ingestion,
              store: options.ingestStore,
              logDirectory: ingestionLogDirectory,
              flushMilliseconds: 20,
            },
          },
    ...(options.deviceAuthorizationInterval === undefined
      ? {}
      : { deviceAuthorizationInterval: options.deviceAuthorizationInterval }),
    ...(options.retellFetch === undefined
      ? {}
      : { retellFetch: options.retellFetch }),
  });
  let webOutput: WebOutputLock | undefined;
  let web: ChildProcess | undefined;

  try {
    await options.beforeApiListen?.(app);
    if (options.observeRequest !== undefined) {
      // `prependListener` puts this before Fastify's own request listener. A
      // Fastify hook added here would come after the route's `onRequest` auth
      // hook and would miss the exact 401 that this boundary evidence must see.
      app.server.prependListener("request", (request) => {
        let rawBody = "";
        request.on("data", (chunk: Buffer) => {
          rawBody += chunk.toString("utf8");
        });
        options.observeRequest?.({
          method: request.method ?? "GET",
          url: request.url ?? "/",
          get rawBody() {
            return rawBody;
          },
        });
      });
    }
    await app.listen({ host: "127.0.0.1", port: apiPort });

    if (withPages) {
      // The development server below compiles into `apps/web/.next`, which is
      // the directory `next build` writes too. Taking the lock here is what
      // makes "a production web build and the browser test never run at once
      // in the same checkout" true rather than merely asked for — whoever is
      // second is refused with a sentence naming the other, instead of both
      // writing over each other. That refusal is inside the `try` because by
      // now this instance has a Postgres, a ClickHouse and a listening API to
      // its name, and every one of them has to go back.
      webOutput = holdWebOutputLock(THE_REAL_BROWSER_TEST);

      web = spawn(
        path.join(WEB, "node_modules/.bin/next"),
        ["dev", "--port", String(webPort), "--hostname", "127.0.0.1"],
        {
          cwd: WEB,
          env: {
            ...process.env,
            EGMA_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
            NODE_ENV: "development",
          },
          stdio: "ignore",
        },
      ) as ChildProcess;
    }

    // Loudly and at once, rather than after two minutes of nothing answering.
    let failedToStart: Error | undefined;
    web?.on("error", (cause) => {
      failedToStart = cause;
    });
    web?.on("exit", (code) => {
      failedToStart ??= new Error(`the web application exited with ${code}`);
    });

    // The pages forward `/api/…` to the API, and the API's own health check
    // is at `/health` — so which address is waited on depends on which of the
    // two is answering at the origin.
    await answers(
      withPages ? `${origin}/api/health` : `${origin}/health`,
      SETTLE,
      () => failedToStart,
    );
  } catch (neverCameUp) {
    // Clean up partial startup because callers receive no instance to close.
    // Wait for Next to exit before releasing its build lock; sending a signal
    // alone does not stop it from writing to .next.
    await releaseAfter(web, webOutput);
    await Promise.allSettled([
      app.close(),
      disconnect(),
      disconnectClickHouse(),
    ]);
    await Promise.allSettled([database.drop(), traceStore.drop()]);
    throw neverCameUp;
  }

  return {
    origin,
    api: app,
    database,
    traceStore,
    async drainEvidence() {
      return (await drainer()?.drainNow()) ?? 0;
    },
    async close() {
      // Waits for the development server to be gone before the output
      // directory is anybody else's. See `releaseAfter`.
      await releaseAfter(web, webOutput);
      await app.close();
      await disconnect();
      await disconnectClickHouse();
      await database.drop();
      await traceStore.drop();
      if (ingestionLogDirectory !== undefined) {
        rmSync(ingestionLogDirectory, { recursive: true, force: true });
      }
    },
  };
}
