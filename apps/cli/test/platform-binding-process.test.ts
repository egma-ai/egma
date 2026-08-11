/**
 * Every later headless command, as a real CLI process, follows the committed
 * repository binding with no flag or environment URL to help it.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createEgmaFolder, writeTestFile } from "../src/folder/egma-folder.ts";
import { DEFAULT_TEST_COUNT } from "../src/wizard/test-generation.ts";
import { startFakeRetell, type FakeRetell } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

const PROVIDER_KEY = "synthetic-retell-key-for-binding-process-test";
const BOUND_KEY = "egma_sk_for-the-bound-platform";
const OTHER_KEY = "egma_sk_for-the-other-platform";

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe("commands after a repository is bound", () => {
  let bound: Platform;
  let other: Platform;
  let retell: FakeRetell;
  let workspace: Workspace;

  beforeAll(async () => {
    [bound, other, retell, workspace] = await Promise.all([
      startPlatform(),
      startPlatform(),
      startFakeRetell({
        keys: [PROVIDER_KEY],
        agents: [
          {
            agent_id: "synthetic-retell-agent",
            agent_name: "Bound receptionist",
            response_engine: { type: "retell-llm", llm_id: "synthetic-llm" },
          },
        ],
        llms: [
          {
            llm_id: "synthetic-llm",
            general_prompt: "Help each persona move an appointment.",
          },
        ],
      }),
      makeWorkspace(),
    ]);

    bound.signedInWith(BOUND_KEY);
    other.signedInWith(OTHER_KEY);
    await workspace.signIn(bound.url, BOUND_KEY);
    // Written second on purpose. A machine login can hold this key, but it
    // cannot select this repository's platform.
    await workspace.signIn(other.url, OTHER_KEY);

    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: { origin: bound.url, instance: bound.instanceId },
        agent: null,
        connection: null,
        suite: null,
      },
    });
  });

  afterAll(async () => {
    await Promise.all([bound.close(), other.close(), retell.close(), workspace.remove()]);
  });

  async function command(
    args: readonly string[],
    extra: NodeJS.ProcessEnv = {},
  ): Promise<CommandResult> {
    const env = workspace.env({ EGMA_RETELL_URL: retell.url, ...extra });
    expect(args).not.toContain("--url");
    expect(env.EGMA_URL).toBeUndefined();
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // `connect` checks standard input before its environment. End the pipe so
    // the real process sees the same promptless EOF a coding agent sends.
    child.stdin.end();
    const code = await new Promise<number>((resolve) => {
      child.on("close", (value) => resolve(value ?? 1));
    });
    return { stdout, stderr, code };
  }

  async function reachesBound(
    args: readonly string[],
    expectedPath: string,
    extra: NodeJS.ProcessEnv = {},
  ): Promise<CommandResult> {
    const before = bound.records.length;
    const result = await command(args, extra);
    const requests = bound.records.slice(before);

    expect(result.stdout, result.stderr).toContain(`url: ${bound.url}`);
    expect(requests[0]).toMatchObject({ method: "GET", path: "/api/platform" });
    expect(requests.some((request) => request.path === expectedPath)).toBe(true);
    expect(other.records).toEqual([]);
    return result;
  }

  it("uses the binding for connect, push, pull, run, and the bare wizard", async () => {
    const connected = await reachesBound(
      ["connect"],
      "/api/agents",
      { EGMA_RETELL_API_KEY: PROVIDER_KEY, EGMA_REACH: "text" },
    );
    expect(connected.code).toBe(0);
    expect(connected.stdout).toContain("status: connected");

    for (let number = 1; number <= DEFAULT_TEST_COUNT; number += 1) {
      const name = `moves-appointment-${number}`;
      await writeTestFile(path.join(workspace.dir, "egma", "tests", `${name}.md`), {
        name,
        personas: [],
        version: null,
        scenario: `The persona needs a different appointment time in case ${number}.`,
        expectedBehaviors: ["The agent confirms the new time."],
        mockTools: [],
      });
    }

    const pushed = await reachesBound(["push"], "/api/tests");
    expect(pushed.code).toBe(0);
    expect(pushed.stdout).toContain("status: pushed");

    const pulled = await reachesBound(["pull"], "/api/tests");
    expect(pulled.code).toBe(0);
    expect(pulled.stdout).toContain("status: pulled");

    const started = await reachesBound(["run", "--no-follow"], "/api/runs");
    expect(started.code).toBe(0);
    expect(started.stdout).toContain("status: started");
    expect(bound.running.runs).toHaveLength(1);
    expect(other.running.runs).toHaveLength(0);

    // The address a developer is handed to watch the run is on the platform
    // that holds the run, and it carries no key. An address on the wrong
    // platform would 404 for the developer; an address with a key in it would
    // put that key in a terminal, a shell history, and whatever they paste it
    // into.
    const runId = bound.running.runs[0]?.id ?? "";
    expect(runId).not.toBe("");
    expect(started.stdout).toContain(`results: ${bound.url}/runs/${runId}`);
    expect(started.stdout).not.toContain(other.url);
    for (const secret of [BOUND_KEY, OTHER_KEY, PROVIDER_KEY]) {
      expect(started.stdout).not.toContain(secret);
      expect(started.stderr).not.toContain(secret);
    }

    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:found framework retell-sdk\n" },
        { kind: "stop", reason: "end_turn" },
      ],
    });
    const beforeRequests = bound.records.length;
    const beforeRuns = bound.running.runs.length;
    const grading = gradeEveryRun(bound);
    let wizard: CommandResult;
    try {
      // No verb and no platform selector: this is the wizard, with headless
      // consent only so a real terminal is not needed in CI.
      wizard = await command(
        ["--headless", "--", process.execPath, FAKE_AGENT, script],
        { EGMA_RETELL_API_KEY: PROVIDER_KEY, EGMA_REACH: "text" },
      );
    } finally {
      grading.stop();
    }

    const wizardRequests = bound.records.slice(beforeRequests);
    expect(wizard.code, wizard.stderr).toBe(0);
    expect(wizard.stdout).toMatch(/^first-verdict: /mu);
    expect(wizardRequests[0]).toMatchObject({ method: "GET", path: "/api/platform" });
    for (const expectedPath of ["/api/agents", "/api/tests", "/api/runs"]) {
      expect(
        wizardRequests.some((request) => request.path === expectedPath),
        expectedPath,
      ).toBe(true);
    }
    expect(bound.running.runs).toHaveLength(beforeRuns + 1);
    expect(other.records).toEqual([]);
  });
});
