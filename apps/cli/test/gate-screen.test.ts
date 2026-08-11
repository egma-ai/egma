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
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import { runInTerminal, showing, type TerminalRun } from "./support/pty.ts";
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
      response_engine: { type: "retell-llm", llm_id: "llm_0001" },
    },
  ],
  llms: [{ llm_id: "llm_0001", general_prompt: "You answer the order line.\n" }],
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
    { kind: "write-file", path: `egma/tests/${name}.md`, content: fileFor(name) },
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
   * Whether to walk to a phone connection rather than a text one. The choosing
   * itself is `connect-screen.test.ts`'s subject; here it is only the ground
   * the gate stands on, so it is one extra keystroke and nothing more.
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
    args: [CLI_ENTRY, "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
    cwd: workspace.dir,
    env: workspace.env({
      EGMA_URL: platform.url,
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

  await showing(run, "Paste your Retell API key");
  run.write(`${KEY}\r`);

  // Text or phone. Not this check's subject, and not skippable
  // either: egma never picks one of the two for a developer.
  await showing(run, "How should egma reach this agent?");
  if (overThePhone) {
    run.write("\u001B[B");
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
 * starts a run over it, and the wizard leaves once a first verdict has landed.
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
  return (await readdir(path.join(workspace.dir, "egma", "tests"))).sort();
}

describe("the files arriving", () => {
  it("puts each one on screen as it is written, with what is left to come", async () => {
    // A real coding agent takes seconds per file. The pauses here are what a
    // developer would be watching through, and they are what make each state
    // of the list a thing the screen really held rather than a frame nobody
    // could have seen.
    const run = await toTheGate({}, [
      { kind: "say", text: `egma:plan ${TESTS.join(", ")}\n` },
      ...writes(TESTS[0]),
      { kind: "say", text: `egma:writing ${TESTS[1]}\n` },
      { kind: "wait", ms: 1_500 },
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
    await showing(run, "5 tests generated", ...GATE_HINTS);
    run.write("q");
    expect(await run.exited).toBe(0);
  });

  it("counts a file once when the agent both announces it and writes it", async () => {
    // Every file here arrives twice over: as a marker line the agent wrote,
    // and as a file the folder poller finds a moment later. Both are the same
    // file, so the count is five and never ten — a developer reading "10/12"
    // off five files would be reading egma's bookkeeping, not their folder.
    const run = await toTheGate();

    const pane = await showing(run, "5 tests generated", ...GATE_HINTS);
    expect(pane).toContain("5 tests generated");

    // Ten rows would be the double count, and the screen holds only five names.
    for (const name of IN_ORDER.slice(0, 3)) {
      expect(pane.split(name).length - 1, name).toBe(1);
    }

    await enterAndLeave(run);
    expect(await run.exited).toBe(0);
    expect(platform.tests.tests).toHaveLength(5);
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
      args: [CLI_ENTRY, "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
      cwd: workspace.dir,
      env: workspace.env({
        EGMA_URL: platform.url,
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
    await showing(run, "Paste your Retell API key");
    run.write(`${KEY}\r`);

    // Text or phone. Not this check's subject, and not skippable
    // either: egma never picks one of the two for a developer.
    await showing(run, "How should egma reach this agent?");
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
      { kind: "wait", ms: 60_000 },
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
      "egma stopped before the task finished, and shut node down. Your 1 test is in egma/tests/.",
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
      ...IN_ORDER.slice(0, 3).flatMap((name) => [
        {
          kind: "write-file" as const,
          path: `egma/tests/${name}.md`,
          content: fileFor(name),
        },
        { kind: "wait" as const, ms: 800 },
      ]),
      { kind: "stop", reason: "end_turn" },
    ]);

    await showing(
      run,
      "Writing tests for your voice agent.",
      `◼ ${IN_ORDER[0] as string}`,
      "written",
      "Progress:",
    );

    await showing(run, "3 tests generated", ...GATE_HINTS);
    run.write("q");
    expect(await run.exited).toBe(0);
  });
});

describe("the gate", () => {
  it("shows the list with its personas, and says how many more there are", async () => {
    const run = await toTheGate();

    const list = await showing(
      run,
      "5 tests generated",
      'suite "first-suite"',
      IN_ORDER[0] as string,
      "default persona",
      "more (↑↓ browse · e opens in $EDITOR)",
      "Run these against order-line over retell-1 (retell, chat)?",
      ...GATE_HINTS,
    );

    // The screen is smaller than the list, so it says so rather than pretending.
    expect(list).toContain("… 2 more");
    // Three rows, in the folder's own order, and the rest browsed to.
    for (const name of IN_ORDER.slice(0, 3)) expect(list).toContain(name);
    expect(list).not.toContain(IN_ORDER[4] as string);
    // The keys are offered in the order the transcript settled on.
    expect(list.indexOf("[enter] run")).toBeLessThan(list.indexOf("[e] edit first"));
    expect(list.indexOf("[e] edit first")).toBeLessThan(list.indexOf("[q] quit"));
  });

  /**
   * The keystroke over a phone connection is the expensive one in this product,
   * and the screen has to say so before it is pressed rather than after.
   *
   * A connection's name does not say what it is: `retell-1` and `phone-1` are
   * both names the platform picks, and one of them dials a real telephone
   * twelve times. So the kind is on the screen beside the name, and the number
   * every simulation will ring is on the line under it — public by
   * construction, because a destination number is the half of a phone
   * connection that carries no credential at all.
   */
  it("names the kind of connection, and the number every simulation will dial", async () => {
    await retell?.close();
    retell = await startFakeRetell({
      ...ONE_AGENT,
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
      "Run these against order-line over phone-1 (phone, voice)?",
      `Every simulation dials ${DIALLED}.`,
      ...GATE_HINTS,
    );
    run.write("q");
    expect(await run.exited).toBe(0);
  });

  /**
   * And the line is about the connection rather than decoration on every gate:
   * a connection that dials nowhere says nothing about dialling, so a developer
   * never reads a number that no simulation is going to ring.
   */
  it("says nothing about dialling when the connection dials nowhere", async () => {
    const run = await toTheGate();

    const list = await showing(run, "5 tests generated", ...GATE_HINTS);

    expect(list).toContain("Run these against order-line over retell-1 (retell, chat)?");
    expect(list).not.toContain("Every simulation dials");
    run.write("q");
    expect(await run.exited).toBe(0);
  });

  it("uploads exactly what was on the list when enter is pressed", async () => {
    const run = await toTheGate();
    await showing(run, "5 tests generated", ...GATE_HINTS);

    await enterAndLeave(run);

    expect(await run.exited).toBe(0);
    // Enter is the end of the gate and the start of the run: the line left
    // behind is about the run, and it names where the files are anyway.
    expect(run.scrollback()).toContain("✓ Your first run is live");
    expect(run.scrollback()).toContain(
      "Tests are code now: egma/tests/ (committed). Edit them, then egma push.",
    );

    // On the platform, and pinned in the files, which is what makes the next
    // push checkable.
    expect(platform.tests.tests.map((test) => test.name).sort()).toEqual([...TESTS].sort());
    for (const name of TESTS) {
      const held = await readFile(
        path.join(workspace.dir, "egma", "tests", `${name}.md`),
        "utf8",
      );
      expect(held, name).toMatch(/^version: tstv_/mu);
    }
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
      "egma stopped. Your 5 tests are in egma/tests/ — read them, then run egma push.",
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
      path.join(workspace.dir, "egma", "tests", `${TESTS[0]}.md`),
      "utf8",
    );
    expect(held).not.toContain("version:");
  });

  it("browses to a test, opens it in $EDITOR, and comes back to the list", async () => {
    const added = "2. The agent thanks the person.";
    const editor = await workspace.editor(added);
    const third = path.join(workspace.dir, "egma", "tests", `${IN_ORDER[2] as string}.md`);

    const run = await toTheGate({ EDITOR: editor.command });
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
    expect(opened).toEqual([third]);

    // The wizard is drawn again after the editor has gone, which is the whole
    // of the promise: the terminal was handed over and taken back.
    await showing(run, "5 tests generated", ...GATE_HINTS);

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

  /**
   * `$EDITOR` is a command line and not a command. `code --wait` and `emacs -nw`
   * are both ordinary settings, and a wizard that spawned the whole string as
   * one binary name would find nothing on this machine called `code --wait`.
   */
  it("honours an $EDITOR that carries arguments of its own", async () => {
    const added = "2. The agent thanks the person.";
    const editor = await workspace.editor(added);
    const first = path.join(workspace.dir, "egma", "tests", `${IN_ORDER[0] as string}.md`);

    const run = await toTheGate({ EDITOR: `${editor.command} --wait` });
    await showing(run, "5 tests generated", ...GATE_HINTS);

    run.write("e");

    expect(await run.waitFor(() => existsSync(editor.opened))).toBe(true);
    const given = (await readFile(editor.opened, "utf8")).trim().split("\n");
    // The flag was passed on as a flag, and the file arrived after it.
    expect(given).toEqual(["--wait", first]);

    await showing(run, "5 tests generated", ...GATE_HINTS);
    await enterAndLeave(run);
    expect(await run.exited).toBe(0);
    expect(await readFile(first, "utf8")).toContain(added);
  });

  /**
   * An editor that takes the whole terminal is the ordinary case, not the odd
   * one: vim, emacs and nano all paint over whatever was there. The promise the
   * gate makes is that the wizard comes back afterwards, and only a terminal
   * can say whether it did.
   */
  it("comes back drawn whole after an editor that took the alternate screen", async () => {
    const added = "2. The agent thanks the person.";
    const editor = await workspace.editor(added, { alternateScreen: true });
    const first = path.join(workspace.dir, "egma", "tests", `${IN_ORDER[0] as string}.md`);

    const run = await toTheGate({ EDITOR: editor.command });
    await showing(run, "5 tests generated", ...GATE_HINTS);

    run.write("e");
    expect(await run.waitFor(() => existsSync(editor.opened))).toBe(true);

    // Every line of the gate, not just its first: a half-diffed frame would
    // show the heading and leave the rest as whatever the editor painted.
    const back = await showing(
      run,
      "5 tests generated",
      'suite "first-suite"',
      IN_ORDER[0] as string,
      "Run these against order-line over retell-1 (retell, chat)?",
      ...GATE_HINTS,
    );
    expect(back).not.toContain("STAND-IN EDITOR HAS THE SCREEN");

    await enterAndLeave(run);
    expect(await run.exited).toBe(0);
    expect(await readFile(first, "utf8")).toContain(added);
  });

  it("says which editor it could not start, and keeps the list waiting", async () => {
    const run = await toTheGate({ EDITOR: "egma-no-such-editor-on-this-machine" });
    await showing(run, "5 tests generated", ...GATE_HINTS);

    run.write("e");

    await showing(
      run,
      "egma could not start egma-no-such-editor-on-this-machine",
      ...GATE_HINTS,
    );

    // The gate is intact: enter still does the one thing it was always for.
    await enterAndLeave(run);
    expect(await run.exited).toBe(0);
    expect(platform.tests.tests).toHaveLength(5);
  });

  /**
   * A file egma will not push is not a file egma hides. Both reasons it holds
   * one back — nothing to check, and nothing it could read — are named on the
   * same screen, beside the tests that are going up.
   */
  it("names the files it is holding back, and pushes the rest", async () => {
    const unfalsifiable = [
      "---",
      "name: nothing-to-check",
      "---",
      "## Scenario",
      "Somebody rings about nothing in particular.",
      "## Expected behaviors",
      "",
    ].join("\n");
    const broken = [
      "---",
      "name: half-written",
      "personas: [somebody-in-a-hurry",
      "---",
      "## Scenario",
      "Somebody rings and the file was never finished.",
      "## Expected behaviors",
      "1. The agent says the workshop's name.",
      "",
    ].join("\n");

    const run = await toTheGate({}, [
      ...writes(TESTS[0]),
      {
        kind: "write-file",
        path: "egma/tests/nothing-to-check.md",
        content: unfalsifiable,
      },
      { kind: "say", text: "egma:wrote nothing-to-check\n" },
      { kind: "write-file", path: "egma/tests/half-written.md", content: broken },
      { kind: "say", text: "egma:wrote half-written\n" },
      { kind: "stop", reason: "end_turn" },
    ]);

    // One test on the list, and both of the others named under it with what to
    // do about them.
    await showing(
      run,
      "1 test generated",
      "egma/tests/half-written.md",
      "egma could not read it",
      "egma/tests/nothing-to-check.md",
      "no expected behaviors",
      ...GATE_HINTS,
    );

    await enterAndLeave(run);
    expect(await run.exited).toBe(0);

    // The good one went up; neither of the others did, and both are still on
    // disk exactly as they were written.
    expect(platform.tests.tests.map((test) => test.name)).toEqual([TESTS[0]]);
    expect(await testsInFolder()).toEqual([
      "half-written.md",
      "nothing-to-check.md",
      `${TESTS[0]}.md`,
    ]);
    const tests = path.join(workspace.dir, "egma", "tests");
    expect(await readFile(path.join(tests, "half-written.md"), "utf8")).toBe(broken);
    expect(await readFile(path.join(tests, "nothing-to-check.md"), "utf8")).toBe(unfalsifiable);
  });

  /**
   * The one refusal egma cannot see coming, met on a real terminal.
   *
   * A file naming a persona reads perfectly well; whether egma holds a persona
   * of that name is the platform's own business. So the refusal lands after the
   * keystroke, and the list comes back rather than the run going ahead on a
   * list nobody agreed to. Every key it offers still does what it says: `e`
   * opens the file that is holding things up, and enter over the list as it now
   * stands is consent to run without it.
   */
  it("puts the list back when the platform turns a test away, and keeps every key", async () => {
    const named = [
      "---",
      "name: wanted-it-by-friday",
      "personas: [in-a-hurry]",
      "---",
      "## Scenario",
      "Somebody rings the order line wanting it by Friday.",
      "## Expected behaviors",
      "1. The agent says the workshop's name.",
      "",
    ].join("\n");
    const refused = path.join(workspace.dir, "egma", "tests", "wanted-it-by-friday.md");
    const added = "2. The agent thanks the person.";
    const editor = await workspace.editor(added);

    const run = await toTheGate({ EDITOR: editor.command }, [
      ...writes(TESTS[0]),
      { kind: "write-file", path: "egma/tests/wanted-it-by-friday.md", content: named },
      { kind: "say", text: "egma:wrote wanted-it-by-friday\n" },
      { kind: "stop", reason: "end_turn" },
    ]);

    // Both are ordinary rows: nothing on this side can tell that one of them is
    // about to be refused.
    await showing(run, "2 tests generated", TESTS[0], "wanted-it-by-friday", ...GATE_HINTS);
    run.write("\r");

    // The platform said no, so the list is back — one test on it, and the other
    // named under it in the platform's own words.
    await showing(
      run,
      "1 test generated",
      "egma/tests/wanted-it-by-friday.md",
      'egma has no persona called "in-a-hurry"',
      ...GATE_HINTS,
    );

    // Down onto the file that is holding things up, and `e` opens that one.
    run.write("\u001B[B");
    run.write("e");
    expect(await run.waitFor(() => existsSync(editor.opened))).toBe(true);
    expect((await readFile(editor.opened, "utf8")).trim().split("\n")).toEqual([refused]);

    // The editor left the persona alone, so enter over this list is agreement
    // to run without it — and the run starts, over what the platform took.
    await showing(run, "1 test generated", ...GATE_HINTS);
    await enterAndLeave(run);

    expect(await run.exited).toBe(0);
    expect(run.scrollback()).toContain("✓ Your first run is live");
    expect(platform.tests.tests.map((test) => test.name)).toEqual([TESTS[0]]);

    // Both files are the developer's. The refused one carries their own edit
    // and no pin, because nothing on egma was ever made from it.
    expect(await testsInFolder()).toEqual([`${TESTS[0]}.md`, "wanted-it-by-friday.md"]);
    const kept = await readFile(refused, "utf8");
    expect(kept).toContain(added);
    expect(kept).not.toContain("version:");
  });
});
