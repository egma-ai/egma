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
 * and "nothing happened at all". Egma carries the deadline itself, so the
 * refusal is decided before the provider is ever asked.
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
 * How long a link is worth following.
 *
 * Short, because unlike an invitation this one is a way into an account that
 * already exists, and the person asked for it seconds ago and is waiting for
 * it. An hour survives a message that sat in a queue and a person who went to
 * make coffee, and does not leave a way in sitting in an inbox for a week.
 */
export const PASSWORD_RESET_LIFETIME_MINUTES = 60;

/**
 * How much longer the provider's own copy of the deadline runs.
 *
 * There are two deadlines because there are two systems, and **they are set
 * deliberately apart so that they can never disagree about which refusal a
 * person is owed**. Egma's is the one that decides, and it is the only one any
 * caller can reach: the provider's own reset endpoint is shut at egma's door,
 * so the hour named above is the hour a link actually lasts, everywhere. See
 * `routes/password-reset.ts`.
 *
 * The extra minutes do two jobs, and neither is about letting anybody in later:
 *
 * **They keep the spent-link inference sound.** Inside egma's deadline the
 * provider cannot be refusing over its own clock, so *the provider refused a
 * live link* means, exactly, that the link was spent.
 *
 * **They leave the provider's record readable after egma stops honouring the
 * link.** A token the provider still holds is a token nobody spent; one it no
 * longer holds is one somebody did. That is the only way egma can tell an
 * expired link from a used one *past* its own deadline without keeping a second
 * record of its own — and past this window it stops being able to, which is a
 * sentence the route has to be willing to write.
 */
export const PASSWORD_RESET_PROVIDER_GRACE_MINUTES = 10;

/** The provider's deadline, in the seconds its own option is written in. */
export const PASSWORD_RESET_PROVIDER_LIFETIME_SECONDS =
  (PASSWORD_RESET_LIFETIME_MINUTES + PASSWORD_RESET_PROVIDER_GRACE_MINUTES) * 60;

/**
 * How much of the grace is deliberately not counted on.
 *
 * The two deadlines are stamped moments apart — the provider stamps its own as
 * it mints the token, egma stamps its own as the message for that token is
 * built — so the provider's expiry falls a shade *before* egma's plus the
 * grace, never after. This is that shade, made enormous: what it has to cover
 * is one row's insert, and a minute is longer than that by every measure a
 * machine has.
 *
 * It is here because a missing record is only evidence while the record would
 * certainly still have been there.
 */
const PROVIDER_RECORD_MARGIN_MINUTES = 1;

export type ResetLink = {
  /** The provider's own single-use token, which is what opens the account. */
  readonly token: string;
  /** When egma stops honouring it, whatever the provider still thinks. */
  readonly expiresAt: Date;
};

/**
 * Whether the provider's record of this link would certainly still be there.
 *
 * **This is what decides whether egma may read anything into the provider's
 * silence.** Inside the window, a token the provider no longer knows is a token
 * somebody spent, and saying so is a fact. Outside it, the record has expired on
 * its own and a missing one means nothing — the link was used, or it was not,
 * and egma cannot tell which. A route that read the second case as the first
 * would tell somebody their password still works when it no longer does.
 */
export function providerRecordSurvives(link: ResetLink, now: Date): boolean {
  const survivesUntil =
    link.expiresAt.getTime() +
    (PASSWORD_RESET_PROVIDER_GRACE_MINUTES - PROVIDER_RECORD_MARGIN_MINUTES) *
      60_000;
  return now.getTime() < survivesUntil;
}

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
 * A path on this instance, or nothing.
 *
 * Somebody who was approving a terminal's login when they discovered they had
 * forgotten their password has somewhere to be sent back to, and that place has
 * to survive the message: the link opens a fresh tab, often minutes later, so
 * nothing the first page was holding is still around to remember it.
 *
 * So the return path travels in the link — which makes it a redirect decided by
 * a query parameter, the shape of every open-redirect bug there has ever been,
 * and this is the rule that stops it being one. One leading slash and no second:
 * `//elsewhere.example/x` is a URL a browser reads as another host, and a
 * backslash is refused too because some browsers have historically read it as a
 * slash. The web application applies the same rule again before it follows one.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (!path.startsWith("/")) return null;
  if (path.startsWith("//") || path.startsWith("/\\")) return null;
  return path;
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
