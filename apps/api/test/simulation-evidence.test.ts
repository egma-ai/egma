import {
  appendGrades,
  claimGradingJobs,
  finishGradingJob,
  getSimulation,
  requestGrading,
  type AuthContext,
  type GradingClaim,
} from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  aConductedRun,
  type ConductedRun,
  type Standing,
} from "./support/recordings.ts";
import {
  contextFor,
  NEUTRAL_PERSON,
  projectKeyFor,
  request,
  signUp,
} from "./support/traces.ts";

let api: TestApi;
let claimantSequence = 0;

afterEach(async () => {
  await api?.close();
});

async function aCustomerWhoRan(label: string): Promise<{
  readonly standing: Standing;
  readonly run: ConductedRun;
}> {
  api = await createApi(label, { traceStore: true });
  const customer = await signUp(
    api.app,
    `${label}@acme.example`,
    "Acme",
  );
  const standing = {
    key: await projectKeyFor(api.app, customer),
    auth: contextFor(customer, "admin"),
  };
  const run = await aConductedRun(api.app, standing, {
    reference: "recordings/grade-surface.wav",
    modality: "chat",
  });
  return { standing, run };
}

async function claimFor(traceId: string): Promise<GradingClaim> {
  claimantSequence += 1;
  const claims = await claimGradingJobs({
    claimant: `api-grade-surface-${claimantSequence}`,
    capacity: 50,
  });
  const claim = claims.find((candidate) => candidate.traceId === traceId);
  if (claim === undefined) throw new Error(`trace ${traceId} was not claimed`);
  return claim;
}

async function writeGrade(
  auth: AuthContext,
  simulationId: string,
  score: number,
  gradedAt: Date,
): Promise<void> {
  const simulation = await getSimulation(auth, simulationId);
  if (simulation?.startedAt === null || simulation?.startedAt === undefined) {
    throw new Error(`simulation ${simulationId} has no start time`);
  }
  const traceId = traceIdOfSimulation(simulationId);
  if (traceId === undefined) throw new Error(`${simulationId} has no trace id`);

  await requestGrading(auth, {
    source: "simulation",
    traceId,
    traceStartedAt: simulation.startedAt,
    runId: simulation.runId,
    endsTrace: false,
    evidenceReady: true,
    modality: simulation.modality,
  });
  const claim = await claimFor(traceId);
  const entry = claim.entries[0];
  if (entry === undefined) throw new Error(`${claim.id} has no grader`);

  await appendGrades(claim.auth, [
    {
      source: "simulation",
      traceId,
      traceStartedAtMicroseconds:
        BigInt(simulation.startedAt.getTime()) * 1_000n,
      runId: simulation.runId,
      projectGraderId: entry.projectGraderId,
      graderDefinitionId: entry.graderDefinitionId,
      graderDefinitionVersion: entry.graderDefinitionVersion,
      score,
      details: {
        rationale: "The agent met one expected behavior.",
        assertions: [
          {
            key: "behavior_1",
            score,
            rationale: "The agent confirmed the requested time.",
            citedSpanIds: ["1111111111111111"],
          },
        ],
      },
      graderPassThreshold: entry.graderPassThreshold,
      gradingSequence: claim.sequenceBase + claim.attempts,
      gradedAtMicroseconds: BigInt(gradedAt.getTime()) * 1_000n,
    },
  ]);
  await finishGradingJob(claim.auth, claim.id, claim.claimedBy);
}

describe("one simulation's recording clock", () => {
  it("returns the captured origin and leaves historical or absent origins null", async () => {
    api = await createApi("simulation_recording_origin", { traceStore: true });
    const customer = await signUp(
      api.app,
      "simulation-recording-origin@acme.example",
      "Acme",
    );
    const standing = {
      key: await projectKeyFor(api.app, customer),
      auth: contextFor(customer, "admin"),
    };
    const origin = new Date("2026-08-05T09:00:17.123Z");
    const run = await aConductedRun(api.app, standing, {
      reference: "recordings/clock-origin.wav",
      recordingStartedAt: origin,
    });

    const heard = await request(
      api.app,
      "GET",
      `/v1/simulations/${run.heard}`,
      standing.key,
    );
    expect(heard.statusCode, JSON.stringify(heard.body)).toBe(200);
    expect(heard.body).toMatchObject({
      hasRecording: true,
      recordingStartedAt: origin.toISOString(),
    });

    const silent = await request(
      api.app,
      "GET",
      `/v1/simulations/${run.silent}`,
      standing.key,
    );
    expect(silent.statusCode, JSON.stringify(silent.body)).toBe(200);
    expect(silent.body).toMatchObject({
      hasRecording: false,
      recordingStartedAt: null,
    });

    const historical = await aConductedRun(api.app, standing, {
      reference: "recordings/before-clock-origins.wav",
    });
    const olderEvidence = await request(
      api.app,
      "GET",
      `/v1/simulations/${historical.heard}`,
      standing.key,
    );
    expect(olderEvidence.statusCode, JSON.stringify(olderEvidence.body)).toBe(200);
    expect(olderEvidence.body).toMatchObject({
      hasRecording: true,
      recordingStartedAt: null,
    });
  });
});

describe("one simulation's grades", () => {
  it("shows current grades, append-only history, a combined score, and whole-plan regrade", async () => {
    const { standing, run } = await aCustomerWhoRan("simulation_grade_history");

    await writeGrade(
      standing.auth,
      run.heard,
      0.25,
      new Date("2026-08-21T10:00:00Z"),
    );
    const first = await request(
      api.app,
      "GET",
      `/v1/simulations/${run.heard}`,
      standing.key,
    );
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect((first.body.connection as { name: string }).name).not.toBe(null);
    const snapshot = first.body.connectionSnapshot as Record<string, unknown>;
    expect(snapshot.agentPlatform).toBe("retell");
    expect(snapshot.connectionType).toBe("retell_chat_api");
    expect(snapshot.accessVariant).toBe("retell_chat_api.api_key");
    expect(snapshot.modality).toBe("chat");
    // Nothing a credential could ride in. The secret lives in its own sealed
    // column and was never copied into the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain("retell-secret");
    expect(snapshot).not.toHaveProperty("connectionKind");

    /*
     * **Who the agent actually heard, off the version this simulation
     * pinned.** `name` is the team's label for the library row and reads live;
     * the three beside it are the authored person and never move.
     *
     * Asserted here because the response is serialized against a schema that
     * *omits* what it cannot match rather than refusing it — so a block that
     * regressed to nulls, or back to the retired `traits` wrapper, would leave
     * this read looking perfectly healthy and say nothing at all.
     */
    expect(first.body.persona).toMatchObject({
      name: expect.stringContaining("Impatient Rita") as unknown as string,
      identityName: NEUTRAL_PERSON.identityName,
      personality: NEUTRAL_PERSON.personality,
      language: NEUTRAL_PERSON.language,
    });
    expect(first.body.persona).not.toHaveProperty("traits");

    expect(first.body).toMatchObject({
      id: run.heard,
      status: "completed",
      gradingState: "complete",
      combinedScore: 0.25,
      grades: [
        {
          graderName: "expected_behaviors",
          score: 0.25,
          passThreshold: 1,
          result: "failed",
          details: {
            rationale: "The agent met one expected behavior.",
            assertions: [
              {
                key: "behavior_1",
                score: 0.25,
                citedSpanIds: ["1111111111111111"],
              },
            ],
          },
        },
      ],
      gradeHistory: [{ score: 0.25, result: "failed" }],
    });
    for (const retired of [
      "verdict",
      "verdicts",
      "outcome",
      "diagnostics",
      "byGrader",
      "gradingJobs",
    ]) {
      expect(first.body).not.toHaveProperty(retired);
    }
    const projection = first.body as {
      readonly grades: readonly Record<string, unknown>[];
      readonly gradeHistory: readonly Record<string, unknown>[];
    };
    expect(projection.grades[0]).not.toHaveProperty("gradingSequence");
    expect(projection.gradeHistory[0]).not.toHaveProperty("gradingSequence");

    const narrowed = await request(
      api.app,
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      standing.key,
      { graderId: "grd_01JQZ0000000000000000000AA" },
    );
    expect(narrowed.statusCode).toBe(422);

    const reopened = await request(
      api.app,
      "POST",
      `/v1/simulations/${run.heard}/regrade`,
      standing.key,
    );
    expect(reopened.statusCode, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body).toEqual({
      simulationId: run.heard,
      reopened: 1,
      alreadyWaiting: 0,
    });

    const simulation = await getSimulation(standing.auth, run.heard);
    if (simulation?.startedAt === null || simulation?.startedAt === undefined) {
      throw new Error("the simulation has no start time");
    }
    const traceId = traceIdOfSimulation(run.heard);
    if (traceId === undefined) throw new Error("the simulation has no trace id");
    const claim = await claimFor(traceId);
    const entry = claim.entries[0];
    if (entry === undefined) throw new Error("the regrade has no grader");
    await appendGrades(claim.auth, [
      {
        source: "simulation",
        traceId,
        traceStartedAtMicroseconds:
          BigInt(simulation.startedAt.getTime()) * 1_000n,
        runId: simulation.runId,
        projectGraderId: entry.projectGraderId,
        graderDefinitionId: entry.graderDefinitionId,
        graderDefinitionVersion: entry.graderDefinitionVersion,
        score: 0.75,
        details: { rationale: "The same frozen grader scored it again." },
        graderPassThreshold: entry.graderPassThreshold,
        gradingSequence: claim.sequenceBase + claim.attempts,
        gradedAtMicroseconds:
          BigInt(new Date("2026-08-21T10:05:00Z").getTime()) * 1_000n,
      },
    ]);
    await finishGradingJob(claim.auth, claim.id, claim.claimedBy);

    const second = await request(
      api.app,
      "GET",
      `/v1/simulations/${run.heard}`,
      standing.key,
    );
    expect(second.statusCode, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({
      gradingState: "complete",
      combinedScore: 0.75,
      grades: [{ score: 0.75, result: "failed" }],
      gradeHistory: [
        { score: 0.25, result: "failed" },
        { score: 0.75, result: "failed" },
      ],
    });
  });
});
