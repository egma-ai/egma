import {
  appendVerdicts,
  connectClickHouse,
  correctVerdict,
  disconnectClickHouse,
  JUDGED_BY_HUMAN,
  NotPermittedError,
  readVerdicts,
  speakingVerdicts,
  type AuthContext,
  type NewVerdict,
  type RecordedVerdict,
  type Role,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";

/**
 * The human word: disagreeing with a verdict, and having the disagreement be
 * what counts without erasing what it disagrees with.
 *
 * Everything here runs against a real ClickHouse, because the two things worth
 * proving are the store's: that a person's row lands *beside* the machine's
 * because the identity spans who judged, and that a second correction lands *on*
 * the first because it does not. A substitute would confirm the strings egma
 * sends and nothing about which rows survive.
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

function at(customer: typeof acme, role: Role = "member"): AuthContext {
  return {
    userId: customer.userId,
    organizationId: customer.organizationId,
    projectId: customer.projectId,
    role,
    via: "session",
  };
}

const GRADER = newId("grd");
const VERSION_ONE = newId("grv");
const VERSION_TWO = newId("grv");
const DIMENSION = "confirms the appointment time back to the caller";

function judgedAt(instant: string): bigint {
  return BigInt(Date.parse(instant)) * 1000n;
}

/** What the engine said, with every field stated as the type requires. */
function machineVerdict(overrides: Partial<NewVerdict> = {}): NewVerdict {
  return {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    graderId: GRADER,
    graderVersionId: VERSION_ONE,
    dimension: DIMENSION,
    source: "simulation",
    judgedBy: "gpt-4o-mini",
    verdict: "failed",
    score: 0,
    rationale: "the agent never said the time back.",
    citedSpanIds: ["00f067aa0ba902b7"],
    priority: "P1",
    runId: "run_01JQZ0000000000000000000AA",
    agentId: "agt_01JQZ0000000000000000000AA",
    agentVersionId: "",
    judgedAtMicroseconds: judgedAt("2026-08-01T09:00:00Z"),
    ...overrides,
  };
}

/** Every row on this conversation, superseded ones included. */
async function rowsOn(traceId: string): Promise<readonly RecordedVerdict[]> {
  return (await readVerdicts(at(acme), traceId)).verdicts;
}

beforeAll(async () => {
  store = await createMigratedTraceStore("verdict_corrections");
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });
});

afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
});

describe("a reviewer disagreeing with a judgment", () => {
  const traceId = "1111111111111111111111111111aaaa";

  it("writes a whole verdict row of their own, and leaves the machine's exactly where it was", async () => {
    const machine = machineVerdict({ traceId });
    await appendVerdicts(at(acme), [machine]);

    const written = await correctVerdict(at(acme), {
      traceId,
      graderId: GRADER,
      graderVersionId: VERSION_ONE,
      dimension: DIMENSION,
      source: "simulation",
      verdict: "passed",
      rationale: "she said 'Tuesday at four' at 00:41; the judge missed it.",
      citedSpanIds: ["00f067aa0ba902b9"],
    });

    expect(written).toMatchObject({
      traceId,
      graderId: GRADER,
      graderVersionId: VERSION_ONE,
      dimension: DIMENSION,
      source: "simulation",
      judgedBy: JUDGED_BY_HUMAN,
      verdict: "passed",
      rationale: "she said 'Tuesday at four' at 00:41; the judge missed it.",
      citedSpanIds: ["00f067aa0ba902b9"],
    });

    const rows = await rowsOn(traceId);
    expect(rows).toHaveLength(2);

    // Beside, not over: the machine's judgment is still on the table, word for
    // word, which is what makes the pair worth keeping at all.
    const beneath = rows.find((row) => row.judgedBy === "gpt-4o-mini");
    expect(beneath).toMatchObject({
      verdict: "failed",
      score: 0,
      rationale: "the agent never said the time back.",
      judgedAtMicroseconds: machine.judgedAtMicroseconds,
    });
  });

  it("is the row that counts, so the conversation's answer is theirs", async () => {
    const read = await readVerdicts(at(acme), traceId);

    const speaking = speakingVerdicts(read.verdicts);
    expect(speaking).toHaveLength(1);
    expect(speaking[0]?.judgedBy).toBe(JUDGED_BY_HUMAN);

    expect(read.outcome.verdict).toBe("passed");
    expect(read.outcome.counts).toMatchObject({ passed: 1, failed: 0, total: 1 });
  });

  it("keeps the priority the judgment was made under, rather than today's", async () => {
    const rows = await rowsOn(traceId);

    // The machine judged this a P1 warning. Promoting the grader to P0 this
    // morning does not make last week's warning a blocker, and a person
    // disagreeing with the warning is disagreeing with a warning.
    for (const row of rows) expect(row.priority).toBe("P1");
  });

  it("carries the conversation's own facts, copied from the row it answers", async () => {
    const rows = await rowsOn(traceId);
    const said = rows.find((row) => row.judgedBy === JUDGED_BY_HUMAN);

    expect(said).toMatchObject({
      runId: "run_01JQZ0000000000000000000AA",
      agentId: "agt_01JQZ0000000000000000000AA",
      agentVersionId: "",
    });
  });
});

describe("a second correction of the same judgment", () => {
  const traceId = "2222222222222222222222222222aaaa";

  it("replaces the first, and never stacks a third voice", async () => {
    await appendVerdicts(at(acme), [machineVerdict({ traceId })]);

    const identity = {
      traceId,
      graderId: GRADER,
      graderVersionId: VERSION_ONE,
      dimension: DIMENSION,
      source: "simulation",
    } as const;

    const first = await correctVerdict(at(acme), {
      ...identity,
      verdict: "passed",
      rationale: "she confirmed the time, near the end.",
    });
    const second = await correctVerdict(at(acme), {
      ...identity,
      verdict: "skipped",
      rationale: "on a second read this check never applied to a chat call.",
    });

    // Later than the word it replaces, which is what makes the store keep it.
    expect(second.judgedAtMicroseconds).toBeGreaterThan(
      first.judgedAtMicroseconds,
    );

    const rows = await rowsOn(traceId);
    const human = rows.filter((row) => row.judgedBy === JUDGED_BY_HUMAN);

    expect(rows).toHaveLength(2);
    expect(human).toHaveLength(1);
    expect(human[0]).toMatchObject({
      verdict: "skipped",
      rationale: "on a second read this check never applied to a chat call.",
    });
    // And the machine is still underneath both of them.
    expect(rows.some((row) => row.judgedBy === "gpt-4o-mini")).toBe(true);
  });

  it("keeps the snapshot the machine's row carried, through however many voices", async () => {
    for (const row of await rowsOn(traceId)) expect(row.priority).toBe("P1");
  });
});

describe("a correction of one grading", () => {
  const traceId = "3333333333333333333333333333aaaa";

  /**
   * The rule the fold holds and this proves through the door: somebody answers
   * the grading they read, which is the only one they can have read. Their word
   * stands against that grading and does not drag it back in front of a newer
   * one that nobody has disagreed with.
   */
  it("does not pull an older grading in front of a newer one", async () => {
    await appendVerdicts(at(acme), [
      machineVerdict({ traceId, verdict: "failed" }),
      machineVerdict({
        traceId,
        graderVersionId: VERSION_TWO,
        verdict: "passed",
        score: 1,
        rationale: "the tightened check reads the confirmation correctly.",
        judgedAtMicroseconds: judgedAt("2026-08-02T09:00:00Z"),
      }),
    ]);

    await correctVerdict(at(acme), {
      traceId,
      graderId: GRADER,
      graderVersionId: VERSION_ONE,
      dimension: DIMENSION,
      source: "simulation",
      verdict: "errored",
      rationale: "version 1 could not read a chat transcript at all.",
    });

    const read = await readVerdicts(at(acme), traceId);
    expect(read.verdicts).toHaveLength(3);

    const speaking = speakingVerdicts(read.verdicts);
    expect(speaking).toHaveLength(1);
    expect(speaking[0]).toMatchObject({
      graderVersionId: VERSION_TWO,
      judgedBy: "gpt-4o-mini",
      verdict: "passed",
    });
    expect(read.outcome.verdict).toBe("passed");
  });
});

describe("the number on a correction", () => {
  const traceId = "4444444444444444444444444444aaaa";

  it("follows the word when nobody gives one, because a reader states a verdict and a reason", async () => {
    await appendVerdicts(at(acme), [machineVerdict({ traceId })]);

    const passed = await correctVerdict(at(acme), {
      traceId,
      graderId: GRADER,
      graderVersionId: VERSION_ONE,
      dimension: DIMENSION,
      source: "simulation",
      verdict: "passed",
      rationale: "the confirmation is there.",
    });
    expect(passed.score).toBe(1);

    const failed = await correctVerdict(at(acme), {
      traceId,
      graderId: GRADER,
      graderVersionId: VERSION_ONE,
      dimension: DIMENSION,
      source: "simulation",
      verdict: "failed",
      rationale: "on reflection the time it confirmed was the wrong one.",
    });
    expect(failed.score).toBe(0);
  });

  it("is taken as given by somebody who has one", async () => {
    const scored = await correctVerdict(at(acme), {
      traceId,
      graderId: GRADER,
      graderVersionId: VERSION_ONE,
      dimension: DIMENSION,
      source: "simulation",
      verdict: "passed",
      score: 0.8,
      rationale: "mostly right: the date was confirmed and the time was not.",
    });

    expect(scored.score).toBe(0.8);
    expect(
      (await rowsOn(traceId)).find((row) => row.judgedBy === JUDGED_BY_HUMAN)
        ?.score,
    ).toBe(0.8);
  });

  it("is refused outside nought and one", async () => {
    await expect(
      correctVerdict(at(acme), {
        traceId,
        graderId: GRADER,
        graderVersionId: VERSION_ONE,
        dimension: DIMENSION,
        source: "simulation",
        verdict: "passed",
        score: 4,
        rationale: "four out of five.",
      }),
    ).rejects.toThrow("between 0 and 1");
  });
});

describe("a correction with nothing behind it", () => {
  const traceId = "5555555555555555555555555555aaaa";

  it("is refused when there is no judgment to disagree with, because that would be authoring a verdict by hand", async () => {
    await expect(
      correctVerdict(at(acme), {
        traceId,
        graderId: GRADER,
        graderVersionId: VERSION_ONE,
        dimension: "a check nobody ever made",
        source: "simulation",
        verdict: "failed",
        rationale: "it should have done better.",
      }),
    ).rejects.toThrow("to disagree with");

    expect(await rowsOn(traceId)).toEqual([]);
  });

  it("is refused when it says no reason, because a correction with none is an assertion", async () => {
    await appendVerdicts(at(acme), [machineVerdict({ traceId })]);

    await expect(
      correctVerdict(at(acme), {
        traceId,
        graderId: GRADER,
        graderVersionId: VERSION_ONE,
        dimension: DIMENSION,
        source: "simulation",
        verdict: "passed",
        rationale: "   ",
      }),
    ).rejects.toThrow("says why you disagree");

    expect(await rowsOn(traceId)).toHaveLength(1);
  });
});

describe("who may disagree", () => {
  const traceId = "6666666666666666666666666666aaaa";

  it("is not a viewer, whose word would still turn a red run green", async () => {
    await appendVerdicts(at(acme), [machineVerdict({ traceId })]);

    await expect(
      correctVerdict(at(acme, "viewer"), {
        traceId,
        graderId: GRADER,
        graderVersionId: VERSION_ONE,
        dimension: DIMENSION,
        source: "simulation",
        verdict: "passed",
        rationale: "I think this one is fine.",
      }),
    ).rejects.toThrow(NotPermittedError);

    expect(await rowsOn(traceId)).toHaveLength(1);
  });

  it("is nobody from another customer, who cannot see the judgment at all", async () => {
    await expect(
      correctVerdict(at(globex), {
        traceId,
        graderId: GRADER,
        graderVersionId: VERSION_ONE,
        dimension: DIMENSION,
        source: "simulation",
        verdict: "passed",
        rationale: "looks fine to me.",
      }),
    ).rejects.toThrow("to disagree with");

    const rows = await rowsOn(traceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.judgedBy).toBe("gpt-4o-mini");
  });
});
