/**
 * `egma` as a developer runs it: the built entry point, in a real subprocess.
 */

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLI_ENTRY,
  FAKE_AGENT,
  PRETEND_OLD_NODE,
  isAlive,
  makeWorkspace,
  waitUntil,
  type Workspace,
} from "./support/workspace.ts";

const run = promisify(execFile);

const MANIFEST = JSON.stringify({ name: "customer-repo", version: "1.0.0" }, null, 2);

async function egma(
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI_ENTRY, ...args], { cwd });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

describe("the egma command", () => {
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = await makeWorkspace({ "package.json": MANIFEST });
  });

  afterEach(async () => {
    await workspace.remove();
  });

  it("refuses an old Node in plain words before it does anything else", async () => {
    const refused = await new Promise<{ stderr: string; code: number }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", PRETEND_OLD_NODE, CLI_ENTRY, "--help"],
        { cwd: workspace.dir },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolve({ stderr, code: code ?? 0 }));
    });

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("egma needs Node 22 or newer");
    expect(refused.stderr).toContain("18.20.4");
    // The refusal came first: not even --help was answered.
    expect(refused.stderr).not.toContain("Usage:");
  });

  it("prints what it can do, and what version it is", async () => {
    const help = await egma(["--help"], workspace.dir);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(help.stdout).toContain("--agent <id>");

    const version = await egma(["--version"], workspace.dir);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("says so when handed an option it does not know", async () => {
    const result = await egma(["--turbo"], workspace.dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--turbo");
  });

  it("drives the whole task and ends with the one exit line", async () => {
    const script = await workspace.script({
      steps: [
        {
          kind: "tool-call",
          id: "t1",
          title: "Read",
          locations: [{ path: "package.json" }],
        },
        { kind: "read-file", path: "package.json", recordAs: "manifest" },
        { kind: "write-file", path: "notes.txt", content: "a package manifest\n" },
        { kind: "say", text: "It is a package manifest." },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const result = await egma(
      ["--headless", "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
      workspace.dir,
    );

    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toContain("◆ Read package.json");
    expect(lines.at(-1)).toBe(
      `${path.basename(process.execPath)} read package.json for egma. Nothing in this folder was changed.`,
    );
    expect(await readFile(path.join(workspace.dir, "notes.txt"), "utf8")).toBe(
      "a package manifest\n",
    );
  });

  it("shuts the agent and everything it started down when it is interrupted", async () => {
    const script = await workspace.script({
      spawnChild: true,
      steps: [
        { kind: "tool-call", id: "t1", title: "Thinking about it" },
        { kind: "wait", ms: 60_000 },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const child = spawn(
      process.execPath,
      [CLI_ENTRY, "--headless", "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
      { cwd: workspace.dir },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    expect(await waitUntil(() => stdout.includes("Thinking about it"))).toBe(true);

    const reportFile = path.join(workspace.dir, "fake-agent-report.json");
    const grandchild = (JSON.parse(await readFile(reportFile, "utf8")) as { childPid: number })
      .childPid;
    expect(isAlive(grandchild)).toBe(true);

    child.kill("SIGINT");
    const code = await new Promise<number>((resolve) => {
      child.on("close", (value) => resolve(value ?? 0));
    });

    expect(code).toBe(130);
    expect(stdout.trimEnd().split("\n").at(-1)).toContain("stopped before the task finished");
    expect(await waitUntil(() => !isAlive(grandchild))).toBe(true);
  });
});
