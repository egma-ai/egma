import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readVerdicts } from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aLatencyCopy,
  conductSimulation,
  eventually,
  makeWorld,
  seedGrader,
  type World,
} from "./support/world.ts";

/**
 * The container's own process, started the way the image starts it, against the
 * compose harness — and it judges a conversation with no model key anywhere in
 * its environment.
 *
 * The other suites drive the service in-process, which is the right seam for
 * asserting what it does. This one asserts the thing that seam cannot: that the
 * entry point boots, reads its configuration from the environment, connects to
 * two stores it was only told the URLs of, and works. Everything between
 * `docker compose up` and this is the Dockerfile, which the deployment test
 * reads and which builds the same command.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const ENTRY = path.join(ROOT, "apps/grader/dist/index.js");

let world: World;
let service: ChildProcessWithoutNullStreams;
let output = "";

/**
 * The environment the process is given: what it needs, and provably nothing
 * that could be a key. Inherited variables are dropped rather than passed
 * through, so a machine that happens to have `OPENAI_API_KEY` set cannot make
 * this test pass for the wrong reason.
 */
function environmentWithoutSecrets(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    DATABASE_URL: world.database.url,
    CLICKHOUSE_URL: world.store.url,
    EGMA_GRADER_CLAIMANT: "grader-from-the-image",
    EGMA_GRADER_LOG_LEVEL: "INFO",
  };
}

beforeAll(async () => {
  world = await makeWorld("grader_entry_point");
  await seedGrader(world, aLatencyCopy());

  const environment = environmentWithoutSecrets();
  service = spawn("node", [ENTRY], { cwd: ROOT, env: environment });
  service.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  service.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  // Waited for rather than slept past, and it doubles as the assertion that the
  // process booted at all: a bad configuration would have stopped it here,
  // saying which variable.
  await eventually(
    "the service to say it is listening",
    async () => (output.includes("listening for finished conversations") ? true : undefined),
    30_000,
  );
});

afterAll(async () => {
  service.kill("SIGTERM");
  await new Promise((resolve) => service.once("exit", resolve));
  await world.drop();
});

describe("the process the image runs", () => {
  /**
   * **The claim is about the process, not about the judgment.** What the
   * container has to prove is that it boots, reads its configuration out of the
   * environment, reaches two stores it was only given the URLs of, claims the
   * work a terminal transition minted, and writes a row. The grader it judges
   * with is a copy of `latency` — on the shelf, pressable today, and not yet
   * something egma computes — so the row it writes says exactly that, in egma's
   * own words, with no account behind it and no model asked anything.
   */
  it("judges a conversation, with no model key in its environment", async () => {
    // Stated as an assertion rather than as a comment: nothing that could be a
    // key is in this process's environment, so nothing it wrote came from one.
    for (const [name, value] of Object.entries(environmentWithoutSecrets())) {
      expect(`${name}=${value ?? ""}`).not.toMatch(/KEY|TOKEN|SECRET/i);
    }

    const { simulationId, runId } = await conductSimulation(world, {
      spans: { measured: { turn_response_latency: [900, 1_100] } },
    });

    const verdicts = await eventually(
      "the process to write a verdict",
      async () => {
        const read = await readVerdicts(world.auth, simulationId);
        return read.verdicts.length > 0 ? read.verdicts : undefined;
      },
      30_000,
    );

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      traceId: simulationId,
      runId,
      source: "simulation",
      // `errored` and never `passed`: this check applies perfectly well and
      // egma did not make it, which is a sentence a page has to be able to
      // show rather than a green tick nobody earned.
      verdict: "errored",
    });
  });

  it("says what it did on standard output, one JSON line at a time", async () => {
    // The verdict row lands a moment before the line that says so, so the line
    // is waited for rather than assumed — the test above returned as soon as
    // the store had the row.
    await eventually(
      "the service to say it judged a conversation",
      async () => (output.includes("judged a conversation") ? true : undefined),
      10_000,
    );

    const lines = output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line["claimant"]).toBe("grader-from-the-image");
      // Nothing a customer wrote reaches the log — a job id and a count, never
      // a transcript and never a credential.
      expect(JSON.stringify(line)).not.toContain("Booked for Tuesday");
    }
    expect(lines.some((line) => line["message"] === "judged a conversation")).toBe(
      true,
    );
  });

  it("is still running, because a service with nothing to do waits rather than exits", () => {
    expect(service.exitCode).toBeNull();
  });
});
