/**
 * Running a command in a real pseudo-terminal and reading its real screen.
 *
 * Adapted from the PostHog wizard (MIT) — see ../../NOTICE.
 *
 * The wizard's whole promise about scrollback is a terminal fact, so proving it
 * needs a terminal. This starts the command in a pseudo-terminal, feeds its
 * output to a headless terminal emulator, and lets a test read either screen:
 * the alternate one the wizard draws on, or the ordinary one whose contents are
 * what a developer scrolls back through.
 *
 * A frame does not arrive whole. A pseudo-terminal hands its output over in
 * chunks of about a kilobyte, and one drawn screen is several of those, so a
 * test that polls the screen on a timer can read a frame that is half painted:
 * the first line of the wizard is there and the rest of it is still in flight.
 * The emulator parses each chunk asynchronously as well, so even a chunk that
 * has arrived may not be on the screen yet.
 *
 * `waitFor` closes both gaps. It is told when a chunk has been *parsed* rather
 * than when it arrived, and it checks the condition then — so a test waits for
 * everything it is about to assert, in one condition, and reads the screen that
 * satisfied it. `showing` is the way to spell that, and every check here uses
 * it rather than polling a screen on a timer.
 *
 * `kill` waits for the command to actually be gone. A test removes the folder
 * the command was running in as soon as it returns, and a process still writing
 * its log into a folder being deleted is a folder that will not delete.
 */

import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import type { IBuffer } from "@xterm/headless";

import { GOAL_ASK_LINE } from "../../src/ui/wizard-ui.ts";

const require = createRequire(import.meta.url);

// @xterm/headless ships CommonJS, and its `module` field points at the browser
// build, so the headless entry has to be required directly.
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
const pty = require("node-pty") as typeof import("node-pty");

/**
 * node-pty's prebuilt spawn helper can lose its execute bit when the package is
 * unpacked without running its install script. Restore it, best effort.
 */
function ensureSpawnHelper(): void {
  try {
    const root = path.dirname(require.resolve("node-pty/package.json"));
    const helper = path.join(
      root,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    if (existsSync(helper)) chmodSync(helper, 0o755);
  } catch {
    // Best effort: if it is already right, or not there, spawn will say so.
  }
}

export type TerminalRun = {
  /** What is on the screen right now, blank trailing lines removed. */
  screen(): string;
  /** What is in ordinary scrollback — what survives the alternate screen. */
  scrollback(): string;
  write(input: string): void;
  /** Everything the command has written, escape codes and all. */
  raw(): string;
  /**
   * Settles as soon as the condition holds, checked every time a chunk has been
   * parsed onto the screen. `false` means the budget ran out first.
   */
  waitFor(condition: () => boolean, timeoutMs?: number): Promise<boolean>;
  /** Stops the command and settles once it is gone and its last words are read. */
  kill(): Promise<void>;
  /** The exit code, once everything the command wrote is on the screen. */
  exited: Promise<number>;
};

/**
 * How long a condition is given.
 *
 * Generous on purpose: this is a real subprocess starting a real Node runtime
 * inside a test run that is using every core, so the honest budget is one that
 * cannot be reached by a machine merely being busy. A test that is going to
 * fail still fails at once, because the condition is checked on every chunk.
 * Sixty seconds because twenty was reached: a full-repository run beside other
 * work on the same machine held a whole-walk test past it while every check
 * still eventually passed. A wait ends the moment its content paints, so a
 * bigger budget costs a healthy run nothing.
 */
const WAIT_BUDGET_MS = 60_000;

export function runInTerminal(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cols?: number;
  readonly rows?: number;
}): TerminalRun {
  const cols = options.cols ?? 100;
  const rows = options.rows ?? 30;
  ensureSpawnHelper();

  const terminal = new Terminal({ cols, rows, allowProposedApi: true });

  // A terminal that thinks it is in CI draws nothing interactive, and the whole
  // point here is the interactive drawing.
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  for (const marker of ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS"]) delete env[marker];

  let raw = "";
  const child = pty.spawn(options.command, [...options.args], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: options.cwd,
    env: env as Record<string, string>,
  });

  /** Told every time the screen has changed, not every time bytes arrived. */
  const watchers = new Set<() => void>();
  const tell = (): void => {
    for (const watcher of [...watchers]) watcher();
  };

  /** Chunks the emulator has been handed and has not parsed yet. */
  let unparsed = 0;

  child.onData((chunk) => {
    raw += chunk;
    unparsed += 1;
    terminal.write(chunk, () => {
      unparsed -= 1;
      tell();
    });
  });

  const waitFor = (condition: () => boolean, timeoutMs = WAIT_BUDGET_MS): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (held: boolean): void => {
        if (done) return;
        done = true;
        watchers.delete(check);
        clearInterval(tick);
        clearTimeout(budget);
        resolve(held);
      };
      function check(): void {
        if (condition()) finish(true);
      }
      // A backstop for a condition that does not depend on the screen at all;
      // the chunk callbacks are what make this prompt.
      const tick = setInterval(check, 100);
      const budget = setTimeout(() => finish(false), timeoutMs);
      watchers.add(check);
      check();
    });

  let settle!: (code: number) => void;
  let gone = false;
  const finished = new Promise<number>((resolve) => {
    settle = resolve;
  });
  child.onExit(({ exitCode }) => {
    gone = true;
    settle(exitCode);
    tell();
  });

  // A command's last words can still be inside the emulator when it exits, and
  // scrollback is the thing tests read afterwards. So the code arrives once the
  // screen is caught up with it.
  const exited = finished.then(async (code) => {
    await waitFor(() => unparsed === 0, 5_000);
    return code;
  });

  const readBuffer = (buffer: IBuffer): string => {
    const lines: string[] = [];
    const end = buffer.baseY + rows;
    for (let index = 0; index < end; index += 1) {
      const line = buffer.getLine(index);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
    return lines.join("\n");
  };

  return {
    screen: () => readBuffer(terminal.buffer.active),
    scrollback: () => readBuffer(terminal.buffer.normal),
    raw: () => raw,
    waitFor,
    write: (input) => child.write(input),
    async kill() {
      // Asked once, then insisted upon. A command that is shutting a coding
      // agent down of its own accord is given a moment to finish doing it.
      for (const signal of ["SIGHUP", "SIGKILL"]) {
        if (gone) break;
        try {
          child.kill(signal);
        } catch {
          break;
        }
        if (await waitFor(() => gone, 2_000)) break;
      }
      // And its last words are on the screen before anything reads the screen
      // or removes the folder it was running in.
      await waitFor(() => unparsed === 0, 2_000);
    },
    exited,
  };
}

/**
 * Waits until the screen, read the given way, holds every one of these, and
 * answers the screen itself.
 *
 * The screen is captured at the moment the condition held, so a redraw that
 * starts immediately afterwards cannot take a line back out from under the
 * assertions. Ask for **everything** the assertions after it will read: waiting
 * for a frame's first line and then asserting on its last is a race the machine
 * wins whenever it is busy.
 *
 * `read` is there for a terminal too narrow to hold a line whole. Every line of
 * such a screen is wrapped, so a phrase is looked for in the screen run
 * together rather than line by line.
 */
export async function showingIn(
  terminal: TerminalRun,
  read: (screen: string) => string,
  ...parts: readonly string[]
): Promise<string> {
  let held = "";
  const shown = await terminal.waitFor(() => {
    const screen = terminal.screen();
    if (!parts.every((part) => read(screen).includes(part))) return false;
    held = screen;
    return true;
  });
  if (!shown) {
    throw new Error(
      `the terminal never showed all of: ${parts.join(" | ")}\n\nlast screen:\n${terminal.screen()}`,
    );
  }
  return held;
}

/** The same, reading the screen as it is drawn. */
export async function showing(
  terminal: TerminalRun,
  ...parts: readonly string[]
): Promise<string> {
  return showingIn(terminal, (screen) => screen, ...parts);
}

/**
 * The one question the wizard asks about itself, answered on the way past.
 *
 * Every walk in a real terminal meets it after discovery, and almost every
 * check in this suite is about something on the far side of it. So the answer
 * is given here, once, in the lane those checks are about — and a check that is
 * about the question itself asks for the screen by name instead.
 */
export async function chooseTesting(terminal: TerminalRun): Promise<void> {
  await showing(terminal, GOAL_ASK_LINE, "› Simulation testing", "[enter] choose this one");
  terminal.write("\r");
}

/** Take the default, explicit No answer at the existing-tests choice. */
export async function chooseNoExistingTests(terminal: TerminalRun): Promise<void> {
  await showing(terminal, "Do you already have test cases", "› No", "[enter] choose this one");
  terminal.write("\r");
}
