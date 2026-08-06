/**
 * Entering and leaving the terminal's alternate screen.
 *
 * Adapted from the PostHog wizard (MIT) — see ../../../NOTICE.
 *
 * The wizard draws on a screen the terminal keeps separate from the developer's
 * scrollback and throws away on exit, so a whole run leaves nothing behind. The
 * one line that must survive is printed after the screen is released.
 */

import process from "node:process";

const RESET_ATTRIBUTES = "[0m";
const CLEAR_SCREEN = "[2J";
const CURSOR_HOME = "[H";
const ENTER_ALTERNATE_SCREEN = "[?1049h";
const LEAVE_ALTERNATE_SCREEN = "[?1049l";

export function enterAlternateScreen(out: NodeJS.WritableStream = process.stdout): void {
  out.write(ENTER_ALTERNATE_SCREEN + CLEAR_SCREEN + CURSOR_HOME);
}

export function leaveAlternateScreen(out: NodeJS.WritableStream = process.stdout): void {
  out.write(RESET_ATTRIBUTES + LEAVE_ALTERNATE_SCREEN);
}
