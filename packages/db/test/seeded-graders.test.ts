import { newId } from "@egma/ids";
import {
  createProject,
  deleteGrader,
  getGrader,
  listGraders,
  PREDEFINED_GRADERS,
  provisionOrganization,
  seedRunningGraders,
  type AuthContext,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedUser } from "./support/tenancy.ts";

/**
 * **No project runs unjudged**, new or old.
 *
 * A test says what should happen and running it means checking whether it did.
 * That check used to be implicit — a built-in that was never a row, applied
 * because running a test *meant* judging it, and writing a sentinel string
 * where verdict rows want a grader id. It is a running copy of a library entry
 * now, which is what gives it a scope, a `required` flag and an identity a
 * verdict can name — and the moment it became a row it became something a
 * project could be missing.
 *
 * So there are two writes and this file is about both:
 *
 * - **At birth.** A project is created holding the copy, in the transaction
 *   that creates the project. There is no instant in which a project exists and
 *   judges nothing, and "it depends when you looked" is not an answer a trust
 *   product may give.
 * - **At start-up.** The backfill gives one to every project that has never had
 *   one, which is every project created before this change. The product is
 *   pre-launch, and dev and demo databases still hold projects; none of them may
 *   quietly lose mandatory grading because a release moved where it lived.
 *
 * Everything goes through the front doors: `provisionOrganization` as signup
 * calls it, `createProject` as the second door, and the backfill as a boot
 * calls it. Raw SQL appears only to make the one state no exported call can —
 * a project written before the copy existed.
 */

let database: MigratedDatabase;

type Provisioned = {
  readonly auth: AuthContext;
  readonly organizationId: string;
  readonly projectId: string;
  readonly userId: string;
};

async function signUp(slug: string, email: string): Promise<Provisioned> {
  const userId = newId("usr");
  await seedUser(database, userId, email);

  const provisioned = await provisionOrganization({
    ownerUserId: userId,
    organizationName: slug,
    organizationSlug: slug,
    projectName: "Default",
    projectSlug: "default",
  });

  return {
    auth: {
      userId,
      organizationId: provisioned.organizationId,
      projectId: provisioned.projectId,
      role: "admin",
      via: "session",
    },
    organizationId: provisioned.organizationId,
    projectId: provisioned.projectId,
    userId,
  };
}

/** The copies pointing at an entry, whatever a read would narrow to. */
async function copiesOf(projectId: string): Promise<readonly string[]> {
  const { rows } = await database.sql<{ id: string }>(
    "select id from grader where project_id = $1 and library_id = $2 order by id",
    [projectId, PREDEFINED_GRADERS.expectedBehaviors],
  );
  return rows.map((row) => row.id);
}

/**
 * A project as it looked before this change: written straight into the table,
 * with no grader in it. Raw SQL because no exported call can leave one — which
 * is the whole point of the backfill this file is about.
 */
async function anOldProject(
  organizationId: string,
  slug: string,
): Promise<string> {
  const projectId = newId("prj");
  await database.sql(
    "insert into project (id, organization_id, name, slug) values ($1, $2, $3, $3)",
    [projectId, organizationId, slug],
  );
  return projectId;
}

let acme: Provisioned;

beforeAll(async () => {
  database = await createConnectedDatabase("seeded_graders");
  acme = await signUp("acme", "ada@acme.example");
  // A second customer, so a backfill missing its scoping has somebody else's
  // project to wrongly leave alone or wrongly write into.
  await signUp("globex", "grace@globex.example");
});

afterAll(async () => {
  await database.drop();
});

describe("the project signup creates", () => {
  it("is born judging, with an active copy of egma's expected-behaviors grader", async () => {
    const page = await listGraders(acme.auth);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      libraryId: PREDEFINED_GRADERS.expectedBehaviors,
      name: "expected_behaviors",
      type: "llm_as_judge",
      // Required, so a test cannot pass while its own expected behaviors do
      // not — which is what "a first run is judged with zero setup" means.
      required: true,
      // Structurally simulations-only: a production trace has no test, so
      // there are no expected behaviors for it to read.
      scope: "simulations",
      version: 1,
    });
    // Its assertions are the test's own sentences, so there is nothing filled
    // in and there never will be. Empty is complete here.
    expect(page.items[0]?.config).toEqual({ assertions: [] });
  });

  /**
   * **In the same transaction as the project**, which is what makes the state
   * above the only state there has ever been. A project that existed for even a
   * moment with no grader in it would be a project whose first run could come
   * back green having judged nothing.
   *
   * Asserted where it can be seen: provisioning either wrote everything or
   * nothing, so a refused signup leaves no project *and* no grader, and the two
   * counts moving together is the transaction.
   */
  it("leaves no grader behind when the signup it belonged to is refused", async () => {
    const before = await database.sql<{ how_many: string }>(
      "select count(*) as how_many from grader",
    );

    await expect(
      provisionOrganization({
        ownerUserId: newId("usr"),
        organizationName: "Nobody",
        organizationSlug: "acme",
        projectName: "Default",
        projectSlug: "default",
      }),
    ).rejects.toThrow();

    const after = await database.sql<{ how_many: string }>(
      "select count(*) as how_many from grader",
    );
    expect(after.rows[0]?.how_many).toBe(before.rows[0]?.how_many);
  });
});

describe("a project created inside an organization that already exists", () => {
  it("is born judging too, on the same terms", async () => {
    const outbound = await createProject(acme.auth, {
      name: "Outbound",
      slug: "outbound",
    });

    const inOutbound = { ...acme.auth, projectId: outbound.id };
    const page = await listGraders(inOutbound);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.libraryId).toBe(
      PREDEFINED_GRADERS.expectedBehaviors,
    );
  });
});

describe("the backfill a deployment runs at start-up", () => {
  it("gives the copy to a project that never had one", async () => {
    const old = await anOldProject(acme.organizationId, "before-the-change");
    expect(await copiesOf(old)).toEqual([]);

    const seeded = await seedRunningGraders();

    expect(seeded.map((copy) => copy.projectId)).toContain(old);
    const [written] = await copiesOf(old);
    expect(written).toBeDefined();

    const inOld = { ...acme.auth, projectId: old };
    expect(await getGrader(inOld, written ?? "")).toMatchObject({
      libraryId: PREDEFINED_GRADERS.expectedBehaviors,
      required: true,
      scope: "simulations",
    });
  });

  /**
   * **Idempotent, and running it on every boot is what it is for.** A second
   * run finds every project already holding its copy and writes nothing at all
   * — which is what makes it free to leave in the boot sequence rather than
   * merely harmless.
   */
  it("writes nothing at all the second time it runs", async () => {
    await seedRunningGraders();

    const before = await database.sql<{ how_many: string }>(
      "select count(*) as how_many from grader",
    );
    const again = await seedRunningGraders();
    const after = await database.sql<{ how_many: string }>(
      "select count(*) as how_many from grader",
    );

    expect(again).toEqual([]);
    expect(after.rows[0]?.how_many).toBe(before.rows[0]?.how_many);
  });

  /**
   * **Deleting a copy is how a grader is switched off**, and there is no other
   * switch. So the question the backfill asks is whether a project has *ever*
   * held one, not whether it holds one now — otherwise it would write the
   * grader back the next time a container started and overrule a person every
   * morning.
   */
  it("does not write the copy back for a project that switched it off", async () => {
    const dormant = await createProject(acme.auth, {
      name: "Dormant",
      slug: "dormant",
    });
    const inDormant = { ...acme.auth, projectId: dormant.id };

    const [switching] = await copiesOf(dormant.id);
    expect(switching).toBeDefined();
    await deleteGrader(inDormant, switching ?? "");
    expect((await listGraders(inDormant)).items).toEqual([]);

    await seedRunningGraders();

    // Still off, and still exactly the one row — the deleted one.
    expect((await listGraders(inDormant)).items).toEqual([]);
    expect(await copiesOf(dormant.id)).toEqual([switching]);
  });

  it("leaves a soft-deleted project alone, because nothing runs in one", async () => {
    const closed = await anOldProject(acme.organizationId, "closed");
    await database.sql("update project set deleted_at = now() where id = $1", [
      closed,
    ]);

    await seedRunningGraders();

    expect(await copiesOf(closed)).toEqual([]);
  });
});
