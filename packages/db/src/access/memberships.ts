import { newId } from "@egma/ids";
import { eq } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { membership } from "../schema/tenancy.ts";
import type { AuthContext, Role } from "./context.ts";
import { within } from "./within.ts";

/**
 * This is the only file that reads the membership table, and a lint rule fails
 * the build if another one starts to. Everything that needs to know which
 * organization a person is in comes through `membershipsOf` below.
 */

/** A person's place in an organization, carrying their role. */
export type Membership = {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: Role;
};

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
 */
export async function membershipsOf(
  userId: string,
): Promise<readonly Membership[]> {
  return db()
    .select({
      organizationId: membership.organizationId,
      userId: membership.userId,
      role: membership.role,
    })
    .from(membership)
    .where(eq(membership.userId, userId))
    .orderBy(membership.organizationId);
}

/** Everyone in the caller's organization, and nobody outside it. */
export async function listMemberships(
  auth: AuthContext,
): Promise<readonly Membership[]> {
  return db()
    .select({
      organizationId: membership.organizationId,
      userId: membership.userId,
      role: membership.role,
    })
    .from(membership)
    .where(within(auth, membership))
    .orderBy(membership.userId);
}

/**
 * Internal, and the only insert into the membership table. It takes wherever
 * the statement should run so that provisioning can put it in the same
 * transaction as the organization it belongs to, without the membership table
 * acquiring a second file that touches it.
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
