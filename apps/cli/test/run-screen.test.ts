/**
 * The run, the last question, and the one thing left in scrollback — as a
 * developer meets them on a real terminal.
 *
 * Everything after the gate is a promise about a screen: one line per
 * simulation moving, the first terminal trace result marked, three keys for
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
import {
  startPlatform,
  type FixtureGrade,
  type Platform,
} from "./support/fixture-platform/index.ts";
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
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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

/** Four, so a first result can be ready while three are still moving. */
const TESTS = [
  "quoted-a-price",
  "lost-the-order-number",
  "open-on-sunday",
  "asked-for-the-binder",
] as const;
const SUITE_DIRECTORY = "order-line-tests";

const EXPECTED_BEHAVIORS = [
  "confirms the new time back before finishing",
  "checks that an afternoon next week is acceptable",
  "keeps the existing booking until the new time is confirmed",
  "does not create a second booking",
] as const;

const EXPECTED_BEHAVIORS_GRADE: FixtureGrade = {
  projectGraderId: "pgr_expected_behaviors",
  graderDefinitionId: "gdf_expected_behaviors",
  graderDefinitionVersion: 1,
  graderName: "expected_behaviors",
  score: 0.75,
  details: {
    rationale: "Three of four expected behaviors were present.",
    assertions: EXPECTED_BEHAVIORS.map((behavior, at) => ({
      key: `behavior_${String(at + 1)}`,
      score: at === EXPECTED_BEHAVIORS.length - 1 ? 0 : 1,
      rationale:
        at === EXPECTED_BEHAVIORS.length - 1
          ? "The transcript did not prove that it avoided a second booking."
          : `The transcript supports: ${behavior}`,
      ...(at === EXPECTED_BEHAVIORS.length - 1
        ? {}
        : { citedSpanIds: [`span_agent_${String(at + 1)}`] }),
    })),
  },
  passThreshold: 0.62,
  result: "passed",
  gradedAt: "2026-01-01T00:01:00.000Z",
};

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
    "format: 4",
    `name: ${name}`,
    "---",
    "## Scenario",
    `Somebody rings the order line about ${name.replaceAll("-", " ")}.`,
    "## Expected behaviors",
    ...EXPECTED_BEHAVIORS.map(
      (behavior, at) => `${String(at + 1)}. ${behavior}`,
    ),
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

/**
 * The wizard, walked all the way through the gate, with the run created and
 * every simulation queued on the platform.
 *
 * The coding agent is named as well as commanded: the command is what egma
 * starts, and the name is what egma calls it — which is what decides where a
 * skill for it would go.
 */
async function toTheRun(cols = 100, rows = 30): Promise<TerminalRun> {
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
      "--url",
      platform.url,
      "--cwd",
      workspace.dir,
      "--coding-agent",
      "claude",
      "--",
      process.execPath,
      FAKE_AGENT,
      script,
    ],
    cwd: workspace.dir,
    env: workspace.env({
      EGMA_RETELL_URL: retell?.url ?? "",
      EGMA_RETELL_API_KEY: KEY,
      // The home a global skill would land in. Never the real one.
      HOME: home,
      VISUAL: "",
      EDITOR: "",
    }),
    cols,
    rows,
  });
  terminal = run;

  await showing(run, "Welcome to egma", "Press Enter to authenticate");
  run.write("\r");

  await showing(run, "[enter] begin", "[q] quit");
  run.write("\r");

  await chooseTesting(run);
  await showing(run, "Paste your Retell API key");
  run.write(`${KEY}\r`);

  // Nothing starts ticked — one lane dials a real telephone — so the text
  // lane is ticked with space before enter confirms the pick.
  await showing(run, "How should Egma test this agent?");
  run.write(" ");
  await showing(run, "[x] Text");
  run.write("\r");

  await chooseNoExistingTests(run);

  await showing(run, `${TESTS.length} tests`, "Press Enter to run.");
  run.write("\r");

  // The push happened, the run was created, and it is queued on the platform.
  await waitUntil(() => platform.running.runs.length > 0, 30_000);
  return run;
}

/** What the skill offer waits on, and the shape it waits in. */
const OFFER_HINTS = ["[p] project", "[g] global", "[s] skip"] as const;

/** Where the standard installer writes the skill and Claude Code's alias. */
const SKILL_PATH = path.join(".agents", "skills", "egma", "SKILL.md");
const INTEGRATION_SKILL_PATH = path.join(
  ".agents",
  "skills",
  "integrate-egma",
  "SKILL.md",
);
const CLAUDE_SKILL_LINK = path.join(".claude", "skills", "egma");

describe("the run screen", () => {
  it("shows one Expected behaviors grade, its four assertion details, and one combined score", async () => {
    const run = await toTheRun(200, 45);

    // Every simulation is on screen the moment the run exists, queued.
    const started = platform.running.runs[0];
    expect(started).toBeDefined();
    const resultsUrl = `${platform.url}/projects/${platform.projectId}/runs/${started!.id}`;
    await showing(
      run,
      "run run_",
      `${TESTS.length} simulations`,
      `Results: ${resultsUrl}`,
      TESTS[0],
      "queued",
      "[enter] open results in browser",
    );
    expect(run.raw()).toContain(
      `\u001B]8;;${resultsUrl}\u001B\\${resultsUrl}\u001B]8;;\u001B\\`,
    );

    run.write("\r");
    await showing(run, "Opened results in your browser.");

    // One at a time. Each check waits for the screen event, so each state is a
    // frame the screen really held without a fixed pause.
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
    });
    await showing(run, `▶ ${TESTS[0]}`, "waiting to grade");
    platform.running.setGrading({
      simulation: TESTS[0],
      state: "complete",
      grades: [EXPECTED_BEHAVIORS_GRADE],
      combinedScore: 0.75,
    });
    const landed = await showing(
      run,
      `First result: ${TESTS[0]}`,
      "Combined score 0.75",
      "Expected behaviors",
      "score 0.75",
      "pass threshold 0.62",
      "Three of four expected behaviors were present.",
      "Assertion 01",
      "Assertion 04",
      EXPECTED_BEHAVIORS[0],
      EXPECTED_BEHAVIORS[3],
      "The transcript did not prove that it avoided a second booking.",
    );
    // The result stays visible while the final choice waits. It is not a frame
    // that disappears before a developer can read it.
    expect(landed).toContain(`First result: ${TESTS[0]}`);
    expect(landed.match(/Assertion \d{2}/gu)).toHaveLength(4);
    expect(landed).not.toMatch(/overall verdict|\bgate\b|\brequired\b|latency/iu);

    const held = platform.running.simulationsOf();
    expect(held.filter((one) => one.gradingState === "complete")).toHaveLength(1);
    expect(held.filter((one) => one.gradingState === null)).toHaveLength(3);
    expect(held.filter((one) => one.status === "running")).toHaveLength(1);
    expect(held.filter((one) => one.status === "queued")).toHaveLength(2);

    // The terminal stays with the complete run. Finish the other simulations,
    // then the skill offer replaces the run screen.
    platform.running.advance({ simulation: TESTS[1], status: "completed" });
    platform.running.setGrading({ simulation: TESTS[1], state: "not_requested" });
    for (const test of TESTS.slice(2)) {
      platform.running.advance({ simulation: test, status: "claimed" });
      platform.running.advance({ simulation: test, status: "running" });
      platform.running.advance({ simulation: test, status: "completed" });
      platform.running.setGrading({ simulation: test, state: "not_requested" });
    }
    await showing(run, "Install 3 Egma skills into Claude Code", ...OFFER_HINTS);
  });

  /**
   * The execution states, on the screen a developer actually reads. A
   * simulation that stopped is not drawn as one that failed, and an execution
   * failure is not counted as a grading result.
   */
  it("draws each terminal execution state without inventing a grading result", async () => {
    const run = await toTheRun();
    await showing(run, "run run_");

    platform.running.advance({ simulation: TESTS[0], status: "claimed" });
    platform.running.advance({ simulation: TESTS[0], status: "running" });
    platform.running.advance({
      simulation: TESTS[0],
      status: "completed",
    });
    platform.running.advance({ simulation: TESTS[1], status: "claimed" });
    platform.running.advance({
      simulation: TESTS[1],
      status: "failed",
      reason: "the agent never joined",
    });
    platform.running.advance({ simulation: TESTS[2], status: "canceled" });
    platform.running.advance({ simulation: TESTS[3], status: "canceled" });

    const screen = await showing(run, "execution 4/4 finished", "grading 0/1 terminal");
    expect(screen).toContain(TESTS[0]);
    expect(screen).toContain("waiting to grade");
    expect(screen).toContain(TESTS[1]);
    expect(screen).toContain("did not run");
    expect(screen).toContain(TESTS[2]);
    expect(screen).toContain("stopped");
    expect(screen).toContain("execution 4/4 finished");
    expect(screen).toContain("grading 0/1 terminal");
  });
});

describe("the skill offer and what is left behind", () => {
  /**
   * Wide, because the lines under check here are lines rather than sentences.
   * A terminal wraps whatever will not fit, and a check that read a wrapped
   * line as two would be checking the terminal's width and not egma's output.
   */
  const WIDE = 200;

  /** The wizard, driven as far as the offer, with the complete run ready. */
  async function toTheOffer(): Promise<TerminalRun> {
    const run = await toTheRun(WIDE);
    await showing(run, "run run_");

    for (const test of TESTS) {
      platform.running.advance({ simulation: test, status: "claimed" });
      platform.running.advance({ simulation: test, status: "running" });
      platform.running.advance({ simulation: test, status: "completed" });
      platform.running.setGrading({ simulation: test, state: "not_requested" });
    }

    await showing(run, "Egma skills into Claude Code", ...OFFER_HINTS);
    return run;
  }

  it("writes the skills into the repository on [p], and says so in scrollback", async () => {
    const run = await toTheOffer();
    run.write("p");

    expect(await run.exited).toBe(0);

    const landed = path.join(workspace.dir, SKILL_PATH);
    expect(await readFile(landed, "utf8")).toContain("name: egma");
    // Every public skill, not only the one that drives the command.
    expect(
      await readFile(path.join(workspace.dir, INTEGRATION_SKILL_PATH), "utf8"),
    ).toContain("name: integrate-egma");
    expect(existsSync(path.join(workspace.dir, CLAUDE_SKILL_LINK))).toBe(true);
    expect(existsSync(path.join(home, SKILL_PATH))).toBe(false);

    const left = run.scrollback();
    expect(left).toContain("3 Egma skills are in this repository.");
    expect(left).toContain("./.agents/skills/egma");
    expect(left).toContain("Commit all of it");
    // The second thing a project install puts in the repository is named too.
    expect(left).toContain("skills-lock.json");
  });

  it("writes the skills into the home on [g], leaving the repository alone", async () => {
    const before = await filesUnder(workspace.dir);
    const run = await toTheOffer();
    run.write("g");

    expect(await run.exited).toBe(0);

    const landed = path.join(home, SKILL_PATH);
    expect(await readFile(landed, "utf8")).toContain("name: egma");
    expect(await filesUnder(workspace.dir)).not.toContain(SKILL_PATH);
    // The repository gained only what the walk was always going to write.
    expect(before.length).toBeLessThan((await filesUnder(workspace.dir)).length);

    expect(existsSync(path.join(home, CLAUDE_SKILL_LINK))).toBe(true);
    expect(run.scrollback()).toContain("3 Egma skills are beside Claude Code.");
    expect(run.scrollback()).toContain("~/.agents/skills/egma");
  });

  /**
   * Skip is a first-class answer, proved by a sweep of both trees rather than
   * by the absence of an error: not a directory, not an empty file, nothing.
   */
  it("shows both destinations, then leaves the machine untouched on [s] with full scrollback", async () => {
    const run = await toTheOffer();
    const homeBefore = await filesUnder(home);

    const offer = await showing(run, "writes nothing at all");
    // Which tree each key writes into, said before anything is written.
    expect(offer).toContain(workspace.dir);
    expect(offer).toContain(home);
    expect(existsSync(path.join(workspace.dir, SKILL_PATH))).toBe(false);
    expect(existsSync(path.join(home, SKILL_PATH))).toBe(false);
    expect(existsSync(path.join(workspace.dir, CLAUDE_SKILL_LINK))).toBe(false);
    expect(existsSync(path.join(home, CLAUDE_SKILL_LINK))).toBe(false);

    run.write("s");

    expect(await run.exited).toBe(0);

    expect(await filesUnder(home)).toEqual(homeBefore);
    expect(existsSync(path.join(workspace.dir, ".claude"))).toBe(false);
    expect(existsSync(path.join(home, ".claude"))).toBe(false);

    const left = run.scrollback();
    expect(left).toContain("Nothing was installed.");
    expect(left).toContain("egma --help");

    const lines = left
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line !== "");

    const runId = platform.running.runs[0]?.id ?? "";
    const address = `${platform.url}/projects/${platform.projectId}/runs/${runId}`;

    // The address is a line, and the whole of that line — a triple-click takes
    // it and gets exactly the address.
    expect(lines).toContain(address);
    expect(lines.some((line) => line.includes(address) && line !== address)).toBe(false);
    // And nothing rides on it. The browser is already signed in from the
    // approval earlier in this same walk, so no token has to.
    expect(new URL(address).search).toBe("");
    expect(left).not.toContain("egma_sk_");

    expect(lines).toContain(
      "Tests are code now: egma/tests/ (committed). Edit them, then egma push.",
    );
    expect(lines).toContain(
      'Hand your coding agent this: "Read egma/config.yaml, then egma --help — you can pull, push, and trigger runs from here."',
    );
    expect(lines.some((line) => line.startsWith("✓ Your first run is live"))).toBe(true);
  });
});
