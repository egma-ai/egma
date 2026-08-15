import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cloneGrader,
  createGrader,
  deleteGrader,
  editGrader,
  getGrader,
  IdentityConflictError,
  listGraderVersions,
  listGraders,
  restoreGrader,
  UnprocessableInputError,
  VersionConflictError,
} from "@egma/db";

import type { MigratedDatabase } from "./support/database.ts";
import { actingAsAcme, seedTestFactory } from "./support/test-factory.ts";

/**
 * What a grader reads and which conversations it can score — versioned content,
 * beside the config and for the same reason — and the two lifecycle verbs
 * around it.
 *
 * **The rule this file exists to hold: a change to what a check is made of
 * mints a version, and a change to nothing mints nothing.** Widening what a
 * rubric reads changes what its verdict means, so it earns a version and takes
 * effect from then on. Saving the same set written in a different order is not
 * a change at all, and a history full of edits nobody made is a history nobody
 * reads.
 */

let database: MigratedDatabase;

beforeAll(async () => {
  ({ database } = await seedTestFactory("grader_reads"));
});

afterAll(async () => {
  await database.drop();
});

const rubric = {
  name: "Verified identity first",
  type: "llm_rubric",
  config: { rubric: "The agent verified identity before any balance." },
} as const;

const threshold = {
  name: "Answers inside two seconds",
  type: "metric_threshold",
  config: {
    measure: "turn_response_latency",
    aggregation: "p90",
    comparator: "below",
    threshold: 2_000,
  },
} as const;

describe("what a grader reads", () => {
  it("takes the type's own reads when its author names none", async () => {
    const written = await createGrader(actingAsAcme(), rubric);
    expect(written.reads).toEqual(["transcript"]);

    const measured = await createGrader(actingAsAcme(), threshold);
    expect(measured.reads).toEqual(["measures"]);

    const tools = await createGrader(actingAsAcme(), {
      name: "Booked it",
      type: "tool_calls",
      config: { required: [{ tool: "book_appointment" }] },
    });
    expect(tools.reads).toEqual(["tool_calls"]);
  });

  /**
   * A deterministic type's reads are a fact about what that kind of judgment is
   * made of, not a choice. Silently replacing somebody's set would leave them
   * believing a threshold reads the transcript because they asked it to.
   */
  it("refuses a set a deterministic type does not choose, rather than correcting it", async () => {
    await expect(
      createGrader(actingAsAcme(), { ...threshold, reads: ["transcript"] }),
    ).rejects.toThrow(UnprocessableInputError);

    // Naming exactly the fixed set is accepted, because that is what a form
    // round-tripping what it read sends back.
    const round = await createGrader(actingAsAcme(), {
      ...threshold,
      reads: ["measures"],
    });
    expect(round.reads).toEqual(["measures"]);
  });

  it("lets a rubric's author choose, and answers in the settled order", async () => {
    const written = await createGrader(actingAsAcme(), {
      ...rubric,
      reads: ["measures", "transcript"],
    });

    expect(written.reads).toEqual(["transcript", "measures"]);
  });

  it("refuses a set that names nothing, because it could never fire", async () => {
    await expect(
      createGrader(actingAsAcme(), { ...rubric, reads: [] }),
    ).rejects.toThrow(UnprocessableInputError);
    await expect(
      createGrader(actingAsAcme(), { ...rubric, modalities: [] }),
    ).rejects.toThrow(UnprocessableInputError);
  });

  it("scores both modalities unless somebody narrows it", async () => {
    const both = await createGrader(actingAsAcme(), rubric);
    expect(both.modalities).toEqual(["voice", "chat"]);

    const narrowed = await createGrader(actingAsAcme(), {
      ...rubric,
      modalities: ["voice"],
    });
    expect(narrowed.modalities).toEqual(["voice"]);
  });
});

describe("editing what a grader reads or scores", () => {
  it("mints a version, because it changes what a verdict means", async () => {
    const written = await createGrader(actingAsAcme(), rubric);

    const widened = await editGrader(actingAsAcme(), written.id, {
      reads: ["transcript", "outcome"],
    });
    expect(widened?.version).toBe(2);
    expect(widened?.reads).toEqual(["transcript", "outcome"]);

    const narrowed = await editGrader(actingAsAcme(), written.id, {
      modalities: ["chat"],
    });
    expect(narrowed?.version).toBe(3);

    const history = await listGraderVersions(actingAsAcme(), written.id);
    expect(history?.map((version) => version.version)).toEqual([3, 2, 1]);
    // The version left behind is never touched: a verdict that named it must
    // still say what decided it.
    expect(history?.at(-1)?.reads).toEqual(["transcript"]);
    expect(history?.at(-1)?.modalities).toEqual(["voice", "chat"]);
  });

  /**
   * The other half of the same rule. Two orders of one set are one set, and a
   * save that changed nothing must write nothing at all — not a version, and
   * not the row's modified time either.
   */
  it("writes nothing at all when the sets are the same in another order", async () => {
    const written = await createGrader(actingAsAcme(), {
      ...rubric,
      reads: ["transcript", "outcome"],
      modalities: ["voice", "chat"],
    });

    const again = await editGrader(actingAsAcme(), written.id, {
      reads: ["outcome", "transcript"],
      modalities: ["chat", "voice"],
      config: rubric.config,
    });

    expect(again?.version).toBe(1);
    expect(again?.versionId).toBe(written.versionId);
    expect(again?.revision).toBe(written.revision);
    expect(again?.updatedAt.getTime()).toBe(written.updatedAt.getTime());

    const history = await listGraderVersions(actingAsAcme(), written.id);
    expect(history).toHaveLength(1);
  });

  /**
   * The live half and the versioned half move apart, so a rename must not make
   * a rubric edit somebody is still typing stale, and the reverse.
   */
  it("refuses a stale live edit and a stale versioned edit apart from each other", async () => {
    const written = await createGrader(actingAsAcme(), rubric);

    await editGrader(actingAsAcme(), written.id, { priority: "P2" });

    // The revision moved; the version did not.
    await expect(
      editGrader(
        actingAsAcme(),
        written.id,
        { name: "Renamed" },
        { expectedRevision: written.revision },
      ),
    ).rejects.toThrow(IdentityConflictError);

    // And a content edit written against the version it read still lands.
    const versioned = await editGrader(
      actingAsAcme(),
      written.id,
      { config: { rubric: "Something else entirely." } },
      { expectedVersionId: written.versionId },
    );
    expect(versioned?.version).toBe(2);

    await expect(
      editGrader(
        actingAsAcme(),
        written.id,
        { config: { rubric: "A third thing." } },
        { expectedVersionId: written.versionId },
      ),
    ).rejects.toThrow(VersionConflictError);
  });
});

describe("cloning a grader", () => {
  it("copies the settings and the current content, and shares no history", async () => {
    const source = await createGrader(actingAsAcme(), {
      ...rubric,
      priority: "P1",
      scope: "both",
      productionSampleRate: 20,
      modalities: ["voice"],
    });
    await editGrader(actingAsAcme(), source.id, {
      config: { rubric: "Two facts before any balance." },
    });

    const copy = await cloneGrader(actingAsAcme(), source.id, {
      name: "Identity, stricter",
    });

    expect(copy?.id).not.toBe(source.id);
    expect(copy?.name).toBe("Identity, stricter");
    expect(copy?.type).toBe("llm_rubric");
    expect(copy?.priority).toBe("P1");
    expect(copy?.scope).toBe("both");
    expect(copy?.productionSampleRate).toBe(20);
    expect(copy?.modalities).toEqual(["voice"]);
    expect(copy?.config).toEqual({ rubric: "Two facts before any balance." });

    // A new identity starts at one, whatever the source had reached: two
    // identities sharing a past would give "what did this check mean then" two
    // answers.
    expect(copy?.version).toBe(1);
    const history = await listGraderVersions(actingAsAcme(), copy?.id ?? "");
    expect(history).toHaveLength(1);

    // And editing the copy leaves the source exactly where it was.
    await editGrader(actingAsAcme(), copy?.id ?? "", {
      config: { rubric: "Three facts." },
    });
    const unchanged = await getGrader(actingAsAcme(), source.id);
    expect(unchanged?.config).toEqual({
      rubric: "Two facts before any balance.",
    });
  });
});

describe("archiving and restoring a grader", () => {
  it("takes it off the active list, keeps it readable, and puts it back", async () => {
    const written = await createGrader(actingAsAcme(), rubric);

    const archived = await deleteGrader(actingAsAcme(), written.id, {
      expectedRevision: written.revision,
    });
    expect(archived?.id).toBe(written.id);

    // Gone from what applies, and gone from what a resolver would judge with.
    const active = await listGraders(actingAsAcme());
    expect(active.items.map((grader) => grader.id)).not.toContain(written.id);
    expect(await getGrader(actingAsAcme(), written.id)).toBeUndefined();

    // Still readable when somebody asks for it by name, and its history is
    // intact — a run pinned this, and a verdict names it.
    const read = await getGrader(actingAsAcme(), written.id, {
      includeArchived: true,
    });
    expect(read?.archivedAt).not.toBeNull();
    expect(await listGraderVersions(actingAsAcme(), written.id)).toHaveLength(1);

    const archivedList = await listGraders(actingAsAcme(), { archived: true });
    expect(archivedList.items.map((grader) => grader.id)).toContain(written.id);

    const restored = await restoreGrader(actingAsAcme(), written.id, {
      expectedRevision: read?.revision ?? "",
    });
    expect(restored?.archivedAt).toBeNull();
    expect(
      (await listGraders(actingAsAcme())).items.map((grader) => grader.id),
    ).toContain(written.id);
  });

  it("refuses an archive written against a revision the grader has left behind", async () => {
    const written = await createGrader(actingAsAcme(), rubric);
    await editGrader(actingAsAcme(), written.id, { priority: "P2" });

    await expect(
      deleteGrader(actingAsAcme(), written.id, {
        expectedRevision: written.revision,
      }),
    ).rejects.toThrow(IdentityConflictError);

    expect(await getGrader(actingAsAcme(), written.id)).toBeDefined();
  });
});
