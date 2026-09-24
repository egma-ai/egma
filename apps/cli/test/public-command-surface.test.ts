/** The public command grammar used by people and by coding agents following skills. */

import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLI_ENTRY,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

const run = promisify(execFile);

type Result = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

let workspace: Workspace;

beforeEach(async () => {
  workspace = await makeWorkspace();
});

afterEach(async () => {
  await workspace.remove();
});

async function egma(args: readonly string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env: workspace.env(),
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly code?: number;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: failure.code ?? 1,
    };
  }
}

describe("the skills-first public command surface", () => {
  it.each([
    {
      command: ["agent", "connection", "options", "--platform", "retell"],
      option: "--api-key",
    },
  ])(
    "refuses raw credential flag $option on `egma $command` without echoing its value",
    async ({ command, option }) => {
      const secret = "must-not-print-this-credential-value";
      const result = await egma([...command, `${option}=${secret}`]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(option);
      expect(result.stderr).not.toContain(secret);
    },
  );
});
