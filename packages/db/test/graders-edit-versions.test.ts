import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createGrader,
  deleteGrader,
  editGrader,
  getGrader,
  getGraderVersion,
  listGraders,
  NotPermittedError,
  type NewGrader,
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
 * by and where the decision applies. Tightening a threshold changes what a
 * verdict means, so it mints a version and the old one stays exactly readable;
 * promoting a warning to a blocker changes nothing already judged, so it writes
 * in place and is true the moment it returns.
 */

let database: MigratedDatabase;

beforeAll(async () => {
  ({ database } = await seedTestFactory("graders_edit"));
});

afterAll(async () => {
  await database.drop();
});

/** A threshold, because a threshold is the thing teams actually tighten. */
const latency = {
  name: "Answers within two seconds",
  description: "The number the support team argues about",
  type: "metric_threshold",
  config: {
    measure: "turn_response_latency",
    aggregation: "p90",
    comparator: "below",
    threshold: 2000,
  },
} as const satisfies NewGrader;

/** The same judgment, said in a way that reorders nothing and changes nothing. */
const sameLatencyConfig = {
  comparator: "below",
  threshold: 2000,
  measure: "turn_response_latency",
  aggregation: "p90",
} as const;

describe("editing what a grader judges by", () => {
  it("creates version 2, moves the pointer, and leaves version 1 exactly where it was", async () => {
    const created = await createGrader(actingAsAcme(), latency);

    const edited = await editGrader(actingAsAcme(), created.id, {
      config: { ...latency.config, threshold: 1500 },
    });

    expect(edited?.version).toBe(2);
    expect(edited?.versionId).not.toBe(created.versionId);
    expect(edited?.config).toEqual({ ...latency.config, threshold: 1500 });

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(2);
    expect(fetched?.versionId).toBe(edited?.versionId);
    expect(fetched?.config).toEqual({ ...latency.config, threshold: 1500 });

    // Version 1 is untouched, which is what makes last week's verdict still
    // mean what it meant when it was written.
    const frozen = await getGraderVersion(actingAsAcme(), created.versionId);
    expect(frozen?.version).toBe(1);
    expect(frozen?.graderId).toBe(created.id);
    expect(frozen?.type).toBe("metric_threshold");
    expect(frozen?.config).toEqual(latency.config);
    expect(frozen?.judgeModel).toBeNull();
    expect(frozen?.createdAt).toBeInstanceOf(Date);
  });

  it("does nothing for a byte-identical save, and returns the current version", async () => {
    const created = await createGrader(actingAsAcme(), latency);
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

  it("counts an argument constraint as content, and a reordered one as the same content", async () => {
    const created = await createGrader(actingAsAcme(), {
      name: "Refunds through the refund tool",
      type: "tool_calls",
      config: {
        required: [{ tool: "issue_refund", arguments: { currency: "USD", partial: false } }],
      },
    });
    const before = await rowCounts();

    const saved = await editGrader(actingAsAcme(), created.id, {
      config: {
        required: [
          { tool: "issue_refund", arguments: { partial: false, currency: "USD" } },
        ],
      },
    });
    expect(saved?.version).toBe(1);
    expect(await rowCounts()).toEqual(before);

    const tightened = await editGrader(actingAsAcme(), created.id, {
      config: {
        required: [{ tool: "issue_refund", arguments: { currency: "EUR" } }],
      },
    });
    expect(tightened?.version).toBe(2);
  });

  it("versions on the judge model, and on clearing it again", async () => {
    const created = await createGrader(actingAsAcme(), latency);

    const overridden = await editGrader(actingAsAcme(), created.id, {
      judgeModel: { provider: "openai", model: "gpt-4.1-mini" },
    });
    expect(overridden?.version).toBe(2);
    expect(overridden?.judgeModel).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini",
    });

    const again = await editGrader(actingAsAcme(), created.id, {
      judgeModel: { provider: "openai", model: "gpt-4.1-mini" },
    });
    expect(again?.version).toBe(2);

    // Null is not "leave it alone" — it is "go back to the project's judge",
    // which is a different judgment and mints a version like any other.
    const cleared = await editGrader(actingAsAcme(), created.id, {
      judgeModel: null,
    });
    expect(cleared?.version).toBe(3);
    expect(cleared?.judgeModel).toBeNull();
  });

  it("numbers each edit after the last, and keeps every version fetchable by its grv_ id", async () => {
    const created = await createGrader(actingAsAcme(), latency);
    const second = await editGrader(actingAsAcme(), created.id, {
      config: { ...latency.config, threshold: 1500 },
    });
    const third = await editGrader(actingAsAcme(), created.id, {
      config: { ...latency.config, threshold: 1200 },
    });

    expect(second?.version).toBe(2);
    expect(third?.version).toBe(3);
    expect((await getGrader(actingAsAcme(), created.id))?.version).toBe(3);

    const first = await getGraderVersion(actingAsAcme(), created.versionId);
    expect(first?.config).toEqual(latency.config);

    if (second?.versionId === undefined) throw new Error("no second version");
    const middle = await getGraderVersion(actingAsAcme(), second.versionId);
    expect(middle?.version).toBe(2);
    expect(middle?.config).toEqual({ ...latency.config, threshold: 1500 });
  });

  it("holds an edited config to the type the grader already has", async () => {
    const created = await createGrader(actingAsAcme(), latency);

    await expect(
      editGrader(actingAsAcme(), created.id, {
        config: { rubric: "was it fast enough" } as never,
      }),
    ).rejects.toThrow(/measure/);

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(1);
    expect(fetched?.config).toEqual(latency.config);
  });

  it("is refused to a viewer, per the permission table", async () => {
    const created = await createGrader(actingAsAcme(), latency);

    await expect(
      editGrader(actingAsAcme("viewer"), created.id, {
        config: { ...latency.config, threshold: 1 },
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
    const created = await createGrader(actingAsAcme(), latency);
    const before = await rowCounts();

    const settled = await editGrader(actingAsAcme(), created.id, {
      priority: "P2",
      scope: "both",
      productionSampleRate: 5,
    });

    expect(settled?.priority).toBe("P2");
    expect(settled?.scope).toBe("both");
    expect(settled?.productionSampleRate).toBe(5);
    expect(settled?.version).toBe(1);
    expect(settled?.versionId).toBe(created.versionId);
    expect(await rowCounts()).toEqual(before);

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.priority).toBe("P2");
    expect(fetched?.scope).toBe("both");
    expect(fetched?.productionSampleRate).toBe(5);
    expect(fetched?.version).toBe(1);
    expect(fetched?.config).toEqual(latency.config);

    // And what was already judged is untouched: no version was minted, so
    // nothing a verdict points at moved.
    const frozen = await getGraderVersion(actingAsAcme(), created.versionId);
    expect(frozen?.version).toBe(1);
    expect(frozen?.config).toEqual(latency.config);
  });

  it("renames without versioning, and clears a description with null", async () => {
    const created = await createGrader(actingAsAcme(), latency);
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
    const created = await createGrader(actingAsAcme(), latency);

    const edited = await editGrader(actingAsAcme(), created.id, {
      name: "Answers fast",
      priority: "P1",
      config: { ...latency.config, threshold: 1000 },
    });

    expect(edited?.name).toBe("Answers fast");
    expect(edited?.priority).toBe("P1");
    expect(edited?.version).toBe(2);
  });

  it("refuses a setting egma does not know, and changes nothing", async () => {
    const created = await createGrader(actingAsAcme(), latency);

    await expect(
      editGrader(actingAsAcme(), created.id, { priority: "P9" as never }),
    ).rejects.toThrow(/priority/);
    await expect(
      editGrader(actingAsAcme(), created.id, { productionSampleRate: -1 }),
    ).rejects.toThrow(/percentage/);
    await expect(
      editGrader(actingAsAcme(), created.id, { name: "  " }),
    ).rejects.toThrow(/name/);

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.priority).toBe("P0");
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
        await createGrader(inOutbound, { ...latency, name: `Threshold ${nth}` }),
      );
    }
    await editGrader(inOutbound, written[0]!.id, {
      config: { ...latency.config, threshold: 900 },
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
    expect(first?.config).toEqual({ ...latency.config, threshold: 900 });
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
    const created = await createGrader(actingAsAcme(), {
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
    expect(frozen?.config).toEqual(latency.config);
  });

  it("is refused to a credential acting in no project", async () => {
    const created = await createGrader(actingAsAcme(), latency);

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
    const created = await createGrader(actingAsAcme(), latency);

    const stolen = await editGrader(actingAsGlobex("admin"), created.id, {
      name: "Globex's now",
      priority: "P2",
    });
    expect(stolen).toBeUndefined();

    const untouched = await getGrader(actingAsAcme(), created.id);
    expect(untouched?.name).toBe(latency.name);
    expect(untouched?.priority).toBe("P0");

    expect(
      await getGraderVersion(actingAsGlobex(), created.versionId),
    ).toBeUndefined();
    expect(await deleteGrader(actingAsGlobex(), created.id)).toBeUndefined();
  });

  it("edits what already exists for a credential acting in no project", async () => {
    const created = await createGrader(actingAsAcme(), latency);

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const edited = await editGrader(wholeCustomer, created.id, {
      config: { ...latency.config, threshold: 800 },
    });

    expect(edited?.version).toBe(2);
    expect(edited?.projectId).toBe(acme.project);
  });
});
