import { describe, expect, it } from "vitest";

import {
  MOVE_TO_ANOTHER_PLATFORM,
  teachingTheMove,
} from "../src/folder/egma-folder.ts";
import {
  buildExitLine,
  buildExitNotice,
  exitLines,
  type ExitReport,
} from "../src/wizard/exit-line.ts";

const RESULTS_URL = "http://localhost:3101/runs/run_01K7QXV2M8ZB4C6D8E0F2G4H6J";

const EVERY_ENDING: readonly ExitReport[] = [
  { kind: "found-agent", framework: "retell-sdk", prompts: "prompts/order-line.md" },
  { kind: "found-agent", framework: "retell-sdk", prompts: null },
  { kind: "found-agent", framework: null, prompts: null },
  { kind: "connected", agentName: "order-line", connectionName: "retell-1", dialled: null },
  {
    kind: "connected",
    agentName: "order-line",
    connectionName: "phone-1",
    dialled: "+14155550111",
  },
  { kind: "tests-pushed", count: 12 },
  { kind: "tests-pushed", count: 1 },
  { kind: "tests-kept", count: 12, stopped: false },
  { kind: "tests-kept", count: 1, stopped: false },
  { kind: "tests-kept", count: 12, stopped: true },
  {
    kind: "run-started",
    resultsUrl: RESULTS_URL,
    dialled: null,
    graded: 3,
    total: 12,
    skill: {
      kind: "installed",
      scope: "project",
      file: "/repo/.claude/skills/egma/SKILL.md",
      drivenAgentName: "Claude Code",
      replaced: false,
    },
  },
  {
    kind: "run-started",
    resultsUrl: RESULTS_URL,
    dialled: null,
    graded: 3,
    total: 12,
    skill: {
      kind: "installed",
      scope: "global",
      file: "/home/you/.claude/skills/egma/SKILL.md",
      drivenAgentName: "Claude Code",
      replaced: true,
    },
  },
  {
    kind: "run-started",
    resultsUrl: RESULTS_URL,
    dialled: null,
    graded: 12,
    total: 12,
    skill: { kind: "skipped", drivenAgentName: "Claude Code" },
  },
  {
    kind: "run-started",
    resultsUrl: RESULTS_URL,
    dialled: null,
    graded: 0,
    total: 12,
    skill: { kind: "not-offered" },
  },
  { kind: "no-agent-context" },
  { kind: "unsupported-agent-platform", platform: "pipecat" },
  { kind: "unsupported-agent-platform", platform: "vapi" },
  { kind: "no-coding-agent" },
  {
    kind: "coding-agent-stopped",
    drivenAgentName: "Claude Agent",
    reason: "I cannot read this repository.",
  },
  { kind: "coding-agent-stopped", drivenAgentName: "Claude Agent", reason: "" },
  { kind: "quit" },
  { kind: "interrupted", drivenAgentName: "Claude Agent" },
  { kind: "interrupted", drivenAgentName: null },
  { kind: "interrupted", drivenAgentName: "Claude Agent", testsKept: 12 },
  { kind: "interrupted", drivenAgentName: "Claude Agent", testsKept: 1 },
  { kind: "failed", reason: "the agent stopped talking" },
];

describe("the exit line", () => {
  it("is always exactly one line, with nothing to select around", () => {
    for (const report of EVERY_ENDING) {
      const line = buildExitLine(report);
      expect(line).not.toContain("\n");
      // Nothing painted: a terminal selects a plain line cleanly.
      expect(line).not.toContain("");
      expect(line.trim()).toBe(line);
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it("says what happened, in words", () => {
    expect(
      buildExitLine({
        kind: "found-agent",
        framework: "retell-sdk",
        prompts: "prompts/order-line.md",
      }),
    ).toBe("Egma found your voice agent: retell-sdk, prompts in prompts/order-line.md.");

    expect(buildExitLine({ kind: "no-agent-context" })).toContain(
      "Use its folder or configure it in the UI",
    );

    expect(
      buildExitLine({ kind: "unsupported-agent-platform", platform: "pipecat" }),
    ).toContain("CLI support is coming soon");

    expect(buildExitLine({ kind: "interrupted", drivenAgentName: "Claude Agent" })).toContain(
      "stopped before the task finished",
    );

    // A stop that left files behind says so, in the same one line: a folder a
    // developer was never told about is a half-truth.
    expect(
      buildExitLine({ kind: "interrupted", drivenAgentName: "Claude Agent", testsKept: 12 }),
    ).toBe(
      "Egma stopped before the task finished, and shut Claude Agent down. Your 12 tests are in egma/tests/.",
    );

    expect(buildExitLine({ kind: "failed", reason: "no answer" })).toContain("no answer");
  });

  /**
   * Both endings the gate has leave files in the repository, so both have to
   * say where they are — the whole point of the wizard's alternate screen is
   * that nothing else survives it.
   */
  it("says where the tests are, whichever way the gate ended", () => {
    expect(buildExitLine({ kind: "tests-pushed", count: 12 })).toBe(
      "Egma put 12 tests on Egma and left them in egma/tests/ — commit them, edit them, then run egma push.",
    );
    expect(buildExitLine({ kind: "tests-kept", count: 12, stopped: false })).toBe(
      "Nothing was uploaded. Your 12 tests are in egma/tests/ — read them, then run egma push.",
    );

    // One test is one test, in both of them.
    expect(buildExitLine({ kind: "tests-pushed", count: 1 })).toContain("1 test on Egma");
    expect(buildExitLine({ kind: "tests-kept", count: 1, stopped: false })).toContain(
      "Your test is in",
    );

    // Ctrl-C over the list is the same decision as q, and it leaves the same
    // files. It says it stopped, because a person who pressed it knows they
    // did — and it still says where the files are, which is the whole job of
    // this line.
    expect(buildExitLine({ kind: "tests-kept", count: 12, stopped: true })).toBe(
      "Egma stopped. Your 12 tests are in egma/tests/ — read them, then run egma push.",
    );
  });

  /**
   * A coding agent that stopped is not a folder that held nothing. Telling the
   * second story for the first says egma looked and found no voice agent, when
   * what happened is that nobody ever looked.
   */
  it("says a stop was a stop, and whose it was", () => {
    expect(
      buildExitLine({
        kind: "coding-agent-stopped",
        drivenAgentName: "Claude Agent",
        reason: "I cannot read this repository.",
      }),
    ).toBe(
      "Claude Agent stopped before it found your voice agent: I cannot read this repository.",
    );

    expect(
      buildExitLine({ kind: "coding-agent-stopped", drivenAgentName: "Claude Agent", reason: "" }),
    ).toBe("Claude Agent stopped before it found your voice agent, and did not say why.");
  });

  it("prints something to copy when the developer has to copy something", () => {
    for (const report of EVERY_ENDING) {
      const notice = buildExitNotice(report);
      if (report.kind === "no-coding-agent") {
        expect(notice).toContain("paste this into it");
        continue;
      }
      if (report.kind === "run-started") continue;
      expect(notice).toBeNull();
    }
  });

  /**
   * The whole point of the alternate screen is that nothing on it survives, so
   * the three things a developer takes away from the walk have to be here — and
   * each of them is a thing somebody copies, which on a terminal means a whole
   * line and nothing sharing it.
   */
  it("leaves three copyable things behind, each alone on its line", () => {
    const lines = exitLines({
      kind: "run-started",
      resultsUrl: RESULTS_URL,
      dialled: null,
      graded: 3,
      total: 12,
      skill: { kind: "skipped", drivenAgentName: "Claude Code" },
    });

    expect(lines).toEqual([
      "✓ Your first run is live — 3 of 12 graded so far.",
      "",
      RESULTS_URL,
      "",
      "Tests are code now: egma/tests/ (committed). Edit them, then egma push.",
      'Hand your coding agent this: "Read egma/config.yaml, then egma --help — you can pull, push, and trigger runs from here."',
    ]);

    for (const line of lines) {
      // No indentation, no border, no colour: a triple-click takes the line
      // and gets exactly what is on it.
      expect(line.trim()).toBe(line);
      expect(line).not.toContain("");
      expect(line).not.toContain("\n");
    }
  });

  /**
   * The results page opens already signed in, because the browser holds the
   * sign-in made at device approval. That is the whole reason nothing has to
   * ride the address — and an address carrying a key would be a key in
   * scrollback, in shell history, and in whatever the developer pastes it into.
   */
  it("carries no token on the results address, ever", () => {
    const lines = exitLines({
      kind: "run-started",
      resultsUrl: RESULTS_URL,
      dialled: null,
      graded: 1,
      total: 12,
      skill: { kind: "not-offered" },
    });

    const address = lines[2] as string;
    expect(address).toBe(RESULTS_URL);
    expect(new URL(address).search).toBe("");
    expect(new URL(address).hash).toBe("");
    expect(new URL(address).username).toBe("");
    expect(new URL(address).pathname).toMatch(/^\/runs\/run_[0-9A-HJKMNP-TV-Z]{26}$/u);
  });

  it("counts what has been graded honestly, however far the suite got", () => {
    const of = (graded: number, total: number): string =>
      buildExitLine({
        kind: "run-started",
        resultsUrl: RESULTS_URL,
        dialled: null,
        graded,
        total,
        skill: { kind: "not-offered" },
      });

    expect(of(3, 12)).toBe("✓ Your first run is live — 3 of 12 graded so far.");
    expect(of(12, 12)).toBe("✓ Your first run is live — all 12 graded.");
    expect(of(0, 12)).toBe("✓ Your first run is live — 12 simulations, none graded yet.");
    expect(of(0, 1)).toBe("✓ Your first run is live — 1 simulation, none graded yet.");
  });

  /**
   * The one fact in the walk that costs somebody money.
   *
   * The wizard says it while it works, in a panel on a screen the terminal
   * throws away — where it was measured living for about a twentieth of a
   * second before the lines after it pushed it out, and where a run that
   * painted no frame in that window said it to nobody at all. So it is on the
   * ending too, which is the part the developer still has afterwards.
   */
  it("says which number Egma will dial, where the developer still has it", () => {
    expect(
      buildExitLine({
        kind: "connected",
        agentName: "order-line",
        connectionName: "phone-1",
        dialled: "+14155550111",
      }),
    ).toBe(
      "Egma connected your voice agent: order-line, over phone-1. Egma will dial +14155550111.",
    );

    expect(
      buildExitNotice({
        kind: "run-started",
        dialled: "+14155550111",
        resultsUrl: RESULTS_URL,
        graded: 1,
        total: 12,
        skill: { kind: "not-offered" },
      }),
    ).toBe("Egma will dial +14155550111.");
  });

  it("says nothing about a number where nothing is dialled", () => {
    // A text connection reaches the agent with messages, and a LiveKit room is
    // spoken into. Neither costs a telephone network anything, and an ending
    // that mentioned a number for one of them would be inventing a fact.
    expect(
      buildExitLine({
        kind: "connected",
        agentName: "order-line",
        connectionName: "retell-1",
        dialled: null,
      }),
    ).toBe("Egma connected your voice agent: order-line, over retell-1.");

    expect(
      buildExitNotice({
        kind: "run-started",
        dialled: null,
        resultsUrl: RESULTS_URL,
        graded: 1,
        total: 12,
        skill: { kind: "not-offered" },
      }),
    ).toBeNull();
  });

  it("keeps the number and the skill answer apart, each on its own", () => {
    // Both must survive and neither may swallow the other, so they are
    // paragraphs rather than a sentence with two halves.
    const notice = buildExitNotice({
      kind: "run-started",
      dialled: "+14155550111",
      resultsUrl: RESULTS_URL,
      graded: 1,
      total: 12,
      skill: { kind: "skipped", drivenAgentName: "Claude Code" },
    });

    expect(notice).toContain("Egma will dial +14155550111.");
    expect(notice).toContain("Claude Code");
    expect(notice?.split("\n\n")).toHaveLength(2);
    // In the order the walk did them.
    expect(notice?.indexOf("dial")).toBeLessThan(notice?.indexOf("Claude Code") ?? 0);
  });

  /** Never silent, in either direction, and it has to outlive the screen. */
  it("says what became of the skill offer, whichever way it was answered", () => {
    expect(
      buildExitNotice({
        kind: "run-started",
        resultsUrl: RESULTS_URL,
        dialled: null,
        graded: 1,
        total: 12,
        skill: {
          kind: "installed",
          scope: "global",
          file: "/home/you/.claude/skills/egma/SKILL.md",
          drivenAgentName: "Claude Code",
          replaced: false,
        },
      }),
    ).toBe(
      "The Egma skill is in /home/you/.claude/skills/egma/SKILL.md. Every repository you open Claude Code in has it.",
    );

    // A file that was already there is gone, and this is the only place the
    // developer will ever be told so.
    expect(
      buildExitNotice({
        kind: "run-started",
        resultsUrl: RESULTS_URL,
        dialled: null,
        graded: 1,
        total: 12,
        skill: {
          kind: "installed",
          scope: "project",
          file: "/repo/.claude/skills/egma/SKILL.md",
          drivenAgentName: "Claude Code",
          replaced: true,
        },
      }),
    ).toBe(
      "The Egma skill in /repo/.claude/skills/egma/SKILL.md was replaced with this version's. Commit it, and everybody on this repository has it.",
    );

    expect(
      buildExitNotice({
        kind: "run-started",
        resultsUrl: RESULTS_URL,
        dialled: null,
        graded: 1,
        total: 12,
        skill: { kind: "skipped", drivenAgentName: "Codex" },
      }),
    ).toBe("Nothing was installed. Codex can still drive Egma — tell it to run egma --help.");

    // A coding agent egma has no skill convention for was never offered one,
    // so there is nothing to report either way.
    expect(
      buildExitNotice({
        kind: "run-started",
        resultsUrl: RESULTS_URL,
        dialled: null,
        graded: 1,
        total: 12,
        skill: { kind: "not-offered" },
      }),
    ).toBeNull();
  });

  it("is one line for every ending that is one thing", () => {
    for (const report of EVERY_ENDING) {
      if (report.kind === "run-started") continue;
      expect(exitLines(report)).toEqual([buildExitLine(report)]);
    }
  });

  /**
   * A reason that arrived carrying a block keeps the block.
   *
   * One refusal in egma is more than a sentence: the one that keeps a
   * repository on the platform it is bound to ends with every line a developer
   * deletes to move it, and a coding agent is meant to act on those lines
   * without a person reading them out. Squashed into the exit line they are
   * neither readable nor usable — which is exactly what happened, because a
   * reason is otherwise flattened to one line on purpose.
   *
   * The flattening stays for everything else. A wrapped sentence and a stack
   * trace are still one line, so the last thing in scrollback still selects
   * whole with one triple-click.
   */
  it("keeps a block under the line, and flattens everything else onto it", () => {
    const refusal = teachingTheMove(
      "This repository is already bound to Egma platform pf_01K3XQ7M4E8YB2FVN0H9TZQWEP at https://theirs.example, and this run reached Egma platform pf_01K3XQ7M4E8YB2FVN0H9TZQWEQ at https://ours.example. Egma does not move a repository between platforms, and nothing was sent.",
    );
    const lines = exitLines({ kind: "failed", reason: refusal });

    expect(lines[0]).toBe(
      "Egma could not finish: This repository is already bound to Egma platform pf_01K3XQ7M4E8YB2FVN0H9TZQWEP at https://theirs.example, and this run reached Egma platform pf_01K3XQ7M4E8YB2FVN0H9TZQWEQ at https://ours.example. Egma does not move a repository between platforms, and nothing was sent.",
    );
    expect(lines[1]).toBe("");
    expect(lines.slice(2)).toEqual([...MOVE_TO_ANOTHER_PLATFORM]);
    // One line each, which is what "one plain block of lines" means.
    expect(lines.filter((line) => line.startsWith("  - "))).toHaveLength(5);

    // And a reason that is one paragraph is still one line, however it wrapped.
    expect(
      exitLines({ kind: "failed", reason: "no answer\n  from the\n  platform" }),
    ).toEqual(["Egma could not finish: no answer from the platform"]);
  });
});
