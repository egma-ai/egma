/**
 * Logging in for the promptless `egma login` command.
 *
 * There is one flow here. `egma login` is a terminal-text adapter over it, so
 * tests exercise the same path a coding agent uses.
 *
 * Nothing in here draws, and nothing in here reads a keystroke. What the
 * developer has to see arrives through `onPrompt` and `say`; what they may have
 * pasted back is read through `paste`, which the caller answers from wherever
 * it collects typing. A flow that asked a question directly could not be both
 * both browser approval and a promptless command.
 */

import {
  readCredentials,
  writeCredentials,
  type Credentials,
} from "./credentials.ts";
import { revokeProjectKey } from "./api-keys.ts";
import { platformText } from "./client.ts";
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
 * The prompt as readable terminal text.
 */
export function loginLines(prompt: LoginPrompt): readonly string[] {
  return [
    "Approve this login in your browser.",
    `Code: ${prompt.userCode}`,
    `Approval URL: ${prompt.url}`,
    prompt.browserOpened
      ? "The approval page was opened in your browser."
      : "Open the approval URL in a browser.",
    "Waiting for approval.",
  ];
}

export type LoginResult =
  | { readonly kind: "stored"; readonly url: string; readonly key: string }
  | {
      readonly kind: "stored-interrupted";
      readonly url: string;
      readonly key: string;
    }
  | { readonly kind: "already-stored"; readonly url: string; readonly key: string }
  | {
      readonly kind: "not-stored";
      readonly reason: string;
      readonly interrupted: boolean;
    }
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
  /** Filesystem boundary, replaced only by recovery tests. */
  readonly saveCredentials?: typeof writeCredentials;
  /** Compensating revoke boundary, replaced only by recovery tests. */
  readonly revokeLoginKey?: typeof revokeProjectKey;
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

function causeText(cause: unknown): string {
  return (
    platformText(cause instanceof Error ? cause.message : String(cause)) ||
    "unknown local error"
  );
}

async function recoverUnstoredKey(
  options: LogInOptions,
  input: {
    readonly key: string;
    readonly apiKeyId: string | null;
    readonly failure: string;
  },
): Promise<LoginResult> {
  if (input.apiKeyId === null) {
    return {
      kind: "not-stored",
      interrupted: options.signal.aborted,
      reason:
        `${input.failure} Egma did not return the new key's ID, so the CLI ` +
        "could not revoke it. Inspect this platform's API keys in Egma before running egma login again.",
    };
  }

  let recovery: string;
  try {
    const revoked = await (options.revokeLoginKey ?? revokeProjectKey)(
      input.apiKeyId,
      {
        url: options.url,
        key: input.key,
        // Cleanup is required because the server write already completed. Do
        // not hand an already-aborted user signal to the compensating request.
        signal: new AbortController().signal,
        ...(options.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetchImpl }),
      },
    );
    recovery =
      revoked.kind === "revoked"
        ? `Egma revoked the unstored login key ${input.apiKeyId}.`
        : `Login key ${input.apiKeyId} may still exist. Open Egma and revoke it before retrying. ${revoked.reason}`;
  } catch (cause) {
    recovery =
      `Login key ${input.apiKeyId} may still exist. Open Egma and revoke it before retrying. ` +
      `The cleanup request failed: ${causeText(cause)}`;
  }

  return {
    kind: "not-stored",
    interrupted: options.signal.aborted,
    reason: `${input.failure} ${recovery}`,
  };
}

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
        wait.say("That is not an Egma code or an approval address. Paste the whole line.");
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

  const held = await readCredentials(options.credentialsFile, options.url);
  if (held !== null && held.url === options.url) {
    return { kind: "already-stored", url: held.url, key: held.key };
  }

  let grant;
  try {
    grant = await startDeviceAuthorization(
      options.url,
      fetchImpl,
      options.signal,
    );
  } catch (cause) {
    if (options.signal.aborted) return { kind: "interrupted" };
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
      collected = await collectKey(
        options.url,
        grant.deviceCode,
        fetchImpl,
        options.signal,
      );
    } catch (cause) {
      if (options.signal.aborted) return { kind: "interrupted" };
      if (cause instanceof PlatformUnreachableError) {
        return { kind: "unreachable", reason: cause.message };
      }
      throw cause;
    }

    if (
      options.signal.aborted &&
      collected.kind !== "key" &&
      collected.kind !== "incomplete-key"
    ) {
      return { kind: "interrupted" };
    }

    switch (collected.kind) {
      case "key": {
        const credentials: Credentials = {
          url: options.url,
          key: collected.key,
          login: collected.login,
        };
        try {
          await (options.saveCredentials ?? writeCredentials)(
            options.credentialsFile,
            credentials,
          );
        } catch (cause) {
          return recoverUnstoredKey(options, {
            key: collected.key,
            apiKeyId: collected.login.apiKeyId,
            failure:
              `Egma created login key ${collected.login.apiKeyId}, but the CLI could not save it in ` +
              `${platformText(options.credentialsFile) || "the Egma credentials file"}: ${causeText(cause)}`,
          });
        }
        return {
          kind: options.signal.aborted ? "stored-interrupted" : "stored",
          url: credentials.url,
          key: credentials.key,
        };
      }
      case "incomplete-key":
        return recoverUnstoredKey(options, {
          key: collected.key,
          apiKeyId: collected.apiKeyId,
          failure: "Egma created a login key but returned an incomplete receipt.",
        });
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
