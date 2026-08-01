import {
  membershipsOf,
  projectsOf,
  readOrganization,
  type AuthContext,
  type Project,
  type Role,
} from "@egma/db";

import type { SessionIdentityProvider } from "./seam.ts";

/**
 * Turning a browser session into who is asking, which customer, which project
 * and what role.
 *
 * This is the one place the provider is on the authenticated-request path, and
 * it is there by design: a session cookie becomes an identity, and only the
 * provider can say so. An API-key request runs none of this — egma verifies
 * those against its own table — and that asymmetry is what keeps the
 * high-volume programmatic path free of the provider entirely.
 *
 * Two lookups follow the provider's answer, and neither is optional. Which
 * organization goes through `membershipsOf`, the single resolver, which returns
 * a **list** even though v1's unique constraint guarantees at most one — so no
 * caller is written as though *the* person's organization is a fact rather than
 * a lookup. Which projects goes through `projectsOf`. Only then is there enough
 * to build a context, and everything downstream takes the context.
 */

export type SessionOrganization = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: Role;
};

export type Session = {
  readonly userId: string;
  readonly email: string;
  /**
   * Empty when the person exists but has not been provisioned — which is only
   * reachable if provisioning failed after their identity was written. They
   * are signed in and have nowhere to be, and the pages say so rather than
   * pretending they are somewhere.
   */
  readonly organizations: readonly SessionOrganization[];
  readonly projects: readonly Project[];
  /** Absent for exactly the same reason `organizations` can be empty. */
  readonly auth: AuthContext | undefined;
};

/**
 * The whole of what the browser's cookie is worth, or nothing.
 *
 * The organization is resolved from the credential and never from anything the
 * request carries, so a client cannot ask for another customer's data by asking
 * nicely.
 */
export async function resolveSession(
  provider: SessionIdentityProvider,
  request: Request,
): Promise<Session | null> {
  const identity = await provider.resolveIdentity(request);
  if (identity === null) return null;

  // The provider writes into egma's own user table, so the identity it resolves
  // is already an egma user id and the external-identity columns stay empty.
  // That emptiness is the design working: a provider that owns its own
  // directory fills those two columns instead, and this line becomes a lookup
  // on them while every product foreign key stays exactly where it is.
  const userId = identity.externalIdentityId;

  const memberships = await membershipsOf(userId);
  const membership = memberships[0];
  if (membership === undefined) {
    return {
      userId,
      email: identity.email,
      organizations: [],
      projects: [],
      auth: undefined,
    };
  }

  const projects = await projectsOf(membership.organizationId);
  const project = projects[0];
  if (project === undefined) {
    throw new Error(
      `organization ${membership.organizationId} has no project, which signup makes impossible`,
    );
  }

  const auth: AuthContext = {
    userId,
    organizationId: membership.organizationId,
    // The project a session acts in, until a person picks another. Signup made
    // exactly one and identifiers sort by mint time, so this is the one it
    // made.
    projectId: project.id,
    role: membership.role,
    via: "session",
  };

  const organization = await readOrganization(auth);
  if (organization === undefined) {
    throw new Error(
      `organization ${membership.organizationId} is gone but its membership is not`,
    );
  }

  return {
    userId,
    email: identity.email,
    organizations: [
      {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: membership.role,
      },
    ],
    projects,
    auth,
  };
}
