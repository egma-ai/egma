import { isId, newId } from "@egma/ids";
import {
  CATALOGED_MEASURES,
  SPAN_DERIVED_MEASURES,
} from "@egma/metrics";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  advanceProductionSampling,
  editGrader,
  getGrader,
  NotPermittedError,
  PREDEFINED_GRADERS,
  ProjectOutsideOrganizationError,
  UnknownGraderLibraryEntryError,
  useLibraryEntry,
  type UseLibraryEntry,
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
 * Pressing **Use** on a library entry, and reading the running copy back —
 * through the factory functions only. Raw SQL appears in the row counts proving
 * what a refused write left behind, in the insert that bypasses the module to
 * show the database refuses what the module never attempts, and in the one
 * hand-corrupted row no seam can write.
 *
 * **There is one door that makes a grader and it takes a pointer, not a type.**
 * That is the whole shape of the redesign at this level: the entry decides what
 * kind of judgment this is and what the form asks for, and the copy holds the
 * answers. So what this file checks is not "does a config fit a type" but "do
 * the filled-in values answer what the entry actually asked" — refused here, in
 * words that name the parameter, because the alternative is a grader that runs
 * for a month and judges nothing.
 */

let database: MigratedDatabase;

beforeAll(async () => {
  ({ database } = await seedTestFactory("graders"));
});

afterAll(async () => {
  await database.drop();
});

/**
 * A copy of the entry that computes: it asks for a measure and a bound, so it
 * is the one entry whose Use form has anything in it at all.
 */
const aLatencyCopy: UseLibraryEntry = {
  libraryId: PREDEFINED_GRADERS.latency,
  params: { metric: "turn_response_latency", bound: 2_000 },
};

/** A copy of the judged entry, whose form asks for nothing. */
const aBehaviorsCopy: UseLibraryEntry = {
  libraryId: PREDEFINED_GRADERS.expectedBehaviors,
};

describe("using a library entry", () => {
  it("returns a grd_ id and fetch round-trips every input", async () => {
    const created = await useLibraryEntry(actingAsAcme(), {
      ...aLatencyCopy,
      name: "Answers inside two seconds",
      description: "The one nobody argues about",
      required: false,
      scope: "both",
      productionSampleRate: 10,
    });

    expect(isId("grd", created.id)).toBe(true);
    expect(isId("grv", created.versionId)).toBe(true);

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.libraryId).toBe(PREDEFINED_GRADERS.latency);
    expect(fetched?.name).toBe("Answers inside two seconds");
    expect(fetched?.description).toBe("The one nobody argues about");
    expect(fetched?.version).toBe(1);
    expect(fetched?.required).toBe(false);
    expect(fetched?.scope).toBe("both");
    expect(fetched?.productionSampleRate).toBe(10);
    expect(fetched?.judgeModel).toBeNull();
    expect(fetched?.projectId).toBe(acme.project);
  });

  /**
   * The type is the stable Library identity's answer and never the caller's.
   * Nothing in the input or project copy stores a second answer for it.
   */
  it("resolves the type from the entry, and takes none from the caller", async () => {
    const computed = await useLibraryEntry(actingAsAcme(), aLatencyCopy);
    const judged = await useLibraryEntry(actingAsAcme(), aBehaviorsCopy);

    expect(computed.type).toBe("code");
    expect(judged.type).toBe("llm_as_judge");
  });

  /**
   * A copy nobody renamed says on screen which grader it is a copy of. The
   * alternative is a Running-graders list of rows called "Untitled", each of
   * which somebody then has to open to find out what it does.
   */
  it("names the copy after the entry when nobody named it", async () => {
    const created = await useLibraryEntry(actingAsAcme(), aBehaviorsCopy);
    expect(created.name).toBe("expected_behaviors");

    const named = await useLibraryEntry(actingAsAcme(), {
      ...aBehaviorsCopy,
      name: "  Our own words for it  ",
    });
    expect(named.name).toBe("Our own words for it");
  });

  it("blocks, judges simulations and names no judge of its own by default", async () => {
    const created = await useLibraryEntry(actingAsAcme(), aLatencyCopy);

    const fetched = await getGrader(actingAsAcme(), created.id);
    // Required by default, because a grader somebody switched on is a grader
    // they expect to be believed; production is opt-in, because it costs money.
    expect(fetched?.required).toBe(true);
    expect(fetched?.scope).toBe("simulations");
    expect(fetched?.productionSampleRate).toBe(100);
    expect(fetched?.judgeModel).toBeNull();
  });

  it("is allowed to a member and refused to a viewer, per the permission table", async () => {
    await expect(
      useLibraryEntry(actingAsAcme("viewer"), aLatencyCopy),
    ).rejects.toThrow(NotPermittedError);

    const created = await useLibraryEntry(actingAsAcme("member"), aLatencyCopy);
    const fetchedByViewer = await getGrader(actingAsAcme("viewer"), created.id);
    expect(fetchedByViewer?.id).toBe(created.id);
  });

  it("is refused to a credential acting in no project", async () => {
    await expect(
      useLibraryEntry(
        { ...actingAsAcme(), projectId: undefined },
        aLatencyCopy,
      ),
    ).rejects.toThrow(/project/);
  });

  /**
   * An entry that is not on this caller's shelf and one that was never written
   * get the same refusal, because telling them apart would answer a question
   * about somebody else's shelf.
   */
  it("is refused for an entry that is not on the shelf, leaving no rows", async () => {
    const before = await rowCounts();

    await expect(
      useLibraryEntry(actingAsAcme(), { libraryId: newId("grl") }),
    ).rejects.toThrow(UnknownGraderLibraryEntryError);

    expect(await rowCounts()).toEqual(before);
  });

  it("cannot commit halfway: an identity row without its version dies at commit", async () => {
    // The factory writes the copy and its version in one transaction, so a Use
    // that fails part-way leaves nothing. That guarantee is the deferred
    // pointer constraint, and this proves it where it lives — at commit, in the
    // database, for a writer that is not the factory.
    const connection = await openSingleConnection(database.url);
    try {
      const orphan = newId("grd");
      await connection.sql("begin");
      await connection.sql(
        `insert into grader
           (id, organization_id, project_id, library_id, name, current_version_id)
         values ($1, $2, $3, $4, 'Halfway', $5)`,
        [
          orphan,
          acme.organization,
          acme.project,
          PREDEFINED_GRADERS.latency,
          newId("grv"),
        ],
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

  /**
   * The pointer is the connecting tissue and the database means it. A copy
   * naming an entry that is not there is refused by the foreign key, not merely
   * by the module above it — which is what makes "never orphaned" true of a
   * hand-written statement too.
   */
  it("refuses a copy pointing at an entry that does not exist, even for raw SQL", async () => {
    await expect(
      database.sql(
        `insert into grader
           (id, organization_id, project_id, library_id, name, current_version_id)
         values ($1, $2, $3, $4, 'Points at nothing', $5)`,
        [
          newId("grd"),
          acme.organization,
          acme.project,
          newId("grl"),
          newId("grv"),
        ],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });

});

/**
 * What the copy holds: one filled-in set per assertion, and nothing the entry
 * did not ask for.
 */
describe("the filled-in values a copy is born with", () => {
  it("stores what Use asked for as the copy's one assertion", async () => {
    const created = await useLibraryEntry(actingAsAcme(), aLatencyCopy);

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.config).toEqual({
      assertions: [{ metric: "turn_response_latency", bound: 2_000 }],
    });
  });

  /**
   * **Empty is a complete answer, not an unfinished one.** The
   * expected-behaviors grader's assertions are the test's own sentences,
   * supplied per test at judging time, so a correct copy of it holds nothing —
   * forever.
   */
  it("stores nothing for an entry that asks nothing, and that is complete", async () => {
    const created = await useLibraryEntry(actingAsAcme(), aBehaviorsCopy);

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.config).toEqual({ assertions: [] });
  });

  /**
   * A project row stores one exact immutable Library-definition reference. It
   * does not copy prompt text into config, so every project shares one revision
   * while a pinned run can still keep that revision forever.
   */
  it("references the exact shared definition without copying its prompt", async () => {
    const created = await useLibraryEntry(actingAsAcme(), aBehaviorsCopy);

    const { rows } = await database.sql<{
      config: unknown;
      library_id: string;
      library_version: number;
      prompt: string | null;
    }>(
      `select gv.config, gv.library_id, gv.library_version, glv.prompt
         from grader_version gv
         join grader_library_version glv
           on glv.library_id = gv.library_id
          and glv.version = gv.library_version
        where gv.id = $1`,
      [created.versionId],
    );
    expect(rows[0]?.config).toEqual({ assertions: [] });
    expect(JSON.stringify(rows[0]?.config)).not.toContain("cannot_determine");
    expect(rows[0]).toMatchObject({
      library_id: PREDEFINED_GRADERS.expectedBehaviors,
      library_version: 1,
    });
    expect(rows[0]?.prompt ?? "").toContain("cannot_determine");
  });
});

describe("values that do not answer what the entry asked", () => {
  /** What a refusal has to do: say the parameter, and write nothing. */
  async function refusedNaming(
    input: UseLibraryEntry,
    named: RegExp,
  ): Promise<void> {
    const before = await rowCounts();
    await expect(useLibraryEntry(actingAsAcme(), input)).rejects.toThrow(named);
    expect(await rowCounts()).toEqual(before);
  }

  it("is refused when a parameter the entry asked for is missing", async () => {
    await refusedNaming(
      {
        libraryId: PREDEFINED_GRADERS.latency,
        params: { metric: "turn_response_latency" },
      },
      /bound/,
    );
    await refusedNaming(
      { libraryId: PREDEFINED_GRADERS.latency, params: { bound: 2_000 } },
      /metric/,
    );
  });

  /**
   * A key the entry never declared is either a typo for one it did or a
   * leftover from a definition that has moved on, and both become a grader
   * quietly judging by less than somebody wrote down.
   */
  it("is refused for a value the entry never asked for, naming what it does ask", async () => {
    const refusal = await useLibraryEntry(actingAsAcme(), {
      libraryId: PREDEFINED_GRADERS.latency,
      params: {
        metric: "turn_response_latency",
        bound: 2_000,
        aggregation: "p90",
      },
    }).then(
      () => "the grader was written",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(refusal).toContain('"aggregation"');
    expect(refusal).toContain("metric");
    expect(refusal).toContain("bound");
  });

  /**
   * The mirror image, and it says the interesting half out loud: this entry
   * asks for nothing because its assertions are the test's own sentences.
   */
  it("is refused for anything at all on an entry that asks nothing", async () => {
    const refusal = await useLibraryEntry(actingAsAcme(), {
      libraryId: PREDEFINED_GRADERS.expectedBehaviors,
      params: { bound: 2_000 },
    }).then(
      () => "the grader was written",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(refusal).toContain("asks for nothing");
    expect(refusal).toContain("expected behaviors");
  });

  /**
   * The one write-door rule that is about the world rather than about the
   * shape.
   *
   * A copy names what it reads as a string, and a string naming nothing
   * produces a grader that reads nothing, judges nothing and is `skipped`
   * forever — green, silent, and wrong. Nothing downstream can catch it: a
   * missing measure is a legitimate `skipped` on a conversation whose spans do
   * not carry it, so the engine cannot tell a typo from a modality. Only this
   * moment can.
   */
  it("is refused for a measure egma does not compute, naming every one it does", async () => {
    const refusal = await useLibraryEntry(actingAsAcme(), {
      libraryId: PREDEFINED_GRADERS.latency,
      params: { metric: "turn_responze_latency", bound: 2_000 },
    }).then(
      () => "the grader was written",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(refusal).toContain('"turn_responze_latency" is not a measure');
    // Every name a copy may bound, because "then what is" is always the next
    // question and a refusal that sends somebody hunting is a refusal that cost
    // them the afternoon.
    for (const cataloged of SPAN_DERIVED_MEASURES) {
      expect(refusal).toContain(cataloged);
    }
  });

  /**
   * **A measure the catalog names and no span carries is refused too**, and the
   * refusal says which of the two things went wrong.
   *
   * The turn count is a real number Egma records. It arrives on the transition
   * that ends a simulation and lives on the simulation row, so a grader reading
   * a conversation's spans would never find it. A
   * copy naming one is exactly the forever-`skipped` check this rule exists to
   * refuse, and it is refused at the one moment anything can tell it from a
   * measure a chat conversation simply did not produce.
   */
  it("is refused for a measure the catalog names and no span carries", async () => {
    const notFromSpans = CATALOGED_MEASURES.filter(
      (measure) => !SPAN_DERIVED_MEASURES.includes(measure),
    );
    expect(notFromSpans.length).toBeGreaterThan(0);

    for (const measure of notFromSpans) {
      const refusal = await useLibraryEntry(actingAsAcme(), {
        libraryId: PREDEFINED_GRADERS.latency,
        params: { metric: measure, bound: 2_000 },
      }).then(
        () => "the grader was written",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );

      expect(refusal).toContain(`"${measure}" is a measure Egma records`);
      expect(refusal).toContain("no span carries it");
    }
  });

  /**
   * **One measure, one check, per copy — because the key has to be an
   * identity.**
   *
   * A latency verdict is filed under the measure its check bounds, and a copy's
   * config is not pinned by a run, so a position could not be the name (an edit
   * makes the next entry the first, and the key would name a different measure
   * than it did before). That makes the measure the key — and a key has to be
   * unique inside a copy or it is not one: the verdict store's sorting key ends
   * at the assertion, so two entries on one measure would collapse into a single
   * row and one of the two checks would vanish inside a single grading.
   *
   * The refusal points at the thing a second bound usually wants to be, which is
   * a second copy — `required` lives on the copy, so a blocking bound and a
   * reporting one are two copies whatever this rule said.
   */
  it("is refused a second check on a measure the copy already bounds", async () => {
    const refusal = await useLibraryEntry(actingAsAcme(), {
      libraryId: PREDEFINED_GRADERS.latency,
      params: { metric: "turn_response_latency", bound: 2_000 },
    })
      .then((created) =>
        editGrader(actingAsAcme(), created.id, {
          config: {
            assertions: [
              { metric: "turn_response_latency", bound: 2_000 },
              { metric: "turn_response_latency", bound: 500 },
            ],
          },
        }),
      )
      .then(
        () => "the grader was written",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );

    expect(refusal).toContain('already bounds "turn_response_latency"');
    expect(refusal).toContain("Press Use again for a second copy");
  });

  it("takes two checks on two different measures, which is the ordinary case", async () => {
    const created = await useLibraryEntry(actingAsAcme(), {
      libraryId: PREDEFINED_GRADERS.latency,
      name: "Two measures, one copy",
      params: { metric: "turn_response_latency", bound: 2_000 },
    });

    const edited = await editGrader(actingAsAcme(), created.id, {
      config: {
        assertions: [
          { metric: "turn_response_latency", bound: 2_000 },
          { metric: "first_response_latency", bound: 1_000 },
        ],
      },
    });

    expect(edited?.config.assertions).toEqual([
      { metric: "turn_response_latency", bound: 2_000 },
      { metric: "first_response_latency", bound: 1_000 },
    ]);
  });

  it("takes every measure a conversation's spans can carry", async () => {
    for (const cataloged of SPAN_DERIVED_MEASURES) {
      const created = await useLibraryEntry(actingAsAcme(), {
        libraryId: PREDEFINED_GRADERS.latency,
        name: `Holds ${cataloged} to something`,
        params: { metric: cataloged, bound: 2_000 },
      });
      expect(created.config.assertions).toEqual([
        { metric: cataloged, bound: 2_000 },
      ]);
    }
  });

  it("is refused when a number arrived as anything but a number", async () => {
    await refusedNaming(
      {
        libraryId: PREDEFINED_GRADERS.latency,
        params: { metric: "turn_response_latency", bound: "2000" },
      },
      /bound/,
    );
  });

  it("is refused when a measure arrived as anything but text", async () => {
    await refusedNaming(
      {
        libraryId: PREDEFINED_GRADERS.latency,
        params: { metric: 4, bound: 2_000 },
      },
      /metric/,
    );
  });
});

describe("a copy whose settings are not settings", () => {
  it("is refused for a scope or sample rate egma does not know", async () => {
    await expect(
      useLibraryEntry(actingAsAcme(), {
        ...aLatencyCopy,
        scope: "everywhere" as never,
      }),
    ).rejects.toThrow(/scope/);
    await expect(
      useLibraryEntry(actingAsAcme(), {
        ...aLatencyCopy,
        productionSampleRate: 101,
      }),
    ).rejects.toThrow(/percentage/);
    await expect(
      useLibraryEntry(actingAsAcme(), {
        ...aLatencyCopy,
        productionSampleRate: 12.5,
      }),
    ).rejects.toThrow(/percentage/);
  });

  it("is refused for a name that says nothing, and no rows are left behind", async () => {
    const before = await rowCounts();

    await expect(
      useLibraryEntry(actingAsAcme(), { ...aLatencyCopy, name: "   " }),
    ).rejects.toThrow(/name/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused for a judge egma cannot ask", async () => {
    await expect(
      useLibraryEntry(actingAsAcme(), {
        ...aBehaviorsCopy,
        judgeModel: { provider: "acme-labs" as never, model: "big" },
      }),
    ).rejects.toThrow(/supported acme-labs llm model/);
    await expect(
      useLibraryEntry(actingAsAcme(), {
        ...aBehaviorsCopy,
        judgeModel: { provider: "openai", model: " " },
      }),
    ).rejects.toThrow(/model/);
  });

  it("stores the name and the measure trimmed", async () => {
    const created = await useLibraryEntry(actingAsAcme(), {
      libraryId: PREDEFINED_GRADERS.latency,
      name: "  Padded  ",
      params: { metric: "  turn_response_latency  ", bound: 1 },
    });

    const fetched = await getGrader(actingAsAcme(), created.id);
    expect(fetched?.name).toBe("Padded");
    expect(fetched?.config.assertions).toEqual([
      { metric: "turn_response_latency", bound: 1 },
    ]);
  });
});

describe("a credential for the whole organization", () => {
  it("reads a project's graders without acting in the project", async () => {
    const created = await useLibraryEntry(actingAsAcme(), aLatencyCopy);

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
      useLibraryEntry(
        { ...actingAsAcme(), projectId: globex.project },
        aLatencyCopy,
      ),
    ).rejects.toThrow(ProjectOutsideOrganizationError);

    expect(await rowCounts()).toEqual(before);
  });

  it("returns nothing when another organization asks for my grader", async () => {
    const created = await useLibraryEntry(actingAsAcme(), aLatencyCopy);

    expect(await getGrader(actingAsGlobex(), created.id)).toBeUndefined();
  });

  it("returns nothing to the same customer acting in a sibling project", async () => {
    const created = await useLibraryEntry(actingAsAcme(), aLatencyCopy);

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
           (id, organization_id, project_id, library_id, name, current_version_id)
         values ($1, $2, $3, $4, 'Smuggled', $5)`,
        [
          newId("grd"),
          acme.organization,
          globex.project,
          PREDEFINED_GRADERS.latency,
          newId("grv"),
        ],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });
});

describe("a direct attempt to rewrite a grader version", () => {
  it("is refused before a pinned run can observe changed meaning", async () => {
    const created = await useLibraryEntry(actingAsAcme(), aLatencyCopy);

    await expect(
      database.sql(
        `update grader_version set config = '{"assertions": "two seconds"}'::jsonb where id = $1`,
        [created.versionId],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
    expect((await getGrader(actingAsAcme(), created.id))?.config).toEqual(
      created.config,
    );
  });
});

/**
 * The production sample rate, which is a promise about *which* conversations
 * are judged rather than about how many roughly are.
 *
 * Everything here is arithmetic on one row, so it is asserted here rather than
 * through the grader service: whether a rate of a quarter comes out as every
 * fourth trace is a question about the counter, and the engine's own tests ask
 * the question that is actually about grading — that a trace nobody sampled
 * carries no verdict row at all.
 */
describe("deciding whether a production trace is a grader's turn", () => {
  /** Walk `traces` conversations past a grader and say which were its turn. */
  async function walkPast(
    productionSampleRate: number,
    traces: number,
  ): Promise<boolean[]> {
    const created = await useLibraryEntry(actingAsAcme(), {
      ...aLatencyCopy,
      name: `Sampled at ${productionSampleRate} per cent`,
      scope: "production",
      productionSampleRate,
    });

    const turns: boolean[] = [];
    for (let trace = 0; trace < traces; trace += 1) {
      turns.push(await advanceProductionSampling(actingAsAcme(), created.id));
    }
    return turns;
  }

  it("makes a quarter mean every fourth trace, and the same fourth every time", async () => {
    expect(await walkPast(25, 8)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      true,
    ]);
  });

  it("judges everything at a hundred per cent and nothing at nought", async () => {
    expect(await walkPast(100, 5)).toEqual([true, true, true, true, true]);
    expect(await walkPast(0, 5)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  /**
   * A rate that does not divide a hundred has no fixed period, and that is the
   * accumulator being honest rather than a flaw. It spends exactly what it
   * accumulates and carries the rest, so thirty-three per cent of thirty
   * conversations is nine of them and nine tenths of the tenth is carried into
   * the next thirty. Nothing is rounded up on the customer's behalf, and nothing
   * is lost.
   */
  it("spends what it accumulates for a rate that divides nothing, and carries the rest", async () => {
    const turns = await walkPast(33, 30);
    expect(turns.filter(Boolean)).toHaveLength(9);
    // Nine of every three, near enough, and never two in a row: the first turn
    // is the fourth trace and they come every third one after it.
    expect(turns.indexOf(true)).toBe(3);
    expect(turns.slice(0, 10)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      true,
      false,
      false,
      true,
    ]);
  });

  it("takes a changed rate forward only, and never re-decides a trace it has passed", async () => {
    const created = await useLibraryEntry(actingAsAcme(), {
      ...aLatencyCopy,
      name: "Turned up later",
      scope: "production",
      productionSampleRate: 0,
    });

    for (let trace = 0; trace < 3; trace += 1) {
      expect(await advanceProductionSampling(actingAsAcme(), created.id)).toBe(
        false,
      );
    }

    await editGrader(actingAsAcme(), created.id, { productionSampleRate: 100 });

    // From here on, and only from here on. The three that went past while the
    // rate was nought are not reconsidered and nothing about them changes.
    expect(await advanceProductionSampling(actingAsAcme(), created.id)).toBe(
      true,
    );
  });

  /**
   * Traffic is not an edit. A grader whose modified time moved every time a call
   * came in would make "what changed on Tuesday" unanswerable, and would put a
   * write on the definition's own audit trail for every conversation a busy
   * customer has.
   */
  it("does not touch the moment the grader was last edited", async () => {
    const created = await useLibraryEntry(actingAsAcme(), {
      ...aLatencyCopy,
      name: "Busy, but unedited",
      scope: "production",
    });
    const before = (await getGrader(actingAsAcme(), created.id))?.updatedAt;

    await advanceProductionSampling(actingAsAcme(), created.id);

    expect((await getGrader(actingAsAcme(), created.id))?.updatedAt).toEqual(
      before,
    );
  });

  it("says no for a grader the caller cannot reach, which judges nothing", async () => {
    const created = await useLibraryEntry(actingAsAcme(), {
      ...aLatencyCopy,
      name: "Somebody else's",
      scope: "production",
      productionSampleRate: 100,
    });

    // The safe direction, and the only one: a grader out of reach is a grader
    // that does not judge, rather than one that judges without being reachable.
    expect(
      await advanceProductionSampling(actingAsGlobex(), created.id),
    ).toBe(false);
  });
});
