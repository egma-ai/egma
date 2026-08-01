import { createHash, randomBytes } from "node:crypto";

/**
 * The string in an invitation link, and what is kept instead of it.
 *
 * It is a sibling of the API-key secret rather than the same thing, because the
 * two are not the same thing: a key is a credential a machine presents on every
 * request, and this is a one-time, expiring, single-use address that a person
 * pastes into a chat window. Sharing an implementation would invite sharing a
 * lifetime, a prefix and a revocation rule that none of them should share.
 *
 * **A single SHA-256 over it, and no slow hash**, for the same reason keys use
 * one: there is nothing here to brute-force. Bcrypt-class hashing protects
 * low-entropy human-chosen passwords, and this is 256 bits of randomness.
 *
 * **No scannable prefix.** The key's `egma_sk_` exists so secret scanners
 * recognise a leaked key in a repository; a token that dies in seven days and
 * stops working the moment it is used is not what a scanner is for, and a prefix
 * would only make an invitation look like a credential to keep.
 */

const TOKEN_BYTES = 32;

/**
 * How long a link is worth following. Long enough that an invitation sent on a
 * Friday survives the weekend, short enough that one pasted into a channel and
 * forgotten does not stay live for a year.
 */
export const INVITATION_LIFETIME_DAYS = 7;

export type MintedInvitationToken = {
  /** Goes in the link, and is never stored. */
  readonly token: string;
  /** What goes in the table instead. */
  readonly hash: string;
  readonly expiresAt: Date;
};

export function mintInvitationToken(
  now: Date = new Date(),
): MintedInvitationToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    hash: hashInvitationToken(token),
    expiresAt: new Date(
      now.getTime() + INVITATION_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
    ),
  };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Where a link points.
 *
 * The instance's own origin, always. A self-hoster's colleague is sent to the
 * machine their team runs and never to a domain egma runs, which is the same
 * rule the login pages are held to.
 */
export function invitationLink(baseUrl: string, token: string): string {
  return `${baseUrl}/invite?token=${encodeURIComponent(token)}`;
}
