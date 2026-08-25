/** Races at the boundary between the run screen and the final skill offer. */

import { afterEach, describe, expect, it, vi } from "vitest";

import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { runStep } from "../src/wizard/run-step.ts";
import { waitUntil } from "./support/workspace.ts";

const URL = "https://egma.example";

class JsonResponse extends Response {
  constructor(body?: string | null, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    super(body, { ...init, headers });
  }
}

function simulation(
  id: string,
  position: number,
  status: "queued" | "completed",
  gradingState: "complete" | null,
): Record<string, unknown> {
  return {
    id,
    position,
    testName: `test-${String(position)}`,
    testVersionId: `tstv_${String(position)}`,
    personaName: "default-persona",
    status,
    gradingState,
    reason: null,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("the first trace result", () => {
  it("opens the skill offer when the first page already has terminal grading", async () => {
    const ui = new HeadlessUI({ answers: { "skills-offer": "skip" } });
    const stopped = new AbortController();
    const fetchImpl: typeof fetch = async (request, init) => {
      const url = String(request);
      if (url === `${URL}/v1/runs` && init?.method === "POST") {
        return new JsonResponse(
          JSON.stringify({
            id: "run_one",
            status: "running",
            agentId: "agt_one",
            connectionId: "con_one",
            productLabel: "Fixture",
            modality: "chat",
            expectedSimulationCount: 3,
            resultsUrl: `${URL}/runs/run_one`,
          }),
          { status: 201 },
        );
      }
      if (url === `${URL}/v1/runs/run_one/simulations`) {
        return new JsonResponse(
          JSON.stringify({
            simulations: [
              simulation("sim_one", 1, "completed", "complete"),
              simulation("sim_two", 2, "queued", null),
              simulation("sim_three", 3, "queued", null),
            ],
            nextPageToken: null,
          }),
        );
      }
      if (url === `${URL}/v1/runs/run_one`) {
        return new JsonResponse(
          JSON.stringify({
            id: "run_one",
            status: "running",
            agentId: "agt_one",
            connectionId: "con_one",
            productLabel: "Fixture",
            modality: "chat",
            expectedSimulationCount: 3,
            resultsUrl: `${URL}/runs/run_one`,
          }),
        );
      }
      if (url === `${URL}/v1/simulations/sim_one`) {
        return new JsonResponse(
          JSON.stringify({
            grades: [],
            combinedScore: null,
            test: { expectedBehaviors: [] },
          }),
        );
      }
      if (url === `${URL}/v1/runs/run_one/events?after=0`) {
        return new JsonResponse(JSON.stringify({ events: [], next: 0, done: false }));
      }
      return new JsonResponse(JSON.stringify({ message: `unexpected request: ${url}` }), {
        status: 404,
      });
    };
    vi.stubGlobal("fetch", fetchImpl);

    const running = runStep({
      ui,
      signedIn: { url: URL, key: "key" },
      agentId: "agt_one",
      connectionId: "con_one",
      suiteId: "ste_one",
      expectedTestVersions: [
        { testId: "tst_one", versionId: "tstv_1" },
        { testId: "tst_two", versionId: "tstv_2" },
        { testId: "tst_three", versionId: "tstv_3" },
      ],
      drivenAgentId: "claude",
      cwd: "/tmp/egma-run-step-project",
      home: "/tmp/egma-run-step-home",
      signal: stopped.signal,
      everyMs: 0,
    });

    const offered = await waitUntil(
      () => ui.record.asked.includes("skills-offer"),
      250,
    );
    if (!offered) stopped.abort("test cleanup");
    const report = await running;

    expect(offered).toBe(true);
    expect(report.kind).toBe("run-started");
    expect(ui.record.run?.firstResult?.gradingState).toBe("complete");
  });
});
