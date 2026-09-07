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
 * Resolve the session identity, then read current membership and projects
 * to build AuthContext. Reject memberships marked with account deactivation.
 * Organization and role come from storage, not request parameters.
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

  // Whatever they are a member of, and at whatever role. The flag is the
  // account's rather than any one membership's, so one row saying so is the
  // account saying so.
  if (memberships.some((held) => held.deactivatedAt !== null)) return null;

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
