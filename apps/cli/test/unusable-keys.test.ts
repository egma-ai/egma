/**
 * Run each credential-reading command against unusable keys files.
 * Require a clear command refusal without overwriting the file, exposing parser
 * details, or emitting an unhandled stack trace.
 */

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createEgmaFolder, EMPTY_CONFIG } from "../src/folder/egma-folder.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, makeWorkspace, type Workspace } from "./support/workspace.ts";

/** Truncated mid-key, which is what an interrupted write leaves behind. */
const DAMAGED = '{\n  "version": 1,\n  "platforms": {\n    "https://one.example": {"ke';
const AGENT_ID = "agt_01K3XQ7M4E8YB2FVN0H9TZQWER";
const CONNECTION_ID = "con_01K3XQ7M4E8YB2FVN0H9TZQWES";

const REPRESENTATIVE_COMMANDS: readonly (readonly string[])[] = [
  ["login"],
  ["agent", "connection", "options", "--platform", "retell"],
  ["push"],
  ["pull"],
  [
    "run",
    "create",
    "release",
    "--agent",
    AGENT_ID,
    "--connection",
    CONNECTION_ID,
  ],
];

let platform: Platform;
let workspace: Workspace;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace();

  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      platform: { origin: platform.url },
      project: { id: platform.projectId, name: "Fixture project" },
      agents: [
        {
          name: "receptionist",
          id: AGENT_ID,
          platform: "retell",
          connections: [
            {
              name: "retell-1",
              id: CONNECTION_ID,
            },
          ],
        },
      ],
    },
  });

  await mkdir(workspace.egmaFolder, { recursive: true });
  await writeFile(workspace.credentialsFile, DAMAGED, "utf8");
});

afterEach(async () => {
  await platform.close();
  await workspace.remove();
});

async function egma(args: readonly string[]): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}> {
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
  const code = await new Promise<number>((resolve) => {
    child.on("close", (value) => resolve(value ?? 1));
  });
  return { stdout, stderr, code };
}

it.each(REPRESENTATIVE_COMMANDS)(
  "tells %s's caller what is wrong with the keys file instead of throwing at them",
  async (...command: string[]) => {
    const result = await egma([...command, "--cwd", workspace.dir]);
    const verb = command[0] as string;
    const shown = `${result.stdout}${result.stderr}`;

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("status:");
    expect(result.stderr).toContain(workspace.credentialsFile);
    expect(result.stderr).toContain("move it aside and sign in again");

    // None of Node's own words: no stack frames, no parser complaint, no dump
    // of the cause. A developer or coding agent gets one useful error sentence
    // on stderr and does not have to read a trace to find out what happened.
    expect(shown).not.toMatch(/^\s+at /mu);
    expect(shown).not.toContain("SyntaxError");
    expect(shown).not.toContain("[cause]");
    expect(shown).not.toContain("node:internal");
  },
);

it("leaves the damaged file exactly as it was, on every one of them", async () => {
  for (const command of REPRESENTATIVE_COMMANDS) {
    await egma([...command, "--cwd", workspace.dir]);
  }
  expect(await readFile(workspace.credentialsFile, "utf8")).toBe(DAMAGED);
});

/**
 * Verify a real command reports an unreadable but valid keys file.
 * Skip users whose privileges bypass the staged permission failure.
 */
it.skipIf(process.getuid?.() === 0)(
  "says the same thing about a keys file it cannot open",
  async () => {
    const readable = `${JSON.stringify(
      { version: 1, platforms: { "https://one.example": { key: "egma_sk_one" } } },
      null,
      2,
    )}\n`;
    await writeFile(workspace.credentialsFile, readable, "utf8");
    await chmod(workspace.credentialsFile, 0o000);

    try {
      // `login` writes and `push` reads, so both doors are checked.
      for (const verb of ["login", "push"]) {
        const result = await egma([verb, "--cwd", workspace.dir]);
        const shown = `${result.stdout}${result.stderr}`;

        expect(result.code, verb).toBe(1);
        expect(result.stdout, verb).not.toContain("status:");
        expect(result.stderr, verb).toContain(workspace.credentialsFile);
        expect(shown, verb).not.toMatch(/^\s+at /mu);
        expect(shown, verb).not.toContain("EACCES");
        expect(shown, verb).not.toContain("[cause]");
      }
    } finally {
      await chmod(workspace.credentialsFile, 0o600);
    }

    // And the key that was in there is still in there.
    expect(await readFile(workspace.credentialsFile, "utf8")).toBe(readable);
  },
);
