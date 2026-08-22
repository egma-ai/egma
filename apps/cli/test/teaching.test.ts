/**
 * The words egma uses, taught while the files land — and never in the way.
 *
 * Two things have to be true of the pane and the second is the harder one. It
 * has to teach the glossary's own vocabulary, because a developer who leaves
 * the wizard calling a run a batch will not find anything egma answers to. And
 * it has to cost nothing: the flow must not wait on it, be paced by it, or end
 * differently because it was drawn. So the same suite is written twice — once
 * with the pane on a real terminal and once with no screen at all — and what
 * comes out is compared.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LEARN_CARDS, CARD_WIDTH, cardAt } from "../src/wizard/teaching.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { exitLines } from "../src/wizard/exit-line.ts";
import { selectedPlatform } from "../src/wizard/login-step.ts";
import { runWizard } from "../src/wizard/wizard-flow.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { bannedWordsIn } from "./support/glossary.ts";
import { gradeEveryRun } from "./support/grading.ts";
import { runInTerminal, showing } from "./support/pty.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  RETELL_FIXTURE_REPO,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const KEY = "key_44a0d7c1e6b39f28510d";

const ACCOUNT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_quillfeather_order_line",
      channel: "chat",
      agent_name: "order-line",
      response_engine: { type: "retell-llm", llm_id: "llm_quillfeather" },
    },
  ],
  llms: [{ llm_id: "llm_quillfeather", general_prompt: "Answer the order line.\n" }],
};

/** The fragment only the write-the-tests task has, whatever it asks for. */
const GENERATE_TASK = "## The words the agent is running on";

const NAMES = ["open-on-sunday", "lost-the-order-number", "wants-it-by-friday"];
const RELEASE_WRITING = ".fake-agent-release-teaching";

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

/**
 * The script both runs use.
 *
 * A terminal check can hold the scripted coding agent on a file barrier until
 * it has read the first card. A headless walk needs no barrier. Neither path
 * waits for a clock.
 */
function scriptFor(workspace: Workspace, releaseFile?: string): Promise<string> {
  return workspace.script({
    steps: [
      { kind: "say", text: "egma:found framework retell-sdk\n" },
      { kind: "stop", reason: "end_turn" },
    ],
    stepsByTask: [
      {
        contains: GENERATE_TASK,
        steps: [
          { kind: "say", text: `egma:plan ${NAMES.join(", ")}\n` },
          ...(releaseFile === undefined
            ? []
            : ([{ kind: "wait-for-file", path: releaseFile }] satisfies FakeStep[])),
          ...NAMES.flatMap((name) => writes(name)),
          { kind: "stop", reason: "end_turn" },
        ],
      },
    ],
  });
}

/**
 * The exit block, with the one line no two runs can share stood in for.
 *
 * Everything the wizard leaves behind is the same sentence on both runs but
 * one: the address of the run, which names the instance it was created on and
 * the run it created. Two runs on two platforms cannot have the same one, and
 * a check that demanded it would be checking the fixture rather than the pane.
 */
function endingShape(lines: readonly string[], resultsUrl: string): readonly string[] {
  return lines.map((line) => (line === resultsUrl ? "<the address of this run>" : line));
}

/** What a terminal left in scrollback, as lines with nothing empty between. */
function scrollbackLines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

let platform: Platform;
let retell: FakeRetell;
let workspace: Workspace;

beforeEach(async () => {
  platform = await startPlatform();
  retell = await startFakeRetell(ACCOUNT);
  workspace = await makeWorkspace({}, { from: RETELL_FIXTURE_REPO });
  await workspace.signIn(platform.url, platform.device.mint());
});

afterEach(async () => {
  await retell.close();
  await platform.close();
  await workspace.remove();
});

describe("the deck", () => {
  it("says what egma means, in egma's own words", () => {
    const said = LEARN_CARDS.flatMap((card) => [card.heading, ...card.lines]).join(" ");

    // The glossary's spine: a test is executed as simulations inside a run, a
    // metric measures, and a grader returns a normalized score.
    expect(said).toContain("expected behaviors");
    expect(said).toContain("One execution of a selection of");
    expect(said).toContain("One test executed once inside a");
    expect(said).toContain("A metric measures");
    expect(said).toContain("A grader assigns one score");
    expect(said).toContain("one score");
    expect(said).toContain("pass threshold");
    expect(said).toContain("display-only combined score");

    // And none of the words the glossary bans, which is the half that matters:
    // a card teaching a near synonym teaches a developer to ask for something
    // egma does not answer to.
    //
    // It is the same list the skills are held to, and it is that list rather
    // than a shorter one written to fit the cards — a guard shaped around the
    // text it guards proves only that somebody read the text once. The deck
    // takes no carve-out at all: the one the skills take is for a file format,
    // and a card is prose from the first word to the last.
    expect(bannedWordsIn(said)).toEqual([]);
  });

  it("is written to the width of the pane, so nothing rewraps it", () => {
    for (const card of LEARN_CARDS) {
      expect(card.heading.length, card.heading).toBeLessThanOrEqual(CARD_WIDTH);
      for (const line of card.lines) {
        expect(line.length, line).toBeLessThanOrEqual(CARD_WIDTH);
      }
    }
  });

  it("never runs out, however long the writing takes", () => {
    expect(cardAt(0)).toBe(LEARN_CARDS[0]);
    expect(cardAt(LEARN_CARDS.length)).toBe(LEARN_CARDS[0]);
    expect(cardAt(LEARN_CARDS.length * 4 + 2)).toBe(LEARN_CARDS[2]);
  });
});

describe("the pane, while the files land", () => {
  it("is drawn beside them, and the walk ends exactly as it does without it", async () => {
    const script = await scriptFor(workspace, RELEASE_WRITING);

    // The gate is not the end of the walk any more: enter starts a run, and
    // the wizard leaves once one trace has terminal grading. Exactly one is ready on
    // each of the two platforms below, so the count in the ending is the same
    // number on both — a sweep that judged all three would leave "1 of 3" on
    // one run and "all 3" on the other, depending on which poll landed first.
    const grading = gradeEveryRun(platform, { atMost: 1 });

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
      // Wide, because the ending under check here is lines rather than
      // sentences. A terminal wraps whatever will not fit, and a check that
      // read a wrapped line as two would be checking the terminal's width and
      // not egma's output. It is wide enough for the pane either way.
      cols: 200,
    });

    try {
      await showing(terminal, "Egma is about to find", "[enter] begin");
      terminal.write("\r");

      await showing(terminal, "Paste your Retell API key");
      terminal.write(`${KEY}\r`);

      // Text or phone. Not this check's subject, and not skippable
      // either: egma never picks one of the two for a developer.
      await showing(terminal, "How should Egma reach this agent?");
      terminal.write("\r");

      await showing(terminal, "Do you already have test cases");
      terminal.write("n");

      // The first card is up, beside the list it is meant to fill the wait of.
      const pane = await showing(
        terminal,
        "Writing tests for your voice agent.",
        "A test",
        "One situation to put your agent",
        "behaviors that say what should",
        "Progress:",
      );
      expect(pane).toContain("behaviors that say what should");

      await writeFile(path.join(workspace.dir, RELEASE_WRITING), "continue\n", "utf8");
      await showing(terminal, "3 tests generated", "[enter] run");
      terminal.write("\r");

      expect(await terminal.exited).toBe(0);
      const drawn = terminal.raw();

      // The timer never fired: the second card was never on screen, so nothing
      // about this run waited on the deck turning.
      expect(drawn).not.toContain("The synthetic person on the");
      expect(drawn).not.toContain("A persona");

      /* the same walk, with no screen at all */

      const elsewhere = await startPlatform();
      const second = await makeWorkspace({}, { from: RETELL_FIXTURE_REPO });
      const gradingElsewhere = gradeEveryRun(elsewhere, { atMost: 1 });
      try {
        await second.signIn(elsewhere.url, elsewhere.device.mint());
        const ui = new HeadlessUI({ answers: { "retell-key": KEY, reach: "text" } });
        const report = await runWizard({
          ui,
          launch: second.launch(await scriptFor(second)),
          cwd: second.dir,
          signal: new AbortController().signal,
          platform: selectedPlatform({
            url: elsewhere.url,
            credentialsFile: second.credentialsFile,
          }),
          retell: { url: retell.url },
          home: path.join(second.dir, "pretend-home"),
          runPollMs: 20,
        });

        expect(report.kind).toBe("run-started");
        const address = report.kind === "run-started" ? report.resultsUrl : "";
        const written = exitLines(report).filter((line) => line !== "");
        expect(written[0]).toBe(
          "✓ Your first run is live — 1 of 3 simulation results ready.",
        );

        // Line for line the same ending, and the same tests on egma either way.
        const here = `${platform.url}/runs/${platform.running.runs[0]?.id ?? ""}`;
        expect(endingShape(scrollbackLines(terminal.scrollback()), here)).toEqual(
          endingShape(written, address),
        );
        expect(elsewhere.tests.tests.map((test) => test.name).sort()).toEqual(
          platform.tests.tests.map((test) => test.name).sort(),
        );
        expect(platform.tests.tests.map((test) => test.name).sort()).toEqual([...NAMES].sort());
      } finally {
        gradingElsewhere.stop();
        await elsewhere.close();
        await second.remove();
      }
    } finally {
      grading.stop();
      await terminal.kill();
    }
  });

  it("gives the whole width to the files when the terminal is too narrow for both", async () => {
    const script = await scriptFor(workspace, RELEASE_WRITING);
    const grading = gradeEveryRun(platform, { atMost: 1 });

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
      cols: 64,
    });

    try {
      await showing(terminal, "[enter] begin");
      terminal.write("\r");
      await showing(terminal, "Paste your Retell API key");
      terminal.write(`${KEY}\r`);

      // Text or phone. Not this check's subject, and not skippable
      // either: egma never picks one of the two for a developer.
      await showing(terminal, "How should Egma reach this agent?");
      terminal.write("\r");
      await showing(terminal, "Do you already have test cases");
      terminal.write("n");

      const narrow = await showing(
        terminal,
        "Writing tests for your voice agent.",
        "open-on-sunday",
        "Progress:",
      );
      // The work is on screen whole; the teaching is what gives way.
      expect(narrow).not.toContain("One situation to put your agent");

      await writeFile(path.join(workspace.dir, RELEASE_WRITING), "continue\n", "utf8");
      await showing(terminal, "[enter] run");
      terminal.write("\r");
      expect(await terminal.exited).toBe(0);
      expect(path.basename(workspace.dir).startsWith("egma-cli-")).toBe(true);
    } finally {
      grading.stop();
      await terminal.kill();
    }
  });
});
