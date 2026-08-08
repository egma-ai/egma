/**
 * Opening the developer's browser on the address they have to approve at.
 *
 * The address is handed to the opener as one argument and never through a
 * shell — but on Windows the opener *is* a shell, because `start` is a builtin
 * of one, and it reads what it is given a second time. So the address is
 * checked before it is passed to anything: it has to be an http address, on the
 * egma this login is against, made of characters no command interpreter reads
 * as syntax. Anything else is not opened at all.
 *
 * `BROWSER` is honoured first. It is the variable a developer already sets when
 * the machine's idea of a browser is wrong — a devbox, a container, a desktop
 * with two of them — and honouring it costs nothing and is the difference
 * between a working login and a shrug.
 *
 * Failing to open a browser is not a failure of login. The address is on the
 * screen either way, and the whole point of the copy key and the paste-back is
 * that a machine with no browser still gets through.
 */

import { spawn } from "node:child_process";
import process from "node:process";

import { isOpenable } from "./address.ts";

/** How a browser is started, per platform, when nothing has been set. */
function opener(platform: string): { command: string; args: readonly string[] } {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [] };
    case "win32":
      // `start` is a shell builtin, so the shell is the command; the empty
      // string is the window title `start` takes before the address.
      return { command: "cmd", args: ["/c", "start", ""] };
    default:
      return { command: "xdg-open", args: [] };
  }
}

export type BrowserOptions = {
  /**
   * The egma this login is against. An address on any other origin is shown
   * and never opened, because egma chose the instance and the instance does
   * not get to choose where the developer is sent.
   */
  readonly instanceUrl: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: string;
};

/** True when a browser was started. False when there was nothing to start. */
export async function openInBrowser(
  url: string,
  options: BrowserOptions,
): Promise<boolean> {
  if (!isOpenable(url, options.instanceUrl)) return false;

  const env = options.env ?? process.env;
  const chosen = env.BROWSER?.trim();
  const { command, args } =
    chosen !== undefined && chosen !== ""
      ? { command: chosen, args: [] as readonly string[] }
      : opener(options.platform ?? process.platform);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };

    try {
      const child = spawn(command, [...args, url], {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => settle(false));
      child.on("spawn", () => settle(true));
      // The browser outlives the wizard, and a browser still running must never
      // be what keeps the terminal from closing.
      child.unref();
    } catch {
      settle(false);
    }
  });
}
