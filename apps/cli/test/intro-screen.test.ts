/**
 * The wizard's first screen, on a real terminal, in a repository that names no
 * platform.
 *
 * A bare command now reaches egma's own platform when nothing else names one,
 * so which egma this is stopped being something the developer chose. It is
 * therefore something they have to be told — and told on the screen that takes
 * the keystroke of consent, before that address has been asked anything at all.
 * Both halves of that are terminal facts, so both are checked here: what the
 * screen says, and that the platform has heard nothing while it says it.
 */

import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEgmaFolder } from "../src/folder/egma-folder.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { runInTerminal, showingIn, type TerminalRun } from "./support/pty.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  MANIFEST,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

// A real subprocess, a real terminal and a test run using every core: the
// budget is generous so that only a broken wizard can reach it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let platform: Platform;
let workspace: Workspace;

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace({ "package.json": MANIFEST });
});

afterEach(async () => {
  await platform.close();
  await workspace.remove();
});

/** Everything on screen as one run of words, for text the box has wrapped. */
function asOneLine(screen: string): string {
  return screen
    .split("\n")
    .map((line) => line.replaceAll("│", "").trim())
    .join(" ")
    .replaceAll(/\s+/gu, " ");
}

/** The bare command: no verb, and no `--url`, which is the one way to say one. */
function bareWizard(): TerminalRun {
  const args = [CLI_ENTRY, "--cwd", workspace.dir];
  expect(args).not.toContain("--url");
  const env = workspace.env({
    // The stand-in for egma's own address. Nothing here dials the real one.
    EGMA_TEST_DEFAULT_URL: platform.url,
  });

  return runInTerminal({
    command: process.execPath,
    args: [...args, "--", process.execPath, FAKE_AGENT, "no-script"],
    cwd: workspace.dir,
    env,
    cols: 100,
  });
}

/** The same bare command, in a repository that already has an egma folder. */
async function wizardInBoundRepository(): Promise<TerminalRun> {
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      format: 2,
      platform: { origin: platform.url },
      project: null,
      agents: [],
    },
  });

  const args = [CLI_ENTRY, "--cwd", workspace.dir];
  expect(args).not.toContain("--url");

  return runInTerminal({
    command: process.execPath,
    args: [...args, "--", process.execPath, FAKE_AGENT, "no-script"],
    cwd: workspace.dir,
    env: workspace.env(),
    cols: 100,
  });
}

describe("the wizard's first screen", () => {
  it("asks for CLI authorization before contacting the selected platform", async () => {
    const terminal = bareWizard();
    try {
      const screen = await showingIn(
        terminal,
        asOneLine,
        "Welcome to Egma",
        "sign in and authorize this CLI",
        "looks for a coding agent after that",
        "[enter] continue",
      );

      // The welcome is local. It has not contacted the configured platform or
      // looked for a coding agent yet.
      const said = asOneLine(screen);
      expect(said).not.toContain("EGMA_TEST_DEFAULT_URL");
      expect(platform.records).toEqual([]);

      // The keystroke starts CLI authorization.
      terminal.write("\r");
      expect(await terminal.waitFor(() => platform.records.length > 0)).toBe(true);
      expect(
        platform.records.some((record) => record.path === "/api/platform"),
      ).toBe(false);
    } finally {
      await terminal.kill();
    }
  });

  it("lets an existing egma folder start another wizard walk", async () => {
    const terminal = await wizardInBoundRepository();
    try {
      const screen = await showingIn(
        terminal,
        asOneLine,
        "Welcome to Egma",
        "[enter] continue",
      );
      expect(asOneLine(screen)).not.toContain("already set up here");
      expect(platform.records).toEqual([]);
    } finally {
      await terminal.kill();
    }
  });
});
