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
  seedGraderLibrary,
  seedPersonaLibrary,
  seedPlatformSettings,
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
 * A whole egma, running: a Postgres of its own, a ClickHouse of its own, the
 * real API, and the real Next process with its real rewrites — reachable at one
 * origin, exactly as a `docker compose up` leaves it.
 *
 * This exists for the browser tests, and every part of it is real on purpose. A
 * stub anywhere in that list removes the only reason to drive a browser at all:
 * what those tests prove is that the pages exist, that they are served from this
 * instance's own origin, and that this process forwards the API paths they use —
 * and none of those three is a claim a mock can make.
 *
 * **One origin, and both halves know it.** Both ports are chosen up front,
 * because the API has to be told the address a browser reaches egma on and the
 * web process has to be told where to forward the API's paths.
 *
 * **One at a time, and that is why every browser test is in one file.** A
 * development server compiles into `apps/web/.next`, and two of them running at
 * once compile into the same files and each ends up serving half of the other's
 * build. Pointing them at different output directories does work and costs more
 * than it buys: Next writes the directory it is using back into the checked-in
 * `tsconfig.json` and `next-env.d.ts`, so running the suite would leave the
 * repository dirty. Vitest runs the tests within one file in order, so one file
 * is the whole of the arrangement — and it is the cheaper one anyway, because
 * every browser test then shares one instance instead of standing up its own.
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
   * Whether the pages are served beside the API. On by default, because that is
   * what a browser needs and the browser tests are why this exists.
   *
   * Off is for a caller that speaks only the HTTP API and never opens a page —
   * the CLI is the whole of that list. A development server costs a minute or
   * two to compile the first page, and a caller that will never ask for one
   * should not pay it. With the pages off, `origin` is the API's own address
   * and the instance tells itself so, which keeps every address it hands out —
   * a device-flow approval address most of all — pointing at something that
   * answers.
   */
  readonly web?: boolean;
  /**
   * The object store recordings are resolved against, where the caller has one
   * running. Absent by default, because most of what a browser does here has
   * nothing to do with audio — and because the one flow that does must skip
   * visibly rather than fail on a machine that cannot start a container.
   *
   * It is a whole store rather than a URL because the address the API signs
   * for is the address the browser will use, and handing both halves in from
   * one place is what keeps this arrangement from proving the wrong thing.
   */
  readonly blob?: Config["blob"];
  /**
   * The ingestion bucket evidence is accepted into, where the caller has a
   * store running. Absent leaves this instance with nowhere to make evidence
   * durable, which is what an unconfigured deployment is: the door answers
   * `503` and nothing is staged.
   */
  readonly ingestStore?: IngestionStore;
  /** Deployment settings required by flows that exercise the phone adapter. */
  readonly platformSettings?: Config["platformSettings"];
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
 * Wait until the process is serving, or give up loudly rather than hang.
 *
 * **Serving rather than ready, deliberately.** `/health` reports write
 * readiness, and an instance given no ingestion bucket answers `503` there for
 * as long as it lives — truthfully, because it has nowhere to make evidence
 * durable. Most instances here are not about ingestion and are started without
 * one, so waiting for a `200` would be waiting for something that is never
 * coming.
 *
 * So this accepts any reply the route itself produced, which is every status
 * below `500` plus the `503` readiness refusal. A `500` is not one of them: a
 * process faulting on every request is not up, and treating that as "serving"
 * would turn a broken instance into a suite that fails somewhere else later.
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
  await seedGraderLibrary();
  if (options.platformSettings !== undefined) {
    await seedPlatformSettings(options.platformSettings);
  }

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
    // Nothing will call `close` on an instance that never came back, so this
    // is the only chance to give back everything it took. The databases matter
    // most: each one is created here and dropped there, and a run that failed
    // halfway used to leave both behind — which is not merely untidy, because
    // `create database` gets slower as the count climbs and the next run is
    // then likelier to fail the same way. See
    // `packages/db/test/support/sweep-stale-databases.ts`.
    // The lock goes back only once the development server has actually gone —
    // `kill` is a signal, not a departure, and a Next process still writing
    // `apps/web/.next` while the next holder starts is the corruption the lock
    // exists to prevent.
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
