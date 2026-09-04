/** Missing repository recovery through every built repository-scoped command. */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLI_ENTRY, makeWorkspace, type Workspace } from "./support/workspace.ts";

const run = promisify(execFile);

type Result = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

type CommandCase = {
  readonly command: string;
  readonly args: readonly string[];
};

const REPOSITORY_COMMANDS: readonly CommandCase[] = [
  { command: "pull", args: ["pull"] },
  { command: "push", args: ["push"] },
  {
    command: "agent register",
    args: ["agent", "register", "--platform", "retell"],
  },
  {
    command: "agent connection options",
    args: ["agent", "connection", "options", "--platform", "livekit"],
  },
  {
    command: "agent connection add",
    args: [
      "agent",
      "connection",
      "add",
      "--agent",
      "agt_missing",
      "--access",
      "retell-api-key",
      "--modality",
      "voice",
    ],
  },
  {
    command: "agent monitoring setup",
    args: [
      "agent",
      "monitoring",
      "setup",
      "--agent",
      "agt_missing",
      "--platform",
      "livekit",
    ],
  },
  {
    command: "agent monitoring stop",
    args: [
      "agent",
      "monitoring",
      "stop",
      "--agent",
      "agt_missing",
      "--platform",
      "livekit",
    ],
  },
  {
    command: "project api-key create",
    args: ["project", "api-key", "create", "--name", "Local development"],
  },
  { command: "persona list", args: ["persona", "list"] },
  {
    command: "suite create",
    args: ["suite", "create", "release-gate", "--name", "Release gate"],
  },
  { command: "suite delete", args: ["suite", "delete", "release-gate"] },
  {
    command: "test delete",
    args: ["test", "delete", "release-gate/books-a-visit.md"],
  },
  {
    command: "run create",
    args: [
      "run",
      "create",
      "release-gate",
      "--agent",
      "agt_missing",
      "--connection",
      "con_missing",
    ],
  },
  { command: "run cancel", args: ["run", "cancel", "run_missing"] },
] as const;

let workspace: Workspace;

beforeEach(async () => {
  workspace = await makeWorkspace();
});

afterEach(async () => {
  await workspace.remove();
});

async function egma(args: readonly string[]): Promise<Result> {
  try {
    const answer = await run(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env: workspace.env(),
    });
    return { ...answer, code: 0 };
  } catch (cause) {
    const failed = cause as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      code: failed.code ?? 1,
    };
  }
}

describe("a repository command without egma/config.yaml", () => {
  it.each(REPOSITORY_COMMANDS)(
    "$command names the missing file and suggests init before any network work",
    async ({ args }) => {
      const result = await egma(args);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("egma/config.yaml");
      expect(result.stderr).toMatch(/\begma init\b/u);
    },
  );

  it.each([
    { command: "pull", args: ["pull"] },
    {
      command: "Run creation",
      args: [
        "run",
        "create",
        "release-gate",
        "--agent",
        "agt_one",
        "--connection",
        "con_one",
      ],
    },
    {
      command: "monitoring setup",
      args: [
        "agent",
        "monitoring",
        "setup",
        "--agent",
        "agt_one",
        "--platform",
        "retell",
      ],
    },
  ])(
    "$command does not call a malformed config missing or suggest init",
    async ({ args }) => {
      const repositoryFolder = path.join(workspace.dir, "egma");
      await mkdir(repositoryFolder, { recursive: true });
      await writeFile(
        path.join(repositoryFolder, "config.yaml"),
        "format: broken\nplatform:\nproject:\nagents: []\n",
      );

      const result = await egma(args);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("config.yaml uses folder format broken");
      expect(result.stderr).not.toContain("There is no egma/config.yaml");
      expect(result.stderr).not.toContain("egma init");
    },
  );
});
