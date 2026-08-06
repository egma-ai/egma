import { describe, expect, it } from "vitest";

import { buildExitLine } from "../src/wizard/exit-line.ts";

describe("the exit line", () => {
  it("is always exactly one line, with nothing to select around", () => {
    const reports = [
      { kind: "task-done", drivenAgentName: "Claude Agent", file: "package.json" },
      { kind: "quit" },
      { kind: "interrupted", drivenAgentName: "Claude Agent" },
      { kind: "interrupted", drivenAgentName: null },
      { kind: "failed", reason: "the agent stopped talking" },
    ] as const;

    for (const report of reports) {
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
      buildExitLine({ kind: "task-done", drivenAgentName: "Claude Agent", file: "package.json" }),
    ).toBe("Claude Agent read package.json for egma. Nothing in this folder was changed.");

    expect(buildExitLine({ kind: "interrupted", drivenAgentName: "Claude Agent" })).toContain(
      "stopped before the task finished",
    );

    expect(buildExitLine({ kind: "failed", reason: "no answer" })).toContain("no answer");
  });
});
