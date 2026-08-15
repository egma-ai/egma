/**
 * Opening the alternate screen, and closing it with one line behind.
 *
 * Adapted from the PostHog wizard (MIT) — see ../../../NOTICE.
 *
 * Everything the wizard draws lives on a screen the terminal discards, so the
 * exit line is written after that screen is released and is the only thing a
 * developer scrolls back to.
 */

import process from "node:process";
import { createElement } from "react";

import { render } from "ink";

import { buildExitNotice, exitLines, type ExitReport } from "../../wizard/exit-line.ts";
import type { StopReason } from "../../wizard/stop.ts";
import type { WizardUI } from "../wizard-ui.ts";
import { App } from "./App.tsx";
import { InkUI } from "./ink-ui.ts";
import { WizardStore } from "./store.ts";
import { enterAlternateScreen, leaveAlternateScreen } from "./terminal.ts";

export type TuiHandle = {
  readonly ui: WizardUI;
  readonly store: WizardStore;
  /**
   * Leaves the alternate screen and prints the one line that survives.
   *
   * `null` leaves nothing behind: the wizard is handing the last word to
   * whoever called it, which is what happens when egma declines to talk to a
   * platform at all. That sentence is not the wizard's to say, and saying it
   * here as well would print it twice.
   */
  close(report: ExitReport | null): void;
};

export type StartTuiOptions = {
  /** Called when the developer quits or interrupts. */
  readonly stop: (reason: StopReason) => void;
  readonly stdout?: NodeJS.WriteStream;
  readonly stdin?: NodeJS.ReadStream;
};

export function startTui(options: StartTuiOptions): TuiHandle {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;

  enterAlternateScreen(stdout);

  const store = new WizardStore();
  const instance = render(
    createElement(App, {
      store,
      onQuit: () => options.stop("quit"),
      onInterrupt: () => options.stop("interrupt"),
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: true },
  );

  let closed = false;
  const close = (report: ExitReport | null): void => {
    if (closed) return;
    closed = true;
    instance.unmount();
    leaveAlternateScreen(stdout);
    if (report === null) return;
    const notice = buildExitNotice(report);
    if (notice !== null) stdout.write(`${notice}\n\n`);
    stdout.write(`${exitLines(report).join("\n")}\n`);
  };

  // Tearing raw mode down while a read is pending surfaces a harmless EIO on
  // some terminals; without this Node prints a stack over the exit line.
  stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EIO") throw error;
  });

  // Whatever happens, the developer's terminal is handed back.
  process.on("exit", () => {
    if (closed) return;
    closed = true;
    instance.unmount();
    leaveAlternateScreen(stdout);
  });

  return { ui: new InkUI(store), store, close };
}
