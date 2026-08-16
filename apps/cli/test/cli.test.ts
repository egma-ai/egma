/**
 * `Egma` as a developer runs it: the built entry point, in a real subprocess.
 */

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  MANIFEST,
  PRETEND_OLD_NODE,
  isAlive,
  makeWorkspace,
  waitUntil,
  type Workspace,
} from "./support/workspace.ts";

const run = promisify(execFile);
let platform: Platform;

/**
 * The built command, with the platform named on the command itself.
 *
 * `--url` on every invocation rather than a shell that names one once: a flag
 * on the command is the only way to name a platform, so a check that reached
 * this one any other way would be checking something Egma does not offer.
 */
async function egma(
  args: readonly string[],
  workspace: Workspace,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [CLI_ENTRY, "--url", platform.url, ...args],
      { cwd: workspace.dir, env: workspace.env() },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

describe("the Egma command", () => {
  let workspace: Workspace;

  beforeEach(async () => {
    platform = await startPlatform();
    workspace = await makeWorkspace({ "package.json": MANIFEST });
    // These checks are about driving a coding agent, so the machine they run on
    // is already signed in and login costs them nothing. Login itself is proved
    // in the checks that are about login.
    await workspace.signIn(platform.url);
  });

  afterEach(async () => {
    await platform.close();
    await workspace.remove();
  });

  it("refuses an old Node in plain words before it does anything else", async () => {
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
    // The refusal came first: not even --help was answered.
    expect(refused.stderr).not.toContain("Usage:");
  });

  it("prints what it can do, and what version it is", async () => {
    const help = await egma(["--help"], workspace);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(help.stdout).toContain("--coding-agent <id>");
    // The one answer a run with nobody watching cannot be asked for.
    expect(help.stdout).toContain("--existing-tests <path>");

    // Every verb, and for the run verb the two things a coding agent has to
    // know before it can act on one: how to start a run without waiting, and
    // what each number it answers with means.
    for (const verb of ["egma login", "egma connect", "egma init", "egma pull", "egma push"]) {
      expect(help.stdout, verb).toContain(verb);
    }
    expect(help.stdout).toContain("egma run [options]");
    expect(help.stdout).toContain("--no-follow");
    expect(help.stdout).toContain("What egma run answers with:");

    // The test seams are not product surface, so neither is offered: not the
    // one that starts a scripted coding agent, and not the one that stands an
    // address in for Egma's own.
    expect(help.stdout).not.toContain("-- <command>");
    expect(help.stdout).not.toContain("EGMA_TEST_DEFAULT_URL");

    // One explicit way to name a platform, and it is offered as one. The
    // whole-shell variable that used to sit beside it is a setting Egma no
    // longer has, and offering a setting that does nothing is worse than
    // offering none.
    expect(help.stdout).toContain("--url <address>");
    expect(help.stdout).not.toContain("EGMA_URL");
    // And what it does with init, which used to accept it and drop it.
    expect(help.stdout).toContain("egma/config.yaml");

    // The platform: line init prints is a fact about the repository, not about
    // the flag: plain init in a repository that is already bound prints it too,
    // so the help must not promise it only where --url was given.
    expect(help.stdout).toContain("adds a platform: line whenever this repository");
    expect(help.stdout).not.toContain("--url gave it");

    const version = await egma(["--version"], workspace);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("says so when handed an option it does not know", async () => {
    const result = await egma(["--turbo"], workspace);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--turbo");
  });

  it("refuses to run the wizard where there is no terminal to agree in", async () => {
    // Not a terminal: this is `npx Egma | tee log`, where the keystroke that
    // means yes can never be pressed.
    const result = await egma(["--cwd", workspace.dir], workspace);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("needs a terminal");
    expect(result.stderr).toContain("--headless");
    expect(result.stderr).toContain("--help");
    // Nothing was driven: no agent was started, and nothing was said about one.
    expect(result.stdout).toBe("");
  });

  it("drives the whole step, then stops plainly where a provider key is needed", async () => {
    const script = await workspace.script({
      steps: [
        {
          kind: "tool-call",
          id: "t1",
          title: "Read",
          locations: [{ path: "package.json" }],
        },
        { kind: "read-file", path: "package.json", recordAs: "manifest" },
        {
          kind: "say",
          text: [
            "egma:found framework retell-sdk",
            "egma:found prompts prompts/order-line.md",
            "",
          ].join("\n"),
        },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const result = await egma(
      ["--headless", "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
      workspace,
    );

    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toContain("◆ Read package.json");
    expect(lines).toContain("┊ Framework  retell-sdk");

    // Finding the agent is not reaching it. The walk goes on to ask for the
    // key that would reach it, and a run with nobody watching and nothing in
    // its environment has none to give — so it says that, and stops.
    expect(lines).toContain("Paste your Retell API key (Retell dashboard → Settings → API keys).");
    expect(result.code).toBe(1);
    expect(lines.at(-1)).toBe(
      "Egma could not finish: no Retell key was given, so there is nothing to test.",
    );
  });

  it("prints what to paste, and exits cleanly, with no coding agent to drive", async () => {
    const result = await egma(
      [
        "--headless",
        "--cwd",
        workspace.dir,
        "--",
        path.join(workspace.dir, "no-such-coding-agent"),
      ],
      workspace,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Open the coding agent you use, and paste this into it:");
    expect(result.stdout).toContain("Find the voice agent in this repository");
    expect(result.stdout.trimEnd().split("\n").at(-1)).toContain(
      "no coding agent on this machine",
    );
    // A message, not a crash.
    expect(result.stderr).toBe("");
  });

  it("prints the same message when the registry names an agent it cannot start", async () => {
    const result = await egma(
      ["--headless", "--cwd", workspace.dir, "--coding-agent", "not-a-real-agent"],
      workspace,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("not-a-real-agent");
    expect(result.stdout).toContain("Open the coding agent you use, and paste this into it:");
  });

  it("keeps the seam working that the tests themselves are driven by", async () => {
    // `-- <command>` is how a test starts a scripted agent in place of a real
    // one. It is not offered in the help text and it is not stable, but
    // everything offline rides on it — so it is checked.
    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:none There is no voice agent here.\n" },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const result = await egma(
      ["--headless", "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
      workspace,
    );

    expect(result.code).toBe(1);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
      "Egma found no voice agent to test. Run egma again where your agent is defined.",
    );
  });

  it("shuts the agent and everything it started down when it is interrupted", async () => {
    const script = await workspace.script({
      spawnChild: true,
      steps: [
        { kind: "tool-call", id: "t1", title: "Thinking about it" },
        { kind: "wait", ms: 60_000 },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        "--url",
        platform.url,
        "--headless",
        "--cwd",
        workspace.dir,
        "--",
        process.execPath,
        FAKE_AGENT,
        script,
      ],
      { cwd: workspace.dir, env: workspace.env() },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    expect(await waitUntil(() => stdout.includes("Thinking about it"))).toBe(true);

    const reportFile = path.join(workspace.dir, "fake-agent-report.json");
    const grandchild = (JSON.parse(await readFile(reportFile, "utf8")) as { childPid: number })
      .childPid;
    expect(isAlive(grandchild)).toBe(true);

    child.kill("SIGINT");
    const code = await new Promise<number>((resolve) => {
      child.on("close", (value) => resolve(value ?? 0));
    });

    expect(code).toBe(130);
    expect(stdout.trimEnd().split("\n").at(-1)).toContain("stopped before the task finished");
    expect(await waitUntil(() => !isAlive(grandchild))).toBe(true);
  });
});
