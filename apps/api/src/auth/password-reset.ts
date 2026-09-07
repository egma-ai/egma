import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sign the provider reset token and an expiration time with HMAC-SHA256.
 * The signed deadline lets the UI distinguish expiration from rejection
 * before expiration. The provider still enforces token validity and single
 * use. Signing protects integrity; it does not encrypt the token.
 */

/** Shared lifetime for provider reset tokens, signed links, and email copy. */
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
 * Return a normalized absolute path only if URL parsing keeps the same
 * origin. Parsing is required because browsers remove some control characters
 * before resolving a URL; prefix checks alone can miss external redirects.
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
