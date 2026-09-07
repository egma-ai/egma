import { billing } from "../billing/ports.ts";
import { newId } from "@egma/ids";

import { db, type Queryable } from "../client.ts";
import { organization, project } from "../schema/tenancy.ts";
import { insertExpectedBehaviorsProjectGrader } from "./seeded-graders.ts";
import type { Membership } from "./memberships.ts";
import { insertMembership } from "./memberships.ts";

/**
 * Provision the organization, first project, expected-behaviors project grader,
 * and owner membership in one transaction. This creates a new isolation boundary
 * before an AuthContext exists.
 */

/**
 * Shared project factory for signup and admin creation. Insert the project and
 * its expected-behaviors project grader on the caller's transaction.
 * No default persona or persona catalog entry is required.
 */
export type NewProjectRow = {
  readonly projectId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly revision: string;
  /** Nullable, because a project can be created by nobody — a seeded one. */
  readonly createdBy: string | null;
};

export async function insertProject(
  on: Queryable,
  input: NewProjectRow,
): Promise<void> {
  await on.insert(project).values({
    id: input.projectId,
    organizationId: input.organizationId,
    name: input.name,
    slug: input.slug,
    description: input.description,
    revision: input.revision,
    createdBy: input.createdBy,
  });

  // The project's expected-behavior grading, in the same transaction as
  // everything else: one project grader with fixed all-simulations scope.
  // It holds project policy, not grader code. The behaviors somebody wrote on
  // their first test are graded because this row exists. There is no separate
  // `required`, `mandatory`, or running-copy field.
  await insertExpectedBehaviorsProjectGrader(on, {
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

}

export type NewOrganization = {
  /** The person the organization is being created for. They become its admin. */
  readonly ownerUserId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly projectName: string;
  readonly projectSlug: string;
};

export type ProvisionedOrganization = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly membership: Membership;
};

export async function provisionOrganization(
  input: NewOrganization,
): Promise<ProvisionedOrganization> {
  const organizationId = newId("org");
  const projectId = newId("prj");

  return db().transaction(async (tx) => {
    await tx.insert(organization).values({
      id: organizationId,
      name: input.organizationName,
      slug: input.organizationSlug,
    });

    try {
      await tx.transaction((billingTx) => billing().organizationCreated(billingTx, organizationId));
    } catch (fault) {
      console.error("Billing account creation failed; organization creation continues", fault);
    }

    // The one project factory, on the same terms an admin's Settings create
    // gets: the row and its seeded grader. Signing up and creating a second
    // project are the same act performed by different people, so they are the
    // same write.
    await insertProject(tx, {
      projectId,
      organizationId,
      name: input.projectName,
      slug: input.projectSlug,
      description: null,
      revision: newId("rev"),
      createdBy: input.ownerUserId,
    });

    // Everyone is an admin in v1 and roles are invisible, but the permission
    // map is real from the first commit. The creator of an organization is its
    // admin; anyone else arrives through an invitation.
    const membership = await insertMembership(tx, {
      organizationId,
      userId: input.ownerUserId,
      role: "admin",
      createdBy: input.ownerUserId,
    });

    return { organizationId, projectId, membership };
  });
}
