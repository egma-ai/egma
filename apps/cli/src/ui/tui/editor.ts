/**
 * Handing the terminal to the developer's own editor, and taking it back.
 *
 * The gate offers to open a generated test before anything is uploaded, and an
 * editor is a program that owns the whole terminal: it reads the keyboard in
 * raw mode and paints every cell. So for as long as it runs, egma must own none
 * of that — the wizard's frame comes off, the alternate screen is released, the
 * child inherits the real terminal, and all three are put back afterwards.
 *
 * Ink is asked to suspend rather than being unmounted and started again: it
 * flushes its frame, hands the keyboard back, and forces a full redraw when the
 * suspension ends, so what the developer sees on their way back is the same
 * screen they left rather than a half-diffed one. The alternate screen is
 * egma's own, entered before Ink was ever started, so egma is what leaves it
 * and enters it again.
 *
 * Nothing here guesses. A machine with no `$EDITOR` set is told to set one,
 * because opening something a developer did not choose is worse than opening
 * nothing.
 */

import { spawn } from "node:child_process";
import process from "node:process";

import { enterAlternateScreen, leaveAlternateScreen } from "./terminal.ts";

/** What a developer is told when there is no editor to open. */
export const NO_EDITOR_LINE =
  "No editor is set. Set $EDITOR (or $VISUAL) to the command you edit with, then press e again.";

/**
 * The editor command and its arguments, out of the environment.
 *
 * `VISUAL` first, then `EDITOR`: that is the order every other tool honours,
 * and it is the one a developer who has set both is expecting. The value is a
 * command line rather than a command — `code --wait` and `emacs -nw` are both
 * ordinary settings — so it is split on blank space, which is what a shell
 * would do to anything without quoting in it.
 */
export function editorCommand(env: NodeJS.ProcessEnv): {
  readonly command: string;
  readonly args: readonly string[];
} | null {
  for (const variable of ["VISUAL", "EDITOR"]) {
    const set = (env[variable] ?? "").trim();
    if (set === "") continue;
    const [command, ...args] = set.split(/\s+/u);
    if (command !== undefined && command !== "") return { command, args };
  }
  return null;
}

export type EditorOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: NodeJS.WriteStream;
  /**
   * Hands the terminal over for as long as the callback runs, and takes it
   * back afterwards. Ink's own, so that its frame and the keyboard are handled
   * by the thing that owns them.
   */
  readonly suspend: (during: () => Promise<void>) => Promise<void>;
};

/**
 * Opens one file and settles when the editor has closed. Answers the line to
 * show when it could not be opened, or `null` when it was.
 */
export async function openInEditor(file: string, options: EditorOptions): Promise<string | null> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;

  const editor = editorCommand(env);
  if (editor === null) return NO_EDITOR_LINE;

  let problem: string | null = null;

  await options.suspend(async () => {
    leaveAlternateScreen(stdout);
    try {
      problem = await runEditor(editor.command, [...editor.args, file], env);
    } finally {
      enterAlternateScreen(stdout);
    }
  });

  return problem;
}

/** The child, with the developer's terminal and nothing of egma's in the way. */
function runEditor(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: "inherit", env });

    child.once("error", (error: Error) => {
      resolve(`egma could not start ${command}: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      // An editor that was killed, or that exited unhappily, has not
      // necessarily lost anything — but saying nothing about it would leave a
      // developer wondering whether their edit landed.
      if (signal !== null) return resolve(`${command} was stopped (${signal}).`);
      if (code !== null && code !== 0) return resolve(`${command} exited with ${code}.`);
      resolve(null);
    });
  });
}
