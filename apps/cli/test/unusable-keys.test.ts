/**
 * What every command does when this machine's keys file cannot be used.
 *
 * egma refuses to write over a keys file it cannot read, which is right — a
 * damaged file can be repaired and one egma has overwritten cannot. But a
 * refusal only counts as a refusal if it reaches the developer. Reaching them
 * as an unhandled exception means a Node stack trace, a `[cause]` dump of the
 * JSON parser's own words, and exit 1 in place of the verb's own answer, which
 * is neither readable by a person nor branchable by a coding agent.
 *
 * So it is checked here through real processes, on every verb that reads the
 * file, because only one of the five paths through `main` used to catch.
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
 * The other way a keys file stops a command: it is there, it is perfectly
 * well-formed, and this machine cannot open it.
 *
 * Told the same way as a damaged one, because it is the same fact about the
 * same file — and proved through the real command rather than reasoned about,
 * because the value of a refusal is entirely in whether it arrives.
 *
 * Skipped only for a user who can read anything, which cannot be staged for.
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
