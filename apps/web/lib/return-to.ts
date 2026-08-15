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
 * Somewhere for the parser to stand, and nothing else.
 *
 * A name RFC 2606 reserves so that it can never resolve anywhere. Nothing is
 * ever fetched from it: it is only what a candidate is measured against, and
 * the measurement is that resolving must not move the origin.
 */
const HERE = "https://egma.invalid";

/**
 * A return path that cannot leave this origin, or nothing.
 *
 * **The candidate is resolved, and it has to land back where it started.**
 * `//elsewhere.example/x` is a URL a browser reads as another host, and
 * `https://elsewhere.example` obviously is — but listing the shapes that leave
 * is a list somebody finds the next entry in. `/<TAB>/elsewhere.example` was
 * one: a URL parser strips tab, carriage return and newline *before* it parses,
 * so a browser reads that as `//elsewhere.example` and goes there. Asking the
 * parser instead of guessing at it cannot be enumerated around.
 *
 * The API applies the same rule before it writes a path into a reset link, and
 * the suite holds the two copies to the same answers.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const asked = raw.trim();
  // Somewhere, rather than something: `device/approve` means whatever page is
  // reading it, which is not a promise a link can carry.
  if (!asked.startsWith("/")) return null;

  let landed: URL;
  try {
    landed = new URL(asked, HERE);
  } catch {
    return null;
  }
  if (landed.origin !== HERE) return null;
  return `${landed.pathname}${landed.search}${landed.hash}`;
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
