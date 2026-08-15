import { isId, newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTest,
  archivePersona,
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
  blocking,
  globex,
  pointProjectAt,
  rescheduling,
  rowCounts,
  seedPersona,
  seedTestFactory,
  STARTER_PERSONA,
} from "./support/test-factory.ts";

/**
 * The factory functions are the seam: every assertion goes through create and
 * get, never through table internals. Raw SQL appears only in fixtures, in row
 * counts proving what a failed create left behind, and in the inserts that
 * bypass the module on purpose to show the database refuses what the module
 * never attempts.
 *
 * The customers, their projects and their starter personas are the shared
 * fixture in `support/test-factory.ts`, which the editing tests seed from too.
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
  it("returns a tst_ id and fetch round-trips every input", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [rita],
    });

    expect(isId("tst", created.id)).toBe(true);
    expect(isId("tstv", created.versionId)).toBe(true);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.name).toBe(rescheduling.name);
    expect(fetched?.description).toBe(rescheduling.description);
    expect(fetched?.version).toBe(1);
    expect(fetched?.scenario).toBe(rescheduling.scenario);
    expect(fetched?.expectedBehaviors).toEqual(
      blocking(rescheduling.expectedBehaviors),
    );
    expect(fetched?.projectId).toBe(acme.project);
    expect(fetched?.personas).toEqual([
      { id: rita, name: STARTER_PERSONA, archivedAt: null },
    ]);
  });

  it("keeps several personas in the order they were authored", async () => {
    const nadia = await seedPersona(actingAsAcme(), "Nadia");
    const omar = await seedPersona(actingAsAcme(), "Omar");

    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [omar, rita, nadia],
    });

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.personas.map((named) => named.id)).toEqual([
      omar,
      rita,
      nadia,
    ]);
    expect(created.personas.map((named) => named.id)).toEqual([
      omar,
      rita,
      nadia,
    ]);
  });

  it("is allowed to a member and refused to a viewer, per the permission table", async () => {
    await expect(
      createTest(actingAsAcme("viewer"), rescheduling),
    ).rejects.toThrow(NotPermittedError);

    const created = await createTest(actingAsAcme("member"), rescheduling);
    const fetchedByViewer = await getTest(actingAsAcme("viewer"), created.id);
    expect(fetchedByViewer?.name).toBe(rescheduling.name);
  });

  it("is refused to a credential acting in no project", async () => {
    await expect(
      createTest({ ...actingAsAcme(), projectId: undefined }, rescheduling),
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
           (id, organization_id, project_id, name, current_version_id,
            revision, applicability_revision)
         values ($1, $2, $3, 'Halfway', $4, $5, $6)`,
        [
          orphan,
          acme.organization,
          acme.project,
          newId("tstv"),
          newId("rev"),
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

  it("is refused for an empty behaviors list, because an unfalsifiable test cannot exist", async () => {
    const before = await rowCounts();

    await expect(
      createTest(actingAsAcme(), { ...rescheduling, expectedBehaviors: [] }),
    ).rejects.toThrow(/expected behavior/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused when one of the behaviors says nothing", async () => {
    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        expectedBehaviors: [...rescheduling.expectedBehaviors, "   "],
      }),
    ).rejects.toThrow(/expected behavior/);
  });

  it("is refused when the same persona is named twice", async () => {
    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        personaIds: [rita, rita],
      }),
    ).rejects.toThrow(/twice/);
  });

  it("stores the name, scenario and behaviors trimmed", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "  Padded  ",
      scenario: "  They want a refund and have no receipt.  ",
      expectedBehaviors: ["  states the refund policy  "],
    });

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.name).toBe("Padded");
    expect(fetched?.scenario).toBe("They want a refund and have no receipt.");
    expect(fetched?.expectedBehaviors).toEqual(
      blocking(["states the refund policy"]),
    );
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

  it("is refused when the id is not a persona's at all", async () => {
    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        personaIds: [newId("agt")],
      }),
    ).rejects.toThrow(/persona id/);
  });

  it("is refused when the persona is archived, and leaves nothing", async () => {
    const retired = await seedPersona(actingAsAcme(), "Retired Rex");
    await archivePersona(actingAsAcme(), retired);

    const before = await rowCounts();

    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        personaIds: [retired],
      }),
    ).rejects.toThrow(/archived/);

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

describe("a test naming no persona", () => {
  it("receives the project's default", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.personas).toEqual([
      { id: rita, name: STARTER_PERSONA, archivedAt: null },
    ]);
  });

  it("receives the project's default for an empty list too", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [],
    });

    expect(created.personas.map((named) => named.id)).toEqual([rita]);
  });

  it("errors clearly when the project has no default, and creates nothing", async () => {
    const before = await rowCounts();

    // Globex's project was never pointed at anything, which is where a project
    // sits before provisioning seeds its starter persona.
    await expect(createTest(actingAsGlobex(), rescheduling)).rejects.toThrow(
      /no default persona/,
    );

    expect(await rowCounts()).toEqual(before);
  });

  it("errors clearly when the default has been archived, and creates nothing", async () => {
    const stale = await seedPersona(actingAsGlobex(), "Stale Default");
    const replacing = await seedPersona(actingAsGlobex(), "Replacing Them");
    await pointProjectAt(globex.project, stale);
    // Archiving the persona a project points at moves the pointer, so the
    // pointer is put back at the archived row by hand: the state this proves
    // is one the product refuses to create and the database still allows.
    await archivePersona(actingAsGlobex(), stale, {
      replacementPersonaId: replacing,
    });
    await pointProjectAt(globex.project, stale);

    const before = await rowCounts();

    await expect(createTest(actingAsGlobex(), rescheduling)).rejects.toThrow(
      /is archived/,
    );

    expect(await rowCounts()).toEqual(before);

    await pointProjectAt(globex.project, null);
  });

  it("says the default is not this project's, not that it is archived, when it points elsewhere", async () => {
    // The column's foreign key only says the row exists, so a pointer at a
    // living persona of another project is a state the database allows and the
    // developer has to be told the truth about.
    await pointProjectAt(acme.outbound, rita);

    const before = await rowCounts();

    const inOutbound = { ...actingAsAcme(), projectId: acme.outbound };
    await expect(createTest(inOutbound, rescheduling)).rejects.toThrow(
      /no persona .* in this project/,
    );
    await expect(createTest(inOutbound, rescheduling)).rejects.not.toThrow(
      /is archived/,
    );

    expect(await rowCounts()).toEqual(before);

    await pointProjectAt(acme.outbound, null);
  });
});

describe("a credential for the whole organization", () => {
  it("reads a project's tests without acting in the project", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

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
      createTest({ ...actingAsAcme(), projectId: globex.project }, rescheduling),
    ).rejects.toThrow(ProjectOutsideOrganizationError);

    expect(await rowCounts()).toEqual(before);
  });

  it("returns nothing when another organization asks for my test", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    expect(await getTest(actingAsGlobex(), created.id)).toBeUndefined();
  });

  it("returns nothing to the same customer acting in a sibling project", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

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
           (id, organization_id, project_id, name, current_version_id,
            revision, applicability_revision)
         values ($1, $2, $3, 'Smuggled', $4, $5, $6)`,
        [
          newId("tst"),
          acme.organization,
          globex.project,
          newId("tstv"),
          newId("rev"),
          newId("rev"),
        ],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });
});

describe("a version row somebody hand-corrupted", () => {
  it("fails loudly on the read, naming the version, rather than leaking", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    // Raw SQL on purpose: the factory can never write this, so the guard is the
    // only thing standing between the row and the caller.
    await database.sql(
      `update test_version set content = '{"scenario": "still here", "expectedBehaviors": []}'::jsonb
        where id = $1`,
      [created.versionId],
    );

    await expect(getTest(actingAsAcme(), created.id)).rejects.toThrow(
      created.versionId,
    );
  });
});
