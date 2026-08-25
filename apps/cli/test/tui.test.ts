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
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runInTerminal, showing } from "./support/pty.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, FAKE_AGENT, MANIFEST, makeWorkspace, type Workspace } from "./support/workspace.ts";

// A real subprocess, a real terminal and a test run using every core: the
// budget is generous so that only a broken wizard can reach it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("the wizard on a real terminal", () => {
  let platform: Platform;
  let workspace: Workspace;

  beforeEach(async () => {
    platform = await startPlatform();
    workspace = await makeWorkspace({ "package.json": MANIFEST });
    // Login has its own checks; these are about what a real terminal draws.
    await workspace.signIn(platform.url);
  });

  afterEach(async () => {
    await platform.close();
    await workspace.remove();
  });

  it("keeps a fast coding-agent choice when arrows and enter arrive together", async () => {
    const bin = path.join(workspace.dir, "coding-agents");
    await mkdir(bin);
    const writeProbe = async (
      name: string,
      version: string,
      acpHelp: string | null = null,
    ): Promise<void> => {
      const file = path.join(bin, name);
      await writeFile(
        file,
        [
          "#!/bin/sh",
          `if [ \"$1\" = \"--version\" ]; then printf '%s\\n' '${version}'; exit 0; fi`,
          ...(acpHelp === null
            ? []
            : [
                `if [ \"$1\" = \"acp\" ] && [ \"$2\" = \"--help\" ]; then printf '%s\\n' '${acpHelp}'; exit 0; fi`,
              ]),
          "exit 97",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(file, 0o755);
    };
    await writeProbe("claude", "2.1.233 (Claude Code)");
    await writeProbe("codex", "codex-cli 0.148.0");
    await writeProbe("agent", "2026.08.15", "Cursor Agent ACP Agent Client Protocol");
    await writeProbe("opencode", "1.18.16", "opencode acp Agent Client Protocol");

    const terminal = runInTerminal({
      command: process.execPath,
      args: [CLI_ENTRY, "--url", platform.url, "--cwd", workspace.dir],
      cwd: workspace.dir,
      env: { ...workspace.env(), PATH: bin },
    });

    try {
      await showing(terminal, "Claude Code", "Codex", "Cursor", "OpenCode");
      terminal.write("\u001b[B\u001b[B\r");

      await showing(terminal, "It reads this folder with Cursor", "[enter] begin");
      terminal.write("q");
      expect(await terminal.exited).toBe(0);
      expect(terminal.scrollback().trim()).toBe("Egma closed. Nothing ran.");
    } finally {
      await terminal.kill();
    }
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
      env: workspace.env(),
    });

    try {
      // The intro says what is about to happen and what the keystroke means.
      const intro = await showing(
        terminal,
        "Egma is about to find your voice agent",
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

      // The one question about what Egma is here to do, drawn on the same
      // alternate screen, once the agent and its platform are known.
      const goal = await showing(
        terminal,
        "What should Egma do for this voice agent?",
        "[t] Test it",
        "[m] Watch its production traffic",
        "[b] Both",
      );
      expect(goal.indexOf("[t] Test it")).toBeLessThan(goal.indexOf("[b] Both"));
      terminal.write("t");

      // The walk goes on to the one secret it needs. This check is about the
      // screens before it, so the key is declined here and the ending is the
      // honest one that follows.
      await showing(terminal, "Paste your Retell API key");
      terminal.write("");

      const code = await terminal.exited;
      expect(code).toBe(1);

      // Everything the wizard drew is gone. One line is left, and it is plain.
      const left = terminal.scrollback().trim();
      expect(left).toBe(
        "Egma could not finish: no Retell key was given, so there is nothing to test.",
      );
      expect(left.split("\n")).toHaveLength(1);
    } finally {
      await terminal.kill();
    }
  });

  it("ends plainly when the folder holds no voice agent", async () => {
    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:none There is no voice agent in this folder.\n" },
        { kind: "stop", reason: "end_turn" },
      ],
    });

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
      env: workspace.env(),
    });

    try {
      await showing(terminal, "Egma is about to find your voice agent", "[enter] begin");
      terminal.write("\r");

      expect(await terminal.exited).toBe(1);
      expect(terminal.scrollback().trim()).toBe(
        "Egma could not find a voice agent. Use its folder or configure it in the UI.",
      );
    } finally {
      await terminal.kill();
    }
  });

  it("closes with nothing run when the developer quits at the intro", async () => {
    const script = await workspace.script({ steps: [{ kind: "stop", reason: "end_turn" }] });

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
      env: workspace.env(),
    });

    try {
      await showing(terminal, "Egma is about to find", "[q] quit");

      terminal.write("q");

      expect(await terminal.exited).toBe(0);
      expect(terminal.scrollback().trim()).toBe("Egma closed. Nothing ran.");
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
      env: workspace.env(),
    });

    try {
      await showing(terminal, "Egma is about to find", "[enter] begin");
      terminal.write("\r");
      await showing(terminal, "Thinking about it");

      terminal.write("");

      expect(await terminal.exited).toBe(130);
      expect(terminal.scrollback().trim()).toBe(
        "Egma stopped before the task finished, and shut node down.",
      );
    } finally {
      await terminal.kill();
    }
  });
});
