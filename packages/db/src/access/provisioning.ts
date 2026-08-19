import { newId } from "@egma/ids";

import { db, type Queryable } from "../client.ts";
import { judgeConfiguration } from "../schema/graders.ts";
import { PREDEFINED_PERSONAS } from "../persona-library/catalog.ts";
import { organization, project } from "../schema/tenancy.ts";
import { platformJudgeRow } from "./judges.ts";
import { insertSeededGrader } from "./seeded-graders.ts";
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
 * and whatever judge state the deployment can give it. It creates no local
 * copy of that persona; a customer fork is a separate, explicit authoring
 * action.
 *
 * **One factory, two callers, and that is the whole reason it is a function.**
 * Signup provisions the first project and an admin creates every one after it,
 * and the two used to be different code — which is how a project created from
 * Settings came to have no default persona and no judge while a project created
 * at signup had both. A project half-built is not a smaller project; it is one
 * that refuses the first test somebody writes in it and returns errored
 * verdicts on the first run, both for reasons nobody could see from the page
 * they were on.
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
  /**
   * The judge this deployment gives a project that has configured none, when it
   * has one at all.
   *
   * **Absent is a state and not a gap.** A project born without one is in
   * `needs_setup`: it can still run every deterministic grader it has, and it
   * cannot ask a model anything until an admin points it at a credential. That
   * is what the settings page says out loud, and it is honest — where a project
   * silently born unjudged would look configured and produce errored verdicts
   * after real calls had been paid for.
   */
  readonly defaultJudge?: NewPlatformJudge | undefined;
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
    defaultPersonaId: PREDEFINED_PERSONAS.defaultPersona,
    createdBy: input.createdBy,
  });

  // The project's mandatory grading, in the same transaction as everything
  // else: an active, required copy of egma's `expected_behaviors` grader,
  // scoped to simulations and holding nothing of its own. It is what makes a
  // first run judged with no setup at all — the behaviors somebody wrote on
  // their first test are checked because this row exists, and a project born
  // without it would be a project whose suite goes green having judged
  // nothing.
  await insertSeededGrader(on, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    createdBy: input.createdBy ?? null,
  });

  // The platform's own judge, where it has one, in the same transaction as
  // everything else this project needs to be usable. `onConflictDoNothing` for
  // the same reason the backfill has it: a project that has a judge has chosen
  // it, and nothing here may spend from a different account than the one
  // somebody picked.
  if (input.defaultJudge !== undefined) {
    await on
      .insert(judgeConfiguration)
      .values(
        platformJudgeRow({
          projectId: input.projectId,
          organizationId: input.organizationId,
          createdBy: input.createdBy,
          provider: input.defaultJudge.provider,
          model: input.defaultJudge.model,
          key: input.defaultJudge.key,
          now: new Date(),
        }),
      )
      .onConflictDoNothing({ target: judgeConfiguration.projectId });
  }
}

export type NewOrganization = {
  /** The person the organization is being created for. They become its admin. */
  readonly ownerUserId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly projectName: string;
  readonly projectSlug: string;
  /**
   * The judge this deployment gives a project that has configured none, if it
   * has one. Applied here, in the transaction that creates the project, so a
   * project is *born* gradable.
   *
   * It used to be applied only by a backfill at API startup, and the gap that
   * left is exactly the shape of the ordinary first run: start a platform with
   * no projects, then sign up — which creates the first project while the API
   * is already running. That project had no judge until somebody restarted the
   * API, and until then every model-based verdict came back `errored`. Nobody
   * would have read that as "the platform is missing configuration", because a
   * grading failure is an operational failure rather than anything the agent
   * under test did.
   */
  readonly defaultJudge?: NewPlatformJudge | undefined;
};

/** A judge a deployment hands to projects that have configured none. */
export type NewPlatformJudge = {
  readonly provider: string;
  readonly model: string;
  readonly key: string;
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
    // gets: the row, the shared default persona pointer, and whatever
    // judge this deployment can give. Signing up and creating a second project
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
      ...(input.defaultJudge === undefined
        ? {}
        : { defaultJudge: input.defaultJudge }),
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
