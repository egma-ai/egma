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

function flagsIn(text: string): readonly string[] {
  return [...new Set(text.match(/--[a-z][a-z-]*/gu) ?? [])].sort();
}

const APPROVED_FLAGS = [
  { words: ["login"], flags: ["--cwd", "--url"] },
  { words: ["logout"], flags: ["--cwd", "--url"] },
  { words: ["init"], flags: ["--cwd", "--project", "--url"] },
  { words: ["pull"], flags: ["--cwd"] },
  { words: ["push"], flags: ["--cwd"] },
  { words: ["agent", "register"], flags: ["--cwd", "--name", "--platform"] },
  {
    words: ["agent", "connection", "options"],
    flags: ["--agent", "--credentials-stdin", "--cwd", "--platform"],
  },
  {
    words: ["agent", "connection", "add"],
    flags: [
      "--access",
      "--agent",
      "--credentials-stdin",
      "--cwd",
      "--livekit-agent-name",
      "--livekit-token-endpoint",
      "--livekit-url",
      "--modality",
      "--name",
      "--retell-agent",
      "--retell-phone-number",
    ],
  },
  {
    words: ["agent", "monitoring", "setup"],
    flags: ["--agent", "--credentials-stdin", "--cwd", "--platform", "--retell-agent"],
  },
  {
    words: ["agent", "monitoring", "stop"],
    flags: ["--agent", "--cwd", "--platform"],
  },
  { words: ["project", "api-key", "create"], flags: ["--cwd", "--name"] },
  { words: ["persona", "list"], flags: ["--cwd"] },
  { words: ["suite", "create"], flags: ["--cwd", "--name"] },
  { words: ["suite", "delete"], flags: ["--cwd"] },
  { words: ["test", "delete"], flags: ["--cwd"] },
  {
    words: ["run", "create"],
    flags: ["--agent", "--connection", "--cwd", "--name"],
  },
  { words: ["run", "cancel"], flags: ["--cwd"] },
  { words: ["self-host", "up"], flags: ["--cwd"] },
] as const;

describe("the skills-first public command surface", () => {
  it("publishes only the approved root command tree", async () => {
    const result = await egma(["--help"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    for (const command of [
      "egma login",
      "egma logout",
      "egma init",
      "egma pull",
      "egma push",
      "egma agent",
      "egma project",
      "egma persona",
      "egma suite",
      "egma test",
      "egma run",
      "egma self-host",
    ]) {
      expect(result.stdout, command).toContain(command);
    }

    for (const removedRoot of [
      "egma connect",
      "egma monitoring",
      "egma livekit",
      "egma validate",
      "egma status",
      "egma personas",
      "egma mock-tool",
      "egma mock-tools",
      "egma worker",
      "egma follow",
      "egma ci",
    ]) {
      expect(result.stdout, removedRoot).not.toContain(removedRoot);
    }
  });

  it.each(APPROVED_FLAGS)(
    "publishes exactly the approved flags for `egma $words`",
    async ({ words, flags }) => {
      const result = await egma([...words, "--help"]);

      expect(result, words.join(" ")).toMatchObject({ code: 0, stderr: "" });
      expect(flagsIn(result.stdout), words.join(" ")).toEqual([...flags].sort());
    },
  );

  it("explains the required platform flag in Connection-options help", async () => {
    const result = await egma(["agent", "connection", "options", "--help"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(
      "--platform <retell|livekit>  Agent platform whose Connection choices to list.",
    );
  });

  it.each([
    { option: "--json", tail: [] },
    { option: "--idempotency-key", tail: ["must-not-be-repeated"] },
    { option: "--no-follow", tail: [] },
    { option: "--allow-phone-call", tail: [] },
    { option: "--worker-entrypoint", tail: ["must-not-be-repeated"] },
    {
      option: "--worker-dependency-manifest",
      tail: ["must-not-be-repeated"],
    },
    { option: "--worker-dispatch-name", tail: ["must-not-be-repeated"] },
  ])("refuses the removed option $option", async ({ option, tail }) => {
    const result = await egma([
      "run",
      "create",
      "release",
      "--agent",
      "agt_one",
      "--connection",
      "con_one",
      option,
      ...tail,
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(option);
    expect(result.stderr).not.toContain("must-not-be-repeated");
  });

  it.each([
    { option: "--access", tail: ["retell-api-key"] },
    { option: "--modality", tail: ["voice"] },
    { option: "--connection-name", tail: ["Primary"] },
    { option: "--retell-agent", tail: ["agent_retell"] },
    { option: "--phone-number", tail: ["+14155550100"] },
    { option: "--retell-phone-number", tail: ["+14155550100"] },
    { option: "--livekit-url", tail: ["wss://example.livekit.cloud"] },
    { option: "--dispatch-name", tail: ["receptionist"] },
    { option: "--livekit-agent-name", tail: ["receptionist"] },
    { option: "--token-endpoint", tail: ["https://example.com/token"] },
    { option: "--livekit-token-endpoint", tail: ["https://example.com/token"] },
    { option: "--metadata", tail: ["{}"] },
    { option: "--livekit-metadata", tail: ["{}"] },
    { option: "--credentials-stdin", tail: [] },
  ])(
    "keeps Connection option $option off agent register",
    async ({ option, tail }) => {
      const result = await egma([
        "agent",
        "register",
        "--platform",
        "retell",
        option,
        ...tail,
      ]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(option);
      expect(result.stderr).not.toContain(tail[0] ?? "must-not-be-repeated");
    },
  );

  it.each([
    { option: "--platform", tail: ["retell"] },
    { option: "--connection-name", tail: ["Primary"] },
    { option: "--phone-number", tail: ["+14155550100"] },
    { option: "--dispatch-name", tail: ["receptionist"] },
    { option: "--token-endpoint", tail: ["https://example.com/token"] },
    { option: "--metadata", tail: ["{}"] },
    // Connection metadata now belongs to each Test's Env, not the Connection.
    { option: "--livekit-metadata", tail: ["{}"] },
  ])(
    "refuses the removed Connection option $option",
    async ({ option, tail }) => {
      const result = await egma([
        "agent",
        "connection",
        "add",
        "--agent",
        "agt_one",
        "--access",
        "retell-api-key",
        "--modality",
        "voice",
        option,
        ...tail,
      ]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(option);
      expect(result.stderr).not.toContain(tail[0]);
    },
  );

  it.each([
    {
      command: ["agent", "connection", "options", "--platform", "retell"],
      option: "--api-key",
    },
    {
      command: [
        "agent",
        "connection",
        "add",
        "--agent",
        "agt_one",
        "--access",
        "retell-api-key",
        "--modality",
        "chat",
      ],
      option: "--retell-api-key",
    },
    {
      command: [
        "agent",
        "monitoring",
        "setup",
        "--agent",
        "agt_one",
        "--platform",
        "retell",
      ],
      option: "--api-secret",
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

  it.each([
    ["pull"],
    ["push"],
    ["agent", "register", "--platform", "retell"],
    ["agent", "connection", "options", "--platform", "retell"],
    ["agent", "connection", "add", "--agent", "agt_one"],
    ["agent", "monitoring", "setup", "--agent", "agt_one", "--platform", "retell"],
    ["agent", "monitoring", "stop", "--agent", "agt_one", "--platform", "retell"],
    ["project", "api-key", "create", "--name", "Local agent"],
    ["persona", "list"],
    ["suite", "create", "release", "--name", "Release"],
    ["suite", "delete", "release"],
    ["test", "delete", "release/books-a-visit.md"],
    ["run", "create", "release", "--agent", "agt_one", "--connection", "con_one"],
    ["run", "cancel", "run_one"],
  ])("refuses --url for the repository command `egma %s`", async (...args: string[]) => {
    const result = await egma([...args, "--url", "https://must-not-be-used.example"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--url");
    expect(result.stderr).not.toContain("must-not-be-used.example");
  });

  it("accepts --url for login, logout, and init", async () => {
    const url = "http://127.0.0.1:1";

    const login = await egma(["login", "--url", url]);
    expect(login.code).toBe(1);
    expect(login.stdout).toContain(`Signing in to ${url}.`);
    expect(login.stderr).toContain(url);
    expect(login.stdout).not.toContain("status:");

    const logout = await egma(["logout", "--url", url]);
    expect(logout).toMatchObject({ code: 0, stderr: "" });
    expect(logout.stdout).toContain(`Logging out from ${url}.`);
    expect(logout.stdout).toContain("This machine is already logged out.");

    const init = await egma(["init", "--url", url]);
    expect(init.code).toBe(1);
    expect(init.stdout).toBe("");
    expect(init.stderr).toContain(url);
    expect(init.stderr).toContain("egma login");
  });

  it("requires both an Agent and a Connection to create a Run", async () => {
    const noAgent = await egma([
      "run",
      "create",
      "release",
      "--connection",
      "con_one",
    ]);
    expect(noAgent.code).toBe(1);
    expect(noAgent.stdout).toBe("");
    expect(noAgent.stderr).toContain("--agent");

    const noConnection = await egma([
      "run",
      "create",
      "release",
      "--agent",
      "agt_one",
    ]);
    expect(noConnection.code).toBe(1);
    expect(noConnection.stdout).toBe("");
    expect(noConnection.stderr).toContain("--connection");
  });
});
