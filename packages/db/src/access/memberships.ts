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
 * Who is in an organization, and everything that changes it.
 *
 * This is the only file that reads the membership table, and a lint rule fails
 * the build if another one starts to. Everything that needs to know which
 * organization a person is in comes through `membershipsOf` below, and every
 * write that adds, re-roles or removes somebody is here beside it — so the
 * answer to "who is in this organization" has one place that decides it and one
 * place that changes it.
 */

/** A person's place in an organization, carrying their role. */
export type Membership = {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: Role;
};

/**
 * The same place as the resolver below answers it: the role, and whether the
 * account behind it has been switched off.
 *
 * **The second fact is the account's rather than the membership's**, and it is
 * carried here because this resolver is the only way a credential reaches a
 * role. A role is a power and a switched-off account holds none, so the fact
 * that says whether the powers exist arrives with the fact that says what they
 * are — and a credential path cannot read the second without being handed the
 * first. That is the difference between a rule every path remembers and a rule
 * every path is given, which is the whole reason the browser path was able to
 * miss it.
 *
 * `Membership` itself stays exactly what the glossary says it is, because
 * provisioning writes one and reads nothing about the account when it does.
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
 * Which organizations is this person in? The single resolver, and the whole
 * reversibility condition on one-organization-per-person.
 *
 * It returns a list, and it will always return at most one today, because
 * `membership` carries `UNIQUE (user_id)` in v1. The signature is the
 * multi-organization one anyway: dropping that unique index is among the
 * cheapest migrations that exists, but only while nothing has compiled *the*
 * person's organization into its own shape. Every caller therefore has to
 * decide what it does with none, one, or several — today the second case, and
 * one day the third, with no signature to change.
 *
 * This is the one shape of read that cannot take an `AuthContext`: it is what
 * produces the organization an `AuthContext` is later built from. It takes a
 * person and returns their memberships and nothing else, so there is no
 * argument that would make it return somebody else's.
 *
 * It joins the identity table for exactly one column — whether the account is
 * switched off — because every credential that becomes a role becomes it here,
 * and a resolver that hands out a role without saying whether the account still
 * holds it is a resolver each caller has to remember to second-guess.
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
 * Somebody's role, changed.
 *
 * There is nothing to hunt down afterwards. A key carries no role of its own
 * and re-reads its creator's membership on every request, so a demotion is
 * complete the moment this row is written — the next request they make, with
 * any key they have ever minted, is answered at the new role.
 *
 * The last admin cannot be demoted. Nobody else may invite, change a role or
 * remove anybody, so it would leave an organization nobody can administer, and
 * there is no role above the organization to fix it from.
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
 * Somebody removed from the organization.
 *
 * **Their keys are revoked and everything they authored stays, with their name
 * on it.** Records of what somebody did are preserved; powers that act on their
 * behalf are revoked. A project they created keeps their id in `created_by`, and
 * an IT deprovisioning script therefore cannot delete a team's work by removing
 * the person who wrote it.
 *
 * The two writes are one transaction, because the window between them is one in
 * which a key of theirs still resolves — the membership is what a key borrows
 * its powers from, so removing it is a second, independent revocation, and
 * neither half is worth having on its own.
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
 * Somebody's account switched off.
 *
 * The sharper of the two: removing somebody ends their place in *this*
 * organization, and this ends their account. Every key they minted stops
 * resolving on the very next request — the key row is not touched, because
 * resolving one already reads whether its creator is still active — and their
 * membership, their name on what they authored and their organization's history
 * are all left exactly as they were.
 *
 * The last admin cannot be deactivated, for the same reason they cannot be
 * demoted or removed.
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
