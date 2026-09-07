/**
 * Open the validated verification URL, honoring BROWSER first.
 * The Windows opener uses a shell builtin, so URL checks remain required.
 * If opening fails, retain the printed URL and continue polling for approval.
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
      // The browser outlives the CLI command, and a browser still running must never
      // be what keeps the terminal from closing.
      child.unref();
    } catch {
      settle(false);
    }
  });
}
