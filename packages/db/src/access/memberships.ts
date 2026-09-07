import { newId } from "@egma/ids";
import { and, count, eq, isNull, ne } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { user } from "../schema/identity.ts";
import { membership } from "../schema/tenancy.ts";
import { revokeApiKeysMintedBy } from "./api-keys.ts";
import type { AuthContext, Role } from "./context.ts";
import { LastAdminError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { within } from "./within.ts";

/**
 * Membership reads and writes live here. Lint enforces this table boundary;
 * credential resolution uses membershipsOf.
 */

/** A person's place in an organization, carrying their role. */
export type Membership = {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: Role;
};

/**
 * Return account deactivation with membership role so credential resolvers can
 * reject disabled accounts. Deactivation belongs to the account, not the membership.
 */
export type ResolvedMembership = Membership & {
  /**
   * Set when the account has been switched off. Deactivating leaves the
   * membership exactly where it is — everything they authored keeps their name
   * on it — and takes away every credential that acts on their behalf.
   */
  readonly deactivatedAt: Date | null;
};

/**
 * The same place, as a list of people rather than a list of rows: enough to
 * show somebody a colleague and act on them.
 *
 * Separate from `Membership` on purpose. `Membership` is what an `AuthContext`
 * is built from and is read on every single request; joining the identity table
 * onto that path to fetch an email address nobody is about to display would be a
 * cost paid everywhere for a page visited rarely.
 */
export type Member = {
  readonly organizationId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: Role;
  /**
   * Set when the account has been switched off. Their keys stop resolving
   * immediately; everything they authored stays exactly where it is.
   */
  readonly deactivatedAt: Date | null;
  readonly joinedAt: Date;
};

const MEMBER_COLUMNS = {
  organizationId: membership.organizationId,
  userId: membership.userId,
  email: user.email,
  name: user.name,
  role: membership.role,
  deactivatedAt: user.deactivatedAt,
  joinedAt: membership.createdAt,
} as const;

/**
 * Resolve memberships and account deactivation for a verified user ID before
 * building AuthContext. Return a list, though the current unique user_id constraint
 * allows at most one membership.
 */
export async function membershipsOf(
  userId: string,
): Promise<readonly ResolvedMembership[]> {
  return db()
    .select({
      organizationId: membership.organizationId,
      userId: membership.userId,
      role: membership.role,
      deactivatedAt: user.deactivatedAt,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.userId, userId))
    .orderBy(membership.organizationId);
}

/** Everyone in the caller's organization, and nobody outside it. */
export async function listMembers(
  auth: AuthContext,
): Promise<readonly Member[]> {
  authorize(auth, "read", here(auth));

  return db()
    .select(MEMBER_COLUMNS)
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(within(auth, membership))
    .orderBy(membership.userId);
}

/**
 * Somebody in the caller's organization, or nobody.
 *
 * Naming a person in another customer's account returns nothing rather than
 * refusing, because to the caller those are the same thing: a person they
 * cannot see is a person who is not there.
 */
async function memberOf(
  auth: AuthContext,
  userId: string,
): Promise<Member | undefined> {
  const [row] = await db()
    .select(MEMBER_COLUMNS)
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(within(auth, membership, eq(membership.userId, userId)))
    .limit(1);
  return row;
}

/**
 * Whether anybody other than this person is an admin here.
 *
 * Asked before every write that could take the last one away. It counts rather
 * than reading a flag, because there is no flag: an organization's admins are
 * whoever holds that role right now.
 */
async function anotherAdminExists(
  auth: AuthContext,
  userId: string,
): Promise<boolean> {
  const [row] = await db()
    .select({ total: count() })
    .from(membership)
    .where(
      within(
        auth,
        membership,
        and(eq(membership.role, "admin"), ne(membership.userId, userId)),
      ),
    );
  return (row?.total ?? 0) > 0;
}

/**
 * Which organization the person with this email address is already in, if they
 * have an account at all.
 *
 * Internal, and it is how inviting somebody who already belongs somewhere is
 * refused before a row is written. It returns an identifier rather than a row
 * so that a refusal can say *whether* the organization is the caller's own
 * without ever being able to say which one it is otherwise.
 */
export async function organizationOfEmail(
  email: string,
): Promise<string | null> {
  const [row] = await db()
    .select({ organizationId: membership.organizationId })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(user.email, email))
    .limit(1);
  return row?.organizationId ?? null;
}

/**
 * Internal, and the only insert into the membership table. It takes wherever
 * the statement should run so that provisioning and accepting an invitation can
 * each put it in the same transaction as the rows it belongs with, without the
 * membership table acquiring a second file that touches it.
 */
export async function insertMembership(
  on: Queryable,
  values: {
    readonly organizationId: string;
    readonly userId: string;
    readonly role: Role;
    readonly createdBy: string | null;
  },
): Promise<Membership> {
  const [row] = await on
    .insert(membership)
    .values({
      id: newId("mbr"),
      organizationId: values.organizationId,
      userId: values.userId,
      role: values.role,
      createdBy: values.createdBy,
    })
    .returning({
      organizationId: membership.organizationId,
      userId: membership.userId,
      role: membership.role,
    });

  if (row === undefined) throw new Error("the membership was not written");
  return row;
}

/**
 * Change a membership role after checking that another admin remains.
 * API keys use the new role when they next resolve the creator's membership.
 */
export async function changeRole(
  auth: AuthContext,
  userId: string,
  role: Role,
): Promise<Member | undefined> {
  const existing = await memberOf(auth, userId);
  if (existing === undefined) return undefined;
  if (existing.role === role) return existing;

  if (existing.role === "admin" && !(await anotherAdminExists(auth, userId))) {
    throw new LastAdminError(auth.organizationId, userId);
  }

  await db()
    .update(membership)
    .set({ role, updatedAt: new Date() })
    .where(within(auth, membership, eq(membership.userId, userId)));

  return memberOf(auth, userId);
}

/** What removing somebody took with it. */
export type RemovedMember = {
  readonly userId: string;
  /** Keys of theirs that were still live, and now are not. */
  readonly keysRevoked: number;
};

/**
 * Remove membership and revoke the member's organization API keys in one
 * transaction. Preserve authored records and their attribution.
 */
export async function removeMember(
  auth: AuthContext,
  userId: string,
): Promise<RemovedMember | undefined> {
  const existing = await memberOf(auth, userId);
  if (existing === undefined) return undefined;

  if (existing.role === "admin" && !(await anotherAdminExists(auth, userId))) {
    throw new LastAdminError(auth.organizationId, userId);
  }

  return db().transaction(async (tx) => {
    const keysRevoked = await revokeApiKeysMintedBy(
      tx,
      auth.organizationId,
      userId,
    );

    await tx
      .delete(membership)
      .where(within(auth, membership, eq(membership.userId, userId)));

    return { userId, keysRevoked };
  });
}

/**
 * Deactivate the account without removing membership or authored history.
 * Key resolution rejects deactivated creators. Check that another admin remains.
 */
export async function deactivateUser(
  auth: AuthContext,
  userId: string,
): Promise<Member | undefined> {
  const existing = await memberOf(auth, userId);
  if (existing === undefined) return undefined;
  if (existing.deactivatedAt !== null) return existing;

  if (existing.role === "admin" && !(await anotherAdminExists(auth, userId))) {
    throw new LastAdminError(auth.organizationId, userId);
  }

  await db()
    .update(user)
    .set({ deactivatedAt: new Date(), updatedAt: new Date() })
    // The membership was just read through the tenancy predicate, and this
    // narrows to the same person, so the only account this statement can reach
    // is one in the caller's own organization.
    .where(and(eq(user.id, userId), isNull(user.deactivatedAt)));

  return memberOf(auth, userId);
}
