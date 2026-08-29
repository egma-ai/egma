import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendGrades,
  ProductionGradingPlanConflictError,
  recordProductionGradingPlan,
  readCurrentSimulationGradeFacts,
  readProductionGradingPlan,
  readTraceGrades,
  type NewGrade,
} from "../src/access/grades.ts";
import { combinedGradeScore, currentGrades } from "../src/grading/results.ts";
import {
  connectClickHouse,
  disconnectClickHouse,
} from "../src/clickhouse/client.ts";
import type { AuthContext } from "../src/access/context.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";

let store: MigratedTraceStore;

const auth: AuthContext = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
  role: "admin",
  via: "api_key",
};

function micros(instant: string): bigint {
  return BigInt(Date.parse(instant)) * 1_000n;
}

function grade(overrides: Partial<NewGrade> = {}): NewGrade {
  return {
    source: "simulation",
    traceId: "1111111111111111111111111111aaaa",
    traceStartedAtMicroseconds: micros("2026-08-21T08:00:00Z"),
    runId: newId("run"),
    projectGraderId: newId("grd"),
    graderDefinitionId: newId("grl"),
    graderDefinitionVersion: 3,
    score: 0.5,
    details: {
      rationale: "One of two expected behaviors passed.",
      assertions: [
        { key: "behavior_1", score: 1, rationale: "The agent confirmed." },
        {
          key: "behavior_2",
          score: 0,
          rationale: "The agent did not state the cancellation policy.",
          citedSpanIds: ["00f067aa0ba902b7"],
        },
      ],
    },
    graderPassThreshold: 0.75,
    gradingSequence: 1,
    gradedAtMicroseconds: micros("2026-08-21T08:01:00Z"),
    ...overrides,
  };
}

beforeAll(async () => {
  store = await createMigratedTraceStore("grades");
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });
});

afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
});

describe("one grader result on one trace", () => {
  it("keeps the higher grading sequence current when completion times tie", () => {
    const projectGraderId = newId("grd");
    const gradedAtMicroseconds = micros("2026-08-21T08:01:00Z");
    const stale = {
      projectGraderId,
      score: 0,
      graderPassThreshold: 0.5,
      gradedAtMicroseconds,
      gradingSequence: 1,
    };
    const reclaimed = {
      ...stale,
      score: 1,
      gradingSequence: 2,
    };

    expect(currentGrades([stale, reclaimed])).toMatchObject([
      { score: 1, gradingSequence: 2, result: "passed" },
    ]);
    expect(currentGrades([reclaimed, stale])).toMatchObject([
      { score: 1, gradingSequence: 2, result: "passed" },
    ]);
  });

  it("uses the higher sequence in batch state reads when completion times tie", async () => {
    const traceId = "1212121212121212121212121212bbbb";
    const runId = newId("run");
    const projectGraderId = newId("grd");
    const gradedAtMicroseconds = micros("2026-08-21T08:01:00Z");

    await appendGrades(auth, [
      grade({
        traceId,
        runId,
        projectGraderId,
        score: null,
        details: { error: "the stale worker could not score" },
        gradingSequence: 1,
        gradedAtMicroseconds,
      }),
      grade({
        traceId,
        runId,
        projectGraderId,
        score: 1,
        gradingSequence: 2,
        gradedAtMicroseconds,
      }),
    ]);

    await expect(readCurrentSimulationGradeFacts(auth, { traceIds: [traceId] }))
      .resolves.toEqual([{
        traceId,
        runId,
        projectGraderId,
        errored: false,
        score: 1,
      }]);
  });

  it("round-trips one normalized grade with its frozen identities and details", async () => {
    const written = grade();

    await expect(appendGrades(auth, [written])).resolves.toEqual({
      appended: 1,
      batches: 1,
    });

    await expect(readTraceGrades(auth, {
      source: "simulation",
      traceId: written.traceId,
      runId: written.runId,
    })).resolves.toEqual({
      history: [{
        ...written,
        traceStartedAt: "2026-08-21T08:00:00.000000Z",
        gradedAt: "2026-08-21T08:01:00.000000Z",
      }],
      current: [{
        ...written,
        traceStartedAt: "2026-08-21T08:00:00.000000Z",
        gradedAt: "2026-08-21T08:01:00.000000Z",
        result: "failed",
      }],
    });
  });

  it("keeps history and averages only the latest complete selected grades", async () => {
    const traceId = "2222222222222222222222222222bbbb";
    const runId = newId("run");
    const expectedBehaviors = newId("grd");
    const policy = newId("grd");

    await appendGrades(auth, [
      grade({
        traceId,
        runId,
        projectGraderId: expectedBehaviors,
        score: 0.25,
        gradedAtMicroseconds: micros("2026-08-21T08:01:00Z"),
      }),
      grade({
        traceId,
        runId,
        projectGraderId: expectedBehaviors,
        score: 0.75,
        graderPassThreshold: 0.75,
        gradedAtMicroseconds: micros("2026-08-21T08:02:00Z"),
      }),
      grade({
        traceId,
        runId,
        projectGraderId: policy,
        score: 1,
        gradedAtMicroseconds: micros("2026-08-21T08:03:00Z"),
      }),
    ]);

    const read = await readTraceGrades(auth, {
      source: "simulation",
      traceId,
      runId,
    });
    expect(read.history).toHaveLength(3);
    expect(read.current.map(({ projectGraderId, score, result }) => ({
      projectGraderId,
      score,
      result,
    }))).toEqual([
      { projectGraderId: expectedBehaviors, score: 0.75, result: "passed" },
      { projectGraderId: policy, score: 1, result: "passed" },
    ].sort((left, right) => left.projectGraderId.localeCompare(right.projectGraderId)));
    expect(combinedGradeScore(
      [expectedBehaviors, policy],
      read.current,
    )).toBe(0.875);
    expect(combinedGradeScore(
      [expectedBehaviors, policy, newId("grd")],
      read.current,
    )).toBeNull();
  });

  it("refuses definition version zero before writing a grade", async () => {
    await expect(appendGrades(auth, [grade({ graderDefinitionVersion: 0 })]))
      .rejects.toThrow("graderDefinitionVersion must fit UInt32");
  });
});

describe("the immutable production selection receipt", () => {
  it("stores an empty selection and returns the same receipt on replay", async () => {
    const traceId = "3333333333333333333333333333cccc";
    const input = {
      traceId,
      traceStartedAtMicroseconds: micros("2026-08-21T09:00:00Z"),
      entries: [],
    } as const;

    const first = await recordProductionGradingPlan(auth, input);
    const replay = await recordProductionGradingPlan(auth, input);

    expect(replay).toEqual(first);
    expect(first).toEqual({
      ...input,
      traceStartedAt: "2026-08-21T09:00:00.000000Z",
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await expect(readProductionGradingPlan(auth, traceId)).resolves.toEqual(first);

    const physical = await store.rows<{ count: string }>(
      `select toString(count()) as count
       from production_grading_plans
       where organization_id = '${auth.organizationId}'
         and project_id = '${auth.projectId}'
         and trace_id = '${traceId}'`,
    );
    expect(physical).toEqual([{ count: "1" }]);
  });

  it("keeps complete project settings with the frozen production selection", async () => {
    const traceId = "3434343434343434343434343434cdcd";
    const entry = {
      projectGraderId: newId("grd"),
      graderDefinitionId: newId("grl"),
      graderDefinitionVersion: 2,
      graderPassThreshold: 1,
      parameterValues: {
        maximum_response_time_ms: 2_500,
      },
    } as const;
    const written = await recordProductionGradingPlan(auth, {
      traceId,
      traceStartedAtMicroseconds: micros("2026-08-21T09:05:00Z"),
      entries: [entry],
    });

    expect(written.entries).toEqual([entry]);
    await expect(readProductionGradingPlan(auth, traceId)).resolves.toEqual(
      written,
    );
  });

  it("refuses a conflicting physical receipt instead of choosing one plan", async () => {
    const traceId = "5555555555555555555555555555eeee";
    const input = {
      traceId,
      traceStartedAtMicroseconds: micros("2026-08-21T09:15:00Z"),
      entries: [],
    } as const;
    await recordProductionGradingPlan(auth, input);

    await store.command(
      `insert into production_grading_plans
         (organization_id, project_id, trace_id, trace_started_at, plan_hash, entries)
       values (
         '${auth.organizationId}',
         '${auth.projectId}',
         '${traceId}',
         toDateTime64('2026-08-21 09:15:00.000000', 6, 'UTC'),
         unhex('${"11".repeat(32)}'),
         []
       )`,
    );

    await expect(recordProductionGradingPlan(auth, input)).rejects
      .toBeInstanceOf(ProductionGradingPlanConflictError);
  });

  it("refuses definition version zero before writing a receipt", async () => {
    await expect(recordProductionGradingPlan(auth, {
      traceId: "4444444444444444444444444444dddd",
      traceStartedAtMicroseconds: micros("2026-08-21T09:30:00Z"),
      entries: [{
        projectGraderId: newId("grd"),
        graderDefinitionId: newId("grl"),
        graderDefinitionVersion: 0,
        graderPassThreshold: 1,
        parameterValues: {},
      }],
    })).rejects.toThrow("graderDefinitionVersion must fit UInt32");
  });
});
