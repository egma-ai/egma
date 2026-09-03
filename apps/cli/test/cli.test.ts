/** The built CLI boundary: help, refusal, and version. */

import { execFile, spawn } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLI_ENTRY,
  MANIFEST,
  PRETEND_OLD_NODE,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

const run = promisify(execFile);

async function egma(
  args: readonly string[],
  workspace: Workspace,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env: workspace.env(),
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: failure.code ?? 1,
    };
  }
}

describe("the egma command", () => {
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = await makeWorkspace({ "package.json": MANIFEST });
  });

  afterEach(async () => workspace.remove());

  it("refuses an old Node before it does anything else", async () => {
    const refused = await new Promise<{ stderr: string; code: number }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", PRETEND_OLD_NODE, CLI_ENTRY, "--help"],
        { cwd: workspace.dir, env: workspace.env() },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolve({ stderr, code: code ?? 0 }));
    });

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("Egma needs Node 22 or newer");
    expect(refused.stderr).toContain("18.20.4");
    expect(refused.stderr).not.toContain("Usage:");
  });

  it("prints help when no command is named", async () => {
    const bare = await egma([], workspace);
    const explicit = await egma(["--help"], workspace);

    expect(bare).toMatchObject({ code: 0, stderr: "" });
    expect(bare.stdout).toBe(explicit.stdout);
    expect(bare.stdout).toContain("Usage:");
    expect(bare.stdout).not.toContain("setup: skills-and-cli");
    expect(bare.stdout).not.toContain("coding-agent handoff");

    const version = await egma(["--version"], workspace);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("refuses options that have no command", async () => {
    const result = await egma(["--url", "http://localhost:3101/"], workspace);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('Egma does not know the command "--url"');
  });

  it("refuses unknown options and secrets in command arguments", async () => {
    const unknown = await egma(["--turbo"], workspace);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("--turbo");

    const secret = await egma([
      "agent",
      "register",
      "--platform",
      "livekit",
      "--livekit-api-secret",
      "must-not-be-repeated",
    ], workspace);
    expect(secret.code).toBe(1);
    expect(secret.stderr).toContain("--livekit-api-secret");
    expect(secret.stderr).not.toContain("must-not-be-repeated");
  });
});
