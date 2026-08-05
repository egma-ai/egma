import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDigitalHuman,
  createTest,
  deleteDigitalHuman,
  editDigitalHuman,
  editTest,
  getTest,
  getTestVersion,
  NotPermittedError,
  type AuthContext,
  type NewTest,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Editing a test, and reading one frozen version of it — through the factory
 * functions only, like the create and fetch tests before them. Raw SQL appears
 * in fixtures and in the reads that prove an old version's rows were left
 * exactly where they were, which no seam shows; every id an assertion needs
 * comes off the seam itself.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
/** A second project of Acme's, so an edit can be narrowed past its sibling. */
const acmeOutbound = newId("prj");
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const gene = newId("usr");

/** Acme's starter digital human, and the one its project points at. */
let rita: string;
/** Two more of Acme's, for the sets an edit moves between. */
let nadia: string;
let omar: string;
/** Globex's, so a cross-project reference has something real to name. */
let grace: string;

function actingAsAcme(role: Role = "member"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

function actingAsGlobex(role: Role = "member"): AuthContext {
  return {
    userId: gene,
    organizationId: globex.organization,
    projectId: globex.project,
    role,
    via: "session",
  };
}

const rescheduling = {
  name: "Reschedules a booked appointment",
  description: "The bread-and-butter front-desk call",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week. They do not remember the exact time of the existing booking.",
  expectedBehaviors: [
    "verifies who it is speaking to before discussing the booking",
    "offers at least one afternoon slot next week",
    "confirms the new time back before finishing",
  ],
} as const satisfies NewTest;

const neutralTraits = {
  personality: "Speaks plainly, stays patient, asks one question at a time.",
  language: "en-US",
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 1 },
} as const;

async function seedDigitalHuman(
  auth: AuthContext,
  name: string,
): Promise<string> {
  const created = await createDigitalHuman(auth, {
    name,
    traits: neutralTraits,
  });
  return created.id;
}

/** What provisioning will do when it seeds a project's starter digital human. */
async function pointProjectAt(
  projectId: string,
  digitalHumanId: string | null,
): Promise<void> {
  await database.sql(
    "update project set default_digital_human_id = $1 where id = $2",
    [digitalHumanId, projectId],
  );
}

beforeAll(async () => {
  database = await createConnectedDatabase("tests_edit");

  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
    { id: acmeOutbound, slug: "outbound" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, gene, "gene@globex.example");

  rita = await seedDigitalHuman(actingAsAcme(), "Impatient Rita");
  nadia = await seedDigitalHuman(actingAsAcme(), "Nadia");
  omar = await seedDigitalHuman(actingAsAcme(), "Omar");
  grace = await seedDigitalHuman(actingAsGlobex(), "Careful Grace");
  await pointProjectAt(acme.project, rita);
});

afterAll(async () => {
  await database.drop();
});

async function rowCounts(): Promise<{
  tests: number;
  versions: number;
  named: number;
}> {
  const count = async (table: string): Promise<number> => {
    const { rows } = await database.sql<{ count: string }>(
      `select count(*) as count from ${table}`,
    );
    return Number(rows[0]?.count);
  };
  return {
    tests: await count("test"),
    versions: await count("test_version"),
    named: await count("test_version_digital_human"),
  };
}

/**
 * The join rows of one version, read raw. Nothing else can show that an old
 * version's rows were left alone rather than rewritten in place, because the
 * seam only ever answers with the version it was asked for.
 */
async function namedOn(
  versionId: string,
): Promise<{ digitalHumanId: string; position: number }[]> {
  const { rows } = await database.sql<{
    digital_human_id: string;
    position: number;
  }>(
    `select digital_human_id, position
       from test_version_digital_human
      where test_version_id = $1
      order by position`,
    [versionId],
  );
  return rows.map((row) => ({
    digitalHumanId: row.digital_human_id,
    position: row.position,
  }));
}

describe("editing what a test checks", () => {
  it("creates version 2 with its own rows, and leaves version 1 exactly where it was", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [omar, rita],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      scenario: "Their cleaning is booked for Thursday and has to move.",
    });

    expect(edited?.version).toBe(2);
    expect(edited?.versionId).not.toBe(created.versionId);
    expect(edited?.scenario).toBe(
      "Their cleaning is booked for Thursday and has to move.",
    );
    expect(edited?.digitalHumans.map((human) => human.id)).toEqual([omar, rita]);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(2);
    expect(fetched?.versionId).toBe(edited?.versionId);

    const frozen = await getTestVersion(actingAsAcme(), created.versionId);
    expect(frozen?.version).toBe(1);
    expect(frozen?.testId).toBe(created.id);
    expect(frozen?.scenario).toBe(rescheduling.scenario);
    expect(frozen?.expectedBehaviors).toEqual(rescheduling.expectedBehaviors);

    // The new version's rows are its own, and version 1 still holds the two it
    // was written with — the whole point of minting a version rather than
    // rewriting one.
    expect(await namedOn(created.versionId)).toEqual([
      { digitalHumanId: omar, position: 1 },
      { digitalHumanId: rita, position: 2 },
    ]);
    if (edited?.versionId === undefined) throw new Error("no second version");
    expect(await namedOn(edited.versionId)).toEqual([
      { digitalHumanId: omar, position: 1 },
      { digitalHumanId: rita, position: 2 },
    ]);
  });

  it("versions on a change to the expected behaviors alone", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    const sharper = [
      ...rescheduling.expectedBehaviors,
      "never states a price it was not given",
    ];
    const edited = await editTest(actingAsAcme(), created.id, {
      expectedBehaviors: sharper,
    });

    expect(edited?.version).toBe(2);
    expect(edited?.expectedBehaviors).toEqual(sharper);
    expect(edited?.scenario).toBe(rescheduling.scenario);
  });

  it("versions on a change to the digital humans alone", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [rita],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      digitalHumanIds: [rita, nadia],
    });

    expect(edited?.version).toBe(2);
    expect(edited?.scenario).toBe(rescheduling.scenario);
    expect(edited?.digitalHumans.map((human) => human.id)).toEqual([
      rita,
      nadia,
    ]);

    expect(await namedOn(created.versionId)).toEqual([
      { digitalHumanId: rita, position: 1 },
    ]);
  });

  it("counts the authored order as content, so reordering versions", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [nadia, omar],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      digitalHumanIds: [omar, nadia],
    });

    expect(edited?.version).toBe(2);
    expect(edited?.digitalHumans.map((human) => human.id)).toEqual([
      omar,
      nadia,
    ]);
  });

  it("keeps what the edit did not mention, and gives the new version its own rows", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [nadia, omar],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      expectedBehaviors: ["confirms the new time back before finishing"],
    });

    expect(edited?.version).toBe(2);
    expect(edited?.scenario).toBe(rescheduling.scenario);
    if (edited?.versionId === undefined) throw new Error("no second version");
    expect(await namedOn(edited.versionId)).toEqual([
      { digitalHumanId: nadia, position: 1 },
      { digitalHumanId: omar, position: 2 },
    ]);
  });

  it("does nothing for a byte-identical save, and returns the current version", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [rita, nadia],
    });
    const before = await rowCounts();

    const saved = await editTest(actingAsAcme(), created.id, {
      scenario: rescheduling.scenario,
      expectedBehaviors: [...rescheduling.expectedBehaviors],
      digitalHumanIds: [rita, nadia],
    });

    expect(saved?.version).toBe(1);
    expect(saved?.versionId).toBe(created.versionId);
    expect(saved?.digitalHumans.map((human) => human.id)).toEqual([rita, nadia]);
    expect(await rowCounts()).toEqual(before);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.updatedAt.getTime()).toBe(created.updatedAt.getTime());
  });

  it("keeps every old version fetchable by its tstv_ id after later edits", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);
    const second = await editTest(actingAsAcme(), created.id, {
      scenario: "They want the Tuesday slot instead.",
    });
    await editTest(actingAsAcme(), created.id, {
      scenario: "They want the Wednesday slot instead.",
    });

    const first = await getTestVersion(actingAsAcme(), created.versionId);
    expect(first?.version).toBe(1);
    expect(first?.scenario).toBe(rescheduling.scenario);

    if (second?.versionId === undefined) throw new Error("no second version");
    const middle = await getTestVersion(actingAsAcme(), second.versionId);
    expect(middle?.version).toBe(2);
    expect(middle?.scenario).toBe("They want the Tuesday slot instead.");
  });

  it("validates edited content exactly as created content, and versions nothing", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    await expect(
      editTest(actingAsAcme(), created.id, { expectedBehaviors: [] }),
    ).rejects.toThrow(/expected behavior/);
    await expect(
      editTest(actingAsAcme(), created.id, { scenario: "   " }),
    ).rejects.toThrow(/scenario/);
    await expect(
      editTest(actingAsAcme(), created.id, {
        expectedBehaviors: ["  "],
      }),
    ).rejects.toThrow(/expected behavior/);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(1);
    expect(fetched?.scenario).toBe(rescheduling.scenario);
  });

  it("stores an edited scenario and behaviors trimmed", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    const edited = await editTest(actingAsAcme(), created.id, {
      scenario: "  They want a refund and have no receipt.  ",
      expectedBehaviors: ["  states the refund policy  "],
    });

    expect(edited?.scenario).toBe("They want a refund and have no receipt.");
    expect(edited?.expectedBehaviors).toEqual(["states the refund policy"]);
  });

  it("is refused to a viewer, per the permission table", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    await expect(
      editTest(actingAsAcme("viewer"), created.id, {
        scenario: "Anything at all.",
      }),
    ).rejects.toThrow(NotPermittedError);
  });
});

describe("renaming a test", () => {
  it("updates name and description and creates no version", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);
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
    expect(fetched?.digitalHumans.map((human) => human.id)).toEqual([rita]);
  });

  it("clears the description with null, still without versioning", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    const cleared = await editTest(actingAsAcme(), created.id, {
      description: null,
    });

    expect(cleared?.description).toBeNull();
    expect(cleared?.version).toBe(1);
  });

  it("refuses a blank name", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    await expect(
      editTest(actingAsAcme(), created.id, { name: "   " }),
    ).rejects.toThrow(/name/);
  });

  it("renames and versions together when one edit carries both", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    const edited = await editTest(actingAsAcme(), created.id, {
      name: "Moves a booked appointment",
      scenario: "They want the Friday slot instead.",
    });

    expect(edited?.name).toBe("Moves a booked appointment");
    expect(edited?.version).toBe(2);
  });
});

describe("an edit naming a digital human it may not have", () => {
  it("is refused when the digital human does not exist, and versions nothing", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);
    const before = await rowCounts();

    await expect(
      editTest(actingAsAcme(), created.id, { digitalHumanIds: [newId("dh")] }),
    ).rejects.toThrow(/no digital human/);

    expect(await rowCounts()).toEqual(before);
    expect((await getTest(actingAsAcme(), created.id))?.version).toBe(1);
  });

  it("is refused when the digital human is deleted, and versions nothing", async () => {
    const retired = await seedDigitalHuman(actingAsAcme(), "Retired Rex");
    await deleteDigitalHuman(actingAsAcme(), retired);
    const created = await createTest(actingAsAcme(), rescheduling);
    const before = await rowCounts();

    await expect(
      editTest(actingAsAcme(), created.id, { digitalHumanIds: [retired] }),
    ).rejects.toThrow(/deleted/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused when the digital human belongs to another project", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    await expect(
      editTest(actingAsAcme(), created.id, { digitalHumanIds: [grace] }),
    ).rejects.toThrow(/no digital human/);
  });

  it("is refused when the same digital human is named twice", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    await expect(
      editTest(actingAsAcme(), created.id, { digitalHumanIds: [rita, rita] }),
    ).rejects.toThrow(/twice/);
  });

  it("is refused when the id is not a digital human's at all", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    await expect(
      editTest(actingAsAcme(), created.id, { digitalHumanIds: [newId("agt")] }),
    ).rejects.toThrow(/digital-human id/);
  });
});

describe("an edit naming no digital human", () => {
  it("leaves the set alone when the field is absent", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [nadia, omar],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      scenario: "They want the Monday slot instead.",
    });

    expect(edited?.digitalHumans.map((human) => human.id)).toEqual([
      nadia,
      omar,
    ]);
  });

  it("takes the project's default for an empty list, exactly as a create does", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [nadia, omar],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      digitalHumanIds: [],
    });

    expect(edited?.version).toBe(2);
    expect(edited?.digitalHumans.map((human) => human.id)).toEqual([rita]);
  });

  it("is no change at all when the default is already the one named", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [rita],
    });
    const before = await rowCounts();

    const saved = await editTest(actingAsAcme(), created.id, {
      digitalHumanIds: [],
    });

    expect(saved?.version).toBe(1);
    expect(saved?.versionId).toBe(created.versionId);
    expect(await rowCounts()).toEqual(before);
  });

  it("errors clearly when the project has no default, and versions nothing", async () => {
    const created = await createTest(actingAsGlobex(), {
      ...rescheduling,
      digitalHumanIds: [grace],
    });
    const before = await rowCounts();

    await expect(
      editTest(actingAsGlobex(), created.id, { digitalHumanIds: [] }),
    ).rejects.toThrow(/no default digital human/);

    expect(await rowCounts()).toEqual(before);
  });
});

describe("a digital human deleted after a version named them", () => {
  it("travels forward on an edit that did not name them", async () => {
    const leaving = await seedDigitalHuman(actingAsAcme(), "Leaving Lena");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [rita, leaving],
    });
    await deleteDigitalHuman(actingAsAcme(), leaving);

    const edited = await editTest(actingAsAcme(), created.id, {
      scenario: "They want the Saturday slot instead.",
    });

    expect(edited?.version).toBe(2);
    expect(edited?.digitalHumans.map((human) => human.id)).toEqual([
      rita,
      leaving,
    ]);
    expect(edited?.digitalHumans[1]?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("one frozen version", () => {
  it("answers with its content and its digital humans in the authored order", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [omar, rita, nadia],
    });

    const frozen = await getTestVersion(actingAsAcme(), created.versionId);
    expect(frozen?.id).toBe(created.versionId);
    expect(frozen?.testId).toBe(created.id);
    expect(frozen?.version).toBe(1);
    expect(frozen?.scenario).toBe(rescheduling.scenario);
    expect(frozen?.expectedBehaviors).toEqual(rescheduling.expectedBehaviors);
    expect(frozen?.digitalHumans).toEqual([
      { id: omar, name: "Omar", deletedAt: null },
      { id: rita, name: "Impatient Rita", deletedAt: null },
      { id: nadia, name: "Nadia", deletedAt: null },
    ]);
    expect(frozen?.createdAt).toBeInstanceOf(Date);
  });

  it("names its digital humans by identity, so editing one versions no test", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [nadia],
    });

    const moved = await editDigitalHuman(actingAsAcme(), nadia, {
      traits: { ...neutralTraits, language: "en-GB" },
    });
    expect(moved?.version).toBe(2);

    const frozen = await getTestVersion(actingAsAcme(), created.versionId);
    expect(frozen?.version).toBe(1);
    expect(frozen?.digitalHumans.map((human) => human.id)).toEqual([nadia]);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(1);
    expect(fetched?.versionId).toBe(created.versionId);
  });

  it("fails loudly on a hand-corrupted row, naming the version, rather than leaking", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    // Raw SQL on purpose: the factory can never write this, so the guard is
    // the only thing standing between the row and the caller.
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
    expect(
      await getTestVersion(actingAsAcme(), newId("tstv")),
    ).toBeUndefined();
  });
});

describe("tenancy", () => {
  it("edits nothing and returns nothing when another organization asks", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    const stolen = await editTest(actingAsGlobex("admin"), created.id, {
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
    const created = await createTest(actingAsAcme(), rescheduling);

    const inOutbound = { ...actingAsAcme(), projectId: acmeOutbound };
    expect(
      await editTest(inOutbound, created.id, { name: "Outbound's now" }),
    ).toBeUndefined();
    expect(await getTestVersion(inOutbound, created.versionId)).toBeUndefined();

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
    const created = await createTest(actingAsAcme(), rescheduling);

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const edited = await editTest(wholeCustomer, created.id, {
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
