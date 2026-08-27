import { describe, expect, it } from "vitest";

import { isMouseInput, mousePressesIn } from "../src/ui/tui/mouse.ts";
import { WizardStore } from "../src/ui/tui/store.ts";

describe("the live coding-agent activity", () => {
  it("keeps streamed ACP message chunks on one readable line", () => {
    const store = new WizardStore();
    store.setDrivenAgent({ id: "claude-code", name: "Claude Code" });
    store.pushStatus("A previous task");
    store.taskStarted();

    store.pushAgentMessage("I am reading");
    store.pushAgentMessage(" the worker.\nNow checking tools.");
    store.pushStatus("◆ Read src/agent.py");
    store.pushAgentMessage("The worker is ready.");

    expect(store.snapshot.statuses).toEqual([
      "A previous task",
      "Claude Code: I am reading the worker.",
      "Claude Code: Now checking tools.",
      "◆ Read src/agent.py",
      "Claude Code: The worker is ready.",
    ]);
    expect(store.snapshot.statuses.slice(store.snapshot.activityFrom)).toEqual([
      "Claude Code: I am reading the worker.",
      "Claude Code: Now checking tools.",
      "◆ Read src/agent.py",
      "Claude Code: The worker is ready.",
    ]);
  });

  it("starts each coding-agent task with a fresh live view", () => {
    const store = new WizardStore();
    store.taskStarted();
    store.pushStatus("◆ First task");
    store.setSummary("Old task summary");
    store.taskFinished();

    store.taskStarted();

    expect(store.snapshot.running).toBe(true);
    expect(store.snapshot.finished).toBe(false);
    expect(store.snapshot.summary).toBe("");
    expect(store.snapshot.statuses.slice(store.snapshot.activityFrom)).toEqual([]);
  });

  it("removes terminal control bytes from agent messages", () => {
    const store = new WizardStore();
    store.taskStarted();

    store.pushAgentMessage("safe\u001B[2Jstill safe\u0000\n");

    expect(store.snapshot.statuses).toEqual(["Coding agent: safestill safe"]);
  });
});

describe("terminal mouse input", () => {
  it("reads SGR left-button presses as zero-based terminal cells", () => {
    expect(mousePressesIn("\u001B[<0;14;9M")).toEqual([{ x: 13, y: 8 }]);
  });

  it("ignores releases, other buttons, motion, and wheel input", () => {
    expect(
      mousePressesIn(
        "\u001B[<0;14;9m\u001B[<2;14;9M\u001B[<32;14;9M\u001B[<64;14;9M",
      ),
    ).toEqual([]);
  });

  it("recognizes the mouse sequence after Ink removes Escape", () => {
    expect(isMouseInput("[<0;14;9M")).toBe(true);
    expect(isMouseInput("ordinary text")).toBe(false);
  });
});
