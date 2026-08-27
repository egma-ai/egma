import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { aConductedRun } from "./support/recordings.ts";
import {
  contextFor,
  projectKeyFor,
  request,
  signUp,
} from "./support/traces.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});
describe("one run waiting for trace grades", () => {
  it("reports grading progress without inventing a quality result", async () => {
    api = await createApi("run_grading_progress", { traceStore: true });
    const customer = await signUp(
      api.app,
      "run-grading-progress@acme.example",
      "Acme",
    );
    const standing = {
      key: await projectKeyFor(api.app, customer),
      auth: contextFor(customer, "admin"),
    };
    const run = await aConductedRun(api.app, standing, {
      reference: "recordings/run-progress.wav",
      modality: "chat",
    });

    const detail = await request(
      api.app,
      "GET",
      `/v1/runs/${run.runId}`,
      standing.key,
    );
    expect(detail.statusCode, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body).toMatchObject({
      id: run.runId,
      finishedCount: 2,
      gradableCount: 2,
      gradedCount: 0,
    });
    for (const retired of ["verdict", "score", "verdictCounts"]) {
      expect(detail.body).not.toHaveProperty(retired);
    }

    const simulations = await request(
      api.app,
      "GET",
      `/v1/runs/${run.runId}/simulations?pageSize=2`,
      standing.key,
    );
    expect(simulations.statusCode, JSON.stringify(simulations.body)).toBe(200);
    expect(
      (simulations.body.simulations as Array<{
        gradingState: string;
        combinedScore: number | null;
        startedAt: string | null;
        endedAt: string | null;
      }>).map(
        (simulation) => ({
          gradingState: simulation.gradingState,
          combinedScore: simulation.combinedScore,
          hasStartedAt: simulation.startedAt !== null,
          hasEndedAt: simulation.endedAt !== null,
        }),
      ),
    ).toEqual([
      {
        gradingState: "pending",
        combinedScore: null,
        hasStartedAt: true,
        hasEndedAt: true,
      },
      {
        gradingState: "pending",
        combinedScore: null,
        hasStartedAt: true,
        hasEndedAt: true,
      },
    ]);

    const events = await request(
      api.app,
      "GET",
      `/v1/runs/${run.runId}/events`,
      standing.key,
    );
    expect(events.statusCode, JSON.stringify(events.body)).toBe(200);
    expect(events.body.done).toBe(false);
    expect(
      (events.body.events as readonly Record<string, unknown>[]).some(
        (event) => "verdict" in event,
      ),
    ).toBe(false);
  });
});
