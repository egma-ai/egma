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

/** A platform answered, but not with the public contract the CLI requires. */
export class PlatformIdentityError extends Error {
  constructor(origin: string) {
    super(
      `egma at ${origin} did not return a usable platform identity. Check the address and update egma before you try again.`,
    );
    this.name = "PlatformIdentityError";
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

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
    });
  } catch (cause) {
    throw new PlatformUnreachableError(selectedOrigin, cause);
  }

  if (!response.ok) throw new PlatformIdentityError(selectedOrigin);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const instanceId = text(body.instance_id);
  const statedOrigin = text(body.origin);

  let origin: string;
  try {
    origin = normalizePlatformOrigin(statedOrigin);
  } catch {
    throw new PlatformIdentityError(selectedOrigin);
  }
  if (!PLATFORM_INSTANCE_ID.test(instanceId)) throw new PlatformIdentityError(selectedOrigin);

  return { instanceId, origin };
}
