/**
 * Every later headless command, as a real CLI process, follows the committed
 * repository binding with no flag to help it — and the refusal that keeps it
 * there arrives whole in a real terminal.
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
import { aTestFile, blocking } from "./support/test-file.ts";

const PROVIDER_KEY = "synthetic-retell-key-for-binding-process-test";
const BOUND_KEY = "egma_sk_for-the-bound-platform";
const OTHER_KEY = "egma_sk_for-the-other-platform";

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** The built CLI as its own process, ended rather than thrown. */
async function runEgma(
  where: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  args: readonly string[],
): Promise<CommandResult> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], where);
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
            channel: "chat",
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
        platform: { origin: bound.url },
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
    // Nothing names a platform, which is what leaves the committed binding to
    // choose one — asserted rather than assumed, because a flag here would make
    // every claim below vacuous.
    expect(args).not.toContain("--url");
    return runEgma({ cwd: workspace.dir, env }, args);
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
    expect(requests.some((request) => request.path === expectedPath)).toBe(true);
    expect(other.records).toEqual([]);
    return result;
  }

  it("uses the binding for connect, push, pull, run, and the bare wizard", async () => {
    const connected = await reachesBound(
      ["connect"],
      "/v1/agents",
      { EGMA_RETELL_API_KEY: PROVIDER_KEY, EGMA_REACH: "text" },
    );
    expect(connected.code).toBe(0);
    expect(connected.stdout).toContain("status: connected");

    for (let number = 1; number <= DEFAULT_TEST_COUNT; number += 1) {
      const name = `moves-appointment-${number}`;
      await writeTestFile(path.join(workspace.dir, "egma", "tests", `${name}.md`), aTestFile({
        name,
        personas: [],
        version: null,
        scenario: `The persona needs a different appointment time in case ${number}.`,
        expectedBehaviors: blocking("The agent confirms the new time."),
        mockTools: [],
      }));
    }

    const pushed = await reachesBound(["push"], "/v1/tests");
    expect(pushed.code).toBe(0);
    expect(pushed.stdout).toContain("status: pushed");

    const pulled = await reachesBound(["pull"], "/v1/tests");
    expect(pulled.code).toBe(0);
    expect(pulled.stdout).toContain("status: pulled");

    const started = await reachesBound(["run", "--no-follow"], "/v1/runs");
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
      // No verb and no platform named: this is the wizard, with headless
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
    for (const expectedPath of ["/v1/agents", "/v1/tests", "/v1/runs"]) {
      expect(
        wizardRequests.some((request) => request.path === expectedPath),
        expectedPath,
      ).toBe(true);
    }
    expect(bound.running.runs).toHaveLength(beforeRuns + 1);
    expect(other.records).toEqual([]);
  });
});

/**
 * The refusal a developer meets when they really are moving, in the terminal
 * they meet it in.
 *
 * Now that an unbound repository falls back to egma's own platform, the first
 * thing somebody moving off their own deployment types is the address they want
 * — and this is what answers. It has to arrive whole: one sentence saying egma
 * will not do it, then every line to delete, then what moving costs. A refusal
 * that named the first step and stopped is what left a developer deleting the
 * platform block, running again, and meeting a stranger failure about
 * identifiers the new platform never issued.
 *
 * Checked here as one real process, because a coding agent reads this out of a
 * terminal and acts on it. Whether the lines say the right thing is
 * `egma-folder.test.ts`; whether they survive the trip is this.
 */
describe("moving a bound repository to another platform", () => {
  let here: Platform;
  let there: Platform;
  let workspace: Workspace;

  beforeAll(async () => {
    [here, there, workspace] = await Promise.all([
      startPlatform(),
      startPlatform(),
      makeWorkspace(),
    ]);
    here.signedInWith(BOUND_KEY);
    there.signedInWith(OTHER_KEY);
    await workspace.signIn(here.url, BOUND_KEY);
    await workspace.signIn(there.url, OTHER_KEY);
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: { origin: here.url },
        agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
        connection: { name: "retell-1", id: "con_01K3XQ7M4E8YB2FVN0H9TZQWES" },
        suite: { name: "first-suite", id: "sui_01K3XQ7M4E8YB2FVN0H9TZQWET" },
      },
    });
  });

  afterAll(async () => {
    await Promise.all([here.close(), there.close(), workspace.remove()]);
  });

  it("refuses, and teaches the whole move in plain lines", async () => {
    const refused = await runEgma(
      { cwd: workspace.dir, env: workspace.env() },
      ["push", "--url", there.url],
    );

    expect(refused.code).toBe(4);
    expect(refused.stdout).toContain("status: refused");
    expect(refused.stderr).toContain("Egma does not move a repository between platforms");
    expect(refused.stderr).toContain("no repository identifiers were sent");

    // Every line to delete, in the terminal, as a block that starts on its own
    // line rather than trailing off the end of a sentence.
    const said = refused.stderr.split("\n").map((line) => line.trimEnd());
    const opens = said.indexOf(
      "To move this repository to another platform, delete these in this order and run egma again:",
    );
    expect(opens).toBeGreaterThan(0);
    expect(said[opens - 1]).toBe("");
    // In that order, and the platform block last. Deleting it is what unbinds
    // the repository, and an unbound repository falls back to egma's own
    // platform — so a developer following this list top-down must never be one
    // line in and holding another platform's identifiers with nothing left to
    // keep them there.
    expect(said.slice(opens + 1, opens + 6)).toEqual([
      "  - the id: line under agent: in egma/config.yaml",
      "  - the id: line under connection: in egma/config.yaml",
      "  - the id: line under suite: in egma/config.yaml",
      "  - the version: line at the top of every file in egma/tests/",
      "  - last of all, the whole platform: block in egma/config.yaml",
    ]);
    expect(said[opens + 6]).toContain("Delete the platform block last");
    expect(said[opens + 7]).toContain("Your tests move with you");
    expect(said[opens + 7]).toContain("stay on the platform that ran them");

    // No command performs the move, so none is offered.
    expect(refused.stderr).not.toMatch(/egma rebind|--rebind|Egma move/u);

    // And nothing was sent: neither platform was asked so much as who it is.
    expect(here.records).toEqual([]);
    expect(there.records).toEqual([]);
  });
});
