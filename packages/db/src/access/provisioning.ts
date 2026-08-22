import { newId } from "@egma/ids";

import { db, type Queryable } from "../client.ts";
import { EGMA_PROVIDED_PERSONAS } from "../persona-library/catalog.ts";
import { organization, project } from "../schema/tenancy.ts";
import { insertExpectedBehaviorsProjectGrader } from "./seeded-graders.ts";
import type { Membership } from "./memberships.ts";
import { insertMembership } from "./memberships.ts";

/**
 * Creating a customer is the one write that cannot take an `AuthContext`,
 * because it is what brings the boundary into existence. It is safe on the same
 * terms as the resolver: it reads nothing, it names no existing organization,
 * and the only rows it can touch are the ones it just made.
 *
 * Signup either fully succeeds or fully fails. An account with an organization
 * but no project is a developer with no way forward, a project with no default
 * persona is a first test waiting on one, and a project with no grader is a
 * first run nobody judges. The organization, its first project, the pointer to
 * Egma's shared default persona, its expected-behaviors grader and the owner's
 * membership are therefore one transaction.
 */

/**
 * Everything a project needs to be a *usable* project, written in one
 * transaction: the row itself, the pointer to Egma's shared default persona,
 * and its seeded expected-behaviors grader. It creates no local
 * copy of that persona; a customer fork is a separate, explicit authoring
 * action.
 *
 * **One factory, two callers, and that is the whole reason it is a function.**
 * Signup provisions the first project and an admin creates every one after it.
 * Both paths create the same complete project. There is no smaller project
 * shape without an active default persona or its seeded grader.
 *
 * It takes the transaction rather than opening one, because both callers have
 * other rows to write in the same breath — an organization and a membership for
 * one, nothing yet for the other — and a project that committed while its
 * organization rolled back would be a project belonging to nobody.
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
    defaultPersonaId: EGMA_PROVIDED_PERSONAS.defaultPersona,
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

    // The one project factory, on the same terms an admin's Settings create
    // gets: the row, the shared default persona pointer, and seeded grader.
    // Signing up and creating a second project
    // are the same act performed by different people, so they are the same
    // write.
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
