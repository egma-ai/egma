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
  readCredentials,
  writeCredentials,
  type Credentials,
} from "./credentials.ts";
import {
  codeFromPaste,
  collectKey,
  normalizeUserCode,
  startDeviceAuthorization,
  PlatformUnreachableError,
  type Caller,
} from "./device-flow.ts";

/** What the developer has to approve, and where. */
export type LoginPrompt = {
  readonly userCode: string;
  /** The address to approve at, with the code already in it. */
  readonly url: string;
  /** Whether a browser was started on it, or the address is all there is. */
  readonly browserOpened: boolean;
};

export type LoginOutcome =
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
  readonly call?: Caller;
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
 * slices and ends early the moment anything arrives.
 */
const LOOK_UP_EVERY_MS = 100;

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

/** Waits out the interval, or ends early with whatever was pasted. */
async function waitOrPaste(
  waitMs: number,
  sleep: (ms: number) => Promise<void>,
  paste: (() => string | null) | undefined,
  signal: AbortSignal,
): Promise<string | null> {
  let left = waitMs;
  for (;;) {
    if (signal.aborted) return null;

    const typed = paste?.() ?? null;
    if (typed !== null && typed.trim() !== "") return typed;

    if (left <= 0) return null;
    const slice = paste === undefined ? left : Math.min(left, LOOK_UP_EVERY_MS);
    await sleep(slice);
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
export async function logIn(options: LogInOptions): Promise<LoginOutcome> {
  const say = options.say ?? NOTHING;
  const sleep = options.sleep ?? ((ms: number) => pause(ms, options.signal));
  const now = options.now ?? Date.now;
  const call = options.call ?? fetch;

  const held = await readCredentials(options.credentialsFile);
  if (options.force !== true && held !== null && held.url === options.url) {
    return { kind: "already-stored", url: held.url, key: held.key };
  }

  let grant;
  try {
    grant = await startDeviceAuthorization(options.url, call);
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
  let pasted: string | null = null;

  for (;;) {
    if (options.signal.aborted) return { kind: "interrupted" };

    if (pasted !== null) {
      const code = codeFromPaste(pasted);
      if (code === null) {
        say("That is not an egma code or an approval address. Paste the whole line.");
      } else if (code !== waitingFor) {
        say(
          `That code is ${code}, and this terminal is waiting on ${grant.userCode}. Approve the one on this screen.`,
        );
      } else {
        // The developer has been to a browser and come back, so the answer is
        // asked for now rather than at the next tick. That is the whole point
        // of pasting it back on a machine that could not open one itself.
        say("Checking that one now.");
      }
      pasted = null;
    }

    let collected;
    try {
      collected = await collectKey(options.url, grant.deviceCode, call);
    } catch (cause) {
      if (cause instanceof PlatformUnreachableError) {
        return { kind: "unreachable", reason: cause.message };
      }
      throw cause;
    }

    switch (collected.kind) {
      case "key": {
        const credentials: Credentials = { url: options.url, key: collected.key };
        await writeCredentials(options.credentialsFile, credentials);
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
        // fast. Anything other than backing off gets the same answer forever.
        waitMs = Math.max(waitMs, grant.intervalSeconds * 1000) + 1000;
        break;
      case "waiting":
        waitMs = grant.intervalSeconds * 1000;
        break;
    }

    if (now() > givesUpAt) return { kind: "expired" };
    pasted = await waitOrPaste(waitMs, sleep, options.paste, options.signal);
    if (options.signal.aborted) return { kind: "interrupted" };
  }
}
