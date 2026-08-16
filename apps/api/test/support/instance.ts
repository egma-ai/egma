import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  seedGraderLibrary,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import { loadConfig, type Config } from "../../src/config.ts";
import { buildApi } from "../../src/server.ts";
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
 * A whole Egma, running: a Postgres of its own, a ClickHouse of its own, the
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
 * because the API has to be told the address a browser reaches Egma on and the
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
   * Every raw HTTP request, before Fastify or authentication can refuse it.
   * Test evidence only: this listener changes no production server.
   */
  readonly observeRequest?: (request: ObservedInstanceRequest) => void;
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

/** Wait until something answers, or give up loudly rather than hang forever. */
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
      if (response.ok) return;
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

  // Egma's own graders, on the shelf before anything can point at one — what
  // the real entry point writes in the same breath as applying its migrations.
  // Every project created afterwards is seeded with a copy of one, so an
  // instance that skipped this would refuse the first signup that reached it,
  // for a reason no test here is about.
  await seedGraderLibrary();

  const withPages = options.web ?? true;
  const apiPort = await freePort();
  const webPort = withPages ? await freePort() : apiPort;
  const origin = `http://127.0.0.1:${webPort}`;

  const { app } = buildApi({
    config: {
      ...loadConfig({
        DATABASE_URL: database.url,
        CLICKHOUSE_URL: traceStore.url,
        EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
        EGMA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        EGMA_SIMULATOR_SERVICE_TOKEN: "egma_st_held-by-this-test-suite-alone",
        EGMA_BASE_URL: origin,
        EGMA_SINGLE_ORGANIZATION: "false",
      }),
      ...(options.blob === undefined ? {} : { blob: options.blob }),
    },
  });
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

  const web: ChildProcess | undefined = withPages
    ? (spawn(
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
      ) as ChildProcess)
    : undefined;

  // Loudly and at once, rather than after two minutes of nothing answering.
  let failedToStart: Error | undefined;
  web?.on("error", (cause) => {
    failedToStart = cause;
  });
  web?.on("exit", (code) => {
    failedToStart ??= new Error(`the web application exited with ${code}`);
  });

  // The pages forward `/api/…` to the API, and the API's own health check is
  // at `/health` — so which address is waited on depends on which of the two
  // is answering at the origin.
  await answers(
    withPages ? `${origin}/api/health` : `${origin}/health`,
    SETTLE,
    () => failedToStart,
  );

  return {
    origin,
    api: app,
    database,
    traceStore,
    async close() {
      web?.kill("SIGTERM");
      await app.close();
      await disconnect();
      await disconnectClickHouse();
      await database.drop();
      await traceStore.drop();
    },
  };
}
