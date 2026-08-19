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
 *
 * The grader it judges with is `latency`, which makes this the end-to-end proof
 * of the whole measure path: the simulator's spans go into ClickHouse, the
 * process claims the job a terminal transition minted, the shared measure module
 * computes the number, the bound is applied, and the verdict comes back out of
 * the read a results page uses — in a process whose environment provably holds
 * nothing key-shaped.
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
    async () => (output.includes("grader service started") ? true : undefined),
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
   * **The whole of the latency path, in the process the image runs.** The
   * container boots, reads its configuration out of the environment, reaches two
   * stores it was only given the URLs of, claims the work a terminal transition
   * minted, computes a measure off the conversation's spans, holds it to the
   * bound its copy carries, and writes the row — with no account behind it and
   * no model asked anything.
   *
   * That last part is the point of judging with `latency` here rather than with
   * the behaviors grader: a computed grader never resolves a judge, so a
   * verdict landing in an environment with nothing key-shaped in it is the
   * strongest form of that claim, made against the real process rather than
   * against a seam.
   *
   * The verdict is read back through `readVerdicts`, which is the run read
   * path's own function — so what this asserts is that the row is visible where
   * a results page reads it, not merely that a row exists.
   */
  it("judges a conversation with a measure it computes, and no model key in its environment", async () => {
    // Stated as an assertion rather than as a comment: nothing that could be a
    // key is in this process's environment, so nothing it wrote came from one.
    for (const [name, value] of Object.entries(environmentWithoutSecrets())) {
      expect(`${name}=${value ?? ""}`).not.toMatch(/KEY|TOKEN|SECRET/i);
    }

    const { simulationId, runId } = await conductSimulation(world, {
      spans: { measured: { turn_response_latency: [900, 1_100] } },
    });

    const read = await eventually(
      "the process to write a verdict",
      async () => {
        const answer = await readVerdicts(world.auth, simulationId);
        return answer.verdicts.length > 0 ? answer : undefined;
      },
      30_000,
    );

    expect(read.verdicts).toHaveLength(1);
    expect(read.verdicts[0]).toMatchObject({
      traceId: simulationId,
      runId,
      source: "simulation",
      // The config entry's position, and the bound held: 1100 milliseconds at
      // its worst, inside the two seconds the copy asks for.
      assertion: "turn_response_latency",
      verdict: "passed",
      score: 1,
    });
    expect(read.verdicts[0]?.rationale).toContain("turn_response_latency");
    // And the folded answer a results page shows above the rows agrees with
    // them, because it is computed from exactly these rows at read time.
    expect(read.outcome.verdict).toBe("passed");
  });

  it("says what it did on standard output, one JSON line at a time", async () => {
    // The verdict row lands a moment before the line that says so, so the line
    // is waited for rather than assumed — the test above returned as soon as
    // the store had the row.
    await eventually(
      "the service to say it judged a conversation",
      async () => (output.includes("grading job finished") ? true : undefined),
      10_000,
    );

    const lines = output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line["service.instance.id"]).toBe("grader-from-the-image");
      expect(line["egma.log_schema_version"]).toBe(1);
      // Nothing a customer wrote reaches the log — a job id and a count, never
      // a transcript and never a credential.
      expect(JSON.stringify(line)).not.toContain("Booked for Tuesday");
    }
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 30,
        "otel.event.name": "egma.grading_job.finished",
        msg: "grading job finished",
        "egma.simulation_id": expect.any(String),
        "egma.grading_job_id": expect.any(String),
        "egma.outcome": "succeeded",
      }),
    );
  });

  it("is still running, because a service with nothing to do waits rather than exits", () => {
    expect(service.exitCode).toBeNull();
  });
});
