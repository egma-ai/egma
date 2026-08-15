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
 * person is owed**. Egma's is the one that decides; the provider's is a backstop
 * that is always later, so a link that is past its time is refused here by name
 * and never reaches the provider to come back as the wrong sentence.
 *
 * Reading the pair the other way round is what makes the refusal sound: inside
 * egma's deadline, the provider only ever refuses a token it has already
 * consumed — so *the provider refused a live link* means, exactly, that the link
 * was spent.
 */
export const PASSWORD_RESET_PROVIDER_GRACE_MINUTES = 10;

/** The provider's deadline, in the seconds its own option is written in. */
export const PASSWORD_RESET_PROVIDER_LIFETIME_SECONDS =
  (PASSWORD_RESET_LIFETIME_MINUTES + PASSWORD_RESET_PROVIDER_GRACE_MINUTES) * 60;

export type ResetLink = {
  /** The provider's own single-use token, which is what opens the account. */
  readonly token: string;
  /** When egma stops honouring it, whatever the provider still thinks. */
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
 * Where a link points.
 *
 * The instance's own origin, always — the same rule the invitation link and the
 * login pages are held to. Somebody resetting a password on a self-hosted egma
 * is sent to the machine their team runs, and never to a domain egma runs.
 */
export function passwordResetLink(baseUrl: string, sealed: string): string {
  return `${baseUrl}/reset-password?token=${encodeURIComponent(sealed)}`;
}
