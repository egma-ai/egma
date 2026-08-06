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
 */

import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import type { IBuffer } from "@xterm/headless";

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
  kill(): void;
  exited: Promise<number>;
};

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

  child.onData((chunk) => {
    raw += chunk;
    terminal.write(chunk);
  });

  let settle!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });
  child.onExit(({ exitCode }) => settle(exitCode));

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
    write: (input) => child.write(input),
    kill: () => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    },
    exited,
  };
}
