import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The string in a reset link, and the deadline that travels inside it.
 *
 * **The provider mints the token and egma names the deadline.** The provider's
 * single-use token is the only thing that can actually change a password, and
 * that stays true — this seals it into one opaque string with the moment the
 * link stops being worth following, and signs the pair.
 *
 * It is here for one reason, and it is the whole reason: **a link that has been
 * spent and a link that has run out of time mean opposite things to the person
 * holding one**, and the provider cannot tell them apart. It consumes the token
 * on the way past, so a spent token and an expired one are both simply a token
 * it no longer knows — one refusal, `Invalid token`, for "you already did this"
 * and "nothing happened at all". The deadline in the link is what lets egma say
 * which: **inside it**, a token the provider will not take is a token somebody
 * already used, and egma says so.
 *
 * Past it, the two are one thing again. The provider is configured with the
 * very same deadline, so its own record of the token goes at the same moment
 * and there is nothing left to ask. Egma says that rather than guessing, and
 * one number for both systems is what buys there being one door and one hour to
 * state.
 *
 * **The signature is what makes the deadline worth reading.** Without it the
 * time in the link is a number the holder could edit, and a page would name its
 * refusal from whatever they typed. Nothing about it opens anything: a valid
 * signature over a spent token still resets no password. It only decides which
 * true sentence a person is told.
 *
 * A single HMAC-SHA256 under the same secret that signs session cookies, and no
 * slow hash — the same reasoning an invitation token uses. There is nothing
 * low-entropy here to brute-force, and the secret never leaves the process.
 */

/**
 * How long a link is worth following — **one number, and both systems get it.**
 *
 * It is what the seal is stamped with, what the provider is configured with,
 * and what the message, the page and the README all say. There is no second
 * deadline for the stated one to be untrue against, and so nothing to spell
 * around: the hour named is the hour a link lasts, whichever door its token
 * reaches.
 *
 * Short, because unlike an invitation this one is a way into an account that
 * already exists, and the person asked for it seconds ago and is waiting for
 * it. An hour survives a message that sat in a queue and a person who went to
 * make coffee, and does not leave a way in sitting in an inbox for a week.
 */
export const PASSWORD_RESET_LIFETIME_MINUTES = 60;

export type ResetLink = {
  /** The provider's own single-use token, which is what opens the account. */
  readonly token: string;
  /** When the link stops working, which is when the token stops working. */
  readonly expiresAt: Date;
};

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("base64url");
}

export function sealResetLink(link: ResetLink, secret: string): string {
  const payload = Buffer.from(
    `${link.token}:${Math.floor(link.expiresAt.getTime() / 1000)}`,
    "utf8",
  ).toString("base64url");

  return `${payload}.${signature(payload, secret)}`;
}

/**
 * What a link says, or nothing at all.
 *
 * `null` covers everything from a token this egma never minted to one somebody
 * edited, because to whoever is holding it those are the same thing: a link that
 * names nothing here. Telling them apart would say more about the secret than
 * the person needs to know.
 */
export function openResetLink(
  sealed: string,
  secret: string,
): ResetLink | null {
  const dot = sealed.lastIndexOf(".");
  if (dot <= 0) return null;

  const payload = sealed.slice(0, dot);
  const given = Buffer.from(sealed.slice(dot + 1), "base64url");
  const ours = Buffer.from(signature(payload, secret), "base64url");
  if (given.length !== ours.length || !timingSafeEqual(given, ours)) return null;

  const opened = Buffer.from(payload, "base64url").toString("utf8");
  // The provider's token is alphanumeric, so the last separator is the one that
  // divides it from the deadline.
  const colon = opened.lastIndexOf(":");
  if (colon <= 0) return null;

  const token = opened.slice(0, colon);
  const seconds = Number(opened.slice(colon + 1));
  if (token === "" || !Number.isSafeInteger(seconds)) return null;

  return { token, expiresAt: new Date(seconds * 1000) };
}

/**
 * Where the return path rides from egma's own route to the message.
 *
 * A header on the request egma builds for the provider, never one a caller
 * sent: the relay writes that request from scratch and copies no headers in,
 * so this cannot be set from outside.
 */
export const RETURN_TO_HEADER = "x-egma-return-to";

/**
 * Somewhere for the parser to stand, and nothing else.
 *
 * A name RFC 2606 reserves so that it can never resolve anywhere. Nothing is
 * ever fetched from it: it is only what a candidate is measured against, and
 * the measurement is that resolving must not move the origin.
 */
const HERE = "https://egma.invalid";

/**
 * A path on this instance, or nothing.
 *
 * Somebody who was approving a terminal's login when they discovered they had
 * forgotten their password has somewhere to be sent back to, and that place has
 * to survive the message: the link opens a fresh tab, often minutes later, so
 * nothing the first page was holding is still around to remember it.
 *
 * So the return path travels in the link — which makes it a redirect decided by
 * a query parameter, the shape of every open-redirect bug there has ever been,
 * and this is the rule that stops it being one. **The candidate is resolved,
 * and it has to land back where it started.**
 *
 * Listing the shapes that leave is what this used to do, and a list is a thing
 * somebody finds the next entry in: `/<TAB>/elsewhere.example` was one, because
 * a URL parser strips tab, carriage return and newline *before* it parses, so a
 * browser reads that as `//elsewhere.example` and goes there. Asking the parser
 * instead of guessing at it costs nothing and cannot be enumerated around.
 *
 * What comes back is the parser's own path, so nothing that survives can carry
 * a stray control character on into a header either. The web application
 * applies the same rule again before it follows one.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
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

/**
 * Where a link points.
 *
 * The instance's own origin, always — the same rule the invitation link and the
 * login pages are held to. Somebody resetting a password on a self-hosted egma
 * is sent to the machine their team runs, and never to a domain egma runs.
 */
export function passwordResetLink(
  baseUrl: string,
  sealed: string,
  returnTo?: string | null,
): string {
  // Checked here as well as where it was taken in, because this is the last
  // place before it is written into a message somebody will click.
  const back = safeReturnPath(returnTo);
  const carried = back === null ? "" : `&next=${encodeURIComponent(back)}`;
  return `${baseUrl}/reset-password?token=${encodeURIComponent(sealed)}${carried}`;
}
