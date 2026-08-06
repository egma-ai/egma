/**
 * The wizard in a real terminal.
 *
 * A pseudo-terminal runs the built command and a headless terminal emulator
 * reads both of its screens, so the promise about scrollback is checked as a
 * terminal fact rather than as an intention. Still no model and still no human:
 * the agent is the scripted one and the keystrokes are written by the test.
 *
 * Every wait here asks for **everything** the assertions after it will read,
 * and reads the screen that satisfied the wait. A frame arrives in chunks, so
 * waiting for its first line and then asserting on its last is a race that
 * the machine wins whenever it is busy — which is what made this file flaky.
 */

import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runInTerminal, showing } from "./support/pty.ts";
import { CLI_ENTRY, FAKE_AGENT, MANIFEST, makeWorkspace, type Workspace } from "./support/workspace.ts";

// A real subprocess, a real terminal and a test run using every core: the
// budget is generous so that only a broken wizard can reach it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("the wizard on a real terminal", () => {
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = await makeWorkspace({ "package.json": MANIFEST });
    // Login has its own checks; these are about what a real terminal draws.
    await workspace.signIn("https://egma.invalid");
  });

  afterEach(async () => {
    await workspace.remove();
  });

  it("opens the alternate screen, shows the intro, works, and leaves one line", async () => {
    const script = await workspace.script({
      steps: [
        { kind: "tool-call", id: "t1", title: "Read", locations: [{ path: "package.json" }] },
        { kind: "read-file", path: "package.json", recordAs: "manifest" },
        { kind: "say", text: "egma:found framework retell-sdk\n" },
        // A real agent takes seconds; this is long enough to watch it work.
        { kind: "wait", ms: 750 },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const terminal = runInTerminal({
      command: process.execPath,
      args: [CLI_ENTRY, "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
      cwd: workspace.dir,
      env: workspace.env(),
    });

    try {
      // The intro says what is about to happen and what the keystroke means.
      const intro = await showing(
        terminal,
        "egma is about to find your voice agent",
        "where its prompts live",
        "[enter] begin",
        "[q] quit",
      );
      expect(intro.indexOf("[enter] begin")).toBeLessThan(intro.indexOf("[q] quit"));

      // It is drawn on the alternate screen, so scrollback is still untouched.
      expect(terminal.scrollback().trim()).toBe("");

      terminal.write("\r");

      // Every action the agent takes, and every fact it reports, lands on
      // screen while it works.
      await showing(terminal, "Read package.json", "┊ Framework  retell-sdk");

      const code = await terminal.exited;
      expect(code).toBe(0);

      // Everything the wizard drew is gone. One line is left, and it is plain.
      const left = terminal.scrollback().trim();
      expect(left).toBe("egma found your voice agent: retell-sdk.");
      expect(left.split("\n")).toHaveLength(1);
    } finally {
      await terminal.kill();
    }
  });

  it("asks once for the prompts when the folder holds no voice agent", async () => {
    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:none There is no voice agent in this folder.\n" },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const terminal = runInTerminal({
      command: process.execPath,
      args: [CLI_ENTRY, "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
      cwd: workspace.dir,
      env: workspace.env(),
    });

    try {
      await showing(terminal, "egma is about to find your voice agent", "[enter] begin");
      terminal.write("\r");

      await showing(
        terminal,
        "Nothing in this folder looks like a voice agent",
        "[enter] look there",
        "[esc] nowhere else",
      );

      // The developer has nowhere to point egma at, and says so.
      terminal.write("");

      expect(await terminal.exited).toBe(1);
      expect(terminal.scrollback().trim()).toBe(
        "egma found no voice agent to test. Run egma again where your agent is defined.",
      );
    } finally {
      await terminal.kill();
    }
  });

  it("stops rather than hangs when Ctrl-C lands on that question", async () => {
    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:none There is no voice agent in this folder.\n" },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const terminal = runInTerminal({
      command: process.execPath,
      args: [CLI_ENTRY, "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
      cwd: workspace.dir,
      env: workspace.env(),
    });

    try {
      await showing(terminal, "egma is about to find", "[enter] begin");
      terminal.write("\r");
      await showing(terminal, "Nothing in this folder looks like a voice agent", "[esc] nowhere else");

      terminal.write("");

      expect(await terminal.exited).toBe(130);
      expect(terminal.scrollback().trim()).toContain("stopped before the task finished");
    } finally {
      await terminal.kill();
    }
  });

  it("closes with nothing run when the developer quits at the intro", async () => {
    const script = await workspace.script({ steps: [{ kind: "stop", reason: "end_turn" }] });

    const terminal = runInTerminal({
      command: process.execPath,
      args: [CLI_ENTRY, "--cwd", workspace.dir, "--", process.execPath, FAKE_AGENT, script],
      cwd: workspace.dir,
      env: workspace.env(),
    });

    try {
      await showing(terminal, "egma is about to find", "[q] quit");

      terminal.write("q");

      expect(await terminal.exited).toBe(0);
      expect(terminal.scrollback().trim()).toBe("egma closed. Nothing ran.");
    } finally {
      await terminal.kill();
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
      env: workspace.env(),
    });

    try {
      await showing(terminal, "egma is about to find", "[enter] begin");
      terminal.write("\r");
      await showing(terminal, "Thinking about it");

      terminal.write("");

      expect(await terminal.exited).toBe(130);
      expect(terminal.scrollback().trim()).toBe(
        "egma stopped before the task finished, and shut node down.",
      );
    } finally {
      await terminal.kill();
    }
  });
});
