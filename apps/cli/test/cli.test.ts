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
  });

  it("refuses options that have no command", async () => {
    const result = await egma(["--url", "http://localhost:3101/"], workspace);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Egma needs a command");
  });

  it("documents the complete raw integration surface and no wizard controls", async () => {
    const help = await egma(["--help"], workspace);

    expect(help.code).toBe(0);
    for (const command of [
      "egma login",
      "egma connect",
      "egma init",
      "egma personas",
      "egma suite create",
      "egma validate",
      "egma pull",
      "egma push",
      "egma run",
      "egma monitoring",
      "egma livekit",
      "egma self-host up",
    ]) {
      expect(help.stdout, command).toContain(command);
    }
    for (const option of [
      "--show-context",
      "--modality",
      "--access-variant",
      "--worker-entrypoint",
      "--worker-dependency-manifest",
      "--worker-dispatch-name",
      "--idempotency-key",
    ]) {
      expect(help.stdout, option).toContain(option);
    }
    expect(help.stdout).not.toContain("--headless");
    expect(help.stdout).not.toContain("--coding-agent");
    expect(help.stdout).not.toContain("--existing-tests");
    expect(help.stdout).not.toContain("Agent Client Protocol");

    const version = await egma(["--version"], workspace);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("prints the versioned LiveKit source contract without login", async () => {
    const result = await egma(["livekit"], workspace);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("integration: livekit");
    expect(result.stdout).toContain(
      "python_testing_call: await mockable(agent, ctx, session)",
    );
    expect(result.stdout).toContain(
      "python_monitoring_call: monitor_livekit(ctx)",
    );
    expect(result.stdout).toContain("javascript_testing: supported");
    expect(result.stdout).toContain(
      "javascript_testing_package: @egma/livekit",
    );
    expect(result.stdout).toContain(
      "javascript_testing_call: await mockable(agent, ctx, session)",
    );
    expect(result.stdout).toContain(
      "javascript_monitoring_package: @egma/livekit",
    );
    expect(result.stdout).toContain(
      "javascript_monitoring_call: monitorLiveKit(ctx)",
    );
    expect(result.stdout).toContain("chat_rule:");
    expect(result.stdout).toContain("status: ready");
    expect(result.stdout).not.toContain("dependency:");
    expect(result.stdout).not.toContain("@egma/livekit@");
    expect(result.stdout).not.toContain("javascript_testing_reason:");
    expect(result.stdout).not.toContain("approve_url:");
  });

  it("refuses unknown options and secrets in command arguments", async () => {
    const unknown = await egma(["--turbo"], workspace);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("--turbo");

    const secret = await egma(
      ["connect", "--livekit-api-secret", "must-not-be-repeated"],
      workspace,
    );
    expect(secret.code).toBe(1);
    expect(secret.stderr).toContain("--livekit-api-secret");
    expect(secret.stderr).not.toContain("must-not-be-repeated");
  });

  it("refuses a missing or blank run idempotency key before platform access", async () => {
    for (const args of [
      ["run", "release", "--idempotency-key"],
      ["run", "release", "--idempotency-key", ""],
      ["run", "release", "--idempotency-key", "--no-follow"],
    ]) {
      const result = await egma(args, workspace);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain(
        "Give --idempotency-key one non-empty value.",
      );
    }
  });
});
