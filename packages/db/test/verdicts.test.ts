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
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";

/**
 * The one way anything writes a verdict, and the one way anything reads one.
 *
 * Everything here runs against a real ClickHouse, because everything here is a
 * ClickHouse behaviour: whether a re-run of the same judgment collapses onto the
 * one it replaces, whether a re-grade at a new grader version lands beside the
 * old rather than over it, whether a second grader's word about the same
 * assertion stands on its own. A substitute would confirm the strings egma sends
 * and nothing about what they do — and what they do is the entire point of the
 * table's identity.
 *
 * **Postgres is here too, and only for one question.** A read folds the required
 * copies apart from the diagnostic ones, and which is which is a live setting on
 * the copy — so the read asks the control plane at the moment of asking rather
 * than trusting a flag frozen into a row months ago. Every grader id below that
 * names no copy is therefore one this cannot resolve, and it counts as required,
 * which is the safe direction and what these cases assert without saying so.
 */

let store: MigratedTraceStore;
let database: MigratedDatabase;

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
    assertion: "behavior_1",
    source: "simulation",
    verdict: "passed",
    score: 1,
    rationale: "the agent repeated Tuesday at four before ending the call.",
    citedSpanIds: ["00f067aa0ba902b7"],
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
  database = await createConnectedDatabase("verdicts");
});

afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
  await database.drop();
});

describe("a judgment written and read back", () => {
  const traceId = "1111111111111111111111111111aaaa";

  /*
   * **A `skipped` verdict states no machine-readable reason, and it used to.**
   * There was a `reason` column beside the rationale — `modality_unsupported`
   * on a grader that could not score this conversation — and it went with the
   * modality check that was the only thing that ever wrote one. The idea is
   * not retired: the glossary still says a grader that cannot score the
   * modality is *skipped* and that a results page has to say `skipped` rather
   * than `failed`. The column returns together with modality skipping, as its
   * own ticket, and a proof of it belongs here when it does.
   */

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
      assertion: "behavior_1",
      source: "simulation",
      verdict: "passed",
      score: 0.75,
      rationale: "the agent repeated Tuesday at four before ending the call.",
      // Empty, and honestly so: a check that was actually made has nothing to
      // say beyond its rationale. The word is for a `skipped` row, where the
      // difference between "never about this conversation" and "nothing to
      // measure" sends a reader to two different places.
      reason: "",
      citedSpanIds: ["00f067aa0ba902b7", "00f067aa0ba902b8"],
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
    // `required: true` because nothing here is a running copy this read can
    // resolve, and a grader it cannot resolve decides — the safe direction.
    expect(read.byGrader).toEqual([
      { graderId: GRADER, required: true, outcome: read.outcome },
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
   * assertion again is a re-run after a transient error — not a second opinion.
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
   * the assertion once, at the newer grading, so the old mistake does not go on
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

    // And the assertion is counted once, at the newer one.
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

describe("a second grader judging the same assertion key", () => {
  const traceId = "4444444444444444444444444444aaaa";
  const otherGrader = newId("grd");

  /**
   * The identity ends at `source` now, so what keeps two words apart is the
   * grader that said them. This is the shape a human word will arrive in when
   * corrections return as the reserved `human` type: its own grader id, its own
   * rows, standing beside the machine's rather than on top of them — and needing
   * no `judged_by` to do it.
   *
   * Two graders may perfectly well key their assertions the same way — a
   * position is a position — so this is the case that would collapse if the
   * grader id had been left out of the identity.
   */
  it("writes its own rows rather than replacing the first grader's", async () => {
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
        graderId: otherGrader,
        verdict: "passed",
        score: 1,
        rationale: "the caller said it back and the agent agreed.",
        judgedAtMicroseconds: judgedAt("2026-08-07T11:00:00Z"),
      }),
    ]);

    const read = await readVerdicts(at(acme), traceId);

    expect(read.verdicts).toHaveLength(2);
    expect(read.verdicts.map((row) => row.graderId).sort()).toEqual(
      [GRADER, otherGrader].sort(),
    );

    // Both count, because they are two graders' assertions and not two words
    // about one. Binary scoring then says the conversation failed: every
    // assertion of every grader has to pass.
    expect(speakingVerdicts(read.verdicts)).toHaveLength(2);
    expect(read.outcome).toEqual({
      verdict: "failed",
      score: 0.5,
      counts: { passed: 1, failed: 1, skipped: 0, errored: 0, total: 2 },
    });
  });

  /**
   * And the other half of the same rule: the second grader re-judging its own
   * assertion at the same version replaces its own row and leaves the first
   * grader's alone.
   */
  it("replaces its own row when it judges again, and only its own", async () => {
    await appendVerdicts(at(acme), [
      verdict({
        traceId,
        graderId: otherGrader,
        verdict: "skipped",
        score: 0,
        rationale: "this assertion does not apply over the phone.",
        judgedAtMicroseconds: judgedAt("2026-08-07T12:00:00Z"),
      }),
    ]);

    const read = await readVerdicts(at(acme), traceId);

    expect(read.verdicts).toHaveLength(2);
    expect(
      read.verdicts.filter((row) => row.graderId === otherGrader),
    ).toHaveLength(1);
    expect(read.outcome).toEqual({
      verdict: "failed",
      // The skipped assertion leaves the denominator, and the first grader's
      // failure is the whole of what is left.
      score: 0,
      counts: { passed: 0, failed: 1, skipped: 1, errored: 0, total: 2 },
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
        assertion: "behavior_1",
        verdict: "passed",
        score: 1,
      }),
      verdict({
        traceId,
        graderId: behaviors,
        assertion: "behavior_2",
        verdict: "failed",
        score: 0,
      }),
      verdict({
        traceId,
        graderId: behaviors,
        assertion: "behavior_3",
        verdict: "skipped",
        score: 0,
      }),
      verdict({
        traceId,
        graderId: behaviors,
        assertion: "behavior_4",
        verdict: "passed",
        score: 1,
      }),
      verdict({
        traceId,
        graderId: latency,
        assertion: "0",
        verdict: "passed",
        score: 1,
      }),
    ]);

    const read = await readVerdicts(at(acme), traceId);

    expect(read.verdicts).toHaveLength(5);
    expect(read.outcome).toEqual({
      verdict: "failed",
      // Three passed of the four that could be scored: the skipped assertion is
      // out of the denominator rather than counted against anybody.
      score: 0.75,
      counts: { passed: 3, failed: 1, skipped: 1, errored: 0, total: 5 },
    });

    expect(read.byGrader).toEqual(
      [
        {
          graderId: behaviors,
          required: true,
          outcome: {
            verdict: "failed",
            score: 2 / 3,
            counts: { passed: 2, failed: 1, skipped: 1, errored: 0, total: 4 },
          },
        },
        {
          graderId: latency,
          required: true,
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
   * Asking the same question of a smaller set of rows is how one grader's own
   * answer is worked out, rather than by a second algebra living beside the
   * first — and it is the same fold `byGrader` above uses.
   */
  it("answers a per-grader question by folding that grader's rows", async () => {
    const { verdicts } = await readVerdicts(at(acme), traceId);
    const itsOwn = verdicts.filter((row) => row.graderId === behaviors);

    expect(itsOwn).toHaveLength(4);
    expect(speakingVerdicts(itsOwn)).toHaveLength(4);
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
  const regraded = "2222222222222222222222222222bbbb";
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
        assertion: "behavior_1",
        verdict: "passed",
        score: 1,
      }),
      verdict({
        traceId: wentWell,
        runId,
        graderId: latency,
        assertion: "0",
        verdict: "passed",
        score: 1,
      }),
      // One the grader failed at version 1 and passed when it was re-graded.
      verdict({
        traceId: regraded,
        runId,
        graderId: behaviors,
        assertion: "behavior_1",
        verdict: "failed",
        score: 0,
        rationale: "no confirmation of the time was found.",
      }),
      verdict({
        traceId: regraded,
        runId,
        graderId: behaviors,
        graderVersionId: VERSION_TWO,
        assertion: "behavior_1",
        verdict: "passed",
        score: 1,
        rationale: "the agent said it back at turn six; the sharpened judge saw it.",
        judgedAtMicroseconds: judgedAt("2026-08-07T11:00:00Z"),
      }),
      // One egma could not judge — never `failed`, which is the distinction the
      // fold carries all the way up to this header.
      verdict({
        traceId: brokeDown,
        runId,
        graderId: behaviors,
        assertion: "behavior_1",
        verdict: "errored",
        score: 0,
        rationale: "this simulation ended before the agent joined.",
      }),
      // And one whose only check did not apply.
      verdict({
        traceId: notScored,
        runId,
        graderId: latency,
        assertion: "0",
        verdict: "skipped",
        score: 0,
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
        // The newer grading's word, with version 1's row still on the table
        // underneath it.
        simulationId: regraded,
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

    // Nothing failed once the re-grade is counted, and one conversation egma
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
    // assertions. That is what makes a run header and the rows on the page
    // beneath it incapable of disagreeing.
    expect(summed).toEqual(read.outcome.counts);
  });

  it("says which check failed across the run, from that same fold", async () => {
    const read = await readRunVerdicts(at(acme), runId);

    expect(read.byGrader).toEqual(
      [
        {
          graderId: behaviors,
          required: true,
          outcome: {
            verdict: "errored",
            score: 2 / 3,
            counts: { passed: 2, failed: 0, skipped: 0, errored: 1, total: 3 },
          },
        },
        {
          graderId: latency,
          required: true,
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
      verdict({ traceId, assertion: `behavior_${index}` }),
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
