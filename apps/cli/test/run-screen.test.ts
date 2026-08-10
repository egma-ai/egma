/**
 * The run, the last question, and the one thing left in scrollback — as a
 * developer meets them on a real terminal.
 *
 * Everything after the gate is a promise about a screen: one line per
 * simulation moving, the first verdict marked where the eye is, three keys for
 * the skill offer, and a block of plain text that survives the alternate screen
 * being thrown away. None of those can be checked without a terminal, so a
 * pseudo-terminal runs the built command and a headless terminal emulator reads
 * its screen.
 *
 * The run's lifecycle is scripted from the check rather than waited for. A real
 * run is a simulator speaking with a real voice agent; here the fixture is told
 * "this one is running, this one passed", which is what makes each state of the
 * list a thing the screen really held rather than a frame nobody could have
 * seen.
 *
 * The home is pointed at a throwaway folder throughout, so nothing here can
 * write a skill into the home of whoever is running the suite.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { runInTerminal, showing, type TerminalRun } from "./support/pty.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  MANIFEST,
  filesUnder,
  makeWorkspace,
  waitUntil,
  type Workspace,
} from "./support/workspace.ts";

// A real subprocess, a real terminal, a fixture platform and a fake provider,
// inside a run using every core: the budget is generous so that only a broken
// wizard can reach it.
// The suite grew past eighty files when the public API's own tests joined it,
// and a whole-walk check under that much company timed out at sixty seconds
// while passing alone in twenty. The waits inside are event-driven, so a
// bigger budget costs a healthy run nothing.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

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

/** Three, so a first verdict can land while two are still moving. */
const TESTS = ["quoted-a-price", "lost-the-order-number", "open-on-sunday"] as const;

let platform: Platform;
let workspace: Workspace;
let retell: FakeRetell | undefined;
let terminal: TerminalRun | undefined;
/** The home this run's coding agent keeps its configuration in. */
let home: string;

beforeEach(async () => {
  platform = await startPlatform();
  retell = await startFakeRetell(ONE_AGENT);
  workspace = await makeWorkspace({ "package.json": MANIFEST });
  home = path.join(workspace.dir, "pretend-home");
  await mkdir(home, { recursive: true });
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

/**
 * The wizard, walked all the way through the gate, with the run created and
 * every simulation queued on the platform.
 *
 * The coding agent is named as well as commanded: the command is what egma
 * starts, and the name is what egma calls it — which is what decides where a
 * skill for it would go.
 */
async function toTheRun(cols = 100): Promise<TerminalRun> {
  const script = await workspace.script({
    steps: [
      { kind: "say", text: "egma:found framework retell-sdk\n" },
      { kind: "stop", reason: "end_turn" },
    ],
    stepsByTask: [
      {
        contains: "## The words the agent is running on",
        steps: [
          { kind: "say", text: `egma:plan ${TESTS.join(", ")}\n` },
          ...TESTS.flatMap((name) => writes(name)),
          { kind: "stop", reason: "end_turn" },
        ],
      },
    ],
  });

  const run = runInTerminal({
    command: process.execPath,
    args: [
      CLI_ENTRY,
      "--cwd",
      workspace.dir,
      "--coding-agent",
      "claude-acp",
      "--",
      process.execPath,
      FAKE_AGENT,
      script,
    ],
    cwd: workspace.dir,
    env: workspace.env({
      EGMA_URL: platform.url,
      EGMA_RETELL_URL: retell?.url ?? "",
      EGMA_RETELL_API_KEY: KEY,
      // The home a global skill would land in. Never the real one.
      HOME: home,
      VISUAL: "",
      EDITOR: "",
    }),
    cols,
  });
  terminal = run;

  await showing(run, "[enter] begin", "[q] quit");
  run.write("\r");

  await showing(run, "Paste your Retell API key");
  run.write(`${KEY}\r`);

  await showing(run, "Do you already have test cases", "[n] none");
  run.write("n");

  await showing(run, `${TESTS.length} tests generated`, "[enter] run");
  run.write("\r");

  // The push happened, the run was created, and it is queued on the platform.
  await waitUntil(() => platform.running.runs.length > 0, 30_000);
  return run;
}

/** What the skill offer waits on, and the shape it waits in. */
const OFFER_HINTS = ["[p] project", "[g] global", "[s] skip"] as const;

/** Where a skill lands, under whichever tree. */
const SKILL_PATH = path.join(".claude", "skills", "egma", "SKILL.md");

describe("the run screen", () => {
  it("shows one line per simulation, moving, and marks the first verdict", async () => {
    const run = await toTheRun();

    // Every simulation is on screen the moment the run exists, queued.
    await showing(run, "run run_", `${TESTS.length} simulations`, TESTS[0], "queued");

    // One at a time, with pauses a developer would be watching through, so
    // each of these is a frame the screen really held.
    platform.running.advance({ simulation: TESTS[0], status: "claimed" });
    await showing(run, `▶ ${TESTS[0]}`, "dialing…");

    platform.running.advance({ simulation: TESTS[0], status: "running" });
    await showing(run, `▶ ${TESTS[0]}`, "in progress");

    platform.running.advance({ simulation: TESTS[1], status: "claimed" });
    platform.running.advance({ simulation: TESTS[1], status: "running" });
    await showing(run, `▶ ${TESTS[1]}`, "in progress");

    // And then the moment the whole walk is timed against.
    platform.running.advance({
      simulation: TESTS[0],
      status: "completed",
      verdict: "passed",
    });
    const landed = await showing(
      run,
      `◼ ${TESTS[0]}`,
      "passed",
      `✓ First verdict: ${TESTS[0]} passed`,
    );
    expect(landed).toContain("passed 1");
    expect(landed).toContain("waiting 2");
    // The other two are still moving, and the screen says the suite is not
    // waiting on this terminal.
    expect(landed).toContain("The suite keeps running on egma");
  });

  /**
   * The glossary rule, on the screen a developer actually reads: four verdicts,
   * four words. A test egma could not run is never drawn as a test that failed.
   */
  it("draws skipped and errored as themselves, never as failed", async () => {
    const run = await toTheRun();
    await showing(run, "run run_");

    platform.running.advance({ simulation: TESTS[0], status: "claimed" });
    platform.running.advance({ simulation: TESTS[0], status: "running" });
    platform.running.advance({
      simulation: TESTS[0],
      status: "completed",
      verdict: "skipped",
      reason: "this test needs DTMF, and this connection has none",
    });
    platform.running.advance({ simulation: TESTS[1], status: "claimed" });
    platform.running.advance({
      simulation: TESTS[1],
      status: "failed",
      verdict: "errored",
      reason: "the agent never joined",
    });

    const screen = await showing(
      run,
      `◼ ${TESTS[0]}`,
      "skipped",
      `◼ ${TESTS[1]}`,
      "errored",
      "skipped 1",
      "errored 1",
    );
    expect(screen).toContain("failed 0");
    // The first verdict is the first one that landed, whatever it was.
    expect(screen).toContain(`✓ First verdict: ${TESTS[0]} skipped`);
  });

  /**
   * The wizard does not wait for the suite. One verdict is the whole of what
   * it waits for; the last question comes next, with two simulations still
   * going.
   */
  it("moves on after the first verdict, with the rest still running", async () => {
    const run = await toTheRun();
    await showing(run, "run run_");

    platform.running.advance({ simulation: TESTS[0], status: "claimed" });
    platform.running.advance({ simulation: TESTS[0], status: "running" });
    platform.running.advance({
      simulation: TESTS[0],
      status: "completed",
      verdict: "passed",
    });

    await showing(run, "Install the egma skill into Claude Code", ...OFFER_HINTS);

    // On the platform, the suite is exactly where it was: one judged, two not.
    const held = platform.running.simulationsOf();
    expect(held.filter((one) => one.verdict !== null)).toHaveLength(1);
    expect(held.filter((one) => one.status === "queued")).toHaveLength(2);
  });
});

describe("the skill offer and what is left behind", () => {
  /**
   * Wide, because the lines under check here are lines rather than sentences.
   * A terminal wraps whatever will not fit, and a check that read a wrapped
   * line as two would be checking the terminal's width and not egma's output.
   */
  const WIDE = 200;

  /** The wizard, driven as far as the offer, with one verdict landed. */
  async function toTheOffer(): Promise<TerminalRun> {
    const run = await toTheRun(WIDE);
    await showing(run, "run run_");

    platform.running.advance({ simulation: TESTS[0], status: "claimed" });
    platform.running.advance({ simulation: TESTS[0], status: "running" });
    platform.running.advance({
      simulation: TESTS[0],
      status: "completed",
      verdict: "passed",
    });

    await showing(run, "Install the egma skill into Claude Code", ...OFFER_HINTS);
    return run;
  }

  it("says where each key would write before either key is pressed", async () => {
    const run = await toTheOffer();

    const offer = await showing(run, "writes nothing at all");
    expect(offer).toContain(path.join(workspace.dir, SKILL_PATH));
    expect(offer).toContain(path.join(home, SKILL_PATH));
    // Nothing has been written yet, whatever the screen is showing.
    expect(existsSync(path.join(workspace.dir, SKILL_PATH))).toBe(false);
    expect(existsSync(path.join(home, SKILL_PATH))).toBe(false);
  });

  it("writes the skill into the repository on [p], and says so in scrollback", async () => {
    const run = await toTheOffer();
    run.write("p");

    expect(await run.exited).toBe(0);

    const landed = path.join(workspace.dir, SKILL_PATH);
    expect(await readFile(landed, "utf8")).toContain("name: egma");
    expect(existsSync(path.join(home, SKILL_PATH))).toBe(false);

    const left = run.scrollback();
    expect(left).toContain(landed);
    expect(left).toContain("Commit it");
  });

  it("writes the skill into the home on [g], leaving the repository alone", async () => {
    const before = await filesUnder(workspace.dir);
    const run = await toTheOffer();
    run.write("g");

    expect(await run.exited).toBe(0);

    const landed = path.join(home, SKILL_PATH);
    expect(await readFile(landed, "utf8")).toContain("name: egma");
    expect(await filesUnder(workspace.dir)).not.toContain(SKILL_PATH);
    // The repository gained only what the walk was always going to write.
    expect(before.length).toBeLessThan((await filesUnder(workspace.dir)).length);

    expect(run.scrollback()).toContain(landed);
  });

  /**
   * Skip is a first-class answer, proved by a sweep of both trees rather than
   * by the absence of an error: not a directory, not an empty file, nothing.
   */
  it("leaves the machine untouched on [s], and still says so", async () => {
    const run = await toTheOffer();
    const homeBefore = await filesUnder(home);
    run.write("s");

    expect(await run.exited).toBe(0);

    expect(await filesUnder(home)).toEqual(homeBefore);
    expect(existsSync(path.join(workspace.dir, ".claude"))).toBe(false);
    expect(existsSync(path.join(home, ".claude"))).toBe(false);

    const left = run.scrollback();
    expect(left).toContain("Nothing was installed.");
    expect(left).toContain("egma --help");
  });

  /**
   * The exit block is the whole promise about scrollback: the alternate screen
   * is thrown away, and these lines are what a developer scrolls back to.
   */
  it("leaves the address, the tests and the handoff, each alone on its line", async () => {
    const run = await toTheOffer();
    run.write("s");
    expect(await run.exited).toBe(0);

    const lines = run
      .scrollback()
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line !== "");

    const runId = platform.running.runs[0]?.id ?? "";
    const address = `${platform.url}/runs/${runId}`;

    // The address is a line, and the whole of that line — a triple-click takes
    // it and gets exactly the address.
    expect(lines).toContain(address);
    expect(lines.some((line) => line.includes(address) && line !== address)).toBe(false);
    // And nothing rides on it. The browser is already signed in from the
    // approval earlier in this same walk, so no token has to.
    expect(new URL(address).search).toBe("");
    expect(run.scrollback()).not.toContain("egma_sk_");

    expect(lines).toContain(
      "Tests are code now: egma/tests/ (committed). Edit them, then egma push.",
    );
    expect(lines).toContain(
      'Hand your coding agent this: "Read egma/config.yaml, then egma --help — you can pull, push, and trigger runs from here."',
    );
    expect(lines.some((line) => line.startsWith("✓ Your first run is live"))).toBe(true);
  });
});
