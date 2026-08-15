import { isId, newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cloneTest,
  createTest,
  deleteTest,
  editTest,
  getTest,
  getTestVersion,
  listTests,
  NotPermittedError,
  type Test,
} from "@egma/db";

import { type MigratedDatabase } from "./support/database.ts";
import {
  acme,
  actingAsAcme,
  actingAsGlobex,
  blocking,
  rescheduling,
  rowCounts,
  seedPersona,
  seedTestFactory,
  STARTER_PERSONA,
} from "./support/test-factory.ts";

/**
 * List, clone, delete — through the factory functions only, like the create,
 * fetch and edit tests before them. Raw SQL appears in the reads that count
 * what a clone did not carry and what a delete did not take away, which no seam
 * shows; every id an assertion needs comes off the seam itself.
 *
 * The listing acts in Acme's sibling project, so what that block asserts is
 * exactly what it created — the blocks that clone and delete work in the
 * default project and cannot disturb it.
 */

let database: MigratedDatabase;
/** Acme's starter persona, and the one its default project points at. */
let rita: string;
/** Globex's, so its test has a persona of its own to name. */
let grace: string;
/** Two more of Acme's, so a cloned set of personas is longer than one. */
let nadia: string;
let omar: string;
/** The sibling project's own two, since that project points at no default. */
let olive: string;
let oscar: string;

/** The sibling project, which the listing block has to itself. */
function actingInOutbound() {
  return { ...actingAsAcme(), projectId: acme.outbound };
}

/** A credential for the whole customer, acting in no project. */
function actingAsWholeCustomer() {
  return { ...actingAsAcme(), projectId: undefined };
}

beforeAll(async () => {
  ({ database, rita, grace } = await seedTestFactory("tests_lifecycle"));

  nadia = await seedPersona(actingAsAcme(), "Nadia");
  omar = await seedPersona(actingAsAcme(), "Omar");
  olive = await seedPersona(actingInOutbound(), "Olive");
  oscar = await seedPersona(actingInOutbound(), "Oscar");
});

afterAll(async () => {
  await database.drop();
});

/**
 * A test's version ids, oldest first, read raw. Nothing else can show how much
 * history a clone did not carry, because the seam only ever answers with the
 * version it was asked for.
 */
async function versionIdsOf(testId: string): Promise<readonly string[]> {
  const { rows } = await database.sql<{ id: string }>(
    "select id from test_version where test_id = $1 order by version",
    [testId],
  );
  return rows.map((row) => row.id);
}

describe("listing tests", () => {
  const created: Test[] = [];
  let sibling: Test;
  let stranger: Test;

  beforeAll(async () => {
    // All but one name the same single persona; "Four" names two, in an order
    // that is not the order they were minted. A page that bucketed every row
    // under one test, or dropped the authored order for the id order, could not
    // survive that.
    for (const name of ["One", "Two", "Three", "Four", "Five"]) {
      created.push(
        await createTest(actingInOutbound(), {
          ...rescheduling,
          name,
          personaIds: name === "Four" ? [oscar, olive] : [olive],
        }),
      );
    }
    // One in the sibling project and one at another customer, so "only the
    // acting project's" is a claim the assertions can actually falsify.
    sibling = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "Sibling",
    });
    stranger = await createTest(actingAsGlobex(), {
      ...rescheduling,
      name: "Stranger",
      personaIds: [grace],
    });
  });

  it("returns only the acting project's tests, newest first", async () => {
    const page = await listTests(actingInOutbound());

    expect(page.items.map((item) => item.id)).toEqual(
      created.map((item) => item.id).reverse(),
    );
    expect(page.items.map((item) => item.name)).toEqual([
      "Five",
      "Four",
      "Three",
      "Two",
      "One",
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("carries the current content and personas on every row", async () => {
    const page = await listTests(actingInOutbound());

    expect(
      page.items.every(
        (item) => item.version === 1 && item.scenario === rescheduling.scenario,
      ),
    ).toBe(true);
    const five = page.items[0];
    expect(five?.expectedBehaviors).toEqual(
      blocking(rescheduling.expectedBehaviors),
    );
    expect(five?.personas).toEqual([
      { id: olive, name: "Olive", archivedAt: null },
    ]);

    // The one row naming two, in the order it authored them and no other: a
    // page reads every row's personas in one go, and each row has to come back
    // with its own.
    const four = page.items.find((item) => item.name === "Four");
    expect(four?.personas).toEqual([
      { id: oscar, name: "Oscar", archivedAt: null },
      { id: olive, name: "Olive", archivedAt: null },
    ]);
  });

  it("pages across the whole set with no overlap and no missed row", async () => {
    const first = await listTests(actingInOutbound(), { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]?.id);

    const second = await listTests(actingInOutbound(), {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBe(second.items[1]?.id);

    const third = await listTests(actingInOutbound(), {
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeUndefined();

    const walked = [...first.items, ...second.items, ...third.items];
    expect(walked.map((item) => item.id)).toEqual(
      created.map((item) => item.id).reverse(),
    );
  });

  it("refuses a page size outside the range and a cursor that is not a tst_ id", async () => {
    await expect(
      listTests(actingInOutbound(), { limit: 0 }),
    ).rejects.toThrow(/between 1 and/);
    await expect(
      listTests(actingInOutbound(), { limit: 201 }),
    ).rejects.toThrow(/between 1 and/);
    await expect(
      listTests(actingInOutbound(), { cursor: "tstv_nonsense" }),
    ).rejects.toThrow(/cursor/);
  });

  it("shows a credential for the whole organization every project, and no other customer", async () => {
    const page = await listTests(actingAsWholeCustomer());

    // Exactly the five of this block and the one in the sibling project —
    // nothing else of Acme's exists yet, so the count is a claim and not a
    // floor.
    const ids = page.items.map((item) => item.id);
    expect(ids).toHaveLength(6);
    for (const item of created) expect(ids).toContain(item.id);
    expect(ids).toContain(sibling.id);
    expect(ids).not.toContain(stranger.id);
    expect(
      page.items.every((item) =>
        [acme.project, acme.outbound].includes(item.projectId),
      ),
    ).toBe(true);
  });

  it("shows another customer none of them", async () => {
    const page = await listTests(actingAsGlobex());
    expect(page.items.map((item) => item.id)).toEqual([stranger.id]);
  });

  it("shows the current version after an edit, not the one it left behind", async () => {
    const [two] = created.filter((item) => item.name === "Two");
    if (two === undefined) throw new Error("Two was never created");

    await editTest(actingInOutbound(), two.id, {
      scenario: "They want the Tuesday slot instead.",
    });

    const page = await listTests(actingInOutbound());
    const listed = page.items.find((item) => item.id === two.id);
    expect(listed?.version).toBe(2);
    expect(listed?.scenario).toBe("They want the Tuesday slot instead.");
  });

  it("drops a deleted test from the list immediately", async () => {
    const [three] = created.filter((item) => item.name === "Three");
    if (three === undefined) throw new Error("Three was never created");

    await deleteTest(actingInOutbound(), three.id);

    const page = await listTests(actingInOutbound());
    expect(page.items.map((item) => item.name)).toEqual([
      "Five",
      "Four",
      "Two",
      "One",
    ]);

    // And it is gone from the whole customer's list too, not only this one.
    const wholeCustomer = await listTests(actingAsWholeCustomer());
    expect(wholeCustomer.items.map((item) => item.id)).not.toContain(three.id);
  });
});

describe("cloning a test", () => {
  let source: Test;

  beforeAll(async () => {
    const first = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "Original",
      personaIds: [omar, rita, nadia],
    });
    // A second version, so a clone that copied history rather than content
    // would have somewhere to show it.
    const second = await editTest(actingAsAcme(), first.id, {
      scenario: "They want any afternoon next week, and cannot do Thursday.",
    });
    if (second === undefined) throw new Error("the source was not versioned");
    source = second;
  });

  it("copies the current scenario, behaviors and personas into a fresh test at version 1", async () => {
    const clone = await cloneTest(actingAsAcme(), source.id);

    expect(clone).toBeDefined();
    if (clone === undefined) throw new Error("unreachable");
    expect(isId("tst", clone.id)).toBe(true);
    expect(clone.id).not.toBe(source.id);
    expect(clone.versionId).not.toBe(source.versionId);
    expect(clone.version).toBe(1);
    expect(clone.name).toBe(source.name);
    expect(clone.description).toBe(source.description);
    expect(clone.scenario).toBe(source.scenario);
    expect(clone.expectedBehaviors).toEqual(source.expectedBehaviors);
    expect(clone.personas).toEqual([
      { id: omar, name: "Omar", archivedAt: null },
      { id: rita, name: STARTER_PERSONA, archivedAt: null },
      { id: nadia, name: "Nadia", archivedAt: null },
    ]);

    const fetched = await getTest(actingAsAcme(), clone.id);
    expect(fetched?.scenario).toBe(source.scenario);
    expect(fetched?.personas.map((named) => named.id)).toEqual([
      omar,
      rita,
      nadia,
    ]);

    // No shared history: the source's two versions stay the source's, and the
    // clone starts with one row of its own.
    const sourceVersions = await versionIdsOf(source.id);
    const cloneVersions = await versionIdsOf(clone.id);
    expect(sourceVersions).toHaveLength(2);
    expect(cloneVersions).toHaveLength(1);
    expect(sourceVersions).not.toContain(cloneVersions[0]);
  });

  it("leaves the source exactly as it was, history included", async () => {
    const before = await versionIdsOf(source.id);

    await cloneTest(actingAsAcme(), source.id);

    expect(await versionIdsOf(source.id)).toEqual(before);
    const fetched = await getTest(actingAsAcme(), source.id);
    expect(fetched?.version).toBe(2);
    expect(fetched?.versionId).toBe(source.versionId);
  });

  it("copies the name verbatim, because a project holds no name uniqueness", async () => {
    const clone = await cloneTest(actingAsAcme(), source.id);
    expect(clone?.name).toBe("Original");

    const page = await listTests(actingAsAcme());
    const sameName = page.items.filter((item) => item.name === "Original");
    expect(sameName.length).toBeGreaterThan(1);
  });

  it("returns nothing for a test the caller could not have fetched", async () => {
    const before = await rowCounts();

    expect(await cloneTest(actingAsGlobex(), source.id)).toBeUndefined();
    expect(await cloneTest(actingInOutbound(), source.id)).toBeUndefined();
    expect(await cloneTest(actingAsAcme(), newId("tst"))).toBeUndefined();

    // No refused clone wrote anything at all.
    expect(await rowCounts()).toEqual(before);
  });

  it("is refused to a viewer", async () => {
    await expect(
      cloneTest(actingAsAcme("viewer"), source.id),
    ).rejects.toThrow(NotPermittedError);
  });

  it("is refused to a credential acting in no project, which has nowhere to put the clone", async () => {
    await expect(
      cloneTest(actingAsWholeCustomer(), source.id),
    ).rejects.toThrow(/project/);

    // The refusal comes before the read, so an id that names nothing gets the
    // same loud answer — never an `undefined` that reads as invisible.
    await expect(
      cloneTest(actingAsWholeCustomer(), newId("tst")),
    ).rejects.toThrow(/project/);
  });
});

describe("deleting a test", () => {
  let doomed: Test;
  /** Its first version, kept aside because deletion must not take it away. */
  let firstVersionId: string;

  beforeAll(async () => {
    const first = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "Doomed",
      personaIds: [rita, nadia],
    });
    firstVersionId = first.versionId;
    const second = await editTest(actingAsAcme(), first.id, {
      scenario: "They want the Friday slot instead.",
    });
    if (second === undefined) throw new Error("the doomed test was not versioned");
    doomed = second;
  });

  it("is refused to a credential acting in no project, like create", async () => {
    await expect(
      deleteTest(actingAsWholeCustomer(), doomed.id),
    ).rejects.toThrow(/project/);

    const stillThere = await getTest(actingAsAcme(), doomed.id);
    expect(stillThere?.id).toBe(doomed.id);
  });

  it("is refused to a viewer", async () => {
    await expect(
      deleteTest(actingAsAcme("viewer"), doomed.id),
    ).rejects.toThrow(NotPermittedError);
  });

  it("succeeds with nothing removed but the test itself, however much names it", async () => {
    const before = await rowCounts();

    const deleted = await deleteTest(actingAsAcme(), doomed.id);

    expect(deleted?.id).toBe(doomed.id);
    expect(deleted?.name).toBe("Doomed");
    expect(deleted?.projectId).toBe(acme.project);
    expect(deleted?.deletedAt).toBeInstanceOf(Date);

    // Nothing blocked the delete — the test names two living personas across
    // two versions — and nothing was taken away: the marker is the whole write,
    // so every version row and every join row is still there.
    expect(await rowCounts()).toEqual(before);
  });

  it("hides it from every fetch and every list", async () => {
    expect(await getTest(actingAsAcme(), doomed.id)).toBeUndefined();
    expect(await getTest(actingAsWholeCustomer(), doomed.id)).toBeUndefined();

    const page = await listTests(actingAsAcme());
    expect(page.items.map((item) => item.id)).not.toContain(doomed.id);
    const wholeCustomer = await listTests(actingAsWholeCustomer());
    expect(wholeCustomer.items.map((item) => item.id)).not.toContain(doomed.id);
  });

  it("keeps every version fetchable by its tstv_ id, with its content and personas", async () => {
    const first = await getTestVersion(actingAsAcme(), firstVersionId);
    expect(first?.testId).toBe(doomed.id);
    expect(first?.version).toBe(1);
    expect(first?.scenario).toBe(rescheduling.scenario);
    expect(first?.personas.map((named) => named.id)).toEqual([rita, nadia]);

    const current = await getTestVersion(actingAsAcme(), doomed.versionId);
    expect(current?.version).toBe(2);
    expect(current?.scenario).toBe("They want the Friday slot instead.");
  });

  it("takes the deleted test out of reach of the other verbs too", async () => {
    expect(await cloneTest(actingAsAcme(), doomed.id)).toBeUndefined();
    expect(
      await editTest(actingAsAcme(), doomed.id, { name: "Back again" }),
    ).toBeUndefined();
  });

  it("deletes only once: a second delete finds nothing", async () => {
    expect(await deleteTest(actingAsAcme(), doomed.id)).toBeUndefined();
  });

  it("keeps the surviving versions invisible to another customer", async () => {
    expect(
      await getTestVersion(actingAsGlobex(), firstVersionId),
    ).toBeUndefined();
    expect(
      await getTestVersion(actingAsGlobex(), doomed.versionId),
    ).toBeUndefined();
  });

  it("returns nothing for another customer's test, and leaves it live", async () => {
    const bystander = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "Bystander",
    });

    expect(await deleteTest(actingAsGlobex(), bystander.id)).toBeUndefined();

    const fetched = await getTest(actingAsAcme(), bystander.id);
    expect(fetched?.id).toBe(bystander.id);
  });

  it("returns nothing to the same customer acting in a sibling project", async () => {
    const bystander = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "Bystander of the sibling project",
    });

    expect(await deleteTest(actingInOutbound(), bystander.id)).toBeUndefined();

    const fetched = await getTest(actingAsAcme(), bystander.id);
    expect(fetched?.id).toBe(bystander.id);
  });
});
