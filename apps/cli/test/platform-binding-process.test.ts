/**
 * Every later headless command, as a real CLI process, follows the committed
 * repository binding with no flag or environment URL to help it.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createEgmaFolder, writeTestFile } from "../src/folder/egma-folder.ts";
import { startFakeRetell, type FakeRetell } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, makeWorkspace, type Workspace } from "./support/workspace.ts";

const PROVIDER_KEY = "synthetic-retell-key-for-binding-process-test";

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

    const boundKey = "egma_sk_for-the-bound-platform";
    const otherKey = "egma_sk_for-the-other-platform";
    bound.signedInWith(boundKey);
    other.signedInWith(otherKey);
    await workspace.signIn(bound.url, boundKey);
    // Written second on purpose. A machine login can hold this key, but it
    // cannot select this repository's platform.
    await workspace.signIn(other.url, otherKey);

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
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env: workspace.env({ EGMA_RETELL_URL: retell.url, ...extra }),
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

  it("uses the binding for connect, push, pull, and run", async () => {
    const connected = await reachesBound(
      ["connect"],
      "/api/agents",
      { EGMA_RETELL_API_KEY: PROVIDER_KEY },
    );
    expect(connected.code).toBe(0);
    expect(connected.stdout).toContain("status: connected");

    await writeTestFile(path.join(workspace.dir, "egma", "tests", "moves-appointment.md"), {
      name: "moves-appointment",
      personas: [],
      version: null,
      scenario: "The persona needs a different appointment time.",
      expectedBehaviors: ["The agent confirms the new time."],
    });

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
  });
});
