import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cloneTest,
  createTest,
  editTest,
  getTest,
  getTestVersion,
  listTests,
} from "@egma/db";

import { type MigratedDatabase } from "./support/database.ts";
import {
  acme,
  actingAsAcme,
  rescheduling,
  rowCounts,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * What a test version holds as content, now that it holds one thing fewer: the
 * scenario, the expected behaviors — an ordered list of plain sentences — and
 * the mock overrides. Behaviors mint a version when they change and round-trip
 * in the order they were authored.
 *
 * **The graders a version named left with the junction.** A test names none, so
 * there is nothing here to round-trip and no array for an edit to move between;
 * which graders judge a simulation is the project's running copies and their
 * scope, tested where those live. What remains of that half is the case below
 * proving a read carries no graders at all — the removal, asserted rather than
 * assumed from a type that no longer has the field.
 *
 * Raw SQL appears once, in the version somebody wrote while behaviors carried
 * priorities, which no seam can write any more.
 */

let database: MigratedDatabase;

beforeAll(async () => {
  ({ database } = await seedTestFactory("tests_behaviors"));
});

afterAll(async () => {
  await database.drop();
});

describe("a test version's content", () => {
  /**
   * The junction is gone from the schema, so this is what is left to check: no
   * read of a test hands back graders, at any of the four grains a test is read
   * at. A field quietly still being answered would mean something upstream was
   * still deciding grading from test content.
   */
  it("names no graders, at every grain a test is read at", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    const fetched = await getTest(actingAsAcme(), created.id);
    const frozen = await getTestVersion(actingAsAcme(), created.versionId);
    const page = await listTests(actingAsAcme(), { limit: 200 });
    const listed = page.items.find((item) => item.id === created.id);

    for (const read of [created, fetched, frozen, listed]) {
      expect(read).toBeDefined();
      expect(read).not.toHaveProperty("graders");
    }

    // And the table itself is not there to be asked.
    await expect(
      database.sql("select 1 from test_grader limit 1"),
    ).rejects.toThrow(/test_grader/);
  });

  /**
   * A caller still sending last month's field is a compile error and never a
   * silent write, so what has to hold at run time is only that nothing is
   * stored for it: the version's content is the three fields it says it is.
   */
  it("stores the scenario, the behaviors and the overrides, and nothing else", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    const { rows } = await database.sql<{ keys: string[] }>(
      `select array(select jsonb_object_keys(content) order by 1) as keys
         from test_version where id = $1`,
      [created.versionId],
    );

    expect(rows[0]?.keys).toEqual([
      "expectedBehaviors",
      "mockOverrides",
      "scenario",
    ]);
  });
});

describe("a test's expected behaviors", () => {
  it("round-trip as the plain sentences they were written as", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.expectedBehaviors).toEqual(rescheduling.expectedBehaviors);

    const frozen = await getTestVersion(actingAsAcme(), created.versionId);
    expect(frozen?.expectedBehaviors).toEqual(rescheduling.expectedBehaviors);
  });

  /**
   * Order is content, and it is load-bearing rather than tidy: a verdict row
   * names its assertion by position in the pinned version, so moving a sentence
   * moves what every row about it meant. Minting a version is what keeps the old
   * rows readable.
   */
  it("mint a version when one is reworded, and nothing when the list is the same", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      expectedBehaviors: ["verifies who it is speaking to", "thanks the caller"],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      expectedBehaviors: [
        "verifies who it is speaking to",
        "thanks the caller by name",
      ],
    });

    expect(edited?.version).toBe(2);
    expect(edited?.expectedBehaviors).toEqual([
      "verifies who it is speaking to",
      "thanks the caller by name",
    ]);

    const saved = await editTest(actingAsAcme(), created.id, {
      expectedBehaviors: [
        "verifies who it is speaking to",
        "thanks the caller by name",
      ],
    });
    expect(saved?.version).toBe(2);
  });

  it("mint a version when two of them swap places", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      expectedBehaviors: ["verifies who it is speaking to", "thanks the caller"],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      expectedBehaviors: ["thanks the caller", "verifies who it is speaking to"],
    });

    expect(edited?.version).toBe(2);
  });

  /**
   * The falsifiability rule, and now the whole of it: with priorities retired
   * there is no way left to demote a test into never being able to fail, so
   * non-empty is all this has to hold.
   */
  it("cannot be empty, on a create or on an edit, and the refusal writes nothing", async () => {
    const before = await rowCounts();

    await expect(
      createTest(actingAsAcme(), { ...rescheduling, expectedBehaviors: [] }),
    ).rejects.toThrow(/at least one expected behavior/);

    expect(await rowCounts()).toEqual(before);

    const created = await createTest(actingAsAcme(), rescheduling);
    const written = await rowCounts();

    await expect(
      editTest(actingAsAcme(), created.id, { expectedBehaviors: [] }),
    ).rejects.toThrow(/at least one expected behavior/);

    expect(await rowCounts()).toEqual(written);
    expect((await getTest(actingAsAcme(), created.id))?.version).toBe(1);
  });

  it("cannot be a sentence that says nothing", async () => {
    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        expectedBehaviors: ["   "],
      }),
    ).rejects.toThrow(/needs to say something/);
  });

  /**
   * The retired shape, named rather than reported as a blank sentence. A writer
   * still sending last month's body should be told what changed, not sent to
   * look at their own words for a problem that is in the envelope.
   */
  it("refuse the retired priority shape by name", async () => {
    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        expectedBehaviors: [
          { behavior: "confirms the new time back", priority: "P0" },
        ] as unknown as readonly string[],
      }),
    ).rejects.toThrow(/plain sentence now/);
  });

  /**
   * A version frozen while behaviors carried priorities still says what it said:
   * the sentence. The priority is read past rather than migrated away, because a
   * version a run can pin is never rewritten — which is the whole reason runs
   * pin versions.
   */
  it("read a version stored with priorities as the sentences it holds", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    // Raw SQL on purpose: this is the shape every version held between the
    // grading effort and the redesign, and no seam can write it any more.
    await database.sql(
      `update test_version
          set content = '{"scenario": "They want to move Thursday.", "expectedBehaviors": [{"behavior": "confirms the new time back", "priority": "P2"}]}'::jsonb
        where id = $1`,
      [created.versionId],
    );

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.expectedBehaviors).toEqual(["confirms the new time back"]);

    // And the next edit writes the shape egma writes now, without the caller
    // having said anything about behaviors at all.
    const edited = await editTest(actingAsAcme(), created.id, {
      scenario: "They want to move Thursday afternoon.",
    });
    expect(edited?.version).toBe(2);
    expect(edited?.expectedBehaviors).toEqual(["confirms the new time back"]);
  });

  /** And the pre-priority shape, which is the shape again, still reads. */
  it("read a version stored as bare strings, which is the shape once more", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    await database.sql(
      `update test_version
          set content = '{"scenario": "They want to move Thursday.", "expectedBehaviors": ["confirms the new time back"]}'::jsonb
        where id = $1`,
      [created.versionId],
    );

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.expectedBehaviors).toEqual(["confirms the new time back"]);
  });
});

describe("cloning a test", () => {
  it("copies the behaviors in the same order into a fresh version 1", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      expectedBehaviors: ["verifies who it is speaking to", "thanks the caller"],
    });

    const clone = await cloneTest(actingAsAcme(), created.id);

    expect(clone?.id).not.toBe(created.id);
    expect(clone?.version).toBe(1);
    expect(clone?.projectId).toBe(acme.project);
    expect(clone?.expectedBehaviors).toEqual([
      "verifies who it is speaking to",
      "thanks the caller",
    ]);
    expect(clone).not.toHaveProperty("graders");
  });
});
