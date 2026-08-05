import { newId } from "@egma/ids";
import { eq } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { digitalHuman, digitalHumanVersion } from "../schema/digital-humans.ts";
import { organization, project } from "../schema/tenancy.ts";
import type { DigitalHumanTraits } from "./digital-humans.ts";
import type { Membership } from "./memberships.ts";
import { insertMembership } from "./memberships.ts";

/**
 * Creating a customer is the one write that cannot take an `AuthContext`,
 * because it is what brings the boundary into existence. It is safe on the same
 * terms as the resolver: it reads nothing, it names no existing organization,
 * and the only rows it can touch are the ones it just made.
 *
 * Signup either fully succeeds or fully fails. An account with an organization
 * but no project is a developer with no way forward, and a project with no
 * digital human in it is a first test waiting on one, so the organization, its
 * first project, that project's starter digital human and the owner's
 * membership are one transaction.
 */

/**
 * Who the starter digital human is.
 *
 * **This is a placeholder, and it is waiting to be replaced.** Which
 * personality a new project should meet, and which voice should say it, is a
 * product decision that has not been made yet; what is below is deliberately
 * plain, so that it says nothing about any industry, accent or manner while
 * still being a digital human the factory would accept. Replacing it changes
 * nothing that already exists — this is read once, when a project is created,
 * and every project seeded before the change keeps the row it was given, to
 * rename or rewrite like any other.
 */
const STARTER_NAME = "Starter";
const STARTER_DESCRIPTION =
  "The digital human a test gets when it names none. Rename them, rewrite them, or point the project at somebody else.";
const STARTER_TRAITS: DigitalHumanTraits = {
  personality: "Speaks plainly, stays patient, and asks one question at a time.",
  language: "en-US",
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 1 },
};

/**
 * The starter digital human, written into a project that exists but has nobody
 * in it yet.
 *
 * These are the same two inserts `createDigitalHuman` makes, in the same order
 * and the same shape: the identity row first, naming a version that does not
 * exist yet, because that pointer's constraint is deferred and Postgres checks
 * it at commit. They are made here rather than by calling that function,
 * because it opens a transaction of its own and takes an `AuthContext` — and
 * at this moment there is neither. The organization a context would name is
 * being brought into existence by the very transaction these rows have to
 * join, and a second transaction could not see it.
 */
async function insertStarterDigitalHuman(
  on: Queryable,
  into: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly createdBy: string;
  },
): Promise<string> {
  const id = newId("dh");
  const versionId = newId("dhv");

  await on.insert(digitalHuman).values({
    id,
    organizationId: into.organizationId,
    projectId: into.projectId,
    name: STARTER_NAME,
    description: STARTER_DESCRIPTION,
    currentVersionId: versionId,
    createdBy: into.createdBy,
  });

  await on.insert(digitalHumanVersion).values({
    id: versionId,
    digitalHumanId: id,
    version: 1,
    traits: STARTER_TRAITS,
    createdBy: into.createdBy,
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

    // The project's first digital human, and the project pointed at them, so a
    // developer's first test never waits on authoring one. In this transaction
    // like everything else, on the same terms the project itself is: a project
    // pointing at nobody would refuse the first test written in it.
    const starterId = await insertStarterDigitalHuman(tx, {
      organizationId,
      projectId,
      createdBy: input.ownerUserId,
    });

    // The pointer is its own statement rather than a column on the insert
    // above, because the two rows reference each other and only one of the two
    // constraints is deferred: the digital human names the project for its
    // tenancy, so the project has to be there first, and the project's
    // reference back is an ordinary foreign key checked statement by statement.
    // `updated_at` stays where the insert left it — the row is being finished,
    // not edited.
    await tx
      .update(project)
      .set({ defaultDigitalHumanId: starterId })
      .where(eq(project.id, projectId));

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
