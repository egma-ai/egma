import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import { loadConfig } from "../../src/config.ts";
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
  /** Where a browser goes. The pages and the API both answer here. */
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

  const apiPort = await freePort();
  const webPort = await freePort();
  const origin = `http://127.0.0.1:${webPort}`;

  const { app } = buildApi({
    config: loadConfig({
      DATABASE_URL: database.url,
      CLICKHOUSE_URL: traceStore.url,
      EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
      EGMA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      EGMA_BASE_URL: origin,
      EGMA_SINGLE_ORGANIZATION: "false",
    }),
  });
  await app.listen({ host: "127.0.0.1", port: apiPort });

  const web = spawn(
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

  // Loudly and at once, rather than after two minutes of nothing answering.
  let failedToStart: Error | undefined;
  web.on("error", (cause) => {
    failedToStart = cause;
  });
  web.on("exit", (code) => {
    failedToStart ??= new Error(`the web application exited with ${code}`);
  });

  await answers(`${origin}/api/health`, SETTLE, () => failedToStart);

  return {
    origin,
    api: app,
    database,
    traceStore,
    async close() {
      web.kill("SIGTERM");
      await app.close();
      await disconnect();
      await disconnectClickHouse();
      await database.drop();
      await traceStore.drop();
    },
  };
}
