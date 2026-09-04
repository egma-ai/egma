/** Ctrl-C stops commands that are waiting for credential JSON on stdin. */

import { spawn } from "node:child_process";

import { expect, it, vi } from "vitest";

import {
  createEgmaFolder,
  EMPTY_CONFIG,
} from "../src/folder/egma-folder.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, makeWorkspace, type Workspace } from "./support/workspace.ts";

const EGMA_KEY = "egma_sk_credential-stdin-interrupt";

async function initialized(
  platform: Platform,
  workspace: Workspace,
): Promise<void> {
  platform.signedInWith(EGMA_KEY);
  await workspace.signIn(platform.url, EGMA_KEY);
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      platform: { origin: platform.url },
      project: { id: platform.projectId, name: "Fixture project" },
      agents: [],
    },
  });
}

async function run(
  workspace: Workspace,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: workspace.dir,
    env: workspace.env(),
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
  child.stdin.end();
  const code = await new Promise<number>((resolve) =>
    child.on("close", (value) => resolve(value ?? 1)),
  );
  return { code, stdout, stderr };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("The CLI did not reach credential input.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function interruptWithOpenStdin(
  workspace: Workspace,
  args: readonly string[],
  reachedInput: () => boolean,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: workspace.dir,
    env: workspace.env(),
    stdio: ["pipe", "pipe", "pipe"],
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

  await waitUntil(reachedInput);
  child.kill("SIGINT");
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The CLI did not stop after credential input was interrupted."));
    }, 5_000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

it.each(["options", "add", "monitoring"] as const)(
  "returns 130 when %s credential stdin stays open and Ctrl-C arrives",
  async (command) => {
    const [platform, workspace] = await Promise.all([
      startPlatform(),
      makeWorkspace(),
    ]);
    try {
      await initialized(platform, workspace);

      let agentId = "";
      if (command !== "options") {
        const registered = await run(workspace, [
          "agent",
          "register",
          "--platform",
          "retell",
          "--name",
          "Receptionist",
        ]);
        expect(registered.code, registered.stderr).toBe(0);
        agentId = platform.registered.agents[0]?.id ?? "";
      }

      const before = platform.records.length;
      const args =
        command === "options"
          ? [
              "agent",
              "connection",
              "options",
              "--platform",
              "retell",
              "--credentials-stdin",
            ]
          : command === "add"
            ? [
                "agent",
                "connection",
                "add",
                "--agent",
                agentId,
                "--access",
                "retell-api-key",
                "--modality",
                "voice",
                "--retell-agent",
                "retell_agent_receptionist",
                "--credentials-stdin",
              ]
            : [
                "agent",
                "monitoring",
                "setup",
                "--agent",
                agentId,
                "--platform",
                "retell",
                "--retell-agent",
                "retell_agent_receptionist",
                "--credentials-stdin",
              ];
      const reachedInput = (): boolean => {
        const records = platform.records.slice(before);
        return command === "monitoring"
          ? records.some(
              (record) =>
                record.method === "GET" &&
                record.path === `/v1/agents/${agentId}`,
            )
          : records.some(
              (record) =>
                record.method === "GET" &&
                record.path === "/v1/connection-options",
            );
      };

      const result = await interruptWithOpenStdin(
        workspace,
        args,
        reachedInput,
      );

      expect(result.signal).toBeNull();
      expect(result.code).toBe(130);
      expect(result.stderr).toContain("interrupted");
      const records = platform.records.slice(before);
      expect(
        records.some(
          (record) =>
            record.method === "POST" &&
            (record.path === "/v1/agents:discover" ||
              record.path.endsWith("/connections") ||
              record.path === "/v1/monitoring/retell/start"),
        ),
      ).toBe(false);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  },
);
