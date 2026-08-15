import {
  appendVerdicts,
  connectClickHouse,
  disconnectClickHouse,
  readRunVerdicts,
  readVerdicts,
  speakingVerdicts,
  type AuthContext,
  type NewVerdict,
  type Role,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";

/**
 * The one way anything writes a verdict, and the one way anything reads one.
 *
 * Everything here runs against a real ClickHouse, because everything here is a
 * ClickHouse behaviour: whether a re-run of the same judgment collapses onto the
 * one it replaces, whether a re-grade at a new grader version lands beside the
 * old rather than over it, whether a person's disagreement sits next to the
 * machine's word instead of erasing it. A substitute would confirm the strings
 * egma sends and nothing about what they do — and what they do is the entire
 * point of the table's identity.
 */

let store: MigratedTraceStore;

const acme = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
};
const globex = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
};

function at(customer: typeof acme, role: Role = "admin"): AuthContext {
  return {
    userId: customer.userId,
    organizationId: customer.organizationId,
    projectId: customer.projectId,
    role,
    via: "api_key",
  };
}

/** A key minted for the whole customer, which is what naming no project means. */
function acrossTheOrganization(customer: typeof acme): AuthContext {
  return { ...at(customer), projectId: undefined };
}

const GRADER = newId("grd");
const VERSION_ONE = newId("grv");
const VERSION_TWO = newId("grv");

/** An instant as the microseconds a judgment is stamped in. */
function judgedAt(instant: string): bigint {
  return BigInt(Date.parse(instant)) * 1000n;
}

/** A verdict with every field stated, which is what the type requires. */
function verdict(overrides: Partial<NewVerdict> = {}): NewVerdict {
  return {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    graderId: GRADER,
    graderVersionId: VERSION_ONE,
    dimension: "confirms the appointment time back to the caller",
    source: "simulation",
    judgedBy: "engine",
    verdict: "passed",
    score: 1,
    rationale: "the agent repeated Tuesday at four before ending the call.",
    citedSpanIds: ["00f067aa0ba902b7"],
    priority: "P0",
    runId: "run_01JQZ0000000000000000000AA",
    agentId: "agt_01JQZ0000000000000000000AA",
    agentVersionId: "agv_01JQZ0000000000000000000AA",
    judgedAtMicroseconds: judgedAt("2026-08-07T09:00:00Z"),
    ...overrides,
  };
}

beforeAll(async () => {
  store = await createMigratedTraceStore("verdicts");
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });
});

afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
});

describe("a judgment written and read back", () => {
  const traceId = "1111111111111111111111111111aaaa";

  /**
   * A `skipped` verdict says why in a word, beside the sentence saying it in
   * prose.
   *
   * Two things are skipped and neither is a failure: a grader that cannot score
   * this conversation's modality, and a threshold whose measure the
   * conversation never produced. A page has to tell them apart, and it cannot
   * do that from prose without making the prose contract — so the word has a
   * column, and the sentence stays free to be reworded.
   */
  it("keeps a skipped verdict's stated reason beside its rationale", async () => {
    await appendVerdicts(at(acme), [
      verdict({
        traceId,
        verdict: "skipped",
        score: 0,
        reason: "modality_unsupported",
        rationale:
          "This grader scores voice conversations, and this one was chat.",
      }),
    ]);

    const read = await readVerdicts(at(acme), traceId);

    expect(read.verdicts[0]).toMatchObject({
      verdict: "skipped",
      reason: "modality_unsupported",
      rationale:
        "This grader scores voice conversations, and this one was chat.",
    });
  });

  it("round-trips every field it was given", async () => {
    const written = await appendVerdicts(at(acme), [
      verdict({
        traceId,
        citedSpanIds: ["00f067aa0ba902b7", "00f067aa0ba902b8"],
        score: 0.75,
      }),
    ]);
    expect(written).toEqual({ appended: 1, batches: 1 });

    const read = await readVerdicts(at(acme), traceId);

    expect(read.verdicts).toHaveLength(1);
    expect(read.verdicts[0]).toEqual({
      traceId,
      graderId: GRADER,
      graderVersionId: VERSION_ONE,
      dimension: "confirms the appointment time back to the caller",
      source: "simulation",
      judgedBy: "engine",
      verdict: "passed",
      score: 0.75,
      rationale: "the agent repeated Tuesday at four before ending the call.",
      // Empty, and honestly so: a check that was actually made has nothing to
      // say beyond its rationale. The word is for a `skipped` row, where the
      // difference between "never about this conversation" and "nothing to
      // measure" sends a reader to two different places.
      reason: "",
      citedSpanIds: ["00f067aa0ba902b7", "00f067aa0ba902b8"],
      priority: "P0",
      runId: "run_01JQZ0000000000000000000AA",
      agentId: "agt_01JQZ0000000000000000000AA",
      agentVersionId: "agv_01JQZ0000000000000000000AA",
      judgedAtMicroseconds: judgedAt("2026-08-07T09:00:00Z"),
      judgedAt: "2026-08-07T09:00:00.000000Z",
    });
  });

  /**
   * The headline is not a column and never will be. It is the fold over the rows
   * the same read just returned, so the two cannot come apart — there is no
   * stored rollup on this path for a headline to disagree with.
   */
  it("comes back with the outcome folded from those same rows", async () => {
    const read = await readVerdicts(at(acme), traceId);

    expect(read.outcome).toEqual({
      verdict: "passed",
      score: 1,
      counts: { passed: 1, failed: 0, skipped: 0, errored: 0, total: 1 },
    });
    expect(read.byGrader).toEqual([
      { graderId: GRADER, outcome: read.outcome },
    ]);
  });

  it("is nothing at all for a conversation nobody judged", async () => {
    const read = await readVerdicts(at(acme), "not-a-trace-anybody-judged");

    expect(read.verdicts).toEqual([]);
    expect(read.byGrader).toEqual([]);
    // Nothing judged is not a pass. Ungraded and all-inapplicable are the same
    // answer, and neither of them earned a green tick.
    expect(read.outcome).toEqual({
      verdict: "skipped",
      score: undefined,
      counts: { passed: 0, failed: 0, skipped: 0, errored: 0, total: 0 },
    });
  });
});

describe("the customer a verdict belongs to", () => {
  it("comes from the context and cannot be passed in, because there is nowhere to pass it", async () => {
    const traceId = "2222222222222222222222222222aaaa";
    await appendVerdicts(at(acme), [verdict({ traceId })]);
    await appendVerdicts(at(globex), [
      verdict({ traceId, verdict: "failed", score: 0 }),
    ]);

    const rows = await store.rows<{
      organization_id: string;
      project_id: string;
      verdict: string;
    }>(
      `select organization_id, project_id, verdict from verdicts ` +
        `where trace_id = '${traceId}' order by organization_id`,
    );
    expect(rows).toHaveLength(2);

    // Each reads its own, including when the conversation id is guessed exactly
    // right: the organization leads the filing order, so the other customer's
    // query never reaches the rows at all.
    const mine = await readVerdicts(at(acme), traceId);
    expect(mine.verdicts.map((row) => row.verdict)).toEqual(["passed"]);

    const theirs = await readVerdicts(at(globex), traceId);
    expect(theirs.verdicts.map((row) => row.verdict)).toEqual(["failed"]);
    expect(theirs.outcome.verdict).toBe("failed");
  });

  it("files under the project sentinel when the credential names no project", async () => {
    const traceId = "2222222222222222222222222222bbbb";
    await appendVerdicts(acrossTheOrganization(acme), [verdict({ traceId })]);

    const [row] = await store.rows<{ project_id: string }>(
      `select project_id from verdicts where trace_id = '${traceId}'`,
    );
    expect(row?.project_id).toBe("default");
  });

  /**
   * A key minted for one product area reads that product area. The argument can
   * only narrow an organization-wide credential; it can never widen a key that
   * already names a project into somebody else's.
   */
  it("narrows to a project by argument, and is never widened by one", async () => {
    const traceId = "2222222222222222222222222222cccc";
    const elsewhere = newId("prj");

    await appendVerdicts(at(acme), [verdict({ traceId })]);

    const asked = await readVerdicts(acrossTheOrganization(acme), traceId, {
      projectId: acme.projectId,
    });
    expect(asked.verdicts).toHaveLength(1);

    const narrowed = await readVerdicts(acrossTheOrganization(acme), traceId, {
      projectId: elsewhere,
    });
    expect(narrowed.verdicts).toEqual([]);

    // The credential's own project is what a key that names one reads, whatever
    // the argument says.
    const pinned = await readVerdicts(at(acme), traceId, {
      projectId: elsewhere,
    });
    expect(pinned.verdicts).toHaveLength(1);
  });

  it("is readable by a viewer, because looking at a judgment is the product", async () => {
    const traceId = "2222222222222222222222222222dddd";
    await appendVerdicts(at(acme), [verdict({ traceId })]);

    const read = await readVerdicts(at(acme, "viewer"), traceId);
    expect(read.verdicts).toHaveLength(1);
  });
});

describe("judging the same thing again", () => {
  const traceId = "3333333333333333333333333333aaaa";

  /**
   * The same grader, at the same version, saying something about the same
   * dimension again is a re-run after a transient error — not a second opinion.
   * The identity collapses it and the later `event_ts` wins, which is what makes
   * grading a simulation twice safe rather than something a caller has to
   * remember not to do.
   */
  it("replaces at the same grader version rather than doubling the row", async () => {
    await appendVerdicts(at(acme), [
      verdict({
        traceId,
        verdict: "errored",
        score: 0,
        rationale: "the judge call timed out.",
      }),
    ]);
    await appendVerdicts(at(acme), [
      verdict({
        traceId,
        verdict: "passed",
        score: 1,
        rationale: "the agent repeated the time back.",
        judgedAtMicroseconds: judgedAt("2026-08-07T09:05:00Z"),
      }),
    ]);

    const read = await readVerdicts(at(acme), traceId);

    expect(read.verdicts).toHaveLength(1);
    expect(read.verdicts[0]?.verdict).toBe("passed");
    expect(read.verdicts[0]?.rationale).toBe("the agent repeated the time back.");
    expect(read.outcome.counts.total).toBe(1);
  });

  /**
   * And the collapse is the engine's rather than the reader's luck: `FINAL` is
   * what makes it true at the moment of asking, because the background merge
   * that would otherwise do it happens whenever it happens. Asserted against the
   * raw table, which still holds both rows until then.
   */
  it("is still one answer before the store has merged anything", async () => {
    // The merge that eventually collapses the two rows on disk happens whenever
    // it happens, and a read cannot wait for it. Held off here so that what is
    // being asserted is the read doing the work rather than a merge that got
    // there first.
    await store.command("system stop merges verdicts");
    try {
      const held = "3333333333333333333333333333cccc";
      await appendVerdicts(at(acme), [
        verdict({ traceId: held, verdict: "errored", score: 0 }),
      ]);
      await appendVerdicts(at(acme), [
        verdict({
          traceId: held,
          verdict: "passed",
          score: 1,
          judgedAtMicroseconds: judgedAt("2026-08-07T09:05:00Z"),
        }),
      ]);

      expect(
        await store.rows(`select 1 from verdicts where trace_id = '${held}'`),
      ).toHaveLength(2);

      const read = await readVerdicts(at(acme), held);
      expect(read.verdicts).toHaveLength(1);
      expect(read.verdicts[0]?.verdict).toBe("passed");
      expect(read.outcome.counts.total).toBe(1);
    } finally {
      await store.command("system start merges verdicts");
    }
  });

  /**
   * Re-grading at a tightened grader is the case the identity was designed
   * around. Both rows are kept, because "v1 said pass, v2 says fail" is exactly
   * the comparison that makes editing a grader meaningful — and the fold counts
   * the dimension once, at the newer grading, so the old mistake does not go on
   * failing the run forever.
   */
  it("adds beside the old row when the grader version changed", async () => {
    const regraded = "3333333333333333333333333333bbbb";

    await appendVerdicts(at(acme), [verdict({ traceId: regraded })]);
    await appendVerdicts(at(acme), [
      verdict({
        traceId: regraded,
        graderVersionId: VERSION_TWO,
        verdict: "failed",
        score: 0,
        rationale: "the tightened grader wanted the date as well as the time.",
        judgedAtMicroseconds: judgedAt("2026-08-08T09:00:00Z"),
      }),
    ]);

    const read = await readVerdicts(at(acme), regraded);

    // Both gradings are on the table and both come back.
    expect(read.verdicts).toHaveLength(2);
    expect(read.verdicts.map((row) => row.graderVersionId).sort()).toEqual(
      [VERSION_ONE, VERSION_TWO].sort(),
    );

    // And the dimension is counted once, at the newer one.
    expect(read.outcome).toEqual({
      verdict: "failed",
      score: 0,
      counts: { passed: 0, failed: 1, skipped: 0, errored: 0, total: 1 },
    });
    expect(speakingVerdicts(read.verdicts).map((row) => row.graderVersionId)).toEqual([
      VERSION_TWO,
    ]);
  });
});

describe("a person disagreeing with the machine", () => {
  const traceId = "4444444444444444444444444444aaaa";

  /**
   * The correction is a row of its own with the same identity except for who
   * judged, so the store keeps both. That is the whole arrangement: the record
   * shows the reviewer's judgment without erasing the machine's, and the pair is
   * the ground truth a future measurement of judge accuracy is made of.
   */
  it("writes a row beside the machine's rather than over it", async () => {
    await appendVerdicts(at(acme), [
      verdict({
        traceId,
        verdict: "failed",
        score: 0,
        rationale: "no confirmation of the time was found.",
      }),
    ]);
    await appendVerdicts(at(acme), [
      verdict({
        traceId,
        judgedBy: "human",
        verdict: "passed",
        score: 1,
        rationale: "the caller said it back and the agent agreed; the judge missed it.",
        judgedAtMicroseconds: judgedAt("2026-08-07T11:00:00Z"),
      }),
    ]);

    const read = await readVerdicts(at(acme), traceId);

    expect(read.verdicts).toHaveLength(2);
    expect(read.verdicts.map((row) => row.judgedBy).sort()).toEqual([
      "engine",
      "human",
    ]);

    // Counted once, and the person's word is the one that counts.
    expect(read.outcome).toEqual({
      verdict: "passed",
      score: 1,
      counts: { passed: 1, failed: 0, skipped: 0, errored: 0, total: 1 },
    });
    expect(speakingVerdicts(read.verdicts).map((row) => row.judgedBy)).toEqual([
      "human",
    ]);
  });

  it("changes their mind by replacing their own row, never by stacking a third voice", async () => {
    await appendVerdicts(at(acme), [
      verdict({
        traceId,
        judgedBy: "human",
        verdict: "skipped",
        score: 0,
        rationale: "on reflection this behavior does not apply over the phone.",
        judgedAtMicroseconds: judgedAt("2026-08-07T12:00:00Z"),
      }),
    ]);

    const read = await readVerdicts(at(acme), traceId);

    expect(read.verdicts).toHaveLength(2);
    expect(
      read.verdicts.filter((row) => row.judgedBy === "human"),
    ).toHaveLength(1);
    expect(read.outcome).toEqual({
      verdict: "skipped",
      score: undefined,
      counts: { passed: 0, failed: 0, skipped: 1, errored: 0, total: 1 },
    });
  });
});

describe("a whole simulation's worth of judgments", () => {
  const traceId = "5555555555555555555555555555aaaa";
  const behaviors = newId("grd");
  const latency = newId("grd");

  /**
   * Four expected behaviors judged one at a time plus a threshold grader, which
   * is the shape a graded simulation actually has. Nothing anywhere stores what
   * it adds up to.
   */
  it("folds to one answer per grader and one overall, all at read time", async () => {
    await appendVerdicts(at(acme), [
      verdict({
        traceId,
        graderId: behaviors,
        dimension: "greets the caller by name",
        verdict: "passed",
        score: 1,
      }),
      verdict({
        traceId,
        graderId: behaviors,
        dimension: "offers the next available slot",
        verdict: "failed",
        score: 0,
      }),
      verdict({
        traceId,
        graderId: behaviors,
        dimension: "reads the address back",
        verdict: "skipped",
        score: 0,
        priority: "P2",
      }),
      verdict({
        traceId,
        graderId: behaviors,
        dimension: "ends the call politely",
        verdict: "passed",
        score: 1,
      }),
      verdict({
        traceId,
        graderId: latency,
        dimension: "p90 turn latency under 2000ms",
        judgedBy: "engine",
        verdict: "passed",
        score: 1,
        priority: "P1",
      }),
    ]);

    const read = await readVerdicts(at(acme), traceId);

    expect(read.verdicts).toHaveLength(5);
    expect(read.outcome).toEqual({
      verdict: "failed",
      // Three passed of the four that could be scored: the skipped dimension is
      // out of the denominator rather than counted against anybody.
      score: 0.75,
      counts: { passed: 3, failed: 1, skipped: 1, errored: 0, total: 5 },
    });

    expect(read.byGrader).toEqual(
      [
        {
          graderId: behaviors,
          outcome: {
            verdict: "failed",
            score: 2 / 3,
            counts: { passed: 2, failed: 1, skipped: 1, errored: 0, total: 4 },
          },
        },
        {
          graderId: latency,
          outcome: {
            verdict: "passed",
            score: 1,
            counts: { passed: 1, failed: 0, skipped: 0, errored: 0, total: 1 },
          },
        },
      ].sort((left, right) => (left.graderId < right.graderId ? -1 : 1)),
    );
  });

  /**
   * Asking the same question of a smaller set of rows is how "did every P0
   * pass" is answered, rather than by a second algebra living beside the first.
   */
  it("answers a priority question by folding the rows of that priority", async () => {
    const { verdicts } = await readVerdicts(at(acme), traceId);
    const blocking = verdicts.filter((row) => row.priority === "P0");

    expect(blocking).toHaveLength(3);
    expect(speakingVerdicts(blocking)).toHaveLength(3);
  });
});

/**
 * A whole run, at both grains, from one fold and no stored anything.
 *
 * The run header's verdict counts are computed here at the moment of asking,
 * exactly as a conversation's are, which is the property the spec asks for: an
 * overall answer that can never disagree with the evidence beneath it. So the
 * assertion that matters most below is the arithmetic one — the run's counts are
 * the conversations' counts added up, because supersession is decided inside a
 * conversation and folding the run whole is therefore the same sum.
 */
describe("a whole run's worth of judgments", () => {
  const runId = "run_01JQZ0000000000000000000BB";
  const elsewhere = "run_01JQZ0000000000000000000CC";

  const wentWell = "1111111111111111111111111111bbbb";
  const disagreed = "2222222222222222222222222222bbbb";
  const brokeDown = "3333333333333333333333333333bbbb";
  const notScored = "4444444444444444444444444444bbbb";
  const anotherRun = "5555555555555555555555555555bbbb";
  const anotherCustomer = "6666666666666666666666666666bbbb";

  const behaviors = newId("grd");
  const latency = newId("grd");

  /** Four conversations of one run, judged the four ways they can be. */
  beforeAll(async () => {
    await appendVerdicts(at(acme), [
      // One that went well, judged by two graders.
      verdict({
        traceId: wentWell,
        runId,
        graderId: behaviors,
        dimension: "confirms the new time back",
        verdict: "passed",
        score: 1,
      }),
      verdict({
        traceId: wentWell,
        runId,
        graderId: latency,
        dimension: "metric_threshold",
        verdict: "passed",
        score: 1,
        priority: "P1",
      }),
      // One the machine failed and a person disagreed with.
      verdict({
        traceId: disagreed,
        runId,
        graderId: behaviors,
        dimension: "confirms the new time back",
        verdict: "failed",
        score: 0,
        rationale: "no confirmation of the time was found.",
      }),
      verdict({
        traceId: disagreed,
        runId,
        graderId: behaviors,
        dimension: "confirms the new time back",
        judgedBy: "human",
        verdict: "passed",
        score: 1,
        rationale: "the agent said it back at turn six; the judge missed it.",
        judgedAtMicroseconds: judgedAt("2026-08-07T11:00:00Z"),
      }),
      // One egma could not judge — never `failed`, which is the distinction the
      // fold carries all the way up to this header.
      verdict({
        traceId: brokeDown,
        runId,
        graderId: behaviors,
        dimension: "confirms the new time back",
        verdict: "errored",
        score: 0,
        rationale: "this simulation ended before the agent joined.",
      }),
      // And one whose only check did not apply.
      verdict({
        traceId: notScored,
        runId,
        graderId: latency,
        dimension: "metric_threshold",
        verdict: "skipped",
        score: 0,
        priority: "P2",
        rationale: "a chat simulation records no audio latency.",
      }),
      // Two rows that must not reach it: another run of the same customer's…
      verdict({
        traceId: anotherRun,
        runId: elsewhere,
        graderId: behaviors,
        verdict: "failed",
        score: 0,
      }),
    ]);

    // …and another customer's run wearing the same id, which is the only way to
    // show the tenancy predicate is doing work rather than the id being unique.
    await appendVerdicts(at(globex), [
      verdict({
        traceId: anotherCustomer,
        runId,
        graderId: behaviors,
        verdict: "failed",
        score: 0,
      }),
    ]);
  });

  it("folds each conversation and the run itself, at read time, from the same rows", async () => {
    const read = await readRunVerdicts(at(acme), runId);

    expect(read.runId).toBe(runId);
    expect(read.simulations).toEqual([
      {
        simulationId: wentWell,
        outcome: {
          verdict: "passed",
          score: 1,
          counts: { passed: 2, failed: 0, skipped: 0, errored: 0, total: 2 },
        },
      },
      {
        // The person's word, not the machine's, and the machine's row is still
        // on the table underneath it.
        simulationId: disagreed,
        outcome: {
          verdict: "passed",
          score: 1,
          counts: { passed: 1, failed: 0, skipped: 0, errored: 0, total: 1 },
        },
      },
      {
        simulationId: brokeDown,
        outcome: {
          verdict: "errored",
          score: 0,
          counts: { passed: 0, failed: 0, skipped: 0, errored: 1, total: 1 },
        },
      },
      {
        simulationId: notScored,
        outcome: {
          verdict: "skipped",
          // A proportion of nothing is not a number, and both available lies
          // are worse than saying so.
          score: undefined,
          counts: { passed: 0, failed: 0, skipped: 1, errored: 0, total: 1 },
        },
      },
    ]);

    // Nothing failed once the correction is counted, and one conversation egma
    // could not judge — so the run errored rather than passed. A run that went
    // green because a simulation never ran is the exact false trust the words
    // `skipped` and `errored` exist to prevent.
    expect(read.outcome).toEqual({
      verdict: "errored",
      score: 0.75,
      counts: { passed: 3, failed: 0, skipped: 1, errored: 1, total: 5 },
    });
  });

  it("adds up: the run's counts are its conversations' counts, because it is one fold", async () => {
    const read = await readRunVerdicts(at(acme), runId);

    const summed = read.simulations.reduce(
      (running, { outcome }) => ({
        passed: running.passed + outcome.counts.passed,
        failed: running.failed + outcome.counts.failed,
        skipped: running.skipped + outcome.counts.skipped,
        errored: running.errored + outcome.counts.errored,
        total: running.total + outcome.counts.total,
      }),
      { passed: 0, failed: 0, skipped: 0, errored: 0, total: 0 },
    );

    // Folding the run whole and folding each conversation and adding up are the
    // same arithmetic, because supersession is decided inside one conversation's
    // dimensions. That is what makes a run header and the rows on the page
    // beneath it incapable of disagreeing.
    expect(summed).toEqual(read.outcome.counts);
  });

  it("says which check failed across the run, from that same fold", async () => {
    const read = await readRunVerdicts(at(acme), runId);

    expect(read.byGrader).toEqual(
      [
        {
          graderId: behaviors,
          outcome: {
            verdict: "errored",
            score: 2 / 3,
            counts: { passed: 2, failed: 0, skipped: 0, errored: 1, total: 3 },
          },
        },
        {
          graderId: latency,
          outcome: {
            verdict: "passed",
            score: 1,
            counts: { passed: 1, failed: 0, skipped: 1, errored: 0, total: 2 },
          },
        },
      ].sort((left, right) => (left.graderId < right.graderId ? -1 : 1)),
    );
  });

  it("reaches no other run and no other customer, whatever the run is called", async () => {
    const mine = await readRunVerdicts(at(acme), runId);
    expect(mine.simulations.map((one) => one.simulationId)).not.toContain(
      anotherRun,
    );
    expect(mine.simulations.map((one) => one.simulationId)).not.toContain(
      anotherCustomer,
    );

    // Globex asks for the same run id and gets its own one conversation, which
    // is the whole of what it has under that name.
    const theirs = await readRunVerdicts(at(globex), runId);
    expect(theirs.simulations.map((one) => one.simulationId)).toEqual([
      anotherCustomer,
    ]);
    expect(theirs.outcome.verdict).toBe("failed");
  });

  it("is nothing at all for a run nobody has judged, and says so as `skipped`", async () => {
    const read = await readRunVerdicts(at(acme), newId("run"));

    expect(read.simulations).toEqual([]);
    // Nothing judged has earned no green tick, and this is the one place that
    // rule shows up as a whole run's answer.
    expect(read.outcome).toEqual({
      verdict: "skipped",
      score: undefined,
      counts: { passed: 0, failed: 0, skipped: 0, errored: 0, total: 0 },
    });
    expect(read.byGrader).toEqual([]);
  });

  it("is readable by a viewer, exactly as one conversation's answer is", async () => {
    const read = await readRunVerdicts(at(acme, "viewer"), runId);
    expect(read.simulations).toHaveLength(4);
  });
});

describe("a batch bigger than one insert", () => {
  it("is split rather than refused, with every row landing", async () => {
    const traceId = "6666666666666666666666666666aaaa";
    const many = Array.from({ length: 5_001 }, (_, index) =>
      verdict({ traceId, dimension: `behavior ${index}` }),
    );

    const written = await appendVerdicts(at(acme), many);

    expect(written.appended).toBe(many.length);
    expect(written.batches).toBe(2);

    const read = await readVerdicts(at(acme), traceId);
    expect(read.verdicts).toHaveLength(many.length);
    expect(read.outcome.counts.total).toBe(many.length);
  });

  it("is not an insert at all when there is nothing in it", async () => {
    expect(await appendVerdicts(at(acme), [])).toEqual({
      appended: 0,
      batches: 0,
    });
  });
});
