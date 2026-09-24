import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTest,
  deletePersona,
  getTest,
  NotPermittedError,
  ProjectOutsideOrganizationError,
} from "@egma/db";

import {
  errorCodeOf,
  openSingleConnection,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";
import {
  acme,
  actingAsAcme,
  actingAsGlobex,
  globex,
  rescheduling,
  rowCounts,
  seedPersona,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * Test the factory through create/get. Raw SQL supplies fixtures, checks
 * failed-write cleanup, and tests constraints by bypassing validation.
 */

let database: MigratedDatabase;
/** Acme's starter persona, and the one its project points at. */
let rita: string;
/** Globex's, so a cross-project reference has something real to name. */
let grace: string;

beforeAll(async () => {
  ({ database, rita, grace } = await seedTestFactory("tests"));
});

afterAll(async () => {
  await database.drop();
});

describe("creating a test", () => {
  it("is allowed to a member and refused to a viewer, per the permission table", async () => {
    await expect(
      createTest(actingAsAcme("viewer"), { ...rescheduling, personaIds: [rita] }),
    ).rejects.toThrow(NotPermittedError);

    const created = await createTest(actingAsAcme("member"), { ...rescheduling, personaIds: [rita] });
    const fetchedByViewer = await getTest(actingAsAcme("viewer"), created.id);
    expect(fetchedByViewer?.name).toBe(rescheduling.name);
  });

  it("is refused to a credential acting in no project", async () => {
    await expect(
      createTest({ ...actingAsAcme(), projectId: undefined }, { ...rescheduling, personaIds: [rita] }),
    ).rejects.toThrow(/project/);
  });

  it("cannot commit halfway: an identity row without its version dies at commit", async () => {
    // The factory writes the test, its version and its join rows in one
    // transaction, so a create that fails part-way leaves nothing. That
    // guarantee is the deferred pointer constraint, and this proves it where it
    // lives — at commit, in the database, for a writer that is not the factory.
    const connection = await openSingleConnection(database.url);
    try {
      const orphan = newId("tst");
      await connection.sql("begin");
      await connection.sql(
        `insert into test
           (id, organization_id, project_id, suite_id, name,
            current_version_id, revision)
         values ($1, $2, $3, $4, 'Halfway', $5, $6)`,
        [
          orphan,
          acme.organization,
          acme.project,
          acme.suite,
          newId("tstv"),
          newId("rev"),
        ],
      );

      await expect(connection.sql("commit")).rejects.toSatisfy(
        (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
      );

      const { rows } = await database.sql("select 1 from test where id = $1", [
        orphan,
      ]);
      expect(rows).toEqual([]);
    } finally {
      await connection.close();
    }
  });
});

describe("a test that fails validation", () => {
  it("is refused for a missing name, and no rows are left behind", async () => {
    const before = await rowCounts();

    await expect(
      createTest(actingAsAcme(), { ...rescheduling, name: "   " }),
    ).rejects.toThrow(/name/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused for an empty scenario, and no rows are left behind", async () => {
    const before = await rowCounts();

    await expect(
      createTest(actingAsAcme(), { ...rescheduling, scenario: "  " }),
    ).rejects.toThrow(/scenario/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused when the same persona is named twice", async () => {
    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        personaIds: [rita, rita],
      }),
    ).rejects.toThrow(/twice/);
  });
});

describe("a test naming a persona it may not have", () => {
  it("is refused when the persona does not exist, and leaves nothing", async () => {
    const before = await rowCounts();

    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        personaIds: [newId("prs")],
      }),
    ).rejects.toThrow(/no persona/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused when the persona is deleted, and leaves nothing", async () => {
    const retired = await seedPersona(actingAsAcme(), "Retired Rex");
    await deletePersona(actingAsAcme(), retired);

    const before = await rowCounts();

    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        personaIds: [retired],
      }),
    ).rejects.toThrow(/deleted/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused when the persona belongs to another project, and leaves nothing", async () => {
    const before = await rowCounts();

    await expect(
      createTest(actingAsAcme(), { ...rescheduling, personaIds: [grace] }),
    ).rejects.toThrow(/no persona/);

    expect(await rowCounts()).toEqual(before);
  });

  it("leaves nothing behind even when the good personas come first", async () => {
    const before = await rowCounts();

    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        personaIds: [rita, newId("prs")],
      }),
    ).rejects.toThrow(/no persona/);

    expect(await rowCounts()).toEqual(before);
  });
});

/** Reject an empty persona list on create. */
describe("a test naming no persona", () => {
  it("is refused for an empty list too", async () => {
    await expect(
      createTest(actingAsAcme(), { ...rescheduling, personaIds: [] }),
    ).rejects.toThrow(/at least one persona/);
  });
});

describe("a credential for the whole organization", () => {
  it("reads a project's tests without acting in the project", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const fetched = await getTest(wholeCustomer, created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.projectId).toBe(acme.project);
    expect(fetched?.personas.map((named) => named.id)).toEqual([rita]);
  });
});

describe("tenancy", () => {
  it("refuses a context pairing one organization with another's project, leaving no rows", async () => {
    const before = await rowCounts();

    await expect(
      createTest({ ...actingAsAcme(), projectId: globex.project }, { ...rescheduling, personaIds: [rita] }),
    ).rejects.toThrow(ProjectOutsideOrganizationError);

    expect(await rowCounts()).toEqual(before);
  });

  it("returns nothing when another organization asks for my test", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    expect(await getTest(actingAsGlobex(), created.id)).toBeUndefined();
  });

  it("returns nothing to the same customer acting in a sibling project", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    // Same organization, same person, same role — only the project differs,
    // which is the whole of what a project is: a filter, not a wall.
    const inOutbound = { ...actingAsAcme(), projectId: acme.outbound };
    expect(await getTest(inOutbound, created.id)).toBeUndefined();

    // And the credential acting in no project still reaches it, so the arm
    // above failed for the project and not for something else.
    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    expect((await getTest(wholeCustomer, created.id))?.id).toBe(created.id);
  });

  it("returns nothing for an id that does not exist", async () => {
    expect(await getTest(actingAsAcme(), newId("tst"))).toBeUndefined();
  });

  it("refuses the mismatched pairing even for raw SQL that bypasses the module", async () => {
    await expect(
      database.sql(
        `insert into test
           (id, organization_id, project_id, suite_id, name,
            current_version_id, revision)
         values ($1, $2, $3, $4, 'Smuggled', $5, $6)`,
        [
          newId("tst"),
          acme.organization,
          globex.project,
          acme.suite,
          newId("tstv"),
          newId("rev"),
        ],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });
});
