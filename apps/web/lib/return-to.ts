/**
 * Where to send somebody back to once they have signed in.
 *
 * A person who opens the approval page without an account has to sign up, and
 * then has to land back on the page they were sent to rather than at the front
 * door with the code lost. That is a redirect decided by a query parameter,
 * which is the shape of every open-redirect bug there has ever been — so the
 * only paths accepted are paths on this instance.
 */

/**
 * A return path that cannot leave this origin, or nothing.
 *
 * One leading slash and no second one: `//elsewhere.example/x` is a URL a
 * browser reads as another host, and `https://elsewhere.example` obviously is.
 * A backslash is refused too, because some browsers have historically read it
 * as a slash.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const path = raw.trim();
  if (!path.startsWith("/")) return null;
  if (path.startsWith("//") || path.startsWith("/\\")) return null;
  return path;
}

/** The same path, with somewhere to come back to attached. */
export function withReturnTo(path: string, returnTo: string): string {
  return `${path}?next=${encodeURIComponent(returnTo)}`;
}

/** What the current page was asked to come back to, if anything. */
export function returnPathIn(search: string): string | null {
  return safeReturnPath(new URLSearchParams(search).get("next"));
}

/**
 * Where a person lands after authenticating: the entrance, which chooses the
 * project and sends them to its Agents page.
 *
 * It is the root rather than a product address because these pages are reached
 * before there is any way to know which project somebody is in — an invitation
 * link and a fresh sign-in both arrive with nothing.
 */
export const DEFAULT_SIGNED_IN_PATH = "/";
