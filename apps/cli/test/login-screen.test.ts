/**
 * The login step as a developer meets it, on a real terminal.
 *
 * A pseudo-terminal runs the built command and a headless terminal emulator
 * reads its screen and everything it wrote, so the promises about the address
 * are checked as terminal facts: the address on its own line, the copy key
 * really copying it, and a terminal too narrow for it getting a way out rather
 * than an address broken across two lines.
 *
 * Every wait here asks for **everything** the assertions after it will read,
 * and reads the screen that satisfied the wait. This screen arrives after a
 * redraw — the intro is on the alternate screen first — and it arrives in
 * chunks, so waiting for the code and then asserting on the hint bar is a race
 * that the machine wins whenever it is busy.
 */

import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copySequence } from "../src/platform/clipboard.ts";
import { columnsNeeded } from "../src/ui/tui/width.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { runInTerminal, showing, showingIn, type TerminalRun } from "./support/pty.ts";
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

type Opened = { readonly command: string; readonly opened: string };

async function wizard(options: {
  readonly browser: Opened;
  readonly does?: string;
  readonly cols?: number;
  readonly rows?: number;
}) {
  // Past login the walk goes straight on to finding the agent, so the scripted
  // agent answers that step. What it reports is the step's business and is
  // checked where that step is; here it only has to be an ending.
  const script = await workspace.script({
    steps: [
      { kind: "say", text: "egma:found framework retell-sdk\n" },
      { kind: "stop", reason: "end_turn" },
    ],
  });

  return runInTerminal({
    command: process.execPath,
    args: [
      CLI_ENTRY,
      "--cwd",
      workspace.dir,
      "--url",
      platform.url,
      "--",
      process.execPath,
      FAKE_AGENT,
      script,
    ],
    cwd: workspace.dir,
    env: workspace.env({
      BROWSER: options.browser.command,
      FIXTURE_BROWSER_WRITES_TO: options.browser.opened,
      FIXTURE_BROWSER_DOES: options.does ?? "nothing",
    }),
    ...(options.cols === undefined ? {} : { cols: options.cols }),
    ...(options.rows === undefined ? {} : { rows: options.rows }),
  });
}

/**
 * The code the terminal is showing, read off its screen.
 *
 * Whatever is on that line is the code. What shape egma issues codes in is the
 * instance's business and is asserted where the instance is — baking it in here
 * would make this screen check fail the day the codes get a character longer.
 */
function codeOn(screen: string): string {
  return /Code: (\S+)/u.exec(screen)?.[1] ?? "";
}

/**
 * The intro, and the keystroke that opens the walk.
 *
 * Login is the second screen, so nothing about it can be waited for until the
 * first one has been answered. The hint bar is what is waited for: it is the
 * last line the intro draws, and it is the one line short enough to survive
 * the narrow terminal one check here runs in without being wrapped.
 */
async function past(terminal: TerminalRun): Promise<void> {
  await showing(terminal, "[enter] begin", "[q] quit");
  terminal.write("\r");
}

/** This screen's own hints, which no other screen in the walk offers. */
const LOGIN_HINTS = ["[c] copy link", "[enter] paste a link back"] as const;

/**
 * Waits for the whole login screen, and for anything else asked for.
 *
 * The hint bar is this screen's own and is the last line it draws, so a screen
 * carrying it whole is a finished login frame. `[q] quit` is not that marker:
 * the intro carries it too, so a half-painted repaint over the intro would
 * satisfy it while the address was still in flight.
 */
async function loginScreen(
  terminal: TerminalRun,
  ...parts: readonly string[]
): Promise<string> {
  return showing(terminal, "Code:", ...LOGIN_HINTS, ...parts);
}

/** What is written inside the box, one line per line, without the box. */
function linesInside(screen: string): string[] {
  return screen.split("\n").map((line) => line.replaceAll("│", "").trim());
}

/** Everything on screen as one run of words, for text that has been wrapped. */
function asOneLine(screen: string): string {
  return linesInside(screen).join(" ").replaceAll(/\s+/gu, " ");
}

describe("the login screen", () => {
  it("shows the code, the address on its own line, and a way to copy it", async () => {
    const browser = await workspace.browser();
    const terminal = await wizard({ browser, cols: 120 });

    try {
      // The intro comes first, and the consent keystroke opens the walk.
      await past(terminal);

      // The browser opening repaints the first line of this screen, so the
      // sentence it repaints to is waited for rather than the one before it.
      const screen = await loginScreen(terminal, platform.url, "Approve this code");
      const code = codeOn(screen);
      expect(code).not.toBe("");

      // The address is on a line of its own, whole, with nothing else on it —
      // which is what makes a triple-click select an address that works.
      const approveUrl = `${platform.url}/device?user_code=${encodeURIComponent(code)}`;
      const ownLine = linesInside(screen).find((line) => line.startsWith(platform.url));
      expect(ownLine).toBe(approveUrl);

      // Pressing it asks the terminal itself to copy, which is what reaches the
      // clipboard of a laptop with an SSH connection open to somewhere else.
      terminal.write("c");
      expect(
        await terminal.waitFor(() => terminal.raw().includes(copySequence(approveUrl))),
      ).toBe(true);
      await showing(terminal, "Copied.");
    } finally {
      await terminal.kill();
    }
  });

  it("asks for a wider terminal rather than drawing an address that wraps", async () => {
    const browser = await workspace.browser();
    // Narrower than the address, which on a fixture is already short. Tall
    // enough that nothing is cut off the bottom, so what is missing from the
    // screen is missing because the screen left it out.
    const terminal = await wizard({ browser, cols: 40, rows: 40 });

    try {
      await past(terminal);

      // Waited for whole, because what is asserted below is what is *missing*
      // from it — and a frame that is still arriving is missing everything.
      // Every line of this screen is wrapped, so it is read run together.
      const screen = await showingIn(
        terminal,
        asOneLine,
        "Code:",
        ...LOGIN_HINTS,
        "The address needs",
        "columns and this terminal has 40",
      );
      const approveUrl = `${platform.url}/device?user_code=${codeOn(screen)}`;
      expect(asOneLine(screen)).toContain(
        `The address needs ${columnsNeeded(approveUrl)} columns and this terminal has 40`,
      );
      expect(asOneLine(screen)).toContain("[c] copy link");

      // The address itself is nowhere on the screen, whole or broken up. An
      // address selected across a line break is an address that does not work.
      expect(screen).not.toContain(platform.url);
      expect(screen.replaceAll(/\s+/gu, "")).not.toContain(
        platform.url.replaceAll(/\s+/gu, ""),
      );
    } finally {
      await terminal.kill();
    }
  });

  it("completes the login when a whole address is pasted back at it", async () => {
    const browser = await workspace.browser();
    // The browser opens nothing and approves nothing: this is the machine with
    // no browser on it at all.
    const terminal = await wizard({ browser, cols: 120 });

    try {
      await past(terminal);

      const code = codeOn(await loginScreen(terminal, platform.url));
      // Approved in a browser on another machine, and then pasted back here.
      expect(platform.device.approve(code)).toBe(true);
      terminal.write(`${platform.url}/device?user_code=${code}\r`);

      // The walk carried on: login is behind, the coding agent is being driven,
      // and the run ends on the one line the wizard leaves in scrollback.
      expect(await terminal.exited).toBe(0);
      expect(terminal.scrollback().trim()).toBe(
        "egma found your voice agent: retell-sdk.",
      );
      expect(platform.device.keys).toHaveLength(1);
    } finally {
      await terminal.kill();
    }
  });

  it("carries on to the task once the browser has approved, showing nothing to approve", async () => {
    const browser = await workspace.browser();
    const terminal = await wizard({ browser, does: "approve", cols: 120 });

    try {
      await past(terminal);

      expect(await terminal.exited).toBe(0);
      expect(terminal.scrollback().trim()).toBe(
        "egma found your voice agent: retell-sdk.",
      );

      // A key was minted and kept, and it is the one this egma issued.
      expect(platform.device.keys).toHaveLength(1);
    } finally {
      await terminal.kill();
    }
  });

  it("never says the words a terminal does not say", async () => {
    const browser = await workspace.browser();
    const terminal = await wizard({ browser, cols: 120 });

    try {
      await past(terminal);

      // Waited for whole: a frame that is half drawn says none of these words
      // because it says almost nothing, and would pass without proving a thing.
      const shown = await loginScreen(terminal, platform.url, "Approve this code");

      // A new account signs up in that browser page and gets everything it
      // needs there. The terminal names none of it — locked rule.
      for (const banned of ["organization", "organisation", "project", "tenant"]) {
        expect(new RegExp(`\\b${banned}`, "iu").test(shown), `the screen says "${banned}"`).toBe(
          false,
        );
      }
    } finally {
      await terminal.kill();
    }
  });
});
