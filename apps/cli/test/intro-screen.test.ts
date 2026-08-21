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

/**
 * The same bare command, in a repository that has committed its platform.
 *
 * The stand-in for egma's own address is left as the closed port every
 * workspace hands over, so the address this screen names can only have come out
 * of the committed file.
 */
async function wizardInBoundRepository(): Promise<TerminalRun> {
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      platform: { origin: platform.url },
      agent: null,
      connection: null,
      suite: null,
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

      // The address, and the one way to name a different one. This is the
      // screen the keystroke of consent is taken on: nothing else stands
      // between reading it and agreeing to the walk.
      const said = asOneLine(screen);
      expect(said).toContain("--url <address>");
      // And the seam that stands the address in is not offered as a second way.
      expect(said).not.toContain("EGMA_TEST_DEFAULT_URL");

      // Nothing has been asked of that address. The whole reason the screen is
      // here rather than after resolution: a developer who reads this and quits
      // has sent nothing anywhere.
      expect(platform.records).toEqual([]);

      // And the keystroke is what lets egma speak to it.
      terminal.write("\r");
      expect(
        await terminal.waitFor(() =>
          platform.records.some((record) => record.path === "/api/device/code"),
        ),
      ).toBe(true);
    } finally {
      await terminal.kill();
    }
  });

  /**
   * A bound repository is offered the change it can actually make.
   *
   * `--url <address>` naming another platform is refused, with the whole move
   * block under it, once a repository has committed one. Offering it here would
   * be egma sending a developer to a command egma turns away — and offering it
   * from the screen that takes the keystroke of consent is the worst place in
   * the product to be wrong about what happens next.
   */
  it("offers a bound repository the edit it can make, not a flag egma refuses", async () => {
    const terminal = await wizardInBoundRepository();
    try {
      const screen = await showingIn(terminal, asOneLine, platform.url, "[enter] begin");
      const said = asOneLine(screen);

      // The address came out of the committed file: the built-in address is
      // stood aside by a closed port for this run, so nothing else could
      // have named it.
      expect(said).toContain(platform.url);

      // The change a bound repository can make is an edit to the file it
      // already commits, and that is what is offered.
      expect(said).toContain("egma/config.yaml");
      expect(said).not.toContain("--url <address>");

      // Still before anything is asked of that address, exactly as above.
      expect(platform.records).toEqual([]);
    } finally {
      await terminal.kill();
    }
  });
});
