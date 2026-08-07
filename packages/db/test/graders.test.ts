import { isId, newId } from "@egma/ids";
import {
  CATALOGED_MEASURES,
  MEASURE_CATALOG_DOCUMENT,
  MEASURE_CATALOG_VERSION,
} from "@egma/simulation-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createGrader,
  getGrader,
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
  globex,
  rowCounts,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * Creating a grader and fetching it back, through the factory functions only.
 * Raw SQL appears in the row counts proving what a refused write left behind,
 * in the insert that bypasses the module to show the database refuses what the
 * module never attempts, and in the one hand-corrupted row no seam can write.
 *
 * What a grader judges by is checked at this door and nowhere later: a config
 * that does not fit the type its author declared is refused here, in words that
 * name the field, because the alternative is a grader that runs for a month and
 * judges nothing.
 */

let database: MigratedDatabase;

beforeAll(async () => {
  ({ database } = await seedTestFactory("graders"));
});

afterAll(async () => {
  await database.drop();
});

/** The rubric this file authors, whole enough to be worth reading back. */
const empathy = {
  name: "Stays kind when the caller is upset",
  description: "The one nobody can write as a rule",
  type: "llm_rubric",
  config: {
    rubric:
      "The agent acknowledges the caller's frustration before it explains anything, and never repeats a policy the caller has already refused.",
  },
} as const;

describe("creating a grader", () => {
  it("returns a grd_ id and fetch round-trips every input", async () => {
    const created = await createGrader(actingAsAcme(), {
      ...empathy,
      priority: "P1",
      scope: "both",
      productionSampleRate: 10,
      judgeModel: { provider: "openai", model: "gpt-4.1" },
    });

    expect(isId("grd", created.id)).toBe(true);
    expect(isId("grv", created.versionId)).toBe(true);

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.name).toBe(empathy.name);
    expect(fetched?.description).toBe(empathy.description);
    expect(fetched?.type).toBe("llm_rubric");
    expect(fetched?.version).toBe(1);
    expect(fetched?.config).toEqual(empathy.config);
    expect(fetched?.priority).toBe("P1");
    expect(fetched?.scope).toBe("both");
    expect(fetched?.productionSampleRate).toBe(10);
    expect(fetched?.judgeModel).toEqual({
      provider: "openai",
      model: "gpt-4.1",
    });
    expect(fetched?.projectId).toBe(acme.project);
  });

  it("blocks, judges simulations and names no judge of its own by default", async () => {
    const created = await createGrader(actingAsAcme(), empathy);

    const fetched = await getGrader(actingAsAcme(), created.id);
    // Blocking by default, because a check somebody wrote is a check they
    // expect to be believed; production is opt-in, because it costs money.
    expect(fetched?.priority).toBe("P0");
    expect(fetched?.scope).toBe("simulations");
    expect(fetched?.productionSampleRate).toBe(100);
    expect(fetched?.judgeModel).toBeNull();
  });

  it("is allowed to a member and refused to a viewer, per the permission table", async () => {
    await expect(
      createGrader(actingAsAcme("viewer"), empathy),
    ).rejects.toThrow(NotPermittedError);

    const created = await createGrader(actingAsAcme("member"), empathy);
    const fetchedByViewer = await getGrader(actingAsAcme("viewer"), created.id);
    expect(fetchedByViewer?.name).toBe(empathy.name);
  });

  it("is refused to a credential acting in no project", async () => {
    await expect(
      createGrader({ ...actingAsAcme(), projectId: undefined }, empathy),
    ).rejects.toThrow(/project/);
  });

  it("cannot commit halfway: an identity row without its version dies at commit", async () => {
    // The factory writes the grader and its version in one transaction, so a
    // create that fails part-way leaves nothing. That guarantee is the deferred
    // pointer constraint, and this proves it where it lives — at commit, in the
    // database, for a writer that is not the factory.
    const connection = await openSingleConnection(database.url);
    try {
      const orphan = newId("grd");
      await connection.sql("begin");
      await connection.sql(
        `insert into grader
           (id, organization_id, project_id, name, type, priority, current_version_id)
         values ($1, $2, $3, 'Halfway', 'llm_rubric', 'P0', $4)`,
        [orphan, acme.organization, acme.project, newId("grv")],
      );

      await expect(connection.sql("commit")).rejects.toSatisfy(
        (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
      );

      const { rows } = await database.sql("select 1 from grader where id = $1", [
        orphan,
      ]);
      expect(rows).toEqual([]);
    } finally {
      await connection.close();
    }
  });
});

describe("each type of grader", () => {
  it("keeps a metric_threshold's measure, aggregation, comparator and threshold", async () => {
    const created = await createGrader(actingAsAcme(), {
      name: "Answers within two seconds",
      type: "metric_threshold",
      config: {
        measure: "turn_response_latency",
        aggregation: "p90",
        comparator: "below",
        threshold: 2000,
      },
    });

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.type).toBe("metric_threshold");
    expect(fetched?.config).toEqual({
      measure: "turn_response_latency",
      aggregation: "p90",
      comparator: "below",
      threshold: 2000,
    });
  });

  it("keeps a tool_calls grader's required and forbidden tools, and their arguments", async () => {
    const created = await createGrader(actingAsAcme(), {
      name: "Refunds through the refund tool",
      type: "tool_calls",
      config: {
        required: [{ tool: "issue_refund", arguments: { currency: "USD" } }],
        forbidden: [{ tool: "transfer_to_human" }],
      },
    });

    const fetched = await getGrader(actingAsAcme(), created.id);
    // The list a caller left out is stored empty rather than absent, and a tool
    // named with no argument constraint says so with a null: what lands in the
    // row is complete, so no reader has to know what a missing field meant.
    expect(fetched?.config).toEqual({
      required: [{ tool: "issue_refund", arguments: { currency: "USD" } }],
      forbidden: [{ tool: "transfer_to_human", arguments: null }],
    });
  });

  it("fills a phrase_match grader's defaults in at the door, not at read time", async () => {
    const created = await createGrader(actingAsAcme(), {
      name: "Never promises a refund",
      type: "phrase_match",
      config: { banned: [{ text: "guaranteed refund" }] },
    });

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.config).toEqual({
      required: [],
      banned: [{ text: "guaranteed refund", match: "contains" }],
      // The agent's turns, because the persona is egma's own synthetic caller
      // and judging what egma made it say would be judging egma.
      speaker: "agent",
    });
  });

  it("keeps a phrase pattern and a speaker the author chose", async () => {
    const created = await createGrader(actingAsAcme(), {
      name: "States the recording disclosure",
      type: "phrase_match",
      config: {
        required: [{ text: "this call (is|may be) recorded", match: "regex" }],
        speaker: "either",
      },
    });

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.config).toEqual({
      required: [{ text: "this call (is|may be) recorded", match: "regex" }],
      banned: [],
      speaker: "either",
    });
  });
});

describe("a grader whose config does not fit its type", () => {
  /** What a refusal has to do: say the field, and write nothing. */
  async function refusedNaming(
    input: Parameters<typeof createGrader>[1],
    field: RegExp,
  ): Promise<void> {
    const before = await rowCounts();
    await expect(createGrader(actingAsAcme(), input)).rejects.toThrow(field);
    expect(await rowCounts()).toEqual(before);
  }

  it("is refused when a metric_threshold names no measure", async () => {
    await refusedNaming(
      {
        name: "Reads nothing",
        type: "metric_threshold",
        config: {
          measure: "  ",
          aggregation: "p90",
          comparator: "below",
          threshold: 2000,
        },
      },
      /measure/,
    );
  });

  /**
   * The one write-door rule that is about the world rather than about the shape.
   *
   * A threshold grader names what it reads as a string, and a string naming
   * nothing produces a grader that reads nothing, judges nothing and is
   * `skipped` forever — green, silent, and wrong. Nothing downstream can catch
   * it: a missing measure is a legitimate `skipped` on a chat conversation with
   * no audio, so the engine cannot tell a typo from a modality. Only this moment
   * can.
   */
  it("is refused when a metric_threshold names a measure the catalog does not", async () => {
    await refusedNaming(
      {
        name: "Reads a measure nobody emits",
        type: "metric_threshold",
        config: {
          measure: "turn_responze_latency",
          aggregation: "p90",
          comparator: "below",
          threshold: 2000,
        },
      },
      /measure catalog/,
    );
  });

  it("names the catalog and everything in it, so the next question is answered too", async () => {
    const refusal = await createGrader(actingAsAcme(), {
      name: "Reads a measure nobody emits",
      type: "metric_threshold",
      config: {
        measure: "time_to_resolution",
        aggregation: "p90",
        comparator: "below",
        threshold: 2000,
      },
    }).then(
      () => "the grader was written",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(refusal).toContain('"time_to_resolution" is not a measure');
    expect(refusal).toContain(MEASURE_CATALOG_DOCUMENT);
    expect(refusal).toContain(`version ${MEASURE_CATALOG_VERSION}`);
    // Every cataloged name, because "then what is" is always the next question
    // and a refusal that sends somebody hunting is a refusal that cost them the
    // afternoon.
    for (const cataloged of CATALOGED_MEASURES) {
      expect(refusal).toContain(cataloged);
    }
  });

  it("takes every measure the catalog does name", async () => {
    for (const cataloged of CATALOGED_MEASURES) {
      const created = await createGrader(actingAsAcme(), {
        name: `Holds ${cataloged} to something`,
        type: "metric_threshold",
        config: {
          measure: cataloged,
          aggregation: "p90",
          comparator: "below",
          threshold: 2000,
        },
      });
      expect(created.config).toMatchObject({ measure: cataloged });
    }
  });

  it("is refused when a metric_threshold names no threshold", async () => {
    await refusedNaming(
      {
        name: "Compares with nothing",
        type: "metric_threshold",
        config: {
          measure: "turn_response_latency",
          aggregation: "p90",
          comparator: "below",
          threshold: "2000" as unknown as number,
        },
      },
      /threshold/,
    );
  });

  it("is refused for an aggregation or comparator egma does not know", async () => {
    await refusedNaming(
      {
        name: "Aggregates somehow",
        type: "metric_threshold",
        config: {
          measure: "turn_response_latency",
          aggregation: "p42" as never,
          comparator: "below",
          threshold: 2000,
        },
      },
      /aggregation/,
    );
    await refusedNaming(
      {
        name: "Compares somehow",
        type: "metric_threshold",
        config: {
          measure: "turn_response_latency",
          aggregation: "p90",
          comparator: "roughly" as never,
          threshold: 2000,
        },
      },
      /comparator/,
    );
  });

  it("is refused when a phrase_match names neither required nor banned phrases", async () => {
    await refusedNaming(
      { name: "Looks for nothing", type: "phrase_match", config: {} },
      /required or banned phrase/,
    );
  });

  it("is refused when a phrase says nothing", async () => {
    await refusedNaming(
      {
        name: "Looks for silence",
        type: "phrase_match",
        config: { banned: [{ text: "   " }] },
      },
      /banned phrase/,
    );
  });

  it("is refused when an llm_rubric carries no rubric", async () => {
    await refusedNaming(
      { name: "Judges by nothing", type: "llm_rubric", config: { rubric: " " } },
      /rubric/,
    );
  });

  it("is refused when a tool_calls names neither required nor forbidden tools", async () => {
    await refusedNaming(
      { name: "Watches no tool", type: "tool_calls", config: {} },
      /required or forbidden tool/,
    );
  });

  it("is refused when a tool entry names no tool", async () => {
    await refusedNaming(
      {
        name: "Watches something",
        type: "tool_calls",
        config: { required: [{ tool: "" }] },
      },
      /required entry/,
    );
  });

  it("is refused for a type egma does not know", async () => {
    await refusedNaming(
      {
        name: "Judges by vibes",
        type: "vibes" as never,
        config: {} as never,
      },
      /grader type/,
    );
  });
});

describe("a grader whose settings are not settings", () => {
  it("is refused for a priority, scope or sample rate egma does not know", async () => {
    await expect(
      createGrader(actingAsAcme(), { ...empathy, priority: "P3" as never }),
    ).rejects.toThrow(/priority/);
    await expect(
      createGrader(actingAsAcme(), { ...empathy, scope: "everywhere" as never }),
    ).rejects.toThrow(/scope/);
    await expect(
      createGrader(actingAsAcme(), { ...empathy, productionSampleRate: 101 }),
    ).rejects.toThrow(/percentage/);
    await expect(
      createGrader(actingAsAcme(), { ...empathy, productionSampleRate: 12.5 }),
    ).rejects.toThrow(/percentage/);
  });

  it("is refused for a missing name, and no rows are left behind", async () => {
    const before = await rowCounts();

    await expect(
      createGrader(actingAsAcme(), { ...empathy, name: "   " }),
    ).rejects.toThrow(/name/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused for a judge egma cannot ask", async () => {
    await expect(
      createGrader(actingAsAcme(), {
        ...empathy,
        judgeModel: { provider: "acme-labs" as never, model: "big" },
      }),
    ).rejects.toThrow(/judge provider/);
    await expect(
      createGrader(actingAsAcme(), {
        ...empathy,
        judgeModel: { provider: "openai", model: " " },
      }),
    ).rejects.toThrow(/model/);
  });

  it("stores the name, rubric and measure trimmed", async () => {
    const created = await createGrader(actingAsAcme(), {
      name: "  Padded  ",
      type: "metric_threshold",
      config: {
        measure: "  turn_response_latency  ",
        aggregation: "mean",
        comparator: "at_most",
        threshold: 1,
      },
    });

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.name).toBe("Padded");
    expect(fetched?.config).toEqual({
      measure: "turn_response_latency",
      aggregation: "mean",
      comparator: "at_most",
      threshold: 1,
    });
  });
});

describe("a credential for the whole organization", () => {
  it("reads a project's graders without acting in the project", async () => {
    const created = await createGrader(actingAsAcme(), empathy);

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const fetched = await getGrader(wholeCustomer, created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.projectId).toBe(acme.project);
  });
});

describe("tenancy", () => {
  it("refuses a context pairing one organization with another's project, leaving no rows", async () => {
    const before = await rowCounts();

    await expect(
      createGrader({ ...actingAsAcme(), projectId: globex.project }, empathy),
    ).rejects.toThrow(ProjectOutsideOrganizationError);

    expect(await rowCounts()).toEqual(before);
  });

  it("returns nothing when another organization asks for my grader", async () => {
    const created = await createGrader(actingAsAcme(), empathy);

    expect(await getGrader(actingAsGlobex(), created.id)).toBeUndefined();
  });

  it("returns nothing to the same customer acting in a sibling project", async () => {
    const created = await createGrader(actingAsAcme(), empathy);

    const inOutbound = { ...actingAsAcme(), projectId: acme.outbound };
    expect(await getGrader(inOutbound, created.id)).toBeUndefined();

    // And the credential acting in no project still reaches it, so the arm
    // above failed for the project and not for something else.
    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    expect((await getGrader(wholeCustomer, created.id))?.id).toBe(created.id);
  });

  it("returns nothing for an id that does not exist", async () => {
    expect(await getGrader(actingAsAcme(), newId("grd"))).toBeUndefined();
  });

  it("refuses the mismatched pairing even for raw SQL that bypasses the module", async () => {
    await expect(
      database.sql(
        `insert into grader
           (id, organization_id, project_id, name, type, priority, current_version_id)
         values ($1, $2, $3, 'Smuggled', 'llm_rubric', 'P0', $4)`,
        [newId("grd"), acme.organization, globex.project, newId("grv")],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });
});

describe("a version row somebody hand-corrupted", () => {
  it("fails loudly on the read, naming the version, rather than leaking", async () => {
    const created = await createGrader(actingAsAcme(), empathy);

    // Raw SQL on purpose: the factory can never write this, so the guard is the
    // only thing standing between the row and the caller.
    await database.sql(
      `update grader_version set config = '{"rubric": ""}'::jsonb where id = $1`,
      [created.versionId],
    );

    await expect(getGrader(actingAsAcme(), created.id)).rejects.toThrow(
      created.versionId,
    );
  });
});
