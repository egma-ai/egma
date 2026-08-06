/**
 * `egma login`: the same flow the wizard runs, with nobody watching.
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
import {
  credentialsFileIn,
  readCredentials,
  resolvePlatformUrl,
} from "../platform/credentials.ts";
import { logIn, type LoginOutcome } from "../platform/login.ts";

/** What each ending means to whoever ran the command. */
export const LOGIN_EXIT = {
  /** A key is on disk for the egma that was asked for. */
  stored: 0,
  /** Somebody said no in the browser. */
  denied: 2,
  /** Nobody approved it before the code ran out. */
  expired: 3,
  /** egma did not answer, or refused. */
  unreachable: 4,
  /** Stopped part way through. */
  interrupted: 130,
} as const;

export type LoginCommandOptions = {
  /** `--url`, when one was given. */
  readonly url: string | null;
  /** Mint a key even when this machine already holds one. */
  readonly force: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
};

function exitCodeFor(outcome: LoginOutcome): number {
  switch (outcome.kind) {
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
  const credentialsFile = credentialsFileIn(options.env);
  const stored = await readCredentials(credentialsFile);
  const url = resolvePlatformUrl({
    flag: options.url,
    env: options.env.EGMA_URL,
    stored: stored?.url ?? null,
  });

  options.out(`url: ${url}`);

  const outcome = await logIn({
    url,
    credentialsFile,
    force: options.force,
    signal: options.signal,
    onPrompt: (prompt) => {
      options.out(`code: ${prompt.userCode}`);
      options.out(`approve_url: ${prompt.url}`);
      options.out(`browser: ${prompt.browserOpened ? "opened" : "not-opened"}`);
      options.out("waiting: for this code to be approved in a browser");
    },
    say: (line) => options.out(`note: ${line}`),
    openBrowser: (address) => openInBrowser(address, options.env),
  });

  switch (outcome.kind) {
    case "stored":
    case "already-stored":
      options.out(`status: ${outcome.kind}`);
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
      options.out(`status: ${outcome.kind}`);
      options.out(`reason: ${outcome.reason}`);
      options.fail(outcome.reason);
      break;
  }

  return exitCodeFor(outcome);
}
