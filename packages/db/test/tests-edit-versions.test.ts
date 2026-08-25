import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTest,
  editPersona,
  editTest,
  getTest,
  getTestVersion,
  NotPermittedError,
} from "@egma/db";

import { type MigratedDatabase } from "./support/database.ts";
import {
  acme,
  actingAsAcme,
  actingAsGlobex,
  rescheduling,
  rowCounts,
  seedPersona,
  seedTestFactory,
  STARTER_PERSONA,
  neutralTraits,
} from "./support/test-factory.ts";

/**
 * Editing a test, and reading one frozen version of it — through the factory
 * functions only, like the create and fetch tests before them. Raw SQL appears
 * in the reads that prove an old version's rows were left exactly where they
 * were, which no seam shows; every id an assertion needs comes off the seam
 * itself.
 *
 * What a write refuses is walked through in full at the create seam, in
 * `tests.test.ts`. Here one representative arm per rule shows the edit is held
 * to the same rules, rather than enumerating them a second time.
 */

let database: MigratedDatabase;
/** Acme's starter persona, and the one its project points at. */
let rita: string;
/** Two more of Acme's, for the sets an edit moves between. */
let nadia: string;
let omar: string;

beforeAll(async () => {
  ({ database, rita } = await seedTestFactory("tests_edit"));

  nadia = await seedPersona(actingAsAcme(), "Nadia");
  omar = await seedPersona(actingAsAcme(), "Omar");
});

afterAll(async () => {
  await database.drop();
});

/**
 * The join rows of one version, read raw. Nothing else can show that an old
 * version's rows were left alone rather than rewritten in place, because the
 * seam only ever answers with the version it was asked for.
 */
async function namedOn(
  versionId: string,
): Promise<{ personaId: string; position: number }[]> {
  const { rows } = await database.sql<{
    persona_id: string;
    position: number;
  }>(
    `select persona_id, position
       from test_persona
      where test_version_id = $1
      order by position`,
    [versionId],
  );
  return rows.map((row) => ({
    personaId: row.persona_id,
    position: row.position,
  }));
}

describe("editing what a test checks", () => {
  it("creates version 2 with its own rows, and leaves version 1 exactly where it was", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [omar, rita],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: created.versionId,
      scenario: "Their cleaning is booked for Thursday and has to move.",
    });

    expect(edited?.version).toBe(2);
    expect(edited?.versionId).not.toBe(created.versionId);
    expect(edited?.scenario).toBe(
      "Their cleaning is booked for Thursday and has to move.",
    );
    expect(edited?.personas.map((named) => named.id)).toEqual([omar, rita]);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(2);
    expect(fetched?.versionId).toBe(edited?.versionId);

    const frozen = await getTestVersion(actingAsAcme(), created.versionId);
    expect(frozen?.version).toBe(1);
    expect(frozen?.testId).toBe(created.id);
    expect(frozen?.scenario).toBe(rescheduling.scenario);
    expect(frozen?.expectedBehaviors).toEqual(
      rescheduling.expectedBehaviors,
    );

    // The new version's rows are its own, and version 1 still holds the two it
    // was written with — the whole point of minting a version rather than
    // rewriting one.
    expect(await namedOn(created.versionId)).toEqual([
      { personaId: omar, position: 1 },
      { personaId: rita, position: 2 },
    ]);
    if (edited?.versionId === undefined) throw new Error("no second version");
    expect(await namedOn(edited.versionId)).toEqual([
      { personaId: omar, position: 1 },
      { personaId: rita, position: 2 },
    ]);
  });

  it("versions on a change to the expected behaviors alone", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    const sharper = [
      ...rescheduling.expectedBehaviors,
      "never states a price it was not given",
    ];
    const edited = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: created.versionId,
      expectedBehaviors: sharper,
    });

    expect(edited?.version).toBe(2);
    expect(edited?.expectedBehaviors).toEqual(sharper);
    expect(edited?.scenario).toBe(rescheduling.scenario);
  });

  it("versions on a change to the personas alone", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [rita],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: created.versionId,
      personaIds: [rita, nadia],
    });

    expect(edited?.version).toBe(2);
    expect(edited?.scenario).toBe(rescheduling.scenario);
    expect(edited?.personas.map((named) => named.id)).toEqual([
      rita,
      nadia,
    ]);

    expect(await namedOn(created.versionId)).toEqual([
      { personaId: rita, position: 1 },
    ]);
  });

  it("counts the authored order as content, so reordering versions", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [nadia, omar],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: created.versionId,
      personaIds: [omar, nadia],
    });

    expect(edited?.version).toBe(2);
    expect(edited?.personas.map((named) => named.id)).toEqual([
      omar,
      nadia,
    ]);
  });

  it("does nothing for a byte-identical save, and returns the current version", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [rita, nadia],
    });
    const before = await rowCounts();

    const saved = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: created.versionId,
      scenario: rescheduling.scenario,
      expectedBehaviors: [...rescheduling.expectedBehaviors],
      personaIds: [rita, nadia],
    });

    expect(saved?.version).toBe(1);
    expect(saved?.versionId).toBe(created.versionId);
    expect(saved?.personas.map((named) => named.id)).toEqual([rita, nadia]);
    expect(await rowCounts()).toEqual(before);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.updatedAt.getTime()).toBe(created.updatedAt.getTime());
  });

  it("numbers each edit after the last, and keeps every version fetchable by its tstv_ id", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });
    const second = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: created.versionId,
      scenario: "They want the Tuesday slot instead.",
    });
    if (second === undefined) throw new Error("no second version");
    const third = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: second.versionId,
      scenario: "They want the Wednesday slot instead.",
    });

    expect(second?.version).toBe(2);
    expect(third?.version).toBe(3);
    expect((await getTest(actingAsAcme(), created.id))?.version).toBe(3);

    const first = await getTestVersion(actingAsAcme(), created.versionId);
    expect(first?.version).toBe(1);
    expect(first?.scenario).toBe(rescheduling.scenario);

    const middle = await getTestVersion(actingAsAcme(), second.versionId);
    expect(middle?.version).toBe(2);
    expect(middle?.scenario).toBe("They want the Tuesday slot instead.");

    if (third?.versionId === undefined) throw new Error("no third version");
    const last = await getTestVersion(actingAsAcme(), third.versionId);
    expect(last?.version).toBe(3);
    expect(last?.scenario).toBe("They want the Wednesday slot instead.");
  });

  it("validates edited content exactly as created content, and versions nothing", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    await expect(
      editTest(actingAsAcme(), created.id, {
        expectedVersionId: created.versionId,
        expectedBehaviors: [],
      }),
    ).rejects.toThrow(/expected behavior/);
    await expect(
      editTest(actingAsAcme(), created.id, {
        expectedVersionId: created.versionId,
        scenario: "   ",
      }),
    ).rejects.toThrow(/scenario/);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(1);
    expect(fetched?.scenario).toBe(rescheduling.scenario);
  });

  it("validates edited personas exactly as created ones, and versions nothing", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });
    const before = await rowCounts();

    await expect(
      editTest(actingAsAcme(), created.id, {
        expectedVersionId: created.versionId,
        personaIds: [newId("prs")],
      }),
    ).rejects.toThrow(/no persona/);

    expect(await rowCounts()).toEqual(before);
    expect((await getTest(actingAsAcme(), created.id))?.version).toBe(1);
  });

  it("stores an edited scenario and behaviors trimmed", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    const edited = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: created.versionId,
      scenario: "  They want a refund and have no receipt.  ",
      expectedBehaviors: ["  states the refund policy  "],
    });

    expect(edited?.scenario).toBe("They want a refund and have no receipt.");
    expect(edited?.expectedBehaviors).toEqual(
      ["states the refund policy"],
    );
  });

  it("is refused to a viewer, per the permission table", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    await expect(
      editTest(actingAsAcme("viewer"), created.id, {
        expectedVersionId: created.versionId,
        scenario: "Anything at all.",
      }),
    ).rejects.toThrow(NotPermittedError);
  });
});

describe("renaming a test", () => {
  it("updates name and description and creates no version", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });
    const before = await rowCounts();

    const renamed = await editTest(actingAsAcme(), created.id, {
      name: "Moves a booked appointment",
      description: "Renamed after the support team's wording",
    });

    expect(renamed?.name).toBe("Moves a booked appointment");
    expect(renamed?.description).toBe("Renamed after the support team's wording");
    expect(renamed?.version).toBe(1);
    expect(renamed?.versionId).toBe(created.versionId);
    expect(await rowCounts()).toEqual(before);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.name).toBe("Moves a booked appointment");
    expect(fetched?.version).toBe(1);
    expect(fetched?.scenario).toBe(rescheduling.scenario);
    expect(fetched?.personas.map((named) => named.id)).toEqual([rita]);
  });

  it("clears the description with null, still without versioning", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    const cleared = await editTest(actingAsAcme(), created.id, {
      description: null,
    });

    expect(cleared?.description).toBeNull();
    expect(cleared?.version).toBe(1);
  });

  it("refuses a blank name", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    await expect(
      editTest(actingAsAcme(), created.id, { name: "   " }),
    ).rejects.toThrow(/name/);
  });

  it("renames and versions together when one edit carries both", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    const edited = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: created.versionId,
      name: "Moves a booked appointment",
      scenario: "They want the Friday slot instead.",
    });

    expect(edited?.name).toBe("Moves a booked appointment");
    expect(edited?.version).toBe(2);
  });
});

/**
 * **An edit naming no persona is refused, and it used to be answered for.**
 *
 * The substitution these cases proved — an empty list quietly taking the
 * project's default — became a refusal on 2026-08-24, so an edit is held to
 * exactly what a create is held to.
 */
describe("an edit naming no persona", () => {
  it("keeps the set the version already named when the field is absent", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [nadia, omar],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: created.versionId,
      scenario: "They want the Monday slot instead.",
    });

    expect(edited?.version).toBe(2);
    expect(edited?.expectedBehaviors).toEqual(
      rescheduling.expectedBehaviors,
    );
    expect(edited?.personas).toEqual([
      { id: nadia, name: "Nadia", archivedAt: null },
      { id: omar, name: "Omar", archivedAt: null },
    ]);

    // The set carried forward, and the new version holds rows of its own that
    // say so — nothing is shared with the version left behind.
    if (edited?.versionId === undefined) throw new Error("no second version");
    expect(await namedOn(edited.versionId)).toEqual([
      { personaId: nadia, position: 1 },
      { personaId: omar, position: 2 },
    ]);
  });

  it("is refused for an empty list, exactly as a create is", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [nadia, omar],
    });

    await expect(
      editTest(actingAsAcme(), created.id, {
        expectedVersionId: created.versionId,
        personaIds: [],
      }),
    ).rejects.toThrow(/at least one persona/);
  });

  it("writes nothing at all when it is refused", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [rita],
    });
    const before = await rowCounts();

    await expect(
      editTest(actingAsAcme(), created.id, {
        expectedVersionId: created.versionId,
        personaIds: [],
      }),
    ).rejects.toThrow(/at least one persona/);

    // The stored version stands, and no row was written on the way to the
    // refusal — the same test, at the same version, naming the same caller.
    const stored = await getTest(actingAsAcme(), created.id);
    expect(stored?.versionId).toBe(created.versionId);
    expect(stored?.personas.map((named) => named.id)).toEqual([rita]);
    expect(await rowCounts()).toEqual(before);
  });

});

describe("one frozen version", () => {
  it("answers with its content and its personas in the authored order", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [omar, rita, nadia],
    });

    const frozen = await getTestVersion(actingAsAcme(), created.versionId);
    expect(frozen?.id).toBe(created.versionId);
    expect(frozen?.testId).toBe(created.id);
    expect(frozen?.version).toBe(1);
    expect(frozen?.scenario).toBe(rescheduling.scenario);
    expect(frozen?.expectedBehaviors).toEqual(
      rescheduling.expectedBehaviors,
    );
    expect(frozen?.personas).toEqual([
      { id: omar, name: "Omar", archivedAt: null },
      { id: rita, name: STARTER_PERSONA, archivedAt: null },
      { id: nadia, name: "Nadia", archivedAt: null },
    ]);
    expect(frozen?.createdAt).toBeInstanceOf(Date);
  });

  it("names its personas by identity, so editing one versions no test", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [nadia],
    });

    const moved = await editPersona(actingAsAcme(), nadia, {
      traits: {
        ...neutralTraits,
        personality: "Now speaks with deliberate precision.",
      },
    });
    expect(moved?.version).toBe(2);

    const frozen = await getTestVersion(actingAsAcme(), created.versionId);
    expect(frozen?.version).toBe(1);
    expect(frozen?.personas.map((named) => named.id)).toEqual([nadia]);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(1);
    expect(fetched?.versionId).toBe(created.versionId);
  });

  it("fails loudly on a hand-corrupted row, naming the version, rather than leaking", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    // Raw SQL on purpose: the factory can never write this, so the guard is the
    // only thing standing between the row and the caller.
    await database.sql(
      `update test_version set content = '{"scenario": "", "expectedBehaviors": ["a"]}'::jsonb
        where id = $1`,
      [created.versionId],
    );

    await expect(
      getTestVersion(actingAsAcme(), created.versionId),
    ).rejects.toThrow(created.versionId);
  });

  it("returns nothing for an id no version carries", async () => {
    expect(await getTestVersion(actingAsAcme(), newId("tstv"))).toBeUndefined();
  });
});

describe("tenancy", () => {
  it("edits nothing and returns nothing when another organization asks", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    const stolen = await editTest(actingAsGlobex("admin"), created.id, {
      expectedVersionId: created.versionId,
      name: "Globex's now",
      scenario: "Anything at all.",
    });
    expect(stolen).toBeUndefined();

    const untouched = await getTest(actingAsAcme(), created.id);
    expect(untouched?.name).toBe(rescheduling.name);
    expect(untouched?.version).toBe(1);

    expect(
      await getTestVersion(actingAsGlobex(), created.versionId),
    ).toBeUndefined();
  });

  it("returns nothing to the same customer acting in a sibling project", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    const inOutbound = { ...actingAsAcme(), projectId: acme.outbound };
    expect(
      await editTest(inOutbound, created.id, { name: "Outbound's now" }),
    ).toBeUndefined();
    expect(
      await editTest(inOutbound, created.id, {
        expectedVersionId: created.versionId,
        scenario: "Outbound's scenario now.",
      }),
    ).toBeUndefined();
    expect(await getTestVersion(inOutbound, created.versionId)).toBeUndefined();

    const untouched = await getTest(actingAsAcme(), created.id);
    expect(untouched?.name).toBe(rescheduling.name);
    expect(untouched?.version).toBe(1);

    // And the credential acting in no project still reaches both, so the arms
    // above failed for the project and not for something else.
    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    expect((await getTestVersion(wholeCustomer, created.versionId))?.id).toBe(
      created.versionId,
    );
    expect((await getTest(wholeCustomer, created.id))?.name).toBe(
      rescheduling.name,
    );
  });

  it("edits what already exists for a credential acting in no project", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const edited = await editTest(wholeCustomer, created.id, {
      expectedVersionId: created.versionId,
      scenario: "They want the Sunday slot instead.",
    });

    expect(edited?.version).toBe(2);
    expect(edited?.projectId).toBe(acme.project);
  });

  it("edits nothing for an id that does not exist", async () => {
    expect(
      await editTest(actingAsAcme(), newId("tst"), { name: "Nobody" }),
    ).toBeUndefined();
  });
});
