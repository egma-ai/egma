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

/** The bare command: no verb, no `--url`, and no `EGMA_URL` in the shell. */
function bareWizard(): TerminalRun {
  const args = [CLI_ENTRY, "--cwd", workspace.dir];
  expect(args).not.toContain("--url");
  const env = workspace.env({
    // The stand-in for egma's own address. Nothing here dials the real one.
    EGMA_TEST_DEFAULT_URL: platform.url,
  });
  expect(env.EGMA_URL).toBeUndefined();

  return runInTerminal({
    command: process.execPath,
    args: [...args, "--", process.execPath, FAKE_AGENT, "no-script"],
    cwd: workspace.dir,
    env,
    cols: 100,
  });
}

describe("the wizard's first screen", () => {
  it("names the egma it will use, and says how to choose another", async () => {
    const terminal = bareWizard();
    try {
      const screen = await showingIn(
        terminal,
        asOneLine,
        platform.url,
        "--url <address>",
        "[enter] begin",
      );

      // The address, and the two ways to name a different one. This is the
      // screen the keystroke of consent is taken on: nothing else stands
      // between reading it and agreeing to the walk.
      const said = asOneLine(screen);
      expect(said).toContain("--url <address>");
      expect(said).toContain("EGMA_URL");
      // And the seam that stands the address in is not offered as a third way.
      expect(said).not.toContain("EGMA_TEST_DEFAULT_URL");

      // Nothing has been asked of that address. The whole reason the screen is
      // here rather than after resolution: a developer who reads this and quits
      // has sent nothing anywhere.
      expect(platform.records).toEqual([]);

      // And the keystroke is what lets egma speak to it.
      terminal.write("\r");
      expect(
        await terminal.waitFor(() =>
          platform.records.some((record) => record.path === "/api/platform"),
        ),
      ).toBe(true);
    } finally {
      await terminal.kill();
    }
  });
});
