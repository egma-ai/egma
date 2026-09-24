import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTest,
  editTest,
  getTest,
} from "@egma/db";

import { type MigratedDatabase } from "./support/database.ts";
import {
  actingAsAcme,
  rescheduling,
  rowCounts,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * Expected behaviors retain order and create a version when changed.
 * Raw SQL creates legacy behavior objects to test read compatibility.
 */

let database: MigratedDatabase;
/** The caller every authored fixture names, because a test says who calls. */
let rita: string;

beforeAll(async () => {
  ({ database, rita } = await seedTestFactory("tests_behaviors"));
});

afterAll(async () => {
  await database.drop();
});

describe("a test's expected behaviors", () => {
  it("mint a version when two of them swap places", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [rita],
      expectedBehaviors: ["verifies who it is speaking to", "thanks the caller"],
    });

    const edited = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: created.versionId,
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

    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });
    const written = await rowCounts();

    await expect(
      editTest(actingAsAcme(), created.id, {
        expectedVersionId: created.versionId,
        expectedBehaviors: [],
      }),
    ).rejects.toThrow(/at least one expected behavior/);

    expect(await rowCounts()).toEqual(written);
    expect((await getTest(actingAsAcme(), created.id))?.version).toBe(1);
  });

  it("cannot be a sentence that says nothing", async () => {
    await expect(
      createTest(actingAsAcme(), {
        ...rescheduling,
        personaIds: [rita],
        expectedBehaviors: ["   "],
      }),
    ).rejects.toThrow(/needs to say something/);
  });

  /**
   * A version frozen while behaviors carried priorities still says what it said:
   * the sentence. The priority is read past rather than migrated away, because a
   * version a run can pin is never rewritten — which is the whole reason runs
   * pin versions.
   */
  it("read a version stored with priorities as the sentences it holds", async () => {
    const created = await createTest(actingAsAcme(), { ...rescheduling, personaIds: [rita] });

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
      expectedVersionId: created.versionId,
      scenario: "They want to move Thursday afternoon.",
    });
    expect(edited?.version).toBe(2);
    expect(edited?.expectedBehaviors).toEqual(["confirms the new time back"]);
  });
});
