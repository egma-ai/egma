/**
 * The public identity read every Egma platform serves before login.
 *
 * The CLI asks this before it sends a repository identifier. That makes an
 * instance mismatch a local refusal instead of a 404 from the wrong platform.
 */

import { PlatformUnreachableError, type Fetch } from "./device-flow.ts";

const PLATFORM_INSTANCE_ID = /^pf_[0-9A-HJKMNP-TV-Z]{26}$/u;

/**
 * The one path this contract lives at, on every platform.
 *
 * It is a constant rather than a literal because three places have to agree on
 * it: the API that serves it, the web process that forwards it at the origin a
 * self-hoster was actually given, and this reader. A rewrite that missed it
 * would leave a self-hosted platform unable to prove its own identity, and the
 * agreement test names the constant so that disagreement fails a check instead
 * of a developer's first command.
 */
export const PLATFORM_IDENTITY_PATH = "/api/platform";

export type PlatformIdentity = {
  readonly instanceId: string;
  readonly origin: string;
};

/** One origin shape for comparison, configuration, and credential lookup. */
export function normalizePlatformOrigin(candidate: string): string {
  // This public CLI is compiled, not bundled. Importing the API check would
  // create a private runtime dependency. The agreement test keeps both checks
  // aligned until the CLI distribution changes.
  let parsed: URL;
  try {
    parsed = new URL(candidate.trim());
  } catch {
    throw new Error("not a web address");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("not an HTTP web address");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("an origin cannot contain a username or password");
  }
  if (
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("an origin cannot contain a path, query, or fragment");
  }
  return parsed.origin;
}

/**
 * How long egma waits for a platform to say who it is.
 *
 * This read is in front of every command — push, pull, run, connect, the whole
 * wizard — so a platform that accepts the connection and then says nothing must
 * not be able to hang all of them with no output at all. A socket that is
 * accepted never times out on its own.
 */
export const IDENTITY_TIMEOUT_MS = 10_000;

/** What egma says when it cannot tell what the address in front of it is. */
const NOT_A_PLATFORM =
  "Check the address. If it is right, this is probably not an Egma platform, or it is older than this copy of egma.";

/**
 * A platform answered, but not with the public contract the CLI requires.
 *
 * The clause saying what happened is kept apart from the advice that follows
 * it, because one caller needs the first half without the second: the built-in
 * address is one nobody typed and nobody outside egma can fix, so a developer
 * who reaches it must be told what happened there and never sent to go and look
 * at it.
 */
export class PlatformIdentityError extends Error {
  /** What happened, in one clause, with no advice attached to it. */
  readonly said: string;
  /** Whether asking this same address again in a moment could answer differently. */
  readonly worthRetrying: boolean;

  constructor(
    origin: string,
    because: string,
    options: { readonly advice?: string; readonly worthRetrying?: boolean } = {},
  ) {
    super(
      `egma asked ${origin} which platform it is, and ${because} ${options.advice ?? NOT_A_PLATFORM}`,
    );
    this.name = "PlatformIdentityError";
    this.said = because;
    // An answer that is not the contract is the address being what it is, not a
    // bad moment, so waiting changes nothing unless the caller says otherwise.
    this.worthRetrying = options.worthRetrying ?? false;
  }
}

/**
 * The address answered with a redirect.
 *
 * Worth its own sentence, and its own advice, because it is what a sign-in wall
 * in front of a deployment looks like from here. Following it would turn a
 * login page into "your egma is out of date", which sends the developer after a
 * problem they do not have — and this read is on the path of every command, so
 * the wrong diagnosis would be the first thing they ever see.
 */
export class PlatformRedirectedError extends PlatformIdentityError {
  constructor(origin: string, to: string) {
    super(
      origin,
      to === ""
        ? "it answered with a redirect somewhere else instead."
        : `it redirected to ${to} instead.`,
      {
        advice:
          "egma does not follow that. Something in front of this address is answering for it — a sign-in page or a proxy — so this is where to look, not at your copy of egma.",
      },
    );
    this.name = "PlatformRedirectedError";
  }
}

/** The platform accepted the connection and then said nothing. */
export class PlatformTimedOutError extends PlatformUnreachableError {
  constructor(origin: string, cause: unknown) {
    super(origin, cause);
    this.message = `egma at ${origin} took the connection but did not answer within ${String(
      IDENTITY_TIMEOUT_MS / 1000,
    )} seconds. Check that the instance is healthy, then run this again.`;
    this.name = "PlatformTimedOutError";
  }
}

/** Whether an address only means anything on the machine that says it. */
function isLoopback(origin: string): boolean {
  const host = new URL(origin).hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\./u.test(host)
  );
}

/**
 * The platform answered to a different address than the one it was asked at.
 *
 * egma talks to the address the developer gave it and to no other. A platform
 * that names a different canonical origin is misconfigured — its
 * `EGMA_BASE_URL` is not the address people reach it at — and following it
 * would be the whole failure this ticket exists to prevent: the CLI would leave
 * for an address nobody chose, and a repository bound on the platform's own
 * host would commit `http://localhost:3101` into a file every teammate clones.
 *
 * There are two of these and they want different advice. `localhost` against
 * `127.0.0.1` is one machine calling itself two names, and either name works —
 * so offering the other one is useful. A platform on the network still calling
 * itself `localhost` is the failure above, and offering `localhost` to somebody
 * on another machine sends them to their own laptop, where nothing is
 * listening. So the second half of the advice is only given when it is true.
 */
export class PlatformOriginMismatchError extends Error {
  /** The address the platform named for itself, which egma did not follow. */
  readonly stated: string;

  constructor(asked: string, stated: string) {
    const statedIsOnlyItsOwnMachine = isLoopback(stated) && !isLoopback(asked);
    super(
      [
        `egma asked ${asked} which platform it is, and it answered that it lives at ${stated}.`,
        "egma uses the address you gave it and never follows a platform to another one.",
        `Set EGMA_BASE_URL on the platform to the address people reach it at and restart it${
          statedIsOnlyItsOwnMachine
            ? ` — ${stated} names only the platform's own machine, so nobody else can reach it there.`
            : `, or use ${stated} here.`
        }`,
        "Nothing was sent.",
      ].join(" "),
    );
    this.name = "PlatformOriginMismatchError";
    this.stated = stated;
  }
}

/**
 * What happened at an address, in one clause, and whether waiting could change
 * it.
 *
 * Written for the one caller that must not relay these refusals whole: egma's
 * own built-in address. The developer never typed it, does not run what is at
 * it, and cannot reconfigure it — so the advice half of every sentence below is
 * addressed to nobody who is reading. What happened is still theirs to know:
 * "it did not answer" told about a platform that answered with a redirect is
 * wrong about the fact and wrong about the remedy, and "try again in a moment"
 * on a permanent shape is a retry loop.
 *
 * `worthRetrying` is deliberately generous at the edges. A 5xx is a bad moment
 * on a deployment that is otherwise the right one; anything egma cannot place
 * is treated the same way, because inviting one wasted retry costs less than
 * telling somebody a passing fault is permanent.
 */
export type WhatAnswered = {
  /** Reads after "…egma used its own at <address>, and ". */
  readonly said: string;
  readonly worthRetrying: boolean;
};

export function whatAnswered(cause: unknown): WhatAnswered {
  if (cause instanceof PlatformTimedOutError) {
    return { said: "it took the connection and then said nothing.", worthRetrying: true };
  }
  if (cause instanceof PlatformUnreachableError) {
    return { said: "nothing answered there.", worthRetrying: true };
  }
  if (cause instanceof PlatformOriginMismatchError) {
    return { said: `it answered that it lives at ${cause.stated} instead.`, worthRetrying: false };
  }
  if (cause instanceof PlatformIdentityError) {
    return { said: cause.said, worthRetrying: cause.worthRetrying };
  }
  return { said: "egma could not use what came back.", worthRetrying: true };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Who answers at this address.
 *
 * The origin that comes back is the origin that was asked, always. The body's
 * own `origin` is read only to be checked against it, because the one thing
 * this read must never do is move the conversation somewhere else: everything
 * after it — the key that is written, the identifiers that are sent, the
 * binding that is committed to a file other people clone — is addressed to
 * whatever this returns.
 */
export async function readPlatformIdentity(
  selected: string,
  fetchImpl: Fetch = fetch,
): Promise<PlatformIdentity> {
  const selectedOrigin = normalizePlatformOrigin(selected);
  let response: Response;
  try {
    response = await fetchImpl(`${selectedOrigin}${PLATFORM_IDENTITY_PATH}`, {
      method: "GET",
      headers: { accept: "application/json" },
      // Not followed, and not merely for safety: a redirect is a fact about
      // this address that the developer needs told, and following it would
      // hide a sign-in wall behind a contract complaint.
      redirect: "manual",
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    throw timedOut
      ? new PlatformTimedOutError(selectedOrigin, cause)
      : new PlatformUnreachableError(selectedOrigin, cause);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new PlatformRedirectedError(
      selectedOrigin,
      text(response.headers.get("location")),
    );
  }
  if (!response.ok) {
    throw new PlatformIdentityError(
      selectedOrigin,
      `it answered ${String(response.status)} rather than its identity.`,
      // A platform having a bad minute answers in the 500s, and the same
      // address a minute later is the ordinary way that ends. A 4xx is the
      // address being what it is, and no amount of waiting makes it egma.
      { worthRetrying: response.status >= 500 },
    );
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const instanceId = text(body.instance_id);
  if (!PLATFORM_INSTANCE_ID.test(instanceId)) {
    throw new PlatformIdentityError(
      selectedOrigin,
      "what came back carries no platform identity egma can use.",
    );
  }

  let stated: string;
  try {
    stated = normalizePlatformOrigin(text(body.origin));
  } catch {
    throw new PlatformIdentityError(
      selectedOrigin,
      "what came back names no address egma can use.",
    );
  }
  if (stated !== selectedOrigin) {
    throw new PlatformOriginMismatchError(selectedOrigin, stated);
  }

  return { instanceId, origin: selectedOrigin };
}
