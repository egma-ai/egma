import { createHash, randomBytes } from "node:crypto";

/**
 * Generate a 256-bit invitation token and store its SHA-256 hash.
 * High entropy permits a fast hash; expiration and single use are enforced
 * by invitation storage, independently of API-key lifetime rules.
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
