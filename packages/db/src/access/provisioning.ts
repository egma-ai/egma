import { newId } from "@egma/ids";
import { eq } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { judgeConfiguration } from "../schema/graders.ts";
import { persona, personaVersion } from "../schema/personas.ts";
import { organization, project } from "../schema/tenancy.ts";
import { platformJudgeRow } from "./judges.ts";
import { insertSeededGrader } from "./seeded-graders.ts";
import type { PersonaTraits } from "./personas.ts";
import type { Membership } from "./memberships.ts";
import { insertMembership } from "./memberships.ts";

/**
 * Creating a customer is the one write that cannot take an `AuthContext`,
 * because it is what brings the boundary into existence. It is safe on the same
 * terms as the resolver: it reads nothing, it names no existing organization,
 * and the only rows it can touch are the ones it just made.
 *
 * Signup either fully succeeds or fully fails. An account with an organization
 * but no project is a developer with no way forward, a project with no persona
 * in it is a first test waiting on one, and a project with no grader in it is a
 * first run nobody judges — so the organization, its first project, that
 * project's starter persona, its copy of egma's expected-behaviors grader and
 * the owner's membership are one transaction.
 */

/**
 * Who the starter persona is.
 *
 * **This is a placeholder, and it is waiting to be replaced.** Which
 * personality a new project should meet, and which voice should say it, is a
 * product decision that has not been made yet; what is below is deliberately
 * plain, so that it says nothing about any industry, accent or manner while
 * still being a persona the factory would accept.
 */
const STARTER_NAME = "Starter";
const STARTER_DESCRIPTION =
  "The persona a test gets when it names none. Rename them, rewrite them, or point the project at somebody else.";
const STARTER_TRAITS: PersonaTraits = {
  personality: "Speaks plainly, stays patient, and asks one question at a time.",
  language: "en-US",
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 1 },
};

/**
 * The starter persona, written into a project that exists but has nobody
 * in it yet.
 *
 * These are the same two inserts `createPersona` makes, in the same order
 * and the same shape: the identity row first, naming a version that does not
 * exist yet, because that pointer's constraint is deferred and Postgres checks
 * it at commit. They are made here rather than by calling that function,
 * because it opens a transaction of its own and takes an `AuthContext` — and
 * at this moment there is neither.
 *
 * The two write shapes are held together by a test rather than the compiler:
 * `provisioning-starter-persona.test.ts` compares these rows against ones
 * `createPersona` wrote, and fails on a column only one of them fills.
 */
async function insertStarterPersona(
  on: Queryable,
  values: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly createdBy: string;
  },
): Promise<string> {
  const id = newId("prs");
  const versionId = newId("prsv");

  await on.insert(persona).values({
    id,
    organizationId: values.organizationId,
    projectId: values.projectId,
    name: STARTER_NAME,
    description: STARTER_DESCRIPTION,
    currentVersionId: versionId,
    createdBy: values.createdBy,
  });

  await on.insert(personaVersion).values({
    id: versionId,
    personaId: id,
    version: 1,
    traits: STARTER_TRAITS,
    createdBy: values.createdBy,
  });

  return id;
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

    await tx.insert(project).values({
      id: projectId,
      organizationId,
      name: input.projectName,
      slug: input.projectSlug,
      createdBy: input.ownerUserId,
    });

    // The project's first persona, and the project pointed at them, so a
    // developer's first test never waits on authoring one. In this transaction
    // like everything else, on the same terms the project itself is: a project
    // pointing at nobody would refuse the first test written in it.
    const starterId = await insertStarterPersona(tx, {
      organizationId,
      projectId,
      createdBy: input.ownerUserId,
    });

    // Its own statement because the project has to exist before a persona
    // can name it, and this reference back is not the deferred one.
    await tx
      .update(project)
      .set({ defaultPersonaId: starterId })
      .where(eq(project.id, projectId));

    // The project's mandatory grading, in the same transaction as everything
    // else: an active, required copy of egma's `expected_behaviors` grader,
    // scoped to simulations and holding nothing of its own. It is what makes a
    // first run judged with no setup at all — the behaviors somebody wrote on
    // their first test are checked because this row exists, and a project born
    // without it would be a project whose suite goes green having judged
    // nothing.
    await insertSeededGrader(tx, {
      organizationId,
      projectId,
      createdBy: input.ownerUserId,
    });

    // The platform's own judge, where it has one, in the same transaction as
    // everything else this project needs to be usable. `onConflictDoNothing`
    // for the same reason the backfill has it: a project that has a judge has
    // chosen it, and nothing here may spend from a different account than the
    // one somebody picked.
    if (input.defaultJudge !== undefined) {
      await tx
        .insert(judgeConfiguration)
        .values(
          platformJudgeRow({
            projectId,
            organizationId,
            createdBy: input.ownerUserId,
            provider: input.defaultJudge.provider,
            model: input.defaultJudge.model,
            key: input.defaultJudge.key,
            now: new Date(),
          }),
        )
        .onConflictDoNothing({ target: judgeConfiguration.projectId });
    }

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
