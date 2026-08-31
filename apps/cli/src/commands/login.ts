/**
 * `egma login`: promptless device login for a coding agent to start.
 *
 * It asks nothing. Nothing here reads standard input, so a coding agent can run
 * it, read what it prints, and act on the answer without a person relaying
 * anything. What it prints is one fact per line, `name: value`, in a shape that
 * does not move: the code and the address while it waits, then what happened
 * and where the key went.
 *
 * The exit code is the branch. A coding agent that reads nothing at all still
 * knows whether it has a key, whether somebody said no, and whether the code
 * simply ran out.
 */

import { openInBrowser } from "../platform/browser.ts";
import type { PlatformAccess } from "../platform/credentials.ts";
import { logIn, loginLines, type LoginResult } from "../platform/login.ts";

/** What each ending means to whoever ran the command. */
export const LOGIN_EXIT = {
  /** A key is on disk for the egma that was asked for. */
  stored: 0,
  /** Somebody said no in the browser. */
  denied: 2,
  /** Nobody approved it before the code ran out. */
  expired: 3,
  /**
   * egma did not answer, or answered and would not do it.
   *
   * One number for both, because both mean the same thing to whoever ran the
   * command: nothing is going to come of asking this egma again the same way,
   * and a person has to look. The `status:` line tells the two apart for
   * anything that reads rather than branches.
   */
  unreachable: 4,
  /** Stopped part way through. */
  interrupted: 130,
} as const;

export type LoginCommandOptions = {
  /** Which egma, and where the key goes. Resolved once, by the caller. */
  readonly access: PlatformAccess;
  /** Mint a key even when this machine already holds one. */
  readonly force: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
};

function loginExitCode(result: LoginResult): number {
  switch (result.kind) {
    case "stored":
    case "already-stored":
      return LOGIN_EXIT.stored;
    case "denied":
      return LOGIN_EXIT.denied;
    case "expired":
      return LOGIN_EXIT.expired;
    case "interrupted":
      return LOGIN_EXIT.interrupted;
    case "unreachable":
    case "refused":
      return LOGIN_EXIT.unreachable;
  }
}

export async function runLoginCommand(options: LoginCommandOptions): Promise<number> {
  const { url, credentialsFile } = options.access;

  options.out(`url: ${url}`);

  const result = await logIn({
    url,
    credentialsFile,
    force: options.force,
    signal: options.signal,
    onPrompt: (prompt) => {
      for (const line of loginLines(prompt)) options.out(line);
    },
    say: (line) => options.out(`note: ${line}`),
    openBrowser: (address) =>
      openInBrowser(address, { instanceUrl: url, env: options.env }),
  });

  switch (result.kind) {
    case "stored":
    case "already-stored":
      options.out(`status: ${result.kind}`);
      options.out(`credentials: ${credentialsFile}`);
      break;
    case "denied":
      options.out("status: denied");
      options.fail("The login was denied in the browser. Nothing was stored.");
      break;
    case "expired":
      options.out("status: expired");
      options.fail("Nobody approved the login before the code ran out. Run egma login again.");
      break;
    case "interrupted":
      options.out("status: interrupted");
      options.fail("The login was stopped before it finished. Nothing was stored.");
      break;
    case "unreachable":
    case "refused":
      options.out(`status: ${result.kind}`);
      options.out(`reason: ${result.reason}`);
      options.fail(result.reason);
      break;
  }

  return loginExitCode(result);
}
