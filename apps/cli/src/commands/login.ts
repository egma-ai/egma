/**
 * `egma login`: promptless device login for a coding agent to start.
 *
 * It asks nothing. Nothing here reads standard input, so a coding agent can run
 * it, read what it prints, and act on the answer without a person relaying
 * anything. Output is ordinary terminal prose, not a private machine protocol.
 */

import { openInBrowser } from "../platform/browser.ts";
import type { PlatformAccess } from "../platform/credentials.ts";
import { logIn, loginLines, type LoginResult } from "../platform/login.ts";
import { oneLineFactText } from "../ui/fact-value.ts";

/** What each ending means to whoever ran the command. */
export const LOGIN_EXIT = {
  /** A key is on disk for the egma that was asked for. */
  stored: 0,
  /** Somebody said no in the browser. */
  denied: 1,
  /** Nobody approved it before the code ran out. */
  expired: 1,
  /**
   * egma did not answer, or answered and would not do it.
   *
   * One number for both, because both mean the same thing to whoever ran the
   * command: nothing is going to come of asking this egma again the same way,
   * and a person has to look. The message explains which case occurred.
   */
  unreachable: 1,
  /** Stopped part way through. */
  interrupted: 130,
} as const;

export type LoginCommandOptions = {
  /** Which egma, and where the key goes. Resolved once, by the caller. */
  readonly access: PlatformAccess;
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
    case "stored-interrupted":
      return LOGIN_EXIT.interrupted;
    case "not-stored":
      return result.interrupted
        ? LOGIN_EXIT.interrupted
        : LOGIN_EXIT.unreachable;
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
  const shownCredentialsFile = oneLineFactText(
    credentialsFile,
    "the Egma credentials file",
  );

  options.out(`Signing in to ${url}.`);

  const result = await logIn({
    url,
    credentialsFile,
    signal: options.signal,
    onPrompt: (prompt) => {
      for (const line of loginLines(prompt)) options.out(line);
    },
    openBrowser: (address) =>
      openInBrowser(address, { instanceUrl: url, env: options.env }),
  });

  switch (result.kind) {
    case "stored":
      options.out(`Login saved in ${shownCredentialsFile}.`);
      break;
    case "stored-interrupted":
      options.out(`Login saved in ${shownCredentialsFile}.`);
      options.fail(
        "The command was interrupted after Egma created and saved the login.",
      );
      break;
    case "already-stored":
      options.out(
        `This machine is already signed in. The saved login is in ${shownCredentialsFile}.`,
      );
      break;
    case "not-stored":
      options.fail(result.reason);
      break;
    case "denied":
      options.fail("The login was denied in the browser. Nothing was stored.");
      break;
    case "expired":
      options.fail("Nobody approved the login before the code ran out. Run egma login again.");
      break;
    case "interrupted":
      options.fail("The login was stopped before it finished. Nothing was stored.");
      break;
    case "unreachable":
    case "refused":
      options.fail(result.reason);
      break;
  }

  return loginExitCode(result);
}
