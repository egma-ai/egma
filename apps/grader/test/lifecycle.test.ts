import { spawn } from "node:child_process";
import { setTimeout as after } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import {
  createMigratedDatabase,
  type MigratedDatabase,
} from "../../../packages/db/test/support/database.ts";
import { MAINTENANCE_CLICKHOUSE_URL } from
  "../../../packages/db/test/support/store-urls.ts";

const GRADER_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CLAIMANT = "grader-lifecycle-test";

type Exit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

type Backend = {
  readonly pid: number;
  readonly query: string;
};

async function eventually<T>(
  description: string,
  inspect: () => Promise<T | undefined>,
  timeoutMilliseconds: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const found = await inspect();
    if (found !== undefined) return found;
    await after(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function graderBackends(database: MigratedDatabase): Promise<Backend[]> {
  const result = await database.sql<Backend>(
    `select pid, query
       from pg_stat_activity
      where datname = current_database()
        and application_name = $1
      order by pid`,
    [CLAIMANT],
  );
  return result.rows;
}

it("stays running and reconnects when its work listener is terminated while idle", async () => {
  const database = await createMigratedDatabase("grader_listener_lifecycle");
  const childUrl = new URL(database.url);
  childUrl.searchParams.set("application_name", CLAIMANT);

  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [GRADER_ENTRY], {
    env: {
      PATH: process.env["PATH"] ?? "",
      DATABASE_URL: childUrl.toString(),
      CLICKHOUSE_URL: MAINTENANCE_CLICKHOUSE_URL,
      EGMA_GRADER_CLAIMANT: CLAIMANT,
      EGMA_GRADER_LOG_LEVEL: "INFO",
      EGMA_GRADER_SWEEP_SECONDS: "30",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    await eventually(
      "the grader to start",
      async () => stdout.includes("grader service started") || undefined,
      5_000,
    );

    // The ordinary query pool keeps one idle connection for ten seconds. Wait
    // until only the dedicated LISTEN connection remains, so terminating it
    // proves whether the service owns its lifetime instead of borrowing the
    // pool's last socket.
    const firstListener = await eventually(
      "the ordinary pool to become idle",
      async () => {
        const backends = await graderBackends(database);
        if (backends.length !== 1) return undefined;
        return /^listen egma_grading_work$/iu.test(backends[0]?.query ?? "")
          ? backends[0]?.pid
          : undefined;
      },
      15_000,
    );

    const killed = await database.sql<{
      readonly terminated: boolean;
    }>("select pg_terminate_backend($1) as terminated", [firstListener]);
    expect(killed.rows[0]?.terminated).toBe(true);

    const nextListener = await eventually(
      "the grader to reconnect its work listener",
      async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `grader exited instead of reconnecting\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          );
        }
        const listener = (await graderBackends(database)).find(
          (backend) =>
            backend.pid !== firstListener &&
            /^listen egma_grading_work$/iu.test(backend.query),
        );
        return listener?.pid;
      },
      5_000,
    );
    expect(nextListener).not.toBe(firstListener);
    expect(child.exitCode).toBeNull();

    const listenerFailure = stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(
        (line) =>
          line["otel.event.name"] === "egma.grading_listener.failed",
      );
    expect(listenerFailure).toMatchObject({
      "error.type": "grading_listener_failed",
      "exception.type": expect.stringMatching(
        /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u,
      ),
      msg: "grader work listener failed; reconnecting",
    });
    expect(JSON.stringify(listenerFailure)).not.toContain(
      "Connection terminated unexpectedly",
    );

    child.kill("SIGTERM");
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
    expect(stdout).toContain("grader service stopped");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await database.drop();
  }
}, 30_000);
