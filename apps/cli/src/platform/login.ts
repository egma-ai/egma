/**
 * Logging in, once, for both the wizard and the headless verb.
 *
 * There is one flow here and there is no second one. The wizard is a screen
 * over it and `egma login` is plain lines over it, which is what makes the
 * wizard passing its tests evidence that the agent-callable surface works.
 *
 * Nothing in here draws, and nothing in here reads a keystroke. What the
 * developer has to see arrives through `onPrompt` and `say`; what they may have
 * pasted back is read through `paste`, which the caller answers from wherever
 * it collects typing. A flow that asked a question directly could not be both
 * a wizard screen and a promptless command.
 */

import {
  normalizePlatformOrigin,
  readCredentialsFor,
  rememberCredentials,
  type Credentials,
} from "./credentials.ts";
import {
  codeFromPaste,
  collectKey,
  normalizeUserCode,
  startDeviceAuthorization,
  PlatformUnreachableError,
  type Fetch,
} from "./device-flow.ts";

/** What the developer has to approve, and where. */
export type LoginPrompt = {
  readonly userCode: string;
  /** The address to approve at, with the code already in it. */
  readonly url: string;
  /** Whether a browser was started on it, or the address is all there is. */
  readonly browserOpened: boolean;
};

/**
 * The prompt as plain lines, one fact per line.
 *
 * Written once and read by both surfaces that print rather than draw — the
 * headless wizard and `egma login`. Two copies of these four lines would drift,
 * and a coding agent reading `browser:` from one of them and not the other is a
 * bug nobody would think to look for.
 */
export function loginLines(prompt: LoginPrompt): readonly string[] {
  return [
    `code: ${prompt.userCode}`,
    `approve_url: ${prompt.url}`,
    `browser: ${prompt.browserOpened ? "opened" : "not-opened"}`,
    "waiting: for this code to be approved in a browser",
  ];
}

export type LoginResult =
  | { readonly kind: "stored"; readonly url: string; readonly key: string }
  | { readonly kind: "already-stored"; readonly url: string; readonly key: string }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

export type LogInOptions = {
  /** The egma being logged in to, already resolved. */
  readonly url: string;
  /** Where the key is kept if one is minted. */
  readonly credentialsFile: string;
  /** Log in again even when a key for this egma is already held. */
  readonly force?: boolean;
  readonly signal: AbortSignal;
  /** The code and the address, as soon as egma has them. */
  readonly onPrompt: (prompt: LoginPrompt) => void;
  /** One line about what is happening, for whoever is watching. */
  readonly say?: (line: string) => void;
  /** What the developer has pasted back since the last look, if anything. */
  readonly paste?: () => string | null;
  /** Starts a browser on the address. Answers whether one started. */
  readonly openBrowser?: (url: string) => Promise<boolean>;
  readonly fetchImpl?: Fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

const NOTHING = (): void => undefined;

/**
 * How often a wait looks up to see whether something was pasted.
 *
 * The instance sets how often it may be asked for a key, and that is measured
 * in seconds. A developer who has just come back from a browser and pasted the
 * address should not sit through the rest of one, so the wait is slept in
 * slices and ends early the moment the code on screen arrives.
 */
const LOOK_UP_EVERY_MS = 100;

/**
 * What `slow_down` costs, in milliseconds.
 *
 * RFC 8628 sets both halves of this and neither is egma's to choose: five
 * seconds, and for this request *and every one after it*. An interval that
 * sprang back to what it was on the next answer would earn the same `slow_down`
 * for as long as the login lasted.
 */
const SLOW_DOWN_MS = 5_000;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      setTimeout(resolve, 0);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type Wait = {
  readonly waitMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly paste: (() => string | null) | undefined;
  readonly say: (line: string) => void;
  /** The code this terminal is waiting on, tidied for comparing. */
  readonly waitingFor: string;
  /** The same code as it is written on the screen, for saying back. */
  readonly shownAs: string;
  readonly signal: AbortSignal;
};

/**
 * Waits out the interval, and ends early only for the code on this screen.
 *
 * Pasting is read here rather than by the caller because what a paste means is
 * a question about the wait. The code on screen means "I have approved it, look
 * now" and cuts the wait short. Anything else — a sentence, half an address,
 * somebody else's code — is answered on screen and changes nothing: the pace
 * belongs to the instance, and a keyboard must not be able to turn a wrong
 * paste into a request. Otherwise a developer holding a paste key would make
 * egma ask for a key as fast as they could type.
 */
async function waitForPace(wait: Wait): Promise<void> {
  let left = wait.waitMs;
  for (;;) {
    if (wait.signal.aborted) return;

    const typed = wait.paste?.() ?? null;
    if (typed !== null && typed.trim() !== "") {
      const code = codeFromPaste(typed);
      if (code === null) {
        wait.say("That is not an egma code or an approval address. Paste the whole line.");
      } else if (code !== wait.waitingFor) {
        wait.say(
          `That code is ${code}, and this terminal is waiting on ${wait.shownAs}. Approve the one on this screen.`,
        );
      } else {
        // The developer has been to a browser and come back, so the answer is
        // asked for now rather than at the next tick. That is the whole point
        // of pasting it back on a machine that could not open one itself.
        wait.say("Checking that one now.");
        return;
      }
    }

    if (left <= 0) return;
    const slice = wait.paste === undefined ? left : Math.min(left, LOOK_UP_EVERY_MS);
    await wait.sleep(slice);
    left -= slice;
  }
}

/**
 * Runs the whole flow and answers what happened.
 *
 * Every ending is a value rather than an exception, because every ending means
 * something different to whoever asked — a denial is not a fault, an expired
 * code is not a denial, and an instance that never answered is neither.
 */
export async function logIn(options: LogInOptions): Promise<LoginResult> {
  const say = options.say ?? NOTHING;
  const sleep = options.sleep ?? ((ms: number) => pause(ms, options.signal));
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;

  const held = await readCredentialsFor(options.credentialsFile, options.url);
  if (options.force !== true && held !== null) {
    return { kind: "already-stored", url: held.url, key: held.key };
  }

  let grant;
  try {
    grant = await startDeviceAuthorization(options.url, fetchImpl);
  } catch (cause) {
    if (cause instanceof PlatformUnreachableError) {
      return { kind: "unreachable", reason: cause.message };
    }
    return {
      kind: "refused",
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const opened =
    options.openBrowser === undefined
      ? false
      : await options.openBrowser(grant.approveUrl);

  options.onPrompt({
    userCode: grant.userCode,
    url: grant.approveUrl,
    browserOpened: opened,
  });

  const waitingFor = normalizeUserCode(grant.userCode);
  const givesUpAt = now() + grant.expiresInSeconds * 1000;
  let waitMs = grant.intervalSeconds * 1000;

  for (;;) {
    if (options.signal.aborted) return { kind: "interrupted" };

    let collected;
    try {
      collected = await collectKey(options.url, grant.deviceCode, fetchImpl);
    } catch (cause) {
      if (cause instanceof PlatformUnreachableError) {
        return { kind: "unreachable", reason: cause.message };
      }
      throw cause;
    }

    switch (collected.kind) {
      case "key": {
        // Kept beside the keys for every other egma this machine knows, never
        // instead of them: a developer signs in to Egma Cloud and to their own
        // platform, and one login must not sign them out of the other.
        const credentials: Credentials = {
          url: normalizePlatformOrigin(options.url),
          key: collected.key,
        };
        await rememberCredentials(options.credentialsFile, credentials);
        return { kind: "stored", url: credentials.url, key: credentials.key };
      }
      case "denied":
        return { kind: "denied" };
      case "expired":
        return { kind: "expired" };
      case "refused":
        return { kind: "refused", reason: collected.reason };
      case "slow-down":
        // The instance sets the pace, and it has just said this one is too
        // fast. The new pace is kept for the rest of the login: an interval
        // that sprang back would earn the same answer at the next poll.
        waitMs += SLOW_DOWN_MS;
        break;
      case "waiting":
        // Nobody has answered yet, and the pace is whatever it already was.
        break;
    }

    if (now() > givesUpAt) return { kind: "expired" };
    await waitForPace({
      waitMs,
      sleep,
      paste: options.paste,
      say,
      waitingFor,
      shownAs: grant.userCode,
      signal: options.signal,
    });
    if (options.signal.aborted) return { kind: "interrupted" };
  }
}
