import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deleteGrader,
  editGrader,
  getGrader,
  getGraderVersion,
  listGraders,
  NotPermittedError,
  PREDEFINED_GRADERS,
  useLibraryEntry,
  type UseLibraryEntry,
} from "@egma/db";

import { type MigratedDatabase } from "./support/database.ts";
import {
  acme,
  actingAsAcme,
  actingAsGlobex,
  rowCounts,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * Editing a grader, listing graders, and deleting one — through the factory
 * functions only, like the create and fetch tests before them.
 *
 * The line every test in this file draws is between what a verdict was decided
 * by and where the decision applies. Tightening a bound changes what a verdict
 * means, so it mints a version and the old one stays exactly readable; making a
 * blocker into a diagnostic rewrites no verdict, so it writes in place and is
 * true the moment it returns.
 *
 * **"Rewrites no verdict" is the whole claim, and it is narrower than it
 * sounds.** Turning `required` off changes what those verdicts *add up to*: the
 * fold reads the flag as it stands, so a run that failed on one grader alone
 * reads as passed from that moment. That is the flag's job and it is proved in
 * `apps/grader/test/lanes.test.ts`. Nothing in this file may be read as saying
 * a live setting cannot reach a page about the past — only that it never
 * touches a row.
 *
 * **The filled-in values are all a copy holds, and they are checked against the
 * entry it points at** — read live, on every edit, which is the same check Use
 * made. A copy cannot edit its way into holding a value the form never asked
 * for, and it cannot edit its way to a different definition either: the pointer
 * and the type are set at Use time and are not on the change surface at all.
 */

let database: MigratedDatabase;

beforeAll(async () => {
  ({ database } = await seedTestFactory("graders_edit"));
});

afterAll(async () => {
  await database.drop();
});

/**
 * A copy of the `latency` entry, because a bound is the thing teams actually
 * tighten — and the only entry v0 ships whose form asks for anything at all.
 */
const latency = {
  libraryId: PREDEFINED_GRADERS.latency,
  name: "Answers within two seconds",
  description: "The number the support team argues about",
  params: { metric: "turn_response_latency", bound: 2000 },
} as const satisfies UseLibraryEntry;

/** What that Use writes: one filled-in set, which is one assertion. */
const latencyConfig = {
  assertions: [{ metric: "turn_response_latency", bound: 2000 }],
} as const;

/** A bound somewhere else, for the edits that mean to change something. */
function boundedAt(bound: number) {
  return { assertions: [{ metric: "turn_response_latency", bound }] };
}

/** The same judgment, said in a way that reorders nothing and changes nothing. */
const sameLatencyConfig = {
  assertions: [{ bound: 2000, metric: "turn_response_latency" }],
} as const;

describe("editing what a grader judges by", () => {
  it("creates version 2, moves the pointer, and leaves version 1 exactly where it was", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);

    const edited = await editGrader(actingAsAcme(), created.id, {
      config: boundedAt(1500),
    });

    expect(edited?.version).toBe(2);
    expect(edited?.versionId).not.toBe(created.versionId);
    expect(edited?.config).toEqual(boundedAt(1500));

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(2);
    expect(fetched?.versionId).toBe(edited?.versionId);
    expect(fetched?.config).toEqual(boundedAt(1500));

    // Version 1 is untouched, which is what makes last week's verdict still
    // mean what it meant when it was written.
    const frozen = await getGraderVersion(actingAsAcme(), created.versionId);
    expect(frozen?.version).toBe(1);
    expect(frozen?.graderId).toBe(created.id);
    expect(frozen?.type).toBe("code");
    expect(frozen?.config).toEqual(latencyConfig);
    expect(frozen?.judgeModel).toBeNull();
    expect(frozen?.createdAt).toBeInstanceOf(Date);
  });

  it("does nothing for a byte-identical save, and returns the current version", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);
    const before = await rowCounts();

    // The same judgment with the fields written in another order: jsonb decides
    // key order on the way in, so the answer has to come from comparing values.
    const saved = await editGrader(actingAsAcme(), created.id, {
      config: sameLatencyConfig,
    });

    expect(saved?.version).toBe(1);
    expect(saved?.versionId).toBe(created.versionId);
    expect(await rowCounts()).toEqual(before);

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.updatedAt.getTime()).toBe(created.updatedAt.getTime());
  });

  /**
   * Assertions compare **in order and by position**, because position is what a
   * verdict row keys an assertion by: swapping two bounds is a different grader
   * from a reader's point of view even though the same two checks are made.
   */
  it("counts an added assertion as content, and a reordered pair as different content", async () => {
    const created = await useLibraryEntry(actingAsAcme(), {
      ...latency,
      name: "Two bounds at once",
    });

    const grown = await editGrader(actingAsAcme(), created.id, {
      config: {
        assertions: [
          { metric: "turn_response_latency", bound: 2000 },
          { metric: "first_response_latency", bound: 900 },
        ],
      },
    });
    expect(grown?.version).toBe(2);

    const before = await rowCounts();
    const saved = await editGrader(actingAsAcme(), created.id, {
      config: {
        // The same two checks, each written with its keys the other way round:
        // jsonb decides key order on the way in, so the answer has to come from
        // comparing values.
        assertions: [
          { bound: 2000, metric: "turn_response_latency" },
          { bound: 900, metric: "first_response_latency" },
        ],
      },
    });
    expect(saved?.version).toBe(2);
    expect(await rowCounts()).toEqual(before);

    const swapped = await editGrader(actingAsAcme(), created.id, {
      config: {
        assertions: [
          { metric: "first_response_latency", bound: 900 },
          { metric: "turn_response_latency", bound: 2000 },
        ],
      },
    });
    expect(swapped?.version).toBe(3);
  });

  it("requires the exact cataloged model on model-judged versions", async () => {
    const created = await useLibraryEntry(actingAsAcme(), {
      libraryId: PREDEFINED_GRADERS.expectedBehaviors,
    });

    const same = await editGrader(actingAsAcme(), created.id, {
      judgeModel: { provider: "openai", model: "gpt-4o-mini" },
    });
    expect(same?.version).toBe(1);
    expect(same?.judgeModel).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });

    await expect(
      editGrader(actingAsAcme(), created.id, { judgeModel: null }),
    ).rejects.toThrow(/cannot be cleared/u);
    await expect(
      editGrader(actingAsAcme(), created.id, {
        judgeModel: { provider: "openai", model: "gpt-4.1-mini" },
      }),
    ).rejects.toThrow(/supported openai llm model/u);
  });

  it("numbers each edit after the last, and keeps every version fetchable by its grv_ id", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);
    const second = await editGrader(actingAsAcme(), created.id, {
      config: boundedAt(1500),
    });
    const third = await editGrader(actingAsAcme(), created.id, {
      config: boundedAt(1200),
    });

    expect(second?.version).toBe(2);
    expect(third?.version).toBe(3);
    expect((await getGrader(actingAsAcme(), created.id))?.version).toBe(3);

    const first = await getGraderVersion(actingAsAcme(), created.versionId);
    expect(first?.config).toEqual(latencyConfig);

    if (second?.versionId === undefined) throw new Error("no second version");
    const middle = await getGraderVersion(actingAsAcme(), second.versionId);
    expect(middle?.version).toBe(2);
    expect(middle?.config).toEqual(boundedAt(1500));
  });

  /**
   * An edit is checked against the entry this copy points at, read live — the
   * same check Use made. So there is no way to edit a copy into holding values
   * its form never asked for, which is what would otherwise turn a grader into
   * one judging by less than somebody wrote down.
   */
  it("holds an edited config to what the entry this copy points at asks for", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);

    await expect(
      editGrader(actingAsAcme(), created.id, {
        config: { assertions: [{ rubric: "was it fast enough" }] } as never,
      }),
    ).rejects.toThrow(/does not ask for/);

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(1);
    expect(fetched?.config).toEqual(latencyConfig);
  });

  /**
   * **The form filled in once is what a screen sends, and it means what it
   * means on a Use.** `params` is the entry's questions answered — one set,
   * which is one assertion — so the door that made a copy and the door that
   * changes one send the same shape and go through the same check. Anything
   * else would be a browser page holding its own idea of what a bound is.
   */
  it("takes the entry's form filled in, exactly as Use takes it", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);

    const edited = await editGrader(actingAsAcme(), created.id, {
      params: { metric: "turn_response_latency", bound: 1500 },
    });

    expect(edited?.version).toBe(2);
    expect(edited?.config).toEqual(boundedAt(1500));

    // And it is checked against the entry this copy points at, in the entry's
    // own words — the same refusal Use answers with.
    await expect(
      editGrader(actingAsAcme(), created.id, {
        params: { metric: "turn_response_latency", bound: 1500, aggregation: "p90" },
      }),
    ).rejects.toThrow(/does not ask for/);
  });

  /**
   * **One filled-in set cannot say two assertions, so it is refused rather than
   * allowed to truncate.**
   *
   * `params` is the form asked once. On a copy holding one set — every copy the
   * product can make today — replacing is complete and nothing is lost. On a
   * copy holding two it is a silent truncation twice over: the second bound
   * stops being judged, and the edit mints a version recording the loss as
   * though somebody had asked for it. Nothing outside this module can build
   * such a copy yet, which is exactly why the door is shut now: re-grade and
   * custom authoring are what make one arrive.
   */
  it("refuses one filled-in set for a copy that holds more than one assertion", async () => {
    const created = await useLibraryEntry(actingAsAcme(), {
      ...latency,
      name: "Two bounds, one form",
    });
    const grown = await editGrader(actingAsAcme(), created.id, {
      config: {
        assertions: [
          { metric: "turn_response_latency", bound: 2000 },
          { metric: "first_response_latency", bound: 900 },
        ],
      },
    });
    expect(grown?.version).toBe(2);

    await expect(
      editGrader(actingAsAcme(), created.id, {
        params: { metric: "turn_response_latency", bound: 1500 },
      }),
    ).rejects.toThrow(/config/);

    // Both bounds still there, and no version minted by the refusal.
    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(2);
    expect(fetched?.config.assertions).toHaveLength(2);

    // And the whole list, said as the whole list, goes through.
    const narrowed = await editGrader(actingAsAcme(), created.id, {
      config: { assertions: [{ metric: "turn_response_latency", bound: 1500 }] },
    });
    expect(narrowed?.version).toBe(3);
    expect(narrowed?.config.assertions).toHaveLength(1);
  });

  /**
   * The mirror of the "needs at least one" rule, which the module promised and
   * did not enforce: an entry that asks nothing must hold none. An empty set of
   * answers passes every rule about keys and stores an assertion holding
   * nothing — a row the Running graders screen counts and nothing ever judges.
   */
  it("refuses an empty set of values on an entry that asks nothing", async () => {
    const behaviors = await useLibraryEntry(actingAsAcme(), {
      libraryId: PREDEFINED_GRADERS.expectedBehaviors,
      name: "A second opinion on the behaviors",
    });
    expect(behaviors.config).toEqual({ assertions: [] });

    await expect(
      editGrader(actingAsAcme(), behaviors.id, { params: {} }),
    ).rejects.toThrow(/asks for nothing/);

    const fetched = await getGrader(actingAsAcme(), behaviors.id);
    expect(fetched?.config).toEqual({ assertions: [] });
    expect(fetched?.version).toBe(1);
  });

  /**
   * Two names for one thing, so exactly one may be used. Ranking them would
   * quietly decide which of two lists somebody meant, and the only honest
   * answer to that is to ask.
   */
  it("refuses an edit that says its values twice", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);

    await expect(
      editGrader(actingAsAcme(), created.id, {
        params: { metric: "turn_response_latency", bound: 1500 },
        config: boundedAt(1200),
      }),
    ).rejects.toThrow(/once/);

    expect((await getGrader(actingAsAcme(), created.id))?.version).toBe(1);
  });

  /**
   * The pointer and the type are set at Use time and are not on the change
   * surface at all: every version behind a copy holds values its type shapes, so
   * a copy that could change either would be a different grader wearing the old
   * one's history.
   */
  it("cannot be edited onto a different library entry", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);

    await editGrader(actingAsAcme(), created.id, {
      libraryId: PREDEFINED_GRADERS.expectedBehaviors,
      type: "llm_as_judge",
    } as never);

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.libraryId).toBe(PREDEFINED_GRADERS.latency);
    expect(fetched?.type).toBe("code");
  });

  it("is refused to a viewer, per the permission table", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);

    await expect(
      editGrader(actingAsAcme("viewer"), created.id, {
        config: boundedAt(1),
      }),
    ).rejects.toThrow(NotPermittedError);
  });

  it("returns nothing for a version id nothing carries", async () => {
    expect(
      await getGraderVersion(actingAsAcme(), newId("grv")),
    ).toBeUndefined();
  });
});

describe("changing where a grader applies and how loudly", () => {
  it("creates no version and reads back immediately", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);
    const before = await rowCounts();

    const settled = await editGrader(actingAsAcme(), created.id, {
      required: false,
      scope: "both",
      productionSampleRate: 5,
    });

    // A blocker turned into a diagnostic: it still judges and is still shown,
    // and it can no longer fail anything. Nothing already judged changes, which
    // is why no version was minted.
    expect(settled?.required).toBe(false);
    expect(settled?.scope).toBe("both");
    expect(settled?.productionSampleRate).toBe(5);
    expect(settled?.version).toBe(1);
    expect(settled?.versionId).toBe(created.versionId);
    expect(await rowCounts()).toEqual(before);

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.required).toBe(false);
    expect(fetched?.scope).toBe("both");
    expect(fetched?.productionSampleRate).toBe(5);
    expect(fetched?.version).toBe(1);
    expect(fetched?.config).toEqual(latencyConfig);

    // And what was already judged is untouched: no version was minted, so
    // nothing a verdict points at moved.
    const frozen = await getGraderVersion(actingAsAcme(), created.versionId);
    expect(frozen?.version).toBe(1);
    expect(frozen?.config).toEqual(latencyConfig);
  });

  it("renames without versioning, and clears a description with null", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);
    const before = await rowCounts();

    const renamed = await editGrader(actingAsAcme(), created.id, {
      name: "Answers within a second and a half",
      description: null,
    });

    expect(renamed?.name).toBe("Answers within a second and a half");
    expect(renamed?.description).toBeNull();
    expect(renamed?.version).toBe(1);
    expect(await rowCounts()).toEqual(before);
  });

  it("renames and versions together when one edit carries both", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);

    const edited = await editGrader(actingAsAcme(), created.id, {
      name: "Answers fast",
      required: false,
      config: boundedAt(1000),
    });

    expect(edited?.name).toBe("Answers fast");
    expect(edited?.required).toBe(false);
    expect(edited?.version).toBe(2);
  });

  it("refuses a setting egma does not know, and changes nothing", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);

    await expect(
      editGrader(actingAsAcme(), created.id, { scope: "anywhere" as never }),
    ).rejects.toThrow(/scope/);
    await expect(
      editGrader(actingAsAcme(), created.id, { productionSampleRate: -1 }),
    ).rejects.toThrow(/percentage/);
    await expect(
      editGrader(actingAsAcme(), created.id, { name: "  " }),
    ).rejects.toThrow(/name/);

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.scope).toBe("simulations");
    expect(fetched?.name).toBe(latency.name);
  });
});

describe("listing graders", () => {
  /** A project of its own, so the page is exactly what this block wrote. */
  const inOutbound = { ...actingAsAcme(), projectId: acme.outbound };

  it("answers newest first, with each row's current content", async () => {
    const written = [];
    for (let nth = 1; nth <= 3; nth += 1) {
      written.push(
        await useLibraryEntry(inOutbound, { ...latency, name: `Threshold ${nth}` }),
      );
    }
    await editGrader(inOutbound, written[0]!.id, {
      config: boundedAt(900),
    });

    const page = await listGraders(inOutbound);
    expect(page.items.map((item) => item.name)).toEqual([
      "Threshold 3",
      "Threshold 2",
      "Threshold 1",
    ]);
    expect(page.nextCursor).toBeUndefined();

    const first = page.items.find((item) => item.name === "Threshold 1");
    expect(first?.version).toBe(2);
    expect(first?.config).toEqual(boundedAt(900));
  });

  it("pages by id, and refuses a cursor that is not a grader's", async () => {
    const page = await listGraders(inOutbound, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(page.items[1]?.id);

    const rest = await listGraders(inOutbound, { cursor: page.nextCursor });
    expect(rest.items.map((item) => item.name)).toEqual(["Threshold 1"]);

    await expect(
      listGraders(inOutbound, { cursor: newId("prs") }),
    ).rejects.toThrow(/grader id/);
  });
});

describe("deleting a grader nothing names", () => {
  it("vanishes from fetches and lists, and its versions stay readable", async () => {
    const created = await useLibraryEntry(actingAsAcme(), {
      ...latency,
      name: "Retired threshold",
    });

    const deleted = await deleteGrader(actingAsAcme(), created.id);
    expect(deleted?.id).toBe(created.id);
    expect(deleted?.name).toBe("Retired threshold");
    expect(deleted?.deletedAt).toBeInstanceOf(Date);

    expect(await getGrader(actingAsAcme(), created.id)).toBeUndefined();
    const page = await listGraders(actingAsAcme());
    expect(page.items.map((item) => item.id)).not.toContain(created.id);

    // The version outlives the delete, because a verdict that named it has to
    // stay interpretable.
    const frozen = await getGraderVersion(actingAsAcme(), created.versionId);
    expect(frozen?.config).toEqual(latencyConfig);
  });

  it("is refused to a credential acting in no project", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);

    await expect(
      deleteGrader({ ...actingAsAcme(), projectId: undefined }, created.id),
    ).rejects.toThrow(/project/);
  });

  it("deletes nothing for an id that does not exist", async () => {
    expect(await deleteGrader(actingAsAcme(), newId("grd"))).toBeUndefined();
  });
});

describe("tenancy", () => {
  it("edits nothing and returns nothing when another organization asks", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);

    const stolen = await editGrader(actingAsGlobex("admin"), created.id, {
      name: "Globex's now",
      required: false,
    });
    expect(stolen).toBeUndefined();

    const untouched = await getGrader(actingAsAcme(), created.id);
    expect(untouched?.name).toBe(latency.name);
    expect(untouched?.required).toBe(true);

    expect(
      await getGraderVersion(actingAsGlobex(), created.versionId),
    ).toBeUndefined();
    expect(await deleteGrader(actingAsGlobex(), created.id)).toBeUndefined();
  });

  it("edits what already exists for a credential acting in no project", async () => {
    const created = await useLibraryEntry(actingAsAcme(), latency);

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const edited = await editGrader(wholeCustomer, created.id, {
      config: boundedAt(800),
    });

    expect(edited?.version).toBe(2);
    expect(edited?.projectId).toBe(acme.project);
  });
});
