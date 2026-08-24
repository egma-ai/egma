/**
 * Ctrl-C, at four different moments, in a real terminal.
 *
 * A developer changes their mind at whatever point they are at, and the wizard
 * is at a different kind of moment at each of them: waiting on a browser with
 * nothing started, part way through a task with somebody else's process tree
 * running, looking at a list of files that are already on disk, and watching a
 * run that is going on the platform.
 *
 * Three things have to be true at every one of them, and they are what these
 * check:
 *
 * - **Nothing is left running.** The coding agent starts a process tree of its
 *   own, and ending only the process egma spawned would leave the rest behind.
 * - **Nothing is left in the repository without being said.** Files that were
 *   written are the developer's, and the line has to name where they are.
 * - **The line tells the truth about where it stopped**, and it is the only
 *   thing in scrollback.
 *
 * Those four moments have three endings between them, and which one a moment
 * gets is decided by what egma had really done by then rather than by which
 * key was pressed. A stop while egma is working stopped work. A stop at the
 * gate stopped nothing and left files. A stop at the run screen stopped
 * nothing at all: the tests are on egma and the suite is going without this
 * terminal, so the developer leaves with the address of a live run.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chooseTesting, runInTerminal, showing } from "./support/pty.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  RETELL_FIXTURE_REPO,
  isAlive,
  makeWorkspace,
  waitUntil,
  type Workspace,
} from "./support/workspace.ts";

// A real terminal, real subprocesses and two servers, inside a run using every
// core: the budget is generous so that only a broken wizard can reach it.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const CTRL_C = "";

const KEY = "key_71bc0e4d938a25f6c0ab";

const ACCOUNT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_quillfeather_order_line",
      agent_name: "order-line",
      channel: "chat",
      response_engine: { type: "retell-llm", llm_id: "llm_quillfeather" },
    },
  ],
  llms: [{ llm_id: "llm_quillfeather", general_prompt: "Answer the order line.\n" }],
};

let platform: Platform;
let retell: FakeRetell;
let workspace: Workspace;

beforeEach(async () => {
  platform = await startPlatform();
  retell = await startFakeRetell(ACCOUNT);
  workspace = await makeWorkspace({}, { from: RETELL_FIXTURE_REPO });
});

afterEach(async () => {
  await retell.close();
  await platform.close();
  await workspace.remove();
});

/** The wizard, in a terminal, driving the scripted agent at this script. */
function startWizard(script: string) {
  return runInTerminal({
    command: process.execPath,
    args: [
      CLI_ENTRY,
      "--url",
      platform.url,
      "--cwd",
      workspace.dir,
      "--",
      process.execPath,
      FAKE_AGENT,
      script,
    ],
    cwd: workspace.dir,
    env: workspace.env({ EGMA_RETELL_URL: retell.url }),
    cols: 100,
  });
}

/** Every test file the folder holds, or none when there is no folder. */
async function testsInFolder(): Promise<string[]> {
  return (await readdir(path.join(workspace.dir, "egma", "tests", "generated")).catch(
    () => [] as string[],
  )).filter((name) => name.endsWith(".md"));
}

/** The fragment only the write-the-tests task has, whatever it asks for. */
const GENERATE_TASK = "## The words the agent is running on";

/** Writing one file, announced the way the notes tell a coding agent to. */
function writes(name: string): FakeStep[] {
  return [
    { kind: "say", text: `egma:writing ${name}\n` },
    {
      kind: "write-file",
      path: `egma/tests/generated/${name}.md`,
      content: [
        "---",
        "format: 4",
        `name: ${name}`,
        "---",
        "## Scenario",
        `Somebody rings the order line about ${name.replaceAll("-", " ")}.`,
        "## Expected behaviors",
        "1. The agent says the workshop's name.",
        "",
      ].join("\n"),
    },
    { kind: "say", text: `egma:wrote ${name}\n` },
  ];
}

describe("Ctrl-C while the browser is being waited on", () => {
  it("stops without a task ever starting, and leaves nothing in the repository", async () => {
    // Nobody will approve this, and nothing should be waiting for them to.
    platform.device.pollEvery(1);

    const script = await workspace.script({ steps: [{ kind: "stop", reason: "end_turn" }] });
    const terminal = startWizard(script);

    try {
      await showing(terminal, "Egma is about to find", "[enter] begin");
      terminal.write("\r");

      // The login screen: a code to approve, an address it is already in, and
      // the wait filled with what egma worked out while the developer read the
      // intro. None of it was asked for and none of it is waited on.
      //
      // Every line is waited for rather than read off one screen and asserted
      // afterwards. The pane arrives on its own and a terminal paints a line at
      // a time, so a screen caught between two of them is a screen that is half
      // drawn — and a check that reads one is a check that fails on a fast day.
      await showing(
        terminal,
        "Code:",
        "Approve this code",
        "While you were away, Egma looked around:",
        "Coding agent   node",
        "Git            not a repository",
        "egma folder    none yet — Egma will make one",
      );

      terminal.write(CTRL_C);

      expect(await terminal.exited).toBe(130);
      expect(terminal.scrollback().trim()).toBe("Egma stopped before the task finished.");

      // Nothing was driven, so nothing was written and nothing was registered.
      expect(await testsInFolder()).toEqual([]);
      expect(platform.registered.agents).toHaveLength(0);
    } finally {
      await terminal.kill();
    }
  });
});

describe("Ctrl-C while the coding agent is working", () => {
  it("ends the agent's whole process tree and says it did", async () => {
    await workspace.signIn(platform.url, platform.device.mint());

    const script = await workspace.script({
      // The agent starts a process of its own, exactly as a real adapter starts
      // its engine. Ending only the process egma spawned would strand it.
      spawnChild: true,
      steps: [
        { kind: "tool-call", id: "t1", title: "Reading the repository" },
        { kind: "wait", ms: 120_000 },
        { kind: "stop", reason: "end_turn" },
      ],
    });
    const terminal = startWizard(script);

    try {
      await showing(terminal, "Egma is about to find", "[enter] begin");
      terminal.write("\r");
      await showing(terminal, "Reading the repository");

      const observed = JSON.parse(
        await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
      ) as { childPid: number | null };
      const childPid = observed.childPid;
      expect(childPid).not.toBeNull();
      expect(isAlive(childPid as number)).toBe(true);

      terminal.write(CTRL_C);

      expect(await terminal.exited).toBe(130);
      expect(terminal.scrollback().trim()).toBe(
        "Egma stopped before the task finished, and shut node down.",
      );

      // The agent's own process is gone, and so is the one it started.
      expect(await waitUntil(() => !isAlive(childPid as number), 10_000)).toBe(true);
      expect(await testsInFolder()).toEqual([]);
    } finally {
      await terminal.kill();
    }
  });
});

describe("Ctrl-C at the gate, with the files already written", () => {
  it("says how many tests are in the repository and pushes none of them", async () => {
    await workspace.signIn(platform.url, platform.device.mint());

    const names = ["open-on-sunday", "lost-the-order-number", "wants-it-by-friday"];
    const script = await workspace.script({
      spawnChild: true,
      steps: [
        { kind: "say", text: "egma:found framework retell-sdk\n" },
        { kind: "stop", reason: "end_turn" },
      ],
      stepsByTask: [
        {
          // Whatever size of suite egma asked for, this agent writes three and
          // stops. What reaches the gate is what is really on disk.
          contains: GENERATE_TASK,
          steps: [
            { kind: "say", text: `egma:plan ${names.join(", ")}\n` },
            ...names.flatMap((name) => writes(name)),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    const terminal = startWizard(script);

    try {
      await showing(terminal, "Egma is about to find", "[enter] begin");
      terminal.write("\r");

      await chooseTesting(terminal);
      await showing(terminal, "Paste your Retell API key");
      terminal.write(`${KEY}\r`);

      // This Retell chat agent supports text. Egma still requires confirmation.
      await showing(terminal, "How should Egma reach this agent?");
      terminal.write("\r");

      await showing(terminal, "Do you already have test cases");
      terminal.write("n");

      // The list, with every file on it, waiting on one keystroke.
      await showing(terminal, "3 tests generated", "[enter] run", ...names);

      terminal.write(CTRL_C);

      // The shell is told this was an interruption, and the line is told the
      // truth about what the interruption did: nothing was running here, so it
      // shut nothing down. It stopped, and the files are where they always were.
      expect(await terminal.exited).toBe(130);
      expect(terminal.scrollback().trim()).toBe(
        "Egma stopped. Your 3 tests are in egma/tests/ — read them, then run egma push.",
      );

      // The agent that wrote them, and the process it started, are both gone —
      // the task was over before the gate, and nothing was left holding on.
      const observed = JSON.parse(
        await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
      ) as { childPid: number | null };
      expect(observed.childPid).not.toBeNull();
      expect(await waitUntil(() => !isAlive(observed.childPid as number), 10_000)).toBe(true);

      // The files are exactly where the line says they are, and nothing was
      // uploaded: the developer stopped before the one keystroke that would
      // have put them on egma.
      expect((await testsInFolder()).sort()).toEqual(names.map((name) => `${name}.md`).sort());
      expect(platform.tests.tests).toHaveLength(0);
    } finally {
      await terminal.kill();
    }
  });
});

describe("Ctrl-C at the run screen, with the suite already going", () => {
  it("leaves the address of a live run, and answers the shell as a run that got there", async () => {
    await workspace.signIn(platform.url, platform.device.mint());

    const names = ["open-on-sunday", "lost-the-order-number", "wants-it-by-friday"];
    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:found framework retell-sdk\n" },
        { kind: "stop", reason: "end_turn" },
      ],
      stepsByTask: [
        {
          contains: GENERATE_TASK,
          steps: [
            { kind: "say", text: `egma:plan ${names.join(", ")}\n` },
            ...names.flatMap((name) => writes(name)),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    // Wide, because what is under check is lines rather than sentences: a
    // terminal wraps whatever will not fit, and a check that read a wrapped
    // line as two would be checking the terminal's width and not egma's.
    const terminal = runInTerminal({
      command: process.execPath,
      args: [
        CLI_ENTRY,
        "--url",
        platform.url,
        "--cwd",
        workspace.dir,
        "--",
        process.execPath,
        FAKE_AGENT,
        script,
      ],
      cwd: workspace.dir,
      env: workspace.env({ EGMA_RETELL_URL: retell.url }),
      cols: 200,
    });

    try {
      await showing(terminal, "Egma is about to find", "[enter] begin");
      terminal.write("\r");

      await chooseTesting(terminal);
      await showing(terminal, "Paste your Retell API key");
      terminal.write(`${KEY}\r`);

      // This Retell chat agent supports text. Egma still requires confirmation.
      await showing(terminal, "How should Egma reach this agent?");
      terminal.write("\r");

      await showing(terminal, "Do you already have test cases");
      terminal.write("n");

      await showing(terminal, "3 tests generated", "[enter] run");
      terminal.write("\r");

      // The run is on the platform, and no trace result is ready: this is
      // the developer stopping before the first result, which is the moment
      // the wizard would otherwise have waited for.
      await showing(terminal, "run run_", "3 simulations", "queued");
      const started = platform.running.runs[0];
      expect(started).toBeDefined();

      terminal.write(CTRL_C);

      // Nothing was stopped, so the shell is not told anything was. The tests
      // are on egma and the suite is queued there; the terminal going away
      // never had anything to do with it.
      expect(await terminal.exited).toBe(0);

      const lines = terminal
        .scrollback()
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line !== "");
      const address = `${platform.url}/runs/${started?.id ?? ""}`;

      expect(lines).toEqual([
        "✓ Your first run is live — no simulation result is ready yet (3 total).",
        address,
        "Tests are code now: egma/tests/ (committed). Edit them, then egma push.",
        'Hand your coding agent this: "Read egma/config.yaml, then egma --help — you can pull, push, and trigger runs from here."',
      ]);
      // No token rides the address, and none is anywhere in scrollback.
      expect(new URL(address).search).toBe("");
      expect(terminal.scrollback()).not.toContain("egma_sk_");
      // Not one word about egma having stopped, because egma did not.
      expect(terminal.scrollback()).not.toContain("stopped");

      expect(platform.tests.tests).toHaveLength(3);
      expect(platform.running.simulationsOf()).toHaveLength(3);
      expect(
        platform.running.simulationsOf().filter((one) => one.gradingState !== null),
      ).toHaveLength(0);
    } finally {
      await terminal.kill();
    }
  });
});
