import { newId } from "@egma/ids";
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "../client.ts";
import { user } from "../schema/identity.ts";
import { invitation, organization } from "../schema/tenancy.ts";
import type { AuthContext, Role } from "./context.ts";
import { AlreadyBelongsToAnOrganizationError } from "./errors.ts";
import { insertMembership, organizationOfEmail } from "./memberships.ts";
import { authorize, here } from "./permissions.ts";
import { projectsOf } from "./projects.ts";
import { within } from "./within.ts";

/**
 * Asking somebody to join, and their side of it.
 *
 * **The row never holds the token.** What is stored is a single SHA-256 of the
 * high-entropy string that went into the link, exactly as an API key is stored,
 * so a copy of the database is not a pile of working invitations. Hashing is the
 * caller's, for the same reason it is on a key: the module that keeps the secret
 * should never be the module that has seen it.
 *
 * **A link is the credential.** Reading one and accepting one therefore take a
 * hash and nothing else — there is no argument that would make either answer
 * about an invitation the caller was not given, and neither can be asked to
 * enumerate. That is what puts them beside `resolveApiKey` rather than beside
 * the reads that require an `AuthContext`.
 */

/** An invitation, as the organization that sent it may see it. */
export type Invitation = {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: Role;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
};

const COLUMNS = {
  id: invitation.id,
  organizationId: invitation.organizationId,
  email: invitation.email,
  role: invitation.role,
  expiresAt: invitation.expiresAt,
  acceptedAt: invitation.acceptedAt,
  createdBy: invitation.createdBy,
  createdAt: invitation.createdAt,
} as const;

export type NewInvitation = {
  readonly email: string;
  readonly role: Role;
  /** A single SHA-256 over the string that goes in the link. Never the string. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
};

/**
 * An invitation into the caller's organization, and no other. The organization
 * and the sender both come from the context, so there is no call that invites
 * somebody into somebody else's account.
 *
 * Somebody who already belongs to an organization is refused here, before a row
 * exists, because one person belongs to one organization in this version and an
 * invitation they could never accept is worse than a refusal they can read.
 */
export async function createInvitation(
  auth: AuthContext,
  input: NewInvitation,
): Promise<Invitation> {
  const alreadyIn = await organizationOfEmail(input.email);
  if (alreadyIn !== null) {
    throw new AlreadyBelongsToAnOrganizationError(
      input.email,
      alreadyIn === auth.organizationId,
    );
  }

  const [row] = await db()
    .insert(invitation)
    .values({
      id: newId("inv"),
      organizationId: auth.organizationId,
      email: input.email,
      role: input.role,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdBy: auth.userId,
    })
    .returning(COLUMNS);

  if (row === undefined) throw new Error("the invitation was not written");
  return row;
}

/**
 * Invitations the caller's organization has sent and nobody has accepted yet.
 *
 * The link is not among them and cannot be: only its hash was kept. Somebody
 * who has lost a link sends another one, which is the same thing an admin would
 * do if it had been emailed to an address that bounced.
 */
export async function listPendingInvitations(
  auth: AuthContext,
): Promise<readonly Invitation[]> {
  authorize(auth, "read", here(auth));

  return db()
    .select(COLUMNS)
    .from(invitation)
    .where(within(auth, invitation, isNull(invitation.acceptedAt)))
    .orderBy(desc(invitation.createdAt));
}

/** Whether a link is still worth following, and if not, which of the two it is. */
export type InvitationState = "pending" | "expired" | "accepted";

/** What a link resolves to, for the page somebody following one lands on. */
export type ResolvedInvitation = {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly email: string;
  readonly role: Role;
  readonly state: InvitationState;
  readonly expiresAt: Date;
};

/** Accepted first: an invitation that was used and then timed out was used. */
function stateOf(row: {
  acceptedAt: Date | null;
  expiresAt: Date;
}): InvitationState {
  if (row.acceptedAt !== null) return "accepted";
  return row.expiresAt.getTime() <= Date.now() ? "expired" : "pending";
}

/**
 * What one link names: which organization, for whom, at what role, and whether
 * it is still live.
 *
 * Safe without an `AuthContext` on the same terms as resolving an API key: the
 * only argument is the hash of a secret egma issued to exactly one holder, so
 * there is nothing to name wrongly and no way to ask about a second invitation.
 * It returns the organization's name because the page a person lands on has to
 * be able to say what they are joining, and at that moment they have no account
 * to build a context from.
 */
export async function readInvitation(
  tokenHash: string,
): Promise<ResolvedInvitation | undefined> {
  const [row] = await db()
    .select({
      id: invitation.id,
      organizationId: invitation.organizationId,
      organizationName: organization.name,
      email: invitation.email,
      role: invitation.role,
      acceptedAt: invitation.acceptedAt,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(eq(invitation.tokenHash, tokenHash))
    .limit(1);

  if (row === undefined) return undefined;

  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    email: row.email,
    role: row.role,
    state: stateOf(row),
    expiresAt: row.expiresAt,
  };
}

/**
 * What following a link did.
 *
 * A union rather than a throw-or-return, because every one of these is an
 * ordinary answer a person needs different words for — and a caller cannot read
 * the organization out of it without first having said which case it is in.
 */
export type Acceptance =
  | {
      readonly outcome: "accepted";
      readonly organizationId: string;
      readonly organizationName: string;
      readonly projectId: string;
      readonly projectName: string;
      readonly role: Role;
    }
  | { readonly outcome: "unknown" }
  | { readonly outcome: "expired" }
  | { readonly outcome: "already_accepted" }
  /** The link names a different address than the account following it. */
  | { readonly outcome: "for_somebody_else"; readonly email: string }
  /** One person belongs to one organization in this version. */
  | { readonly outcome: "already_in_an_organization" };

/**
 * The constraint a write broke, if it broke one.
 *
 * Read rather than guessed at from the message, and read here rather than by
 * the caller: the constraint is this module's, its name is this module's, and a
 * route that recognised it by substring would be a route that breaks silently
 * the day it is renamed. Drizzle may hand the driver's error back wrapped, so
 * both depths are looked at.
 */
function constraintViolated(error: unknown): string | undefined {
  for (
    let at: unknown = error, depth = 0;
    at !== undefined && at !== null && depth < 4;
    depth += 1
  ) {
    if (typeof at !== "object") break;
    const carrier = at as { constraint?: unknown; cause?: unknown };
    if (typeof carrier.constraint === "string") return carrier.constraint;
    at = carrier.cause;
  }
  return undefined;
}

/**
 * A link followed, and the person now in the organization it named.
 *
 * The whole of it is one transaction, and the invitation row is locked before it
 * is read: two people following the same link at the same moment must not both
 * get a membership out of it, and a link is single-use because `accepted_at` is
 * written in the same breath as the membership.
 *
 * The address on the invitation has to be the address on the account. The page
 * shows which one it is and fills the field in, so this costs nothing in the
 * ordinary case — and it keeps an invitation a thing addressed to a person
 * rather than a bearer token for anybody who is handed the URL.
 *
 * Somebody who already belongs to an organization is refused by the unique
 * constraint on the membership, and the whole transaction goes with it. The
 * check cannot be made only when the invitation is written: an account can be
 * created in between, so the database is what has to say so.
 */
export async function acceptInvitation(
  tokenHash: string,
  userId: string,
): Promise<Acceptance> {
  let accepted;
  try {
    accepted = await db().transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: invitation.id,
          organizationId: invitation.organizationId,
          organizationName: organization.name,
          email: invitation.email,
          role: invitation.role,
          acceptedAt: invitation.acceptedAt,
          expiresAt: invitation.expiresAt,
          createdBy: invitation.createdBy,
        })
        .from(invitation)
        .innerJoin(organization, eq(organization.id, invitation.organizationId))
        .where(eq(invitation.tokenHash, tokenHash))
        .limit(1)
        .for("update", { of: invitation });

      if (row === undefined) return { outcome: "unknown" } as const;

      const state = stateOf(row);
      if (state === "accepted") return { outcome: "already_accepted" } as const;
      if (state === "expired") return { outcome: "expired" } as const;

      const [account] = await tx
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);

      // Both columns are `citext` and Postgres would compare them without
      // regard to case; this comparison happens in application code, so it has
      // to be told. An address that differs only in case is the same address.
      if (
        account === undefined ||
        account.email.toLowerCase() !== row.email.toLowerCase()
      ) {
        return { outcome: "for_somebody_else", email: row.email } as const;
      }

      // Attributed to whoever sent the invitation, so "who let this person in"
      // is answered by the membership row without any audit machinery.
      await insertMembership(tx, {
        organizationId: row.organizationId,
        userId,
        role: row.role,
        createdBy: row.createdBy,
      });

      await tx
        .update(invitation)
        .set({ acceptedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(invitation.id, row.id), isNull(invitation.acceptedAt)));

      return {
        outcome: "accepted",
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        role: row.role,
      } as const;
    });
  } catch (cause) {
    // Caught out here rather than inside, so the transaction rolls back rather
    // than being committed around a statement Postgres has already refused.
    if (constraintViolated(cause) === "membership_user_id_unique") {
      return { outcome: "already_in_an_organization" };
    }
    throw cause;
  }

  if (accepted.outcome !== "accepted") return accepted;

  // The project the invited person lands in is the organization's oldest — the
  // one provisioning made — for the same reason a session with no project named
  // lands there. Identifiers sort by mint time, so that is the first row.
  const project = (await projectsOf(accepted.organizationId))[0];
  if (project === undefined) {
    throw new Error(
      `organization ${accepted.organizationId} has no project, which provisioning makes impossible`,
    );
  }

  return { ...accepted, projectId: project.id, projectName: project.name };
}
