/**
 * The login step as a developer meets it, on a real terminal.
 *
 * A pseudo-terminal runs the built command and a headless terminal emulator
 * reads its screen and everything it wrote, so the promises about the address
 * are checked as terminal facts: the address on its own line, the copy key
 * really copying it, and a terminal too narrow for it getting a way out rather
 * than an address broken across two lines.
 */

import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copySequence } from "../src/platform/clipboard.ts";
import { columnsNeeded } from "../src/ui/tui/width.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { runInTerminal } from "./support/pty.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  MANIFEST,
  makeWorkspace,
  waitUntil,
  type Workspace,
} from "./support/workspace.ts";

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
  const script = await workspace.script({
    steps: [
      { kind: "say", text: "It is a package manifest." },
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

/** The code the terminal is showing, read off its screen. */
function codeOn(screen: string): string {
  return /Code: ([A-Z]{4}-[A-Z]{4})/u.exec(screen)?.[1] ?? "";
}

/**
 * Wait until the whole login screen is drawn, not merely the first line of it.
 *
 * The hint bar is the last thing on the screen, so a screen carrying both the
 * code and the hints is a finished frame rather than half of one.
 */
async function drawn(terminal: { screen(): string }): Promise<boolean> {
  return waitUntil(() => {
    const screen = terminal.screen();
    return screen.includes("Code:") && screen.includes("[q] quit");
  });
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
      expect(await waitUntil(() => terminal.screen().includes("[enter] begin"))).toBe(true);
      terminal.write("\r");

      expect(await drawn(terminal)).toBe(true);
      const screen = terminal.screen();
      const code = codeOn(screen);
      expect(code).not.toBe("");

      // The address is on a line of its own, whole, with nothing else on it —
      // which is what makes a triple-click select an address that works.
      const approveUrl = `${platform.url}/device/approve?user_code=${encodeURIComponent(code)}`;
      const ownLine = linesInside(screen).find((line) => line.startsWith(platform.url));
      expect(ownLine).toBe(approveUrl);

      expect(screen).toContain("[c] copy link");
      expect(screen).toContain("Approve this code");

      // Pressing it asks the terminal itself to copy, which is what reaches the
      // clipboard of a laptop with an SSH connection open to somewhere else.
      terminal.write("c");
      expect(await waitUntil(() => terminal.raw().includes(copySequence(approveUrl)))).toBe(
        true,
      );
      expect(await waitUntil(() => terminal.screen().includes("Copied."))).toBe(true);
    } finally {
      terminal.kill();
    }
  });

  it("asks for a wider terminal rather than drawing an address that wraps", async () => {
    const browser = await workspace.browser();
    // Narrower than the address, which on a fixture is already short. Tall
    // enough that nothing is cut off the bottom, so what is missing from the
    // screen is missing because the screen left it out.
    const terminal = await wizard({ browser, cols: 40, rows: 40 });

    try {
      expect(await waitUntil(() => terminal.screen().includes("[enter] begin"))).toBe(true);
      terminal.write("\r");
      expect(await drawn(terminal)).toBe(true);

      const screen = terminal.screen();
      const approveUrl = `${platform.url}/device/approve?user_code=${codeOn(screen)}`;
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
      terminal.kill();
    }
  });

  it("completes the login when a whole address is pasted back at it", async () => {
    const browser = await workspace.browser();
    // The browser opens nothing and approves nothing: this is the machine with
    // no browser on it at all.
    const terminal = await wizard({ browser, cols: 120 });

    try {
      expect(await waitUntil(() => terminal.screen().includes("[enter] begin"))).toBe(true);
      terminal.write("\r");
      expect(await drawn(terminal)).toBe(true);

      const code = codeOn(terminal.screen());
      // Approved in a browser on another machine, and then pasted back here.
      expect(platform.device.approve(code)).toBe(true);
      terminal.write(`${platform.url}/device/approve?user_code=${code}\r`);

      // The walk carried on: login is behind, the coding agent is being driven,
      // and the run ends on the one line the wizard leaves in scrollback.
      expect(await terminal.exited).toBe(0);
      expect(terminal.scrollback().trim()).toBe(
        "node read package.json for egma. Nothing in this folder was changed.",
      );
      expect(platform.device.keys).toHaveLength(1);
    } finally {
      terminal.kill();
    }
  });

  it("carries on to the task once the browser has approved, showing nothing to approve", async () => {
    const browser = await workspace.browser();
    const terminal = await wizard({ browser, does: "approve", cols: 120 });

    try {
      expect(await waitUntil(() => terminal.screen().includes("[enter] begin"))).toBe(true);
      terminal.write("\r");

      expect(await terminal.exited).toBe(0);
      expect(terminal.scrollback().trim()).toBe(
        "node read package.json for egma. Nothing in this folder was changed.",
      );

      // A key was minted and kept, and it is the one this egma issued.
      expect(platform.device.keys).toHaveLength(1);
    } finally {
      terminal.kill();
    }
  });

  it("never says the words a terminal does not say", async () => {
    const browser = await workspace.browser();
    const terminal = await wizard({ browser, cols: 120 });

    try {
      expect(await waitUntil(() => terminal.screen().includes("[enter] begin"))).toBe(true);
      terminal.write("\r");
      expect(await drawn(terminal)).toBe(true);

      // A new account signs up in that browser page and gets everything it
      // needs there. The terminal names none of it — locked rule.
      const shown = terminal.screen();
      for (const banned of ["organization", "organisation", "project", "tenant"]) {
        expect(new RegExp(`\\b${banned}`, "iu").test(shown), `the screen says "${banned}"`).toBe(
          false,
        );
      }
    } finally {
      terminal.kill();
    }
  });
});
