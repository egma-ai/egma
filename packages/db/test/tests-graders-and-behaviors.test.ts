import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cloneTest,
  createTest,
  deleteGrader,
  editGrader,
  editTest,
  getTest,
  getTestVersion,
  listTests,
} from "@egma/db";

import { type MigratedDatabase } from "./support/database.ts";
import {
  acme,
  actingAsAcme,
  actingAsGlobex,
  rescheduling,
  rowCounts,
  seedGrader,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * Two things a test version holds as content: the graders it names, and its
 * expected behaviors — an ordered list of plain sentences. Both mint a version
 * when they change, and both round-trip in the order they were authored.
 *
 * The graders themselves arrive through their own factory, which has its own
 * tests: they are an input to this file, not what it is checking. Raw SQL
 * appears once, in the version somebody wrote while behaviors carried
 * priorities, which no seam can write any more.
 */

let database: MigratedDatabase;
/** Three of Acme's graders, for the arrays an edit moves between. */
let disclosure: string;
let refundTool: string;
let latency: string;

beforeAll(async () => {
  ({ database } = await seedTestFactory("tests_graders"));

  disclosure = await seedGrader(actingAsAcme(), "States the recording notice");
  refundTool = await seedGrader(actingAsAcme(), "Refunds through the tool");
  latency = await seedGrader(actingAsAcme(), "Answers within two seconds");
});

afterAll(async () => {
  await database.drop();
});

/**
 * The join rows of one version, read raw. Nothing else can show that an old
 * version's rows were left alone rather than rewritten in place, because the
 * seam only ever answers with the version it was asked for.
 */
async function gradersOn(
  versionId: string,
): Promise<{ graderId: string; position: number }[]> {
  const { rows } = await database.sql<{ grader_id: string; position: number }>(
    `select grader_id, position
       from test_grader
      where test_version_id = $1
      order by position`,
    [versionId],
  );
  return rows.map((row) => ({
    graderId: row.grader_id,
    position: row.position,
  }));
}

describe("the graders a test names", () => {
  it("round-trip in the authored order through create, fetch and the frozen version", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      graderIds: [refundTool, disclosure, latency],
    });

    expect(created.graders.map((named) => named.id)).toEqual([
      refundTool,
      disclosure,
      latency,
    ]);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.graders).toEqual([
      { id: refundTool, name: "Refunds through the tool", deletedAt: null },
      { id: disclosure, name: "States the recording notice", deletedAt: null },
      { id: latency, name: "Answers within two seconds", deletedAt: null },
    ]);

    const frozen = await getTestVersion(actingAsAcme(), created.versionId);
    expect(frozen?.graders.map((named) => named.id)).toEqual([
      refundTool,
      disclosure,
      latency,
    ]);

    // And a page carries them on every row, in one read rather than one per row.
    const page = await listTests(actingAsAcme(), { limit: 200 });
    const listed = page.items.find((item) => item.id === created.id);
    expect(listed?.graders.map((named) => named.id)).toEqual([
      refundTool,
      disclosure,
      latency,
    ]);
  });

  it("is empty when the test names none, because the project's graders judge it anyway", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);

    expect(created.graders).toEqual([]);
    expect((await getTest(actingAsAcme(), created.id))?.graders).toEqual([]);
  });

  it("versions on a change to the array alone, exactly as the personas do", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      graderIds: [disclosure],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      graderIds: [disclosure, refundTool],
    });

    expect(edited?.version).toBe(2);
    expect(edited?.scenario).toBe(rescheduling.scenario);
    expect(edited?.graders.map((named) => named.id)).toEqual([
      disclosure,
      refundTool,
    ]);

    // The version left behind keeps the rows it was written with.
    expect(await gradersOn(created.versionId)).toEqual([
      { graderId: disclosure, position: 1 },
    ]);
    if (edited?.versionId === undefined) throw new Error("no second version");
    expect(await gradersOn(edited.versionId)).toEqual([
      { graderId: disclosure, position: 1 },
      { graderId: refundTool, position: 2 },
    ]);
  });

  it("counts the authored order as content, so reordering versions", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      graderIds: [disclosure, refundTool],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      graderIds: [refundTool, disclosure],
    });

    expect(edited?.version).toBe(2);
    expect(edited?.graders.map((named) => named.id)).toEqual([
      refundTool,
      disclosure,
    ]);
  });

  it("does nothing for a save that names the same graders in the same order", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      graderIds: [disclosure, refundTool],
    });
    const before = await rowCounts();

    const saved = await editTest(actingAsAcme(), created.id, {
      graderIds: [disclosure, refundTool],
    });

    expect(saved?.version).toBe(1);
    expect(saved?.versionId).toBe(created.versionId);
    expect(await rowCounts()).toEqual(before);
  });

  it("keeps the array the version already named when the field is absent", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      graderIds: [latency],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      scenario: "They want the Monday slot instead.",
    });

    expect(edited?.version).toBe(2);
    expect(edited?.graders.map((named) => named.id)).toEqual([latency]);
    if (edited?.versionId === undefined) throw new Error("no second version");
    expect(await gradersOn(edited.versionId)).toEqual([
      { graderId: latency, position: 1 },
    ]);
  });

  it("clears the array with an empty list, and that is a version too", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      graderIds: [latency],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      graderIds: [],
    });

    expect(edited?.version).toBe(2);
    expect(edited?.graders).toEqual([]);
    if (edited?.versionId === undefined) throw new Error("no second version");
    expect(await gradersOn(edited.versionId)).toEqual([]);
  });

  it("names its graders by identity, so editing one versions no test", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      graderIds: [latency],
    });

    const sharpened = await editGrader(actingAsAcme(), latency, {
      config: { banned: [{ text: "I promise" }, { text: "guaranteed" }] },
    });
    expect(sharpened?.version).toBe(2);

    const fetched = await getTest(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(1);
    expect(fetched?.versionId).toBe(created.versionId);
    expect(fetched?.graders.map((named) => named.id)).toEqual([latency]);
  });
});

describe("a test naming a grader it may not have", () => {
  it("is refused when the grader does not exist, and leaves nothing", async () => {
    const before = await rowCounts();

    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        graderIds: [newId("grd")],
      }),
    ).rejects.toThrow(/no grader/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused when the id is not a grader's at all", async () => {
    await expect(
      createTest(actingAsAcme(), { ...rescheduling, graderIds: [newId("prs")] }),
    ).rejects.toThrow(/grader id/);
  });

  it("is refused when the same grader is named twice", async () => {
    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        graderIds: [disclosure, disclosure],
      }),
    ).rejects.toThrow(/twice/);
  });

  it("is refused when the grader belongs to another project, and leaves nothing", async () => {
    const elsewhere = await seedGrader(actingAsGlobex(), "Globex's own");
    const before = await rowCounts();

    await expect(
      createTest(actingAsAcme(), { ...rescheduling, graderIds: [elsewhere] }),
    ).rejects.toThrow(/no grader/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused when the grader is deleted, and leaves nothing", async () => {
    const retired = await seedGrader(actingAsAcme(), "Retired Rex");
    await deleteGrader(actingAsAcme(), retired);

    const before = await rowCounts();

    await expect(
      createTest(actingAsAcme(), { ...rescheduling, graderIds: [retired] }),
    ).rejects.toThrow(/is deleted/);

    expect(await rowCounts()).toEqual(before);
  });

  it("validates an edited array exactly as a created one, and versions nothing", async () => {
    const created = await createTest(actingAsAcme(), rescheduling);
    const before = await rowCounts();

    await expect(
      editTest(actingAsAcme(), created.id, { graderIds: [newId("grd")] }),
    ).rejects.toThrow(/no grader/);

    expect(await rowCounts()).toEqual(before);
    expect((await getTest(actingAsAcme(), created.id))?.version).toBe(1);
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

describe("cloning a test that names graders", () => {
  it("copies the array in the same order into a fresh version 1", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      expectedBehaviors: ["verifies who it is speaking to", "thanks the caller"],
      graderIds: [latency, disclosure],
    });

    const clone = await cloneTest(actingAsAcme(), created.id);

    expect(clone?.id).not.toBe(created.id);
    expect(clone?.version).toBe(1);
    expect(clone?.projectId).toBe(acme.project);
    expect(clone?.graders.map((named) => named.id)).toEqual([
      latency,
      disclosure,
    ]);
    expect(clone?.expectedBehaviors).toEqual([
      "verifies who it is speaking to",
      "thanks the caller",
    ]);
  });
});
