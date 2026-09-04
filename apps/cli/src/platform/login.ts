/**
 * Logging in for the promptless `egma login` command.
 *
 * There is one flow here. `egma login` is a terminal-text adapter over it, so
 * tests exercise the same path a coding agent uses.
 *
 * Nothing in here draws, and nothing in here reads a keystroke. What the
 * developer has to see arrives through `onPrompt`; browser approval is polled
 * at the pace set by the platform. A flow that
 * asked a question directly could not be both browser approval and a
 * promptless command.
 */

import {
  readCredentials,
  writeCredentials,
  type Credentials,
} from "./credentials.ts";
import { revokeProjectKey } from "./api-keys.ts";
import { platformText } from "./client.ts";
import {
  collectKey,
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
  /** Starts a browser on the address. Answers whether one started. */
  readonly openBrowser?: (url: string) => Promise<boolean>;
  readonly fetchImpl?: Fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

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
    const revoked = await revokeProjectKey(
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
  readonly signal: AbortSignal;
};

/**
 * Waits out the interval set by the platform, unless the command is stopped.
 */
async function waitForPace(wait: Wait): Promise<void> {
  if (wait.signal.aborted) return;
  await wait.sleep(wait.waitMs);
}

/**
 * Runs the whole flow and answers what happened.
 *
 * Every ending is a value rather than an exception, because every ending means
 * something different to whoever asked — a denial is not a fault, an expired
 * code is not a denial, and an instance that never answered is neither.
 */
export async function logIn(options: LogInOptions): Promise<LoginResult> {
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
          await writeCredentials(
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
      signal: options.signal,
    });
    if (options.signal.aborted) return { kind: "interrupted" };
  }
}
