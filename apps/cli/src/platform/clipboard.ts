/**
 * Putting the approval address on the clipboard, including over SSH.
 *
 * The terminal is asked to do it, with the escape sequence terminals answer for
 * exactly this — because the machine egma is running on is often not the
 * machine the keyboard is on, and a clipboard tool on a devbox copies to a
 * clipboard nobody can paste from. The sequence travels the SSH connection and
 * lands on the laptop's own clipboard, which is where the browser is.
 *
 * The local clipboard tool is tried as well, best effort, for the terminals
 * that answer nothing. Whichever works, the developer never sees the
 * difference; and if neither does, the address is still on the screen.
 */

import { spawn } from "node:child_process";
import process from "node:process";

/** What a terminal is asked with. `c` is the clipboard everybody pastes from. */
export function copySequence(url: string): string {
  return `\u001b]52;c;${Buffer.from(url, "utf8").toString("base64")}\u0007`;
}

function localTool(platform: string): { command: string; args: readonly string[] } | null {
  switch (platform) {
    case "darwin":
      return { command: "pbcopy", args: [] };
    case "win32":
      return { command: "clip", args: [] };
    case "linux":
      return { command: "xclip", args: ["-selection", "clipboard"] };
    default:
      return null;
  }
}

export type CopyOptions = {
  /** Where the escape sequence goes. The terminal egma is drawing on. */
  readonly write: (sequence: string) => void;
  readonly platform?: string;
};

/** Copies the address, both ways at once. Neither way is waited on. */
export function copyLink(url: string, options: CopyOptions): void {
  options.write(copySequence(url));

  const tool = localTool(options.platform ?? process.platform);
  if (tool === null) return;

  try {
    const child = spawn(tool.command, [...tool.args], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    // Nothing here is worth interrupting a login for: the sequence above has
    // already gone, and a machine without the tool is the ordinary case.
    child.on("error", () => undefined);
    child.stdin.on("error", () => undefined);
    child.stdin.end(url, "utf8");
  } catch {
    // Same.
  }
}
