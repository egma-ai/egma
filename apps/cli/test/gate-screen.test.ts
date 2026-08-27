/**
 * The files arriving, and the gate over them, as a developer meets them on a
 * real terminal.
 *
 * Enter uploads what is on the list, and `q` closes the wizard leaving every
 * file where it is. A pseudo-terminal runs the built command and a headless
 * terminal emulator reads the screen a developer sees.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import {
  chooseNoExistingTests,
  chooseTesting,
  runInTerminal,
  showing,
  type TerminalRun,
} from "./support/pty.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  MANIFEST,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

// A real subprocess, a real terminal, a fixture platform and a fake provider,
// inside a run using every core: the budget is generous so that only a broken
// wizard can reach it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const KEY = "key_2e8a4c6b1d09f735a2c4";

const ONE_AGENT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_0001",
      agent_name: "order-line",
      channel: "chat",
      response_engine: { type: "retell-llm", llm_id: "llm_0001" },
    },
  ],
  llms: [{ llm_id: "llm_0001", general_prompt: "You answer the order line.\n" }],
};

/** The four tests in the first suite. */
const TESTS = [
  "quoted-a-price",
  "lost-the-order-number",
  "open-on-sunday",
  "asked-for-the-binder",
] as const;
const SUITE_DIRECTORY = "order-line-tests";

/**
 * The order the list is in: the folder's own, which is by file name, so two
 * runs of the same wizard show the same list in the same order.
 */
const IN_ORDER = [...TESTS].sort();

/** Test-only files that release a scripted coding agent after a frame is read. */
const RELEASE_WRITING = ".fake-agent-release-writing";
const RELEASE_FOLDER = ".fake-agent-release-folder";

let platform: Platform;
let workspace: Workspace;
let retell: FakeRetell | undefined;
let terminal: TerminalRun | undefined;

beforeEach(async () => {
  platform = await startPlatform();
  retell = await startFakeRetell(ONE_AGENT);
  workspace = await makeWorkspace({ "package.json": MANIFEST });
  await workspace.signIn(platform.url, platform.device.mint());
});

afterEach(async () => {
  // Waited for: the command is still writing its log into the folder that is
  // about to be removed.
  await terminal?.kill();
  terminal = undefined;
  await retell?.close();
  retell = undefined;
  await platform.close();
  await workspace.remove();
});

function fileFor(name: string): string {
  return [
    "---",
    "format: 4",
    `name: ${name}`,
    "---",
    "## Scenario",
    `Somebody rings the order line about ${name.replaceAll("-", " ")}.`,
    "## Expected behaviors",
    "1. The agent says the workshop's name.",
    "",
  ].join("\n");
}

function writes(name: string): FakeStep[] {
  return [
    { kind: "say", text: `egma:writing ${name}\n` },
    {
      kind: "write-file",
      path: `egma/tests/${SUITE_DIRECTORY}/${name}.md`,
      content: fileFor(name),
    },
    { kind: "say", text: `egma:wrote ${name}\n` },
  ];
}

/** The wizard, driven to the gate, with a scripted agent that writes four. */
async function toTheGate(
  env: NodeJS.ProcessEnv = {},
  writing: readonly FakeStep[] = [
    { kind: "say", text: `egma:plan ${TESTS.join(", ")}\n` },
    ...TESTS.flatMap((name) => writes(name)),
    { kind: "stop", reason: "end_turn" },
  ],
): Promise<TerminalRun> {
  const script = await workspace.script({
    steps: [
      { kind: "say", text: "egma:found framework retell-sdk\n" },
      { kind: "stop", reason: "end_turn" },
    ],
    stepsByTask: [{ contains: "## The words the agent is running on", steps: [...writing] }],
  });

  const run = runInTerminal({
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
    env: workspace.env({
      EGMA_RETELL_URL: retell?.url ?? "",
      EGMA_RETELL_API_KEY: KEY,
      ...env,
    }),
    cols: 100,
  });
  terminal = run;

  await showing(run, "Welcome to egma", "Press Enter to authenticate");
  run.write("\r");

  await showing(run, "[enter] begin", "[q] quit");
  run.write("\r");

  await chooseTesting(run);
  await showing(run, "Paste your Retell API key");
  run.write(`${KEY}\r`);

  // The provider offers the reach that matches this agent. Egma still requires
  // confirmation before it creates the connection.
  await showing(run, "How should Egma reach this agent?");
  run.write("\r");

  await chooseNoExistingTests(run);

  return run;
}

/** What the list waits on, and the shape it waits in. */
const GATE_HINTS = ["[q] quit"] as const;

/**
 * Enter at the gate, and out the other side of the run it starts.
 *
 * The gate is not the end of the walk any more: enter pushes the list and
 * starts a run over it, and the wizard leaves once the first trace result is ready.
 * Nothing here conducts a simulation, so the fixture is given something that
 * judges what the run queues.
 *
 * No skill is offered on this walk, because the coding agent is a command
 * rather than an agent egma has a skill convention for — which is why these
 * checks end at the run and not at a question about skills.
 */
async function enterAndLeave(run: TerminalRun): Promise<void> {
  const grading = gradeEveryRun(platform);
  run.write("\r");
  await run.exited;
  grading.stop();
}

async function testsInFolder(): Promise<string[]> {
  return (await readdir(path.join(workspace.dir, "egma", "tests", SUITE_DIRECTORY)))
    .filter((name) => name.endsWith(".md"))
    .sort();
}

describe("the files arriving", () => {
  it("shows the coding agent session while each test is written", async () => {
    // A real coding agent takes seconds per file. The scripted one stops on a
    // barrier instead: that makes this a frame the screen really held without
    // making the suite pay for a clock.
    const run = await toTheGate({}, [
      { kind: "say", text: `egma:plan ${TESTS.join(", ")}\n` },
      ...writes(TESTS[0]),
      { kind: "say", text: `egma:writing ${TESTS[1]}\n` },
      { kind: "wait-for-file", path: RELEASE_WRITING },
      ...writes(TESTS[1]),
      ...TESTS.slice(2).flatMap((name) => writes(name)),
      { kind: "stop", reason: "end_turn" },
    ]);

    // The screen shows the coding agent's own session and an honest file count.
    const pane = await showing(
      run,
      "Writing tests for your voice agent.",
      "This may take a couple of minutes.",
      `Wrote ${TESTS[0]}`,
      `Writing ${TESTS[1]}`,
      "Progress: 1/4",
    );
    expect(pane).toContain("Coding agent:");
    expect(pane).not.toContain("egma:wrote");
    expect(pane).not.toContain("egma:writing");

    // And it keeps moving until the list is the gate's list.
    await writeFile(path.join(workspace.dir, RELEASE_WRITING), "continue\n", "utf8");
    await showing(run, "4 tests", ...GATE_HINTS);
    run.write("q");
    expect(await run.exited).toBe(0);
  });

  it("shows each generated test once, then uploads exactly that list", async () => {
    // Every file here arrives twice over: as a marker line the agent wrote,
    // and as a file the folder poller finds a moment later. Both are the same
    // file, so the count is four and never eight — a developer reading "8/12"
    // off four files would be reading egma's bookkeeping, not their folder.
    const run = await toTheGate();

    const list = await showing(
      run,
      "4 tests",
      ...IN_ORDER,
      "0 mock tools written",
      "Press Enter to run.",
      ...GATE_HINTS,
    );
    expect(list).toContain("4 tests");

    // Eight rows would be the double count, and the screen holds only four names.
    for (const name of IN_ORDER) {
      expect(list.split(name).length - 1, name).toBe(1);
    }
    expect(list).not.toContain("[enter] run");
    expect(list).not.toContain("[e] edit first");

    await enterAndLeave(run);
    expect(await run.exited).toBe(0);
    expect(run.scrollback()).toContain("✓ Your first run is live");
    expect(run.scrollback()).toContain(
      "Tests are code now: egma/tests/ (committed). Edit them, then egma push.",
    );
    expect(platform.tests.tests.map((test) => test.name).sort()).toEqual([...TESTS].sort());
    for (const name of TESTS) {
      const held = await readFile(
        path.join(workspace.dir, "egma", "tests", SUITE_DIRECTORY, `${name}.md`),
        "utf8",
      );
      expect(held, name).toMatch(/^version: tstv_/mu);
    }
  });

  it("stops rather than hangs when Ctrl-C lands on the one question it asks", async () => {
    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:found framework retell-sdk\n" },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const run = runInTerminal({
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
      env: workspace.env({
        EGMA_RETELL_URL: retell?.url ?? "",
        EGMA_RETELL_API_KEY: KEY,
        VISUAL: "",
        EDITOR: "",
      }),
      cols: 100,
    });
    terminal = run;

    await showing(run, "Welcome to egma", "Press Enter to authenticate");
    run.write("\r");
    await showing(run, "[enter] begin", "[q] quit");
    run.write("\r");
    await chooseTesting(run);
    await showing(run, "Paste your Retell API key");
    run.write(`${KEY}\r`);

    // Text or phone. Not this check's subject, and not skippable
    // either: egma never picks one of the two for a developer.
    await showing(run, "How should Egma reach this agent?");
    run.write("\r");
    await showing(run, "Do you already have test cases", "› No", "[enter] choose this one");

    run.write("");

    // A question the flow is parked on ends with the signal, not only with a
    // keystroke, so nothing was generated and nothing hangs.
    expect(await run.exited).toBe(130);
    expect(run.scrollback().trim()).toContain("stopped before the task finished");
    expect(platform.tests.tests).toHaveLength(0);
  });

  it("stops on Ctrl-C while the files are still arriving, and says so", async () => {
    const run = await toTheGate({}, [
      { kind: "say", text: `egma:plan ${TESTS.join(", ")}\n` },
      ...writes(TESTS[0]),
      { kind: "say", text: `egma:writing ${TESTS[1]}\n` },
      { kind: "wait-for-file", path: ".fake-agent-never-released" },
      { kind: "stop", reason: "end_turn" },
    ]);

    await showing(
      run,
      "Writing tests for your voice agent.",
      `Wrote ${TESTS[0]}`,
      "Progress: 1/4",
    );
    run.write("");

    // The poller is a timer, so a wizard that left it running would never leave.
    // It does leave, on its own answer, with one honest line behind it — and the
    // line counts the file the agent had already written, because a folder a
    // developer was never told about is a half-truth.
    expect(await run.exited).toBe(130);
    expect(run.scrollback().trim()).toBe(
      "Egma stopped before the task finished, and shut node down. Your 1 test is in egma/tests/.",
    );

    // And what the agent had already written is still the developer's.
    expect(await testsInFolder()).toEqual([`${TESTS[0]}.md`]);
    expect(platform.tests.tests).toHaveLength(0);
  });

  it("fills in from the folder, when the agent says nothing at all", async () => {
    // A real coding agent writes the files and forgets the marker lines it was
    // asked for — and it may write them any way it likes. What every way has in
    // common is a file appearing in the folder, so the folder is what the pane
    // is drawn from and the developer is never left looking at nothing.
    const run = await toTheGate({}, [
      {
        kind: "write-file",
        path: `egma/tests/${SUITE_DIRECTORY}/${IN_ORDER[0] as string}.md`,
        content: fileFor(IN_ORDER[0] as string),
      },
      { kind: "wait-for-file", path: RELEASE_FOLDER },
      ...IN_ORDER.slice(1).map((name) => ({
        kind: "write-file" as const,
        path: `egma/tests/${SUITE_DIRECTORY}/${name}.md`,
        content: fileFor(name),
      })),
      { kind: "stop", reason: "end_turn" },
    ]);

    await showing(
      run,
      "Writing tests for your voice agent.",
      "Waiting for coding-agent activity.",
      "Progress: 1/4",
    );

    await writeFile(path.join(workspace.dir, RELEASE_FOLDER), "continue\n", "utf8");
    await showing(run, "4 tests", ...GATE_HINTS);
    run.write("q");
    expect(await run.exited).toBe(0);
  });
});

describe("the gate", () => {
  /**
   * Ctrl-C over the list is the same decision as `q`: nothing is running, the
   * files are written, and `q` is on the screen beside them. So it leaves the
   * same files and the same sentence about where they are — a line saying egma
   * had stopped a task and shut a coding agent down would be describing a run
   * that was already over.
   */
  it("says where the files are when Ctrl-C lands on the list", async () => {
    const run = await toTheGate();
    await showing(run, "4 tests", ...GATE_HINTS);

    run.write("");

    // Still an interruption to a shell, and still an honest line to a person.
    expect(await run.exited).toBe(130);
    expect(run.scrollback().trim()).toBe(
      "Egma stopped. Your 4 tests are in egma/tests/ — read them, then run egma push.",
    );

    expect(await testsInFolder()).toHaveLength(4);
    expect(platform.tests.tests).toHaveLength(0);
  });

  it("leaves every file where it is when the developer quits", async () => {
    const run = await toTheGate();
    await showing(run, "4 tests", ...GATE_HINTS);

    run.write("q");

    expect(await run.exited).toBe(0);
    // The line says where they are, because that is the only thing left to say.
    expect(run.scrollback().trim()).toBe(
      "Nothing was uploaded. Your 4 tests are in egma/tests/ — read them, then run egma push.",
    );

    expect(await testsInFolder()).toHaveLength(4);
    expect(platform.tests.tests).toHaveLength(0);
    // Nothing was pinned, because nothing was uploaded.
    const held = await readFile(
      path.join(workspace.dir, "egma", "tests", SUITE_DIRECTORY, `${TESTS[0]}.md`),
      "utf8",
    );
    expect(held).not.toContain("version:");
  });

});
