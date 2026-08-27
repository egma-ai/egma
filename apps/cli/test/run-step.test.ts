/** The boundary between a complete run and the final skill offer. */

import { afterEach, describe, expect, it, vi } from "vitest";

import { HeadlessUI } from "../src/ui/headless-ui.ts";
import type { AskId } from "../src/ui/wizard-ui.ts";
import { runStep } from "../src/wizard/run-step.ts";
import { waitUntil } from "./support/workspace.ts";

const URL = "https://egma.example";
const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";

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
  status: "queued" | "completed" | "failed" | "canceled",
  gradingState: "complete" | "error" | null,
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

function runBody(runId: string, expectedSimulationCount = 1): Record<string, unknown> {
  return {
    id: runId,
    status: "completed",
    agentId: "agt_one",
    connectionId: "con_one",
    productLabel: "Fixture",
    modality: "voice",
    expectedSimulationCount,
    resultsUrl: `${URL}/projects/${PROJECT_ID}/runs/${runId}`,
  };
}

function completedRunFetch(
  runId: string,
  row: Record<string, unknown>,
): typeof fetch {
  return async (request, init) => {
    const url = String(request);
    if (url === `${URL}/v1/runs` && init?.method === "POST") {
      return new JsonResponse(JSON.stringify(runBody(runId)), { status: 201 });
    }
    if (url === `${URL}/v1/runs/${runId}/simulations`) {
      return new JsonResponse(
        JSON.stringify({ simulations: [row], nextPageToken: null }),
      );
    }
    if (url === `${URL}/v1/runs/${runId}`) {
      return new JsonResponse(JSON.stringify(runBody(runId)));
    }
    if (url === `${URL}/v1/runs/${runId}/events?after=0`) {
      return new JsonResponse(JSON.stringify({ events: [], next: 0, done: true }));
    }
    if (url === `${URL}/v1/simulations/${String(row["id"])}`) {
      return new JsonResponse(
        JSON.stringify({
          grades: [],
          combinedScore: null,
          test: { expectedBehaviors: [] },
        }),
      );
    }
    return new JsonResponse(JSON.stringify({ message: `unexpected request: ${url}` }), {
      status: 404,
    });
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("the complete run", () => {
  it("keeps the skill offer closed until every simulation and grade is terminal", async () => {
    const ui = new HeadlessUI({ answers: { "skills-offer": "skip" } });
    const stopped = new AbortController();
    let releaseTerminalPage!: () => void;
    const terminalPage = new Promise<void>((resolve) => {
      releaseTerminalPage = resolve;
    });
    let simulationReads = 0;
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
            resultsUrl: `${URL}/projects/${PROJECT_ID}/runs/run_one`,
          }),
          { status: 201 },
        );
      }
      if (url === `${URL}/v1/runs/run_one/simulations`) {
        simulationReads += 1;
        if (simulationReads > 1) await terminalPage;
        return new JsonResponse(
          JSON.stringify({
            simulations:
              simulationReads === 1
                ? [
                    simulation("sim_one", 1, "completed", "complete"),
                    simulation("sim_two", 2, "queued", null),
                    simulation("sim_three", 3, "queued", null),
                  ]
                : [
                    simulation("sim_one", 1, "completed", "complete"),
                    simulation("sim_two", 2, "completed", "complete"),
                    simulation("sim_three", 3, "completed", "complete"),
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
            resultsUrl: `${URL}/projects/${PROJECT_ID}/runs/run_one`,
          }),
        );
      }
      if (url.startsWith(`${URL}/v1/simulations/sim_`)) {
        return new JsonResponse(
          JSON.stringify({
            grades: [],
            combinedScore: null,
            test: { expectedBehaviors: [] },
          }),
        );
      }
      if (url === `${URL}/v1/runs/run_one/events?after=0`) {
        return new JsonResponse(JSON.stringify({ events: [], next: 0, done: true }));
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

    await waitUntil(() => simulationReads > 1, 250);
    expect(ui.record.asked).not.toContain("skills-offer");
    releaseTerminalPage();
    const offered = await waitUntil(() => ui.record.asked.includes("skills-offer"), 250);
    if (!offered) stopped.abort("test cleanup");
    const report = await running;

    expect(offered).toBe(true);
    expect(report.kind).toBe("run-started");
    expect(ui.record.run?.firstResult?.gradingState).toBe("complete");
  });

  it("stops following and names the hosted run when the local worker dies", async () => {
    const ui = new HeadlessUI();
    const fetchImpl: typeof fetch = async (request, init) => {
      const url = String(request);
      if (url === `${URL}/v1/runs` && init?.method === "POST") {
        return new JsonResponse(
          JSON.stringify({
            id: "run_worker_died",
            status: "running",
            agentId: "agt_one",
            connectionId: "con_one",
            productLabel: "LiveKit",
            modality: "voice",
            expectedSimulationCount: 1,
            resultsUrl: `${URL}/projects/${PROJECT_ID}/runs/run_worker_died`,
          }),
          { status: 201 },
        );
      }
      if (url === `${URL}/v1/runs/run_worker_died/simulations`) {
        return new JsonResponse(
          JSON.stringify({
            simulations: [simulation("sim_one", 1, "queued", null)],
            nextPageToken: null,
          }),
        );
      }
      if (url === `${URL}/v1/runs/run_worker_died/events?after=0`) {
        return new JsonResponse(JSON.stringify({ events: [], next: 0, done: false }));
      }
      if (url === `${URL}/v1/runs/run_worker_died`) {
        return new JsonResponse(
          JSON.stringify({
            id: "run_worker_died",
            status: "running",
            agentId: "agt_one",
            connectionId: "con_one",
            productLabel: "LiveKit",
            modality: "voice",
            expectedSimulationCount: 1,
            resultsUrl: `${URL}/projects/${PROJECT_ID}/runs/run_worker_died`,
          }),
        );
      }
      return new JsonResponse(JSON.stringify({ message: `unexpected request: ${url}` }), {
        status: 404,
      });
    };
    vi.stubGlobal("fetch", fetchImpl);

    const report = await runStep({
      ui,
      signedIn: { url: URL, key: "key" },
      agentId: "agt_one",
      connectionId: "con_one",
      suiteId: "ste_one",
      expectedTestVersions: [{ testId: "tst_one", versionId: "tstv_1" }],
      drivenAgentId: "claude",
      cwd: "/tmp/egma-run-step-project",
      home: "/tmp/egma-run-step-home",
      signal: new AbortController().signal,
      everyMs: 0,
      localWorker: {
        ended: Promise.resolve({
          kind: "failed",
          reason: "The local LiveKit worker exited.",
        }),
        stop: async () => undefined,
      },
    });

    expect(report).toEqual({
      kind: "failed",
      reason:
        `The local LiveKit worker exited. The hosted run is ${URL}/projects/${PROJECT_ID}/runs/run_worker_died.`,
    });
    expect(ui.record.statuses).toContain("✗ The local LiveKit worker exited.");
  });

  it("reports a follow failure with the hosted URL and does not offer skills", async () => {
    const runId = "run_follow_failed";
    const ui = new HeadlessUI({ answers: { "skills-offer": "skip" } });
    const fetchImpl: typeof fetch = async (request, init) => {
      const url = String(request);
      if (url === `${URL}/v1/runs` && init?.method === "POST") {
        return new JsonResponse(JSON.stringify(runBody(runId)), { status: 201 });
      }
      if (url === `${URL}/v1/runs/${runId}/simulations`) {
        return new JsonResponse(
          JSON.stringify({
            simulations: [simulation("sim_one", 1, "queued", null)],
            nextPageToken: null,
          }),
        );
      }
      if (url === `${URL}/v1/runs/${runId}/events?after=0`) {
        return new JsonResponse(
          JSON.stringify({ message: "The run service is temporarily unavailable" }),
          { status: 503 },
        );
      }
      return new JsonResponse(JSON.stringify({ message: `unexpected request: ${url}` }), {
        status: 404,
      });
    };
    vi.stubGlobal("fetch", fetchImpl);

    const report = await runStep({
      ui,
      signedIn: { url: URL, key: "key" },
      agentId: "agt_one",
      connectionId: "con_one",
      suiteId: "ste_one",
      expectedTestVersions: [{ testId: "tst_one", versionId: "tstv_1" }],
      drivenAgentId: "claude",
      cwd: "/tmp/egma-run-step-project",
      home: "/tmp/egma-run-step-home",
      signal: new AbortController().signal,
      everyMs: 0,
    });

    expect(report).toEqual({
      kind: "failed",
      reason:
        "Egma stopped answering before this run was complete: " +
        "The run service is temporarily unavailable. " +
        `The hosted run is ${URL}/projects/${PROJECT_ID}/runs/${runId}.`,
    });
    expect(ui.record.statuses.join("\n")).not.toContain(
      "Egma stopped answering",
    );
    expect(ui.record.asked).not.toContain("skills-offer");
    expect(ui.record.skillPlaces).toBeNull();
  });

  it("stops the local worker before asking whether to install skills", async () => {
    const runId = "run_worker_order";
    let workerStopped = false;
    let stoppedWhenAsked: boolean | null = null;
    let finishWorker!: () => void;
    const ended = new Promise<{ readonly kind: "stopped" }>((resolve) => {
      finishWorker = () => resolve({ kind: "stopped" });
    });
    const ui = new (class extends HeadlessUI {
      constructor() {
        super({ answers: { "skills-offer": "skip" } });
      }

      override waitForAnswer(ask: AskId): Promise<string | null> {
        if (ask === "skills-offer") stoppedWhenAsked = workerStopped;
        return super.waitForAnswer(ask);
      }
    })();
    vi.stubGlobal(
      "fetch",
      completedRunFetch(
        runId,
        simulation("sim_one", 1, "completed", "complete"),
      ),
    );

    const report = await runStep({
      ui,
      signedIn: { url: URL, key: "key" },
      agentId: "agt_one",
      connectionId: "con_one",
      suiteId: "ste_one",
      expectedTestVersions: [{ testId: "tst_one", versionId: "tstv_1" }],
      drivenAgentId: "claude",
      cwd: "/tmp/egma-run-step-project",
      home: "/tmp/egma-run-step-home",
      signal: new AbortController().signal,
      everyMs: 0,
      localWorker: {
        ended,
        stop: async () => {
          workerStopped = true;
          finishWorker();
        },
      },
    });

    expect(report.kind).toBe("run-started");
    expect(ui.record.asked).toContain("skills-offer");
    expect(workerStopped).toBe(true);
    expect(stoppedWhenAsked).toBe(true);
  });

  it.each([
    {
      ending: "an execution failure",
      status: "failed" as const,
      gradingState: null,
      counts: "1 execution failures, 0 canceled simulations, and 0 grading errors",
    },
    {
      ending: "a canceled simulation",
      status: "canceled" as const,
      gradingState: null,
      counts: "0 execution failures, 1 canceled simulations, and 0 grading errors",
    },
    {
      ending: "a grading error",
      status: "completed" as const,
      gradingState: "error" as const,
      counts: "0 execution failures, 0 canceled simulations, and 1 grading errors",
    },
  ])("reports $ending and does not offer skills", async ({ status, gradingState, counts }) => {
    const runId = `run_${status}_${gradingState ?? "none"}`;
    const ui = new HeadlessUI({ answers: { "skills-offer": "skip" } });
    vi.stubGlobal(
      "fetch",
      completedRunFetch(runId, simulation("sim_one", 1, status, gradingState)),
    );

    const report = await runStep({
      ui,
      signedIn: { url: URL, key: "key" },
      agentId: "agt_one",
      connectionId: "con_one",
      suiteId: "ste_one",
      expectedTestVersions: [{ testId: "tst_one", versionId: "tstv_1" }],
      drivenAgentId: "claude",
      cwd: "/tmp/egma-run-step-project",
      home: "/tmp/egma-run-step-home",
      signal: new AbortController().signal,
      everyMs: 0,
    });

    expect(report).toEqual({
      kind: "failed",
      reason:
        `The run finished with ${counts}. ` +
        `Review it at ${URL}/projects/${PROJECT_ID}/runs/${runId}.`,
    });
    expect(ui.record.asked).not.toContain("skills-offer");
    expect(ui.record.skillPlaces).toBeNull();
  });
});
