import { describe, expect, it } from "vitest";

import { buildExitLine, buildExitNotice, type ExitReport } from "../src/wizard/exit-line.ts";

const EVERY_ENDING: readonly ExitReport[] = [
  { kind: "found-agent", framework: "retell-sdk", prompts: "prompts/order-line.md" },
  { kind: "found-agent", framework: "retell-sdk", prompts: null },
  { kind: "found-agent", framework: null, prompts: null },
  { kind: "connected", agentName: "order-line", connectionName: "retell-1" },
  { kind: "tests-pushed", count: 12 },
  { kind: "tests-pushed", count: 1 },
  { kind: "tests-kept", count: 12, stopped: false },
  { kind: "tests-kept", count: 1, stopped: false },
  { kind: "tests-kept", count: 12, stopped: true },
  { kind: "no-agent-context" },
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
    ).toBe("egma found your voice agent: retell-sdk, prompts in prompts/order-line.md.");

    expect(buildExitLine({ kind: "no-agent-context" })).toContain(
      "Run egma again where your agent is defined",
    );

    expect(buildExitLine({ kind: "interrupted", drivenAgentName: "Claude Agent" })).toContain(
      "stopped before the task finished",
    );

    // A stop that left files behind says so, in the same one line: a folder a
    // developer was never told about is a half-truth.
    expect(
      buildExitLine({ kind: "interrupted", drivenAgentName: "Claude Agent", testsKept: 12 }),
    ).toBe(
      "egma stopped before the task finished, and shut Claude Agent down. Your 12 tests are in egma/tests/.",
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
      "egma put 12 tests on egma and left them in egma/tests/ — commit them, edit them, then run egma push.",
    );
    expect(buildExitLine({ kind: "tests-kept", count: 12, stopped: false })).toBe(
      "Nothing was uploaded. Your 12 tests are in egma/tests/ — read them, then run egma push.",
    );

    // One test is one test, in both of them.
    expect(buildExitLine({ kind: "tests-pushed", count: 1 })).toContain("1 test on egma");
    expect(buildExitLine({ kind: "tests-kept", count: 1, stopped: false })).toContain(
      "Your test is in",
    );

    // Ctrl-C over the list is the same decision as q, and it leaves the same
    // files. It says it stopped, because a person who pressed it knows they
    // did — and it still says where the files are, which is the whole job of
    // this line.
    expect(buildExitLine({ kind: "tests-kept", count: 12, stopped: true })).toBe(
      "egma stopped. Your 12 tests are in egma/tests/ — read them, then run egma push.",
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

  it("prints something to copy only when the developer has to copy something", () => {
    for (const report of EVERY_ENDING) {
      const notice = buildExitNotice(report);
      if (report.kind === "no-coding-agent") {
        expect(notice).toContain("paste this into it");
      } else {
        expect(notice).toBeNull();
      }
    }
  });
});
