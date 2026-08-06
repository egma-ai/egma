import { describe, expect, it } from "vitest";

import { buildExitLine, buildExitNotice, type ExitReport } from "../src/wizard/exit-line.ts";

const EVERY_ENDING: readonly ExitReport[] = [
  { kind: "found-agent", framework: "retell-sdk", prompts: "prompts/order-line.md" },
  { kind: "found-agent", framework: "retell-sdk", prompts: null },
  { kind: "found-agent", framework: null, prompts: null },
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

    expect(buildExitLine({ kind: "failed", reason: "no answer" })).toContain("no answer");
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
