/** The built CLI boundary: handoff, help, refusal, and version. */

import { execFile, spawn } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INTEGRATION_HANDOFF,
  SKILLS_INSTALL_COMMAND,
} from "../src/commands/setup.ts";
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

  it("prints the coding-agent handoff without login or a terminal", async () => {
    const result = await egma([], workspace);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("setup: skills-and-cli");
    expect(result.stdout).toContain(`skills: ${SKILLS_INSTALL_COMMAND}`);
    expect(result.stdout).toContain(`next: ${INTEGRATION_HANDOFF}`);
    expect(result.stdout).toContain("status: ready-for-agent");
    expect(result.stdout).not.toContain("approve_url:");
    expect(result.stdout).not.toContain("waiting:");
  });

  it("keeps a named self-hosted URL in the agent handoff", async () => {
    const result = await egma(["--url", "http://localhost:3101/"], workspace);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("platform: http://localhost:3101");
    expect(result.stdout).toContain("Use http://localhost:3101 as the Egma platform URL.");

    const refused = await egma(
      ["--url", "https://developer:must-not-be-repeated@example.com"],
      workspace,
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--url is not a platform origin");
    expect(refused.stderr).not.toContain("must-not-be-repeated");
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
});
