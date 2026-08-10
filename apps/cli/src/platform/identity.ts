/**
 * The public identity read every Egma platform serves before login.
 *
 * The CLI asks this before it sends a repository identifier. That makes an
 * instance mismatch a local refusal instead of a 404 from the wrong platform.
 */

import { PlatformUnreachableError, type Fetch } from "./device-flow.ts";

const PLATFORM_INSTANCE_ID = /^pf_[0-9A-HJKMNP-TV-Z]{26}$/u;

export type PlatformIdentity = {
  readonly instanceId: string;
  readonly origin: string;
};

/** One origin shape for comparison, configuration, and credential lookup. */
export function normalizePlatformOrigin(candidate: string): string {
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
    response = await fetchImpl(`${selectedOrigin}/api/platform`, {
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
