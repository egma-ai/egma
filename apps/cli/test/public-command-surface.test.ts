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

function escapedForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

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
    ]) {
      expect(result.stdout, removedRoot).not.toContain(removedRoot);
    }
  });

  it.each([
    ["login"],
    ["logout"],
    ["init"],
    ["pull"],
    ["push"],
    ["agent"],
    ["agent", "register"],
    ["agent", "connection"],
    ["agent", "connection", "options"],
    ["agent", "connection", "add"],
    ["agent", "monitoring"],
    ["agent", "monitoring", "setup"],
    ["agent", "monitoring", "stop"],
    ["project"],
    ["project", "api-key"],
    ["project", "api-key", "create"],
    ["persona"],
    ["persona", "list"],
    ["suite"],
    ["suite", "create"],
    ["run"],
    ["run", "create"],
    ["run", "cancel"],
    ["self-host"],
    ["self-host", "up"],
  ])("prints focused help for `egma %s`", async (...words: string[]) => {
    const result = await egma([...words, "--help"]);
    const command = `egma ${words.join(" ")}`;

    expect(result, command).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout, command).toMatch(
      new RegExp(`Usage:\\s*${escapedForRegExp(command)}(?:\\s|$)`, "u"),
    );
  });

  it.each([
    { words: ["agent", "register"], named: ["--platform", "livekit"] },
    { words: ["agent", "connection", "add"], named: ["--agent", "agt_one"] },
  ])(
    "refuses the removed --metadata option on `egma $words`",
    async ({ words, named }) => {
      // The LiveKit room's metadata field is gone from the catalog. What a test
      // hands the job is the test's own env now, and it rides the test's file.
      const help = await egma([...words, "--help"]);
      expect(help.stdout).not.toContain("--metadata");

      const result = await egma([
        ...words,
        ...named,
        "--access",
        "livekit-project-credentials",
        "--modality",
        "voice",
        "--metadata",
        "must-not-be-repeated",
      ]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--metadata");
      expect(result.stderr).not.toContain("must-not-be-repeated");
    },
  );

  it.each(["connect", "monitoring", "livekit", "validate", "status", "personas"])(
    "refuses the removed root command `%s`",
    async (command) => {
      const result = await egma([command]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(command);
    },
  );

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
    ["pull"],
    ["push"],
    ["agent", "register", "--platform", "retell"],
    ["agent", "connection", "options", "--platform", "retell"],
    ["agent", "connection", "add", "--agent", "agt_one"],
    ["agent", "monitoring", "setup", "--agent", "agt_one", "--platform", "retell"],
    ["agent", "monitoring", "stop", "--agent", "agt_one"],
    ["project", "api-key", "create", "--name", "Local agent"],
    ["persona", "list"],
    ["suite", "create", "release", "--name", "Release"],
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
    expect(login.code).toBe(4);
    expect(login.stdout).toContain("status: unreachable");

    const logout = await egma(["logout", "--url", url]);
    expect(logout).toMatchObject({ code: 0, stderr: "" });
    expect(logout.stdout).toContain(`url: ${url}`);
    expect(logout.stdout).toContain("status: already-logged-out");

    const init = await egma(["init", "--url", url]);
    expect(init.code).not.toBe(1);
    expect(init.stdout).toContain(`url: ${url}`);
    expect(init.stdout).toContain("status: not-signed-in");
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
