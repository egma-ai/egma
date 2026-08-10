/**
 * A whole egma, running as its own process, for the checks that need two.
 *
 * The real API entry point — the one the container runs — over a Postgres and a
 * ClickHouse of its own, applying its own migrations on boot exactly as a fresh
 * self-host does. Nothing here is a fixture.
 *
 * It is a process rather than an in-process server because the point is to have
 * *two*, and one process holds one database connection: `connect` refuses a
 * second. Two processes are also the more honest shape — two egmas on one
 * laptop is precisely the situation an agent repository's binding exists for.
 *
 * Every line the process logs is kept. That is the evidence for the claim these
 * checks exist to make: which requests a platform received, and therefore which
 * identifiers never reached it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import {
  createEmptyTraceStore,
  type EmptyTraceStore,
} from "../../../../packages/db/test/support/clickhouse.ts";
import {
  createEmptyDatabase,
  TEST_ENCRYPTION_KEY,
  type EmptyDatabase,
} from "../../../../packages/db/test/support/database.ts";

const API_ENTRY = fileURLToPath(new URL("../../../api/dist/index.js", import.meta.url));

/** Long enough for migrations on a cold machine, short enough to fail loudly. */
const BOOT_MS = 60_000;

export type RealPlatform = {
  /** The address a repository is pointed at, and the origin it answers as. */
  readonly origin: string;
  /** What this deployment minted for itself, read over the public contract. */
  readonly instanceId: string;
  /** Everything the process has written to its log, in order. */
  log(): string;
  /** The paths this platform has been asked for, in order, repeats and all. */
  pathsAsked(): readonly string[];
  /** Sign a person up here and keep the browser cookie they were given. */
  signUp(email: string): Promise<string>;
  /** Approve a terminal's code, as a person in a browser would. */
  approve(userCode: string, cookie: string): Promise<void>;
  /** Stop the process, as a self-hoster stopping their egma does. */
  stop(): Promise<void>;
  /** Stop it, if it is still up, and take its databases away. */
  close(): Promise<void>;
};

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
      probe.close(() => resolve(address.port));
    });
  });
}

async function answers(url: string, within: number, gaveUp: () => string | null): Promise<void> {
  const until = Date.now() + within;
  for (;;) {
    const failed = gaveUp();
    if (failed !== null) throw new Error(failed);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > until) throw new Error(`nothing answered at ${url}`);
    await new Promise((resume) => setTimeout(resume, 200));
  }
}

export async function startRealPlatform(label: string): Promise<RealPlatform> {
  const database: EmptyDatabase = await createEmptyDatabase(label);
  const traceStore: EmptyTraceStore = await createEmptyTraceStore(label);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;

  const api: ChildProcess = spawn(process.execPath, [API_ENTRY], {
    env: {
      ...process.env,
      DATABASE_URL: database.url,
      CLICKHOUSE_URL: traceStore.url,
      EGMA_AUTH_SECRET: `a-secret-only-${label}-uses`,
      EGMA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      EGMA_SIMULATOR_SERVICE_TOKEN: `egma_st_held-by-${label}-alone`,
      EGMA_BASE_URL: origin,
      HOST: "127.0.0.1",
      PORT: String(port),
      // A line per request, which is how these checks know what a platform was
      // asked for and — the whole point — what it was never asked for.
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  let died: string | null = null;
  api.stdout?.setEncoding("utf8");
  api.stderr?.setEncoding("utf8");
  api.stdout?.on("data", (chunk: string) => {
    log += chunk;
  });
  api.stderr?.on("data", (chunk: string) => {
    log += chunk;
  });
  api.on("error", (cause) => {
    died = `the api could not be started: ${cause.message}`;
  });
  api.on("exit", (code) => {
    died ??= `the api exited with ${code}\n${log}`;
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    api.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const give = setTimeout(() => {
        api.kill("SIGKILL");
        resolve();
      }, 5_000);
      api.on("close", () => {
        clearTimeout(give);
        resolve();
      });
    });
  };

  try {
    await answers(`${origin}/health`, BOOT_MS, () => died);

    const identity = await fetch(`${origin}/api/platform`);
    const said = (await identity.json()) as { instance_id?: string };
    const instanceId = said.instance_id ?? "";
    if (instanceId === "") throw new Error(`${origin} would not say which egma it is`);

    return {
      origin,
      instanceId,
      log: () => log,
      pathsAsked: () =>
        [...log.matchAll(/"url":"([^"]+)"/gu)].map((match) => match[1] as string),
      async signUp(email) {
        const created = await fetch(`${origin}/api/signup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email,
            password: "a-long-enough-password",
            organizationName: "Acme",
          }),
        });
        if (created.status !== 201) {
          throw new Error(`${origin} would not sign anybody up: ${await created.text()}`);
        }
        return (created.headers.getSetCookie() ?? [])
          .map((cookie) => cookie.split(";", 1)[0])
          .join("; ");
      },
      async approve(userCode, cookie) {
        const approved = await fetch(`${origin}/api/device/approve`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ user_code: userCode }),
        });
        const answer = (await approved.json()) as { status?: string };
        if (answer.status !== "approved") {
          throw new Error(`${origin} would not approve ${userCode}: ${JSON.stringify(answer)}`);
        }
      },
      stop,
      async close() {
        await stop();
        await database.drop();
        await traceStore.drop();
      },
    };
  } catch (cause) {
    await stop();
    await database.drop();
    await traceStore.drop();
    throw cause;
  }
}
