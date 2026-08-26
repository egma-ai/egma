/**
 * The files arriving, and the gate over them, as a developer meets them on a
 * real terminal.
 *
 * Three keys, and all three are promises to a person rather than to a machine:
 * enter uploads what is on the list, `e` hands the terminal to their own editor
 * and takes it back, and `q` closes the wizard leaving every file where it is.
 * None of those can be checked without a terminal, so a pseudo-terminal runs
 * the built command and a headless terminal emulator reads its screen.
 *
 * The editor here is a short shell script rather than a person in vim. It
 * writes down every argument it was handed and adds a line to the file, which
 * is exactly what the checks need to know: egma split the command line the way
 * a shell would, it opened the right file, the developer's edit survived, and
 * the wizard came back. One of them takes the alternate screen the way vim
 * does, because "the wizard came back" is only worth checking against an editor
 * that painted over it.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import { chooseTesting, runInTerminal, showing, type TerminalRun } from "./support/pty.ts";
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

const VOICE_AGENT: FakeRetellScript = {
  ...ONE_AGENT,
  agents: ONE_AGENT.agents.map((agent) => ({ ...agent, channel: "voice" as const })),
};

/** Five, so the list is longer than the screen and browsing is a real thing. */
const TESTS = [
  "quoted-a-price",
  "lost-the-order-number",
  "open-on-sunday",
  "asked-for-the-binder",
  "rang-off-halfway",
] as const;

/**
 * The order the list is in: the folder's own, which is by file name, so two
 * runs of the same wizard show the same list in the same order.
 */
const IN_ORDER = [...TESTS].sort();

/** The number the agent under test answers, for the walk that ends in phone. */
const DIALLED = "+14155550111";

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
    { kind: "write-file", path: `egma/tests/generated/${name}.md`, content: fileFor(name) },
    { kind: "say", text: `egma:wrote ${name}\n` },
  ];
}

/** The wizard, driven to the gate, with a scripted agent that writes five. */
async function toTheGate(
  env: NodeJS.ProcessEnv = {},
  writing: readonly FakeStep[] = [
    { kind: "say", text: `egma:plan ${TESTS.join(", ")}\n` },
    ...TESTS.flatMap((name) => writes(name)),
    { kind: "stop", reason: "end_turn" },
  ],
  /**
   * Whether this walk uses a voice agent and confirms its phone connection.
   * The choice itself is `connect-screen.test.ts`'s subject.
   */
  overThePhone = false,
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
      // Whatever the person running the suite edits with is not what this
      // wizard opens, so both are set on purpose every time.
      VISUAL: "",
      EDITOR: "",
      ...env,
    }),
    cols: 100,
  });
  terminal = run;

  await showing(run, "[enter] begin", "[q] quit");
  run.write("\r");

  await chooseTesting(run);
  await showing(run, "Paste your Retell API key");
  run.write(`${KEY}\r`);

  // The provider offers the reach that matches this agent. Egma still requires
  // confirmation before it creates the connection.
  await showing(run, "How should Egma reach this agent?");
  if (overThePhone) {
    await showing(run, "\u203a Phone");
  }
  run.write("\r");

  await showing(run, "Do you already have test cases", "[n] none");
  run.write("n");

  return run;
}

/** What the list waits on, and the shape it waits in. */
const GATE_HINTS = ["[enter] run", "[e] edit first", "[q] quit"] as const;

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
  return (await readdir(path.join(workspace.dir, "egma", "tests", "generated")))
    .filter((name) => name.endsWith(".md"))
    .sort();
}

describe("the files arriving", () => {
  it("puts each one on screen as it is written, with what is left to come", async () => {
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

    // One written, one being written, the rest still to come, and the count.
    const pane = await showing(
      run,
      "Writing tests for your voice agent.",
      `◼ ${TESTS[0]}`,
      "written",
      `▶ ${TESTS[1]}`,
      "writing…",
      `◻ ${TESTS[2]}`,
      // Twelve is what egma asked this coding agent for, so twelve is what the
      // count is against. What really lands is what the gate shows.
      "Progress: 1/12",
    );
    expect(pane).toContain(`◻ ${TESTS[4]}`);

    // And it keeps moving until the list is the gate's list.
    await writeFile(path.join(workspace.dir, RELEASE_WRITING), "continue\n", "utf8");
    await showing(run, "5 tests generated", ...GATE_HINTS);
    run.write("q");
    expect(await run.exited).toBe(0);
  });

  it("shows each generated test once, then uploads exactly that list", async () => {
    // Every file here arrives twice over: as a marker line the agent wrote,
    // and as a file the folder poller finds a moment later. Both are the same
    // file, so the count is five and never ten — a developer reading "10/12"
    // off five files would be reading egma's bookkeeping, not their folder.
    const run = await toTheGate();

    const list = await showing(
      run,
      "5 tests generated",
      'suite "order-line tests"',
      IN_ORDER[0] as string,
      "no persona named",
      "more (↑↓ browse · e opens in $EDITOR)",
      "Run these against order-line over retell_chat_api-1 (Retell chat, chat)?",
      ...GATE_HINTS,
    );
    expect(list).toContain("5 tests generated");

    // Ten rows would be the double count, and the screen holds only five names.
    for (const name of IN_ORDER.slice(0, 3)) {
      expect(list.split(name).length - 1, name).toBe(1);
    }
    expect(list).toContain("… 2 more");
    expect(list).not.toContain(IN_ORDER[4] as string);
    expect(list.indexOf("[enter] run")).toBeLessThan(list.indexOf("[e] edit first"));
    expect(list.indexOf("[e] edit first")).toBeLessThan(list.indexOf("[q] quit"));
    expect(list).not.toContain("Every simulation dials");

    await enterAndLeave(run);
    expect(await run.exited).toBe(0);
    expect(run.scrollback()).toContain("✓ Your first run is live");
    expect(run.scrollback()).toContain(
      "Tests are code now: egma/tests/ (committed). Edit them, then egma push.",
    );
    expect(platform.tests.tests.map((test) => test.name).sort()).toEqual([...TESTS].sort());
    for (const name of TESTS) {
      const held = await readFile(
        path.join(workspace.dir, "egma", "tests", "generated", `${name}.md`),
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

    await showing(run, "[enter] begin", "[q] quit");
    run.write("\r");
    await chooseTesting(run);
    await showing(run, "Paste your Retell API key");
    run.write(`${KEY}\r`);

    // Text or phone. Not this check's subject, and not skippable
    // either: egma never picks one of the two for a developer.
    await showing(run, "How should Egma reach this agent?");
    run.write("\r");
    await showing(run, "Do you already have test cases", "[n] none");

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

    await showing(run, "Writing tests for your voice agent.", `▶ ${TESTS[1]}`);
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
        path: `egma/tests/generated/${IN_ORDER[0] as string}.md`,
        content: fileFor(IN_ORDER[0] as string),
      },
      { kind: "wait-for-file", path: RELEASE_FOLDER },
      ...IN_ORDER.slice(1, 3).map((name) => ({
        kind: "write-file" as const,
        path: `egma/tests/generated/${name}.md`,
        content: fileFor(name),
      })),
      { kind: "stop", reason: "end_turn" },
    ]);

    await showing(
      run,
      "Writing tests for your voice agent.",
      `◼ ${IN_ORDER[0] as string}`,
      "written",
      "Progress:",
    );

    await writeFile(path.join(workspace.dir, RELEASE_FOLDER), "continue\n", "utf8");
    await showing(run, "3 tests generated", ...GATE_HINTS);
    run.write("q");
    expect(await run.exited).toBe(0);
  });
});

describe("the gate", () => {
  /**
   * The keystroke over a phone connection is the expensive one in this product,
   * and the screen has to say so before it is pressed rather than after.
   *
   * A connection's name does not say what it is: `retell_chat_api-1` and
   * `phone_number-1` are both names the platform picks, and one of them dials a
   * real telephone twelve times. So the product label is on the screen beside
   * the name, and the number every simulation will ring is on the line under it — public by
   * construction, because a destination number is the half of a phone
   * connection that carries no credential at all.
   */
  it("names the kind of connection, and the number every simulation will dial", async () => {
    await retell?.close();
    retell = await startFakeRetell({
      ...VOICE_AGENT,
      numbers: [
        {
          phone_number: DIALLED,
          nickname: "order line",
          inbound_agents: [{ agent_id: "agent_0001", weight: 1 }],
        },
      ],
    });

    const run = await toTheGate({}, undefined, true);

    await showing(
      run,
      "5 tests generated",
      "Run these against order-line over phone_number-1 (Retell phone, voice)?",
      `Every simulation dials ${DIALLED}.`,
      ...GATE_HINTS,
    );
    run.write("q");
    expect(await run.exited).toBe(0);
  });

  /**
   * Ctrl-C over the list is the same decision as `q`: nothing is running, the
   * files are written, and `q` is on the screen beside them. So it leaves the
   * same files and the same sentence about where they are — a line saying egma
   * had stopped a task and shut a coding agent down would be describing a run
   * that was already over.
   */
  it("says where the files are when Ctrl-C lands on the list", async () => {
    const run = await toTheGate();
    await showing(run, "5 tests generated", ...GATE_HINTS);

    run.write("");

    // Still an interruption to a shell, and still an honest line to a person.
    expect(await run.exited).toBe(130);
    expect(run.scrollback().trim()).toBe(
      "Egma stopped. Your 5 tests are in egma/tests/ — read them, then run egma push.",
    );

    expect(await testsInFolder()).toHaveLength(5);
    expect(platform.tests.tests).toHaveLength(0);
  });

  it("leaves every file where it is when the developer quits", async () => {
    const run = await toTheGate();
    await showing(run, "5 tests generated", ...GATE_HINTS);

    run.write("q");

    expect(await run.exited).toBe(0);
    // The line says where they are, because that is the only thing left to say.
    expect(run.scrollback().trim()).toBe(
      "Nothing was uploaded. Your 5 tests are in egma/tests/ — read them, then run egma push.",
    );

    expect(await testsInFolder()).toHaveLength(5);
    expect(platform.tests.tests).toHaveLength(0);
    // Nothing was pinned, because nothing was uploaded.
    const held = await readFile(
      path.join(workspace.dir, "egma", "tests", "generated", `${TESTS[0]}.md`),
      "utf8",
    );
    expect(held).not.toContain("version:");
  });

  it("opens the selected test with editor arguments, then redraws after its alternate screen", async () => {
    const added = "2. The agent thanks the person.";
    const editor = await workspace.editor(added, { alternateScreen: true });
    const third = path.join(
      workspace.dir,
      "egma",
      "tests",
      "generated",
      `${IN_ORDER[2] as string}.md`,
    );

    const run = await toTheGate({ EDITOR: `${editor.command} --wait` });
    await showing(run, "5 tests generated", ...GATE_HINTS);

    // Down twice, so the file that opens is the third one and not the first.
    run.write("\u001B[B");
    run.write("\u001B[B");
    await showing(run, `› ${IN_ORDER[2] as string}`);

    run.write("e");

    // Waited for by what it does rather than by a clock: an editor draws
    // whatever it likes over the wizard, so the screen is no evidence that one
    // ran, and the file it was handed is.
    expect(await run.waitFor(() => existsSync(editor.opened))).toBe(true);
    const opened = (await readFile(editor.opened, "utf8")).trim().split("\n");
    expect(opened).toEqual(["--wait", third]);

    // Every line of the gate is drawn again. A partial diff would leave some of
    // the editor's alternate screen behind.
    const back = await showing(
      run,
      "5 tests generated",
      'suite "order-line tests"',
      IN_ORDER[0] as string,
      "Run these against order-line over retell_chat_api-1 (Retell chat, chat)?",
      ...GATE_HINTS,
    );
    expect(back).not.toContain("STAND-IN EDITOR HAS THE SCREEN");

    await enterAndLeave(run);
    expect(await run.exited).toBe(0);

    // What the developer's editor wrote is what egma uploaded.
    expect(platform.tests.tests.map((test) => test.name).sort()).toEqual(IN_ORDER);
    expect(await readFile(third, "utf8")).toContain(added);
  });

  it("says so rather than guessing when there is no editor to open", async () => {
    const run = await toTheGate();
    await showing(run, "5 tests generated", ...GATE_HINTS);

    run.write("e");

    await showing(run, "No editor is set. Set $EDITOR", ...GATE_HINTS);

    // Nothing was opened and nothing was lost: the list is still waiting.
    await enterAndLeave(run);
    expect(await run.exited).toBe(0);
    expect(platform.tests.tests).toHaveLength(5);
  });

  it("says which editor it could not start, and keeps the list waiting", async () => {
    const run = await toTheGate({ EDITOR: "egma-no-such-editor-on-this-machine" });
    await showing(run, "5 tests generated", ...GATE_HINTS);

    run.write("e");

    await showing(
      run,
      "Egma could not start egma-no-such-editor-on-this-machine",
      ...GATE_HINTS,
    );

    // The gate is intact: enter still does the one thing it was always for.
    await enterAndLeave(run);
    expect(await run.exited).toBe(0);
    expect(platform.tests.tests).toHaveLength(5);
  });

});
