/**
 * The wizard in a real terminal.
 *
 * A pseudo-terminal runs the built command and a headless terminal emulator
 * reads both of its screens, so the promise about scrollback is checked as a
 * terminal fact rather than as an intention. Still no model and still no human:
 * the agent is the scripted one and the keystrokes are written by the test.
 */

import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInTerminal } from "./support/pty.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  makeWorkspace,
  waitUntil,
  type Workspace,
} from "./support/workspace.ts";

const MANIFEST = JSON.stringify({ name: "customer-repo", version: "1.0.0" }, null, 2);

describe("the wizard on a real terminal", () => {
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = await makeWorkspace({ "package.json": MANIFEST });
  });

  afterEach(async () => {
    await workspace.remove();
  });

  it("opens the alternate screen, shows the intro, works, and leaves one line", async () => {
    const script = await workspace.script({
      steps: [
        { kind: "tool-call", id: "t1", title: "Read", locations: [{ path: "package.json" }] },
        { kind: "read-file", path: "package.json", recordAs: "manifest" },
        // A real agent takes seconds; this is long enough to watch it work.
        { kind: "wait", ms: 750 },
        { kind: "say", text: "It is a package manifest." },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const terminal = runInTerminal({
      command: process.execPath,
      args: [CLI_ENTRY, "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
      cwd: workspace.dir,
    });

    try {
      expect(await waitUntil(() => terminal.screen().includes("read package.json"))).toBe(true);

      // The intro says what is about to happen and what the keystroke means.
      const intro = terminal.screen();
      expect(intro).toContain("This is the first check that egma can drive your own coding agent");
      expect(intro).toContain("[enter] begin");
      expect(intro).toContain("[q] quit");
      expect(intro.indexOf("[enter] begin")).toBeLessThan(intro.indexOf("[q] quit"));

      // It is drawn on the alternate screen, so scrollback is still untouched.
      expect(terminal.scrollback().trim()).toBe("");

      terminal.write("\r");

      expect(await waitUntil(() => terminal.screen().includes("Read package.json"))).toBe(true);

      const code = await terminal.exited;
      expect(code).toBe(0);

      // Everything the wizard drew is gone. One line is left, and it is plain.
      const left = terminal.scrollback().trim();
      expect(left).toBe(
        "node read package.json for egma. Nothing in this folder was changed.",
      );
      expect(left.split("\n")).toHaveLength(1);
    } finally {
      terminal.kill();
    }
  });

  it("closes with nothing run when the developer quits at the intro", async () => {
    const script = await workspace.script({ steps: [{ kind: "stop", reason: "end_turn" }] });

    const terminal = runInTerminal({
      command: process.execPath,
      args: [CLI_ENTRY, "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
      cwd: workspace.dir,
    });

    try {
      expect(
        await waitUntil(() => terminal.screen().includes("This is the first check")),
      ).toBe(true);

      terminal.write("q");

      expect(await terminal.exited).toBe(0);
      expect(terminal.scrollback().trim()).toBe("egma closed. Nothing ran.");
    } finally {
      terminal.kill();
    }
  });

  it("says honestly that it stopped when Ctrl-C lands mid-task", async () => {
    const script = await workspace.script({
      spawnChild: true,
      steps: [
        { kind: "tool-call", id: "t1", title: "Thinking about it" },
        { kind: "wait", ms: 60_000 },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const terminal = runInTerminal({
      command: process.execPath,
      args: [CLI_ENTRY, "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
      cwd: workspace.dir,
    });

    try {
      expect(
        await waitUntil(() => terminal.screen().includes("This is the first check")),
      ).toBe(true);
      terminal.write("\r");
      expect(await waitUntil(() => terminal.screen().includes("Thinking about it"))).toBe(true);

      terminal.write("");

      expect(await terminal.exited).toBe(130);
      expect(terminal.scrollback().trim()).toBe(
        "egma stopped before the task finished, and shut node down.",
      );
    } finally {
      terminal.kill();
    }
  });
});
