// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import RunDetailPage from "../app/projects/[projectId]/runs/[runId]/page.tsx";
import RunsPage from "../app/projects/[projectId]/runs/page.tsx";
import { EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID } from "../lib/graders.ts";
import type { Me } from "../lib/me.ts";
import { REGRADE_IS_NOT_A_REPLAY } from "../lib/simulations.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

const routed = vi.hoisted(() => ({
  pathname: "/projects/prj_1/runs",
  params: { projectId: "prj_1", runId: "run_1" } as Record<string, string>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useParams: () => routed.params,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const ME: Me = {
  user: { id: "usr_1", email: "ada@acme.example" },
  organizations: [{ id: "org_1", name: "Acme", slug: "acme", role: "admin" }],
  projects: [{ id: "prj_1", name: "Receptionists", slug: "receptionists" }],
};

type Stub =
  | { readonly status: number; readonly body: unknown }
  | { readonly deferred: Promise<Response>; readonly onRequest?: () => void }
  | "never";
type Sent = {
  readonly path: string;
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
};

let sent: Sent[] = [];

function answers(stubs: Record<string, Stub | readonly Stub[]>): void {
  const turns: Record<string, number> = {};
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = await observeRequest(input, init);
      sent.push({
        path: request.path,
        url: request.url,
        method: request.method,
        body: request.body,
      });
      const held = stubs[request.path];
      if (held === undefined) throw new Error(`nothing stubbed for ${request.path}`);
      const turn = turns[request.path] ?? 0;
      turns[request.path] = turn + 1;
      const answer = Array.isArray(held)
        ? (held[Math.min(turn, held.length - 1)] ?? "never")
        : held;
      if (answer === "never") return new Promise<Response>(() => undefined);
      if ("deferred" in answer) {
        answer.onRequest?.();
        return answer.deferred;
      }
      return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const NO_SIMULATIONS = {
  queued: 0,
  claimed: 0,
  running: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
};

function runHeader(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    projectId: "prj_1",
    status: "completed",
    suiteId: "ste_1",
    suiteName: "Northside Ford",
    suiteDeleted: false,
    name: "Release check",
    agentId: "agt_1",
    connectionId: "con_1",
    agentPlatform: "retell",
    connectionType: "retell_chat_api",
    accessVariant: "retell_chat_api.api_key",
    modality: "chat",
    productLabel: "Retell chat",
    environment: "staging",
    expectedSimulationCount: 1,
    completedCount: 1,
    failedCount: 0,
    canceledCount: 0,
    simulationCounts: { ...NO_SIMULATIONS, completed: 1 },
    finishedCount: 1,
    gradableCount: 1,
    gradedCount: 1,
    resultsUrl: "/projects/prj_1/runs/run_1",
    createdAt: "2026-08-21T10:00:00.000Z",
    startedAt: "2026-08-21T10:00:01.000Z",
    finishedAt: "2026-08-21T10:01:00.000Z",
    ...overrides,
  };
}

function runDetail(overrides: Record<string, unknown> = {}) {
  return {
    workBlock: null,
    ...runHeader(),
    eventThrough: 0,
    connectionSnapshot: {
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      topology: "hosted-broker",
      environment: "staging",
      config: { retellAgentId: "agent_abc" },
    },
    agent: { id: "agt_1", name: "Front desk", archived: false },
    connection: {
      id: "con_1",
      name: "retell-staging",
      productLabel: "Retell chat",
      archived: false,
    },
    ...overrides,
  };
}

function simulation(overrides: Record<string, unknown> = {}) {
  return {
    id: "sim_1",
    position: 1,
    testId: "tst_1",
    testName: "Books service",
    testVersionId: "tstv_1",
    personaId: "prs_1",
    personaName: "Patient caller",
    personaVersionId: "prsv_1",
    status: "completed",
    gradingState: "complete",
    combinedScore: 1,
    gradeTally: { passed: 1, failed: 0, errored: 0, selected: 1 },
    reason: null,
    executionFailure: null,
    startedAt: "2026-08-21T10:00:01.000Z",
    endedAt: "2026-08-21T10:01:00.000Z",
    modality: "chat",
    hasRecording: false,
    ...overrides,
  };
}

function simulationEvidence(overrides: Record<string, unknown> = {}) {
  const tool = {
    spanId: "span_tool",
    parentSpanId: "span_agent",
    name: "lookup_appointment",
    kind: "tool",
    status: "ok",
    startedAt: "2026-08-21T10:00:05.000Z",
    durationNs: "250000000",
    text: "",
    audioUrl: "",
    toolName: "lookup_appointment",
    toolArguments: '{"customer":"Ada"}',
    toolResult: '{"appointment":"Tuesday at 10"}',
    spans: [],
  };
  const human = {
    spanId: "span_human",
    parentSpanId: "root",
    name: "turn:human",
    kind: "turn:human",
    status: "ok",
    startedAt: "2026-08-21T10:00:02.000Z",
    durationNs: "1000000000",
    text: "Can you find my appointment?",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    spans: [],
  };
  const agent = {
    spanId: "span_agent",
    parentSpanId: "root",
    name: "turn:agent",
    kind: "turn:agent",
    status: "ok",
    startedAt: "2026-08-21T10:00:04.000Z",
    durationNs: "2000000000",
    text: "I found it for Tuesday at 10.",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    spans: [tool],
  };
  return {
    id: "sim_1",
    projectId: "prj_1",
    runId: "run_1",
    runName: "Release check",
    position: 1,
    status: "completed",
    gradingState: "complete",
    grades: [
      {
        projectGraderId: "grd_1",
        graderDefinitionId: EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID,
        graderDefinitionVersion: 2,
        graderName: "expected_behaviors",
        parameterValues: { llm_provider: "openai", llm_model: "gpt-4o-mini" },
        score: 1,
        details: {
          rationale: "The agent found and confirmed the appointment.",
          assertions: [
            {
              key: "behavior_1",
              score: 1,
              rationale: "The agent found and confirmed the appointment.",
              citedSpanIds: ["span_agent"],
            },
          ],
        },
        passThreshold: 0.8,
        result: "passed",
        gradedAt: "2026-08-21T10:01:00.000Z",
      },
    ],
    gradeHistory: [],
    combinedScore: 1,
    reason: null,
    executionFailure: null,
    modality: "chat",
    createdAt: "2026-08-21T10:00:00.000Z",
    startedAt: "2026-08-21T10:00:01.000Z",
    endedAt: "2026-08-21T10:01:00.000Z",
    providerReference: null,
    hasRecording: false,
    measures: { durationMs: 59_000, turnCount: 2, toolCallCount: 1 },
    metrics: [],
    test: {
      id: "tst_1",
      versionId: "tstv_1",
      name: "Books service",
      scenario: "Find the caller's appointment.",
      expectedBehaviors: ["Finds and confirms the appointment"],
    },
    persona: {
      id: "prs_1",
      name: "Patient caller",
      versionId: "prsv_1",
      traits: null,
    },
    agent: { id: "agt_1", name: "Front desk", archived: false },
    connection: { id: "con_1", name: "retell-staging", archived: false },
    connectionSnapshot: {
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      topology: "hosted-broker",
      environment: "staging",
      config: {},
    },
    gradingPlan: {
      capturedAt: "2026-08-21T10:00:00.000Z",
      items: [
        {
          projectGraderId: "grd_1",
          graderDefinitionId: EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID,
          graderDefinitionVersion: 2,
          graderName: "expected_behaviors",
          passThreshold: 0.8,
        },
      ],
    },
    transcript: {
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      startedAt: "2026-08-21T10:00:01.000Z",
      endedAt: "2026-08-21T10:01:00.000Z",
      durationNs: "59000000000",
      spanCount: 3,
      turnCounts: { human: 1, agent: 1 },
      toolSpanCount: 1,
      erroredSpanCount: 0,
      turns: [human, agent],
      spans: [],
      spansTruncated: false,
    },
    ...overrides,
  };
}

function shellStubs(): Record<string, Stub> {
  return {
    "/api/me": { status: 200, body: ME },
    "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
  };
}

beforeEach(() => {
  sent = [];
  routed.pathname = "/projects/prj_1/runs";
  routed.params = { projectId: "prj_1", runId: "run_1" };
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, search: "", replace: vi.fn() },
  });
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  toast.dismiss();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("run history after suites", () => {
  it("loads the next bounded page from the runs field", async () => {
    answers({
      ...shellStubs(),
      "/v1/runs": [
        {
          status: 200,
          body: { runs: [runHeader()], nextPageToken: "run_next" },
        },
        {
          status: 200,
          body: {
            runs: [runHeader({ id: "run_2", name: "Second release check" })],
            nextPageToken: null,
          },
        },
      ],
    });
    render(<RunsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("link", { name: "Second release check" })).toBeTruthy();
    expect(
      sent.some(
        (request) =>
          request.path === "/v1/runs" && request.url.includes("pageToken=run_next"),
      ),
    ).toBe(true);
  });
});

describe("one run after suites", () => {
  function detailStubs(
    detail: Record<string, unknown> = runDetail(),
    pages: Stub | readonly Stub[] = {
      status: 200,
      body: { simulations: [simulation()], nextPageToken: null },
    },
    evidenceRead: Stub | readonly Stub[] = { status: 200, body: simulationEvidence() },
  ): Record<string, Stub | readonly Stub[]> {
    return {
      "/api/me": { status: 200, body: ME },
      "/v1/runs/run_1": { status: 200, body: detail },
      "/v1/runs/run_1/simulations": pages,
      "/v1/simulations/sim_1": evidenceRead,
      "/v1/runs/run_1/cancel": { status: 200, body: detail },
    };
  }

  it("keeps expected behaviors visible while grading is still running", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(
      detailStubs(
        runDetail(),
        undefined,
        {
          status: 200,
          body: simulationEvidence({
            gradingState: "running",
            grades: [],
            gradeHistory: [],
            combinedScore: null,
          }),
        },
      ),
    );
    render(<RunDetailPage />);

    const expected = await screen.findByRole("region", { name: "Expected behaviors" });
    const table = within(expected).getByRole("table", {
      name: "Expected behaviors results",
    });
    expect(within(table).getByText("Finds and confirms the appointment")).toBeTruthy();
    expect(within(table).getByText("Waiting for the grader.")).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Total Score" })).toBeTruthy();
    expect(within(table).getByText("-")).toBeTruthy();
    expect(within(expected).getByText("Score - · Threshold 0.8")).toBeTruthy();
    expect(within(expected).queryAllByText(/—/u)).toHaveLength(0);
    /* A grader with no result yet opens itself: the wait is the finding. */
    expect(
      within(expected)
        .getByRole("button", { name: "Expected behaviors" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    /* No count is claimed while the graders are still working. */
    const grading = screen.getByRole("region", { name: "Simulation summary" });
    expect(within(grading).getByText("Graders passed")).toBeTruthy();
    expect(within(grading).getAllByText("—").length).toBeGreaterThan(0);
    /*
     * The facts come first and the notice stands under them: the bar is what
     * the reader came for, and the notice says why it is not settled yet.
     */
    const notice = screen.getByText("Grading in progress").closest("[role]");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(
      grading.compareDocumentPosition(notice as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows partial-transcript disclosure before the recorded conversation", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const read = simulationEvidence();
    answers(
      detailStubs(
        runDetail(),
        undefined,
        {
          status: 200,
          body: {
            ...read,
            transcript: {
              ...read.transcript,
              spanCount: 500,
              spansTruncated: true,
            },
          },
        },
      ),
    );
    render(<RunDetailPage />);

    fireEvent.click(await screen.findByRole("tab", { name: "Transcript" }));
    expect(
      await screen.findByText(
        /later tool calls or conversation turns may be absent/iu,
      ),
    ).toBeTruthy();
  });

  it("clears a queued work block after funding recovers without a run event", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const waiting = runDetail({
      status: "running", gradableCount: 0, gradedCount: 0,
      workBlock: { error: "providers_unfunded", message: "The inference balance is $0.00." },
    });
    answers({
      ...detailStubs(waiting),
      "/v1/runs/run_1": [
        { status: 200, body: waiting },
        { status: 200, body: { ...waiting, workBlock: null } },
      ],
    });
    render(<RunDetailPage />);
    expect(await screen.findByText("Queued simulations are waiting. The inference balance is $0.00.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Queued simulations are waiting. The inference balance is $0.00.")).toBeNull();
    }, { timeout: 3500 });
  });

  it("offers funding actions when a regrade from the run is refused", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers({
      ...detailStubs(runDetail(), undefined, [{ status: 200, body: simulationEvidence() }]),
      "/v1/simulations/sim_1/regrade": {
        status: 422,
        body: { error: "providers_unfunded", message: "The inference balance is $0.00." },
      },
    });
    render(<RunDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Regrade this simulation" }));
    const dialog = screen.getByRole("dialog", { name: "Regrade “Books service”?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Regrade simulation" }));
    const refusal = await screen.findByText("The inference balance is $0.00.");
    const alert = within(refusal.closest('[role="alert"]') as HTMLElement);
    expect(alert.getByRole("link", { name: "Add credits" }).getAttribute("href"))
      .toBe("/projects/prj_1/settings/billing");
    expect(alert.getByRole("link", { name: "Manage provider API keys" }).getAttribute("href"))
      .toBe("/projects/prj_1/settings/provider-api-keys");
    expect(screen.queryByText(/queued for a whole-simulation regrade/iu)).toBeNull();
  });

  it("keeps the compact p90 summary, grade history, and regrade in the run", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const read = simulationEvidence();
    const older = {
      ...read.grades[0],
      score: null,
      result: "failed",
      gradedAt: "2026-08-21T09:01:00.000Z",
    };
    const completeEvidence = simulationEvidence({
      gradeHistory: [older],
      metrics: [
        {
          measure: "turn_response_latency",
          unit: "milliseconds",
          derived: false,
          samples: [420, 6249],
          spanIds: ["span_agent"],
          mean: 760,
          p50: 420,
          p90: 6249,
          partial: true,
        },
      ],
    });
    answers({
      ...detailStubs(
        runDetail(),
        undefined,
        [
          { status: 200, body: completeEvidence },
          { status: 200, body: { ...completeEvidence, gradingState: "pending" } },
        ],
      ),
      "/v1/simulations/sim_1/regrade": {
        status: 200,
        body: { simulationId: "sim_1", reopened: 1, alreadyWaiting: 0 },
      },
    });
    render(<RunDetailPage />);

    const summary = await screen.findByRole("region", {
      name: "Simulation summary",
    });
    expect(within(summary).getByText("P90 turn latency")).toBeTruthy();
    expect(within(summary).getByText("6250 ms · partial")).toBeTruthy();
    expect(within(summary).queryByText("760")).toBeNull();
    expect(within(summary).queryByText("420")).toBeNull();
    expect(screen.queryByRole("region", { name: "What was measured" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Frozen grading plan" })).toBeNull();
    /* Earlier grades live inside the grader's own section, which passed. */
    fireEvent.click(
      within(screen.getByRole("region", { name: "Expected behaviors" })).getByRole(
        "button",
        { name: "Expected behaviors" },
      ),
    );
    const history = screen.getByText("1 earlier grade");
    fireEvent.click(history);
    const historyDetails = within(history.closest("details")!);
    expect(historyDetails.getByText(/score -$/iu)).toBeTruthy();
    expect(historyDetails.queryAllByText(/—/u)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Regrade this simulation" }));
    const dialog = screen.getByRole("dialog", { name: "Regrade “Books service”?" });
    expect(within(dialog).getByText(REGRADE_IS_NOT_A_REPLAY)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Regrade simulation" }));
    expect(
      await screen.findByText(/queued for a whole-simulation regrade/iu),
    ).toBeTruthy();
    expect(
      sent.some(
        (request) =>
          request.path === "/v1/simulations/sim_1/regrade" && request.method === "POST",
      ),
    ).toBe(true);
  });

  /** A run whose one simulation has not settled, with the evidence it has so far. */
  function unsettledStubs(
    status: "queued" | "running",
    evidence: Record<string, unknown>,
  ): Record<string, Stub | readonly Stub[]> {
    return detailStubs(
      runDetail({ status: "running", finishedAt: null }),
      {
        status: 200,
        body: {
          simulations: [
            simulation({
              status,
              gradingState: null,
              gradeTally: null,
              combinedScore: null,
              endedAt: null,
            }),
          ],
          nextPageToken: null,
        },
      },
      {
        status: 200,
        body: simulationEvidence({
          status,
          gradingState: "not_requested",
          grades: [],
          gradeHistory: [],
          combinedScore: null,
          endedAt: null,
          ...evidence,
        }),
      },
    );
  }

  /* The first turn ends the wait, and the tab streams as it always has. */
  it("shows the transcript as soon as a running simulation has a turn", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(unsettledStubs("running", {}));
    render(<RunDetailPage />);

    const panel = await screen.findByRole("tabpanel", { name: "Transcript" });
    expect(panel.querySelector('[data-slot="waiting-mark"]')).toBeNull();
    expect(within(panel).getByRole("heading", { name: "Conversation" })).toBeTruthy();
    expect(within(panel).getByText("Can you find my appointment?")).toBeTruthy();
  });

  it("loads more simulations with the cursor and keeps the first page", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(
      detailStubs(runDetail({ expectedSimulationCount: 2 }), [
        {
          status: 200,
          body: { simulations: [simulation()], nextPageToken: "sim_next" },
        },
        {
          status: 200,
          body: {
            simulations: [
              simulation({ id: "sim_2", position: 2, testName: "Reschedules service" }),
            ],
            nextPageToken: null,
          },
        },
      ]),
    );
    render(<RunDetailPage />);

    const paged = await screen.findByRole("complementary", {
      name: "Simulations in this run",
    });
    expect(
      within(paged).getByRole("heading", { name: /^Simulations/u }).textContent,
    ).toBe("Simulations · 2");
    expect(screen.queryByText("1 loaded")).toBeNull();
    expect(screen.getByText("More simulations are available")).toBeTruthy();
    expect(screen.queryByText(/simulations so far/iu)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("button", { name: /Reschedules service,/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Books service,/u })).toBeTruthy();
    expect(
      sent.some(
        (request) =>
          request.path === "/v1/runs/run_1/simulations" &&
          request.url.includes("pageToken=sim_next"),
      ),
    ).toBe(true);
  });

  it("keeps execution failure separate from grades without capability text", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(
      detailStubs(
        runDetail(),
        {
          status: 200,
          body: {
            simulations: [
              simulation({
                status: "failed",
                gradingState: "not_requested",
                combinedScore: null,
                reason: "not_answered",
                executionFailure: "Retell did not answer the test call.",
              }),
            ],
            nextPageToken: null,
          },
        },
        {
          status: 200,
          body: simulationEvidence({
            status: "failed",
            gradingState: "not_requested",
            grades: [],
            combinedScore: null,
            reason: "not_answered",
            executionFailure: "Retell did not answer the test call.",
            gradingPlan: null,
            transcript: null,
          }),
        },
      ),
    );
    render(<RunDetailPage />);

    expect(await screen.findByRole("button", { name: /Execution failed/u })).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Retell did not answer the test call. This is an execution problem, not a failed grade.",
    );
    /* The heading is the test's name; the failed square is on the row. */
    const failedHeader = document.querySelector(
      '[data-slot="selected-simulation-header"]',
    );
    expect(failedHeader?.textContent).toBe("Books service");
    expect(failedHeader?.querySelector('[data-slot="state-mark"]')).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /Books service,/u })
        .querySelector('[data-slot="state-mark"]')
        ?.getAttribute("data-state-mark"),
    ).toBe("failed");
    expect(await screen.findByText("No grading was requested")).toBeTruthy();
    expect(screen.queryByText("No score")).toBeNull();
    expect(screen.queryByText(/capabilit/u)).toBeNull();

    const summary = screen.getByRole("region", { name: "Simulation summary" });
    const executionFailure = screen.getByRole("alert");
    expect(
      executionFailure.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(summary).getAllByText("-")).toHaveLength(2);
    expect(within(summary).queryByText("Not available")).toBeNull();
    expect(within(summary).getAllByText("Not recorded")).toHaveLength(2);
    for (const meaning of within(summary).getAllByText("Not recorded")) {
      expect(meaning.className).toContain("sr-only");
    }

    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    const conversationHeading = await screen.findByRole("heading", {
      name: "Conversation",
    });
    const conversation = conversationHeading.closest("section");
    expect(conversation).not.toBeNull();
    expect(within(conversation!).getByText("No conversation recorded")).toBeTruthy();
    expect(
      within(conversation!).getByText(
        "This simulation finished without a recorded conversation or tool calls.",
      ),
    ).toBeTruthy();
  });

  it("toasts the exact execution failure when a non-selected simulation fails", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const notify = vi.spyOn(toast, "error");
    const dismiss = vi.spyOn(toast, "dismiss");
    const activeRun = runDetail({
      status: "running",
      finishedAt: null,
      expectedSimulationCount: 2,
      simulationCounts: { ...NO_SIMULATIONS, running: 2 },
      finishedCount: 0,
      gradableCount: 0,
      gradedCount: 0,
    });
    const first = simulation({
      status: "running",
      gradingState: null,
      gradeTally: null,
      combinedScore: null,
      endedAt: null,
    });
    const second = simulation({
      id: "sim_2",
      position: 2,
      testId: "tst_2",
      testName: "Reschedules service",
      status: "running",
      gradingState: null,
      gradeTally: null,
      combinedScore: null,
      endedAt: null,
    });
    answers({
      ...detailStubs(
        activeRun,
        [
          {
            status: 200,
            body: { simulations: [first, second], nextPageToken: null },
          },
          {
            status: 200,
            body: {
              simulations: [
                first,
                {
                  ...second,
                  status: "failed",
                  reason: "simulator_error",
                  executionFailure:
                    "LiveKit refused the room because the token had expired.",
                  endedAt: "2026-08-21T10:01:00.000Z",
                },
              ],
              nextPageToken: null,
            },
          },
        ],
        "never",
      ),
      "/v1/runs/run_1/events": [
        {
          status: 200,
          body: {
            events: [],
            next: 0,
            caughtUp: true,
            done: false,
          },
        },
        {
          status: 200,
          body: {
            events: [
              {
                seq: 1,
                at: "2026-08-21T10:01:00.000Z",
                kind: "simulation",
                simulationId: "sim_2",
                testName: "Reschedules service",
                personaName: "Patient caller",
                status: "failed",
                reason: "simulator_error",
                executionFailure:
                  "LiveKit refused the room because the token had expired.",
              },
            ],
            next: 1,
            caughtUp: true,
            done: false,
          },
        },
        "never",
      ],
      "/v1/simulations/sim_2": {
        status: 200,
        body: simulationEvidence({
          id: "sim_2",
          status: "failed",
          gradingState: "not_requested",
          combinedScore: null,
          reason: "simulator_error",
          executionFailure:
            "LiveKit refused the room because the token had expired.",
          endedAt: "2026-08-21T10:01:00.000Z",
          grades: [],
          gradeHistory: [],
          gradingPlan: null,
          transcript: null,
        }),
      },
    });
    render(<RunDetailPage />);

    await waitFor(
      () => {
        expect(notify).toHaveBeenCalledTimes(1);
      },
      { timeout: 4000 },
    );
    expect(notify).toHaveBeenCalledWith("Simulation execution failed", {
      id: "run_1:1",
      description:
        "Reschedules service · Patient caller: LiveKit refused the room because the token had expired.",
    });
    expect(await screen.findByText("Simulation execution failed")).toBeTruthy();
    expect(
      screen.getByText(
        "Reschedules service · Patient caller: LiveKit refused the room because the token had expired.",
      ),
    ).toBeTruthy();
    const firstChoice = await screen.findByRole("button", { name: /Books service,/u });
    expect(firstChoice.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Reschedules service, Patient caller, Execution failed",
      }),
    );
    expect(
      await screen.findByText(/This is an execution problem, not a failed grade\./u),
    ).toBeTruthy();
    expect(dismiss).toHaveBeenCalledWith("run_1:1");
  });

  it("does not replay a historical failure toast while the feed catches up", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const notify = vi.spyOn(toast, "error");
    const activeRun = runDetail({
      status: "running",
      eventThrough: 1,
      finishedAt: null,
      expectedSimulationCount: 2,
      simulationCounts: { ...NO_SIMULATIONS, running: 2 },
      finishedCount: 0,
      gradableCount: 0,
      gradedCount: 0,
    });
    const first = simulation({
      status: "running",
      gradingState: null,
      gradeTally: null,
      combinedScore: null,
      endedAt: null,
    });
    const second = simulation({
      id: "sim_2",
      position: 2,
      testId: "tst_2",
      testName: "Reschedules service",
      status: "running",
      gradingState: null,
      gradeTally: null,
      combinedScore: null,
      endedAt: null,
    });
    answers({
      ...detailStubs(
        activeRun,
        {
          status: 200,
          body: { simulations: [first, second], nextPageToken: null },
        },
        "never",
      ),
      "/v1/runs/run_1/events": [
        {
          status: 200,
          body: {
            events: [
              {
                seq: 1,
                at: "2026-08-21T10:01:00.000Z",
                kind: "simulation",
                simulationId: "sim_2",
                testName: "Reschedules service",
                personaName: "Patient caller",
                status: "failed",
                reason: "simulator_error",
                executionFailure:
                  "LiveKit refused the room because the token had expired.",
              },
            ],
            next: 1,
            caughtUp: true,
            done: false,
          },
        },
        "never",
      ],
    });
    render(<RunDetailPage />);

    await screen.findByRole("button", {
      name: "Reschedules service, Patient caller, Execution failed",
    });
    expect(notify).not.toHaveBeenCalled();
    expect(screen.queryByText("Simulation execution failed")).toBeNull();
  });

  it("switches simulations in place and ignores a slower first detail read", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const first = simulation();
    const second = simulation({
      id: "sim_2",
      position: 2,
      testId: "tst_2",
      testName: "Reschedules service",
      combinedScore: 0.4,
    });
    answers({
      ...detailStubs(
        runDetail({ expectedSimulationCount: 2 }),
        {
          status: 200,
          body: { simulations: [first, second], nextPageToken: null },
        },
        "never",
      ),
      "/v1/simulations/sim_2": {
        status: 200,
        body: simulationEvidence({
          id: "sim_2",
          position: 2,
          combinedScore: 0.4,
          test: {
            id: "tst_2",
            versionId: "tstv_2",
            name: "Reschedules service",
            scenario: "Move the appointment.",
            expectedBehaviors: ["Moves the appointment"],
          },
          grades: [
            {
              projectGraderId: "grd_2",
              graderDefinitionId: "grl_2",
              graderDefinitionVersion: 1,
              graderName: "policy_grader",
              parameterValues: { llm_provider: "openai", llm_model: "gpt-4o-mini" },
              score: 0.4,
              details: { rationale: "The requested day was not confirmed." },
              passThreshold: 0.8,
              result: "failed",
              gradedAt: "2026-08-21T10:02:00.000Z",
            },
          ],
          gradingPlan: {
            capturedAt: "2026-08-21T10:00:00.000Z",
            items: [
              {
                projectGraderId: "grd_2",
                graderDefinitionId: "grl_2",
                graderDefinitionVersion: 1,
                graderName: "policy_grader",
                passThreshold: 0.8,
              },
            ],
          },
        }),
      },
    });
    render(<RunDetailPage />);

    const firstChoice = await screen.findByRole("button", { name: /Books service,/u });
    const secondChoice = screen.getByRole("button", { name: /Reschedules service,/u });
    expect(firstChoice.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(secondChoice);

    expect(await screen.findByRole("heading", { name: "Reschedules service" })).toBeTruthy();
    const results = await screen.findByRole("region", { name: "Grader results" });
    const policy = within(results).getByRole("region", { name: "Policy grader" });
    expect(within(policy).getByText("The requested day was not confirmed.")).toBeTruthy();
    expect(secondChoice.getAttribute("aria-pressed")).toBe("true");
    expect(firstChoice.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not show ready evidence from the prior selection under a new heading", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const second = simulation({
      id: "sim_2",
      position: 2,
      testId: "tst_2",
      testName: "Reschedules service",
    });
    answers({
      ...detailStubs(
        runDetail({ expectedSimulationCount: 2 }),
        {
          status: 200,
          body: { simulations: [simulation(), second], nextPageToken: null },
        },
      ),
      "/v1/simulations/sim_2": "never",
    });
    render(<RunDetailPage />);

    const graders = await screen.findByRole("region", { name: "Grader results" });
    fireEvent.click(
      within(graders).getByRole("button", { name: "Expected behaviors" }),
    );
    expect(
      screen.getAllByText("The agent found and confirmed the appointment."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Reschedules service,/u }));

    expect(screen.getByRole("heading", { name: "Reschedules service" })).toBeTruthy();
    expect(screen.queryAllByText("The agent found and confirmed the appointment."))
      .toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Grader results" })).toBeNull();
  });

  it("refreshes a non-selected row when its terminal feed event lands", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const activeRun = runDetail({
      status: "running",
      finishedAt: null,
      expectedSimulationCount: 2,
      simulationCounts: { ...NO_SIMULATIONS, running: 2 },
      finishedCount: 0,
      gradableCount: 0,
      gradedCount: 0,
    });
    const first = simulation({
      status: "running",
      gradingState: null,
      gradeTally: null,
      combinedScore: null,
      endedAt: null,
    });
    const second = simulation({
      id: "sim_2",
      position: 2,
      testId: "tst_2",
      testName: "Reschedules service",
      status: "running",
      gradingState: null,
      gradeTally: null,
      combinedScore: null,
      endedAt: null,
    });
    answers({
      ...detailStubs(
        activeRun,
        [
          {
            status: 200,
            body: { simulations: [first, second], nextPageToken: null },
          },
          {
            status: 200,
            body: {
              simulations: [
                first,
                {
                  ...second,
                  status: "completed",
                  gradingState: "complete",
                  combinedScore: 0.7,
                  gradeTally: { passed: 2, failed: 1, errored: 0, selected: 3 },
                  endedAt: "2026-08-21T10:01:00.000Z",
                },
              ],
              nextPageToken: null,
            },
          },
        ],
        "never",
      ),
      "/v1/runs/run_1/events": [
        {
          status: 200,
          body: {
            events: [
              {
                seq: 1,
                at: "2026-08-21T10:01:00.000Z",
                kind: "simulation",
                simulationId: "sim_2",
                testName: "Reschedules service",
                personaName: "Patient caller",
                status: "completed",
                reason: "persona_concluded",
              },
            ],
            next: 1,
            caughtUp: true,
            done: false,
          },
        },
        "never",
      ],
    });
    render(<RunDetailPage />);

    const refreshed = await screen.findByRole("button", {
      name: "Reschedules service, Patient caller, 2/3 passed",
    });
    expect(refreshed.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a chat transcript and its tool calls in one ordered detail tab", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(detailStubs());
    render(<RunDetailPage />);

    const transcriptTab = await screen.findByRole("tab", { name: "Transcript" });
    fireEvent.click(transcriptTab);

    expect(screen.queryByRole("heading", { name: "Recording" })).toBeNull();
    expect(screen.queryByText("No audio was recorded.")).toBeNull();
    expect(screen.getByRole("heading", { name: "Conversation" })).toBeTruthy();
    const conversation = screen.getByRole("list", { name: "Transcript messages" });
    const events = within(conversation).getAllByRole("listitem");
    expect(events).toHaveLength(2);
    expect(events[0]?.getAttribute("aria-label")).toBe("Turn 1, User");
    expect(events[1]?.getAttribute("aria-label")).toBe("Turn 2, Agent");
    const toolCall = within(conversation).getByLabelText(
      "Tool call, lookup_appointment",
    );
    expect(events[1]?.contains(toolCall)).toBe(true);
    const toolName = within(conversation).getByText("lookup_appointment");
    const details = toolName.closest("details");
    expect(details).not.toBeNull();
    fireEvent.click(toolName.closest("summary")!);
    expect(details?.open).toBe(true);
    expect(
      within(details!).getByRole("region", { name: "lookup_appointment request" })
        .textContent,
    ).toContain('{"customer":"Ada"}');
    expect(
      within(details!).getByRole("region", { name: "lookup_appointment response" })
        .textContent,
    ).toContain('{"appointment":"Tuesday at 10"}');
  });

  it("keeps a selected later-page simulation open while its row refreshes", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const activeRun = runDetail({
      status: "running",
      finishedAt: null,
      expectedSimulationCount: 2,
      simulationCounts: { ...NO_SIMULATIONS, running: 2 },
      finishedCount: 0,
      gradableCount: 0,
      gradedCount: 0,
    });
    const first = simulation({
      status: "running",
      gradingState: null,
      gradeTally: null,
      combinedScore: null,
      endedAt: null,
    });
    const second = simulation({
      id: "sim_2",
      position: 2,
      testId: "tst_2",
      testName: "Reschedules service",
      status: "running",
      gradingState: null,
      gradeTally: null,
      combinedScore: null,
      endedAt: null,
    });
    const refreshedSecond = {
      ...second,
      status: "completed",
      gradingState: "complete",
      combinedScore: 0.7,
      gradeTally: { passed: 2, failed: 1, errored: 0, selected: 3 },
      endedAt: "2026-08-21T10:01:00.000Z",
    };
    answers({
      ...detailStubs(
        activeRun,
        [
          {
            status: 200,
            body: { simulations: [first], nextPageToken: "sim_next" },
          },
          {
            status: 200,
            body: { simulations: [second], nextPageToken: null },
          },
          {
            status: 200,
            body: { simulations: [refreshedSecond], nextPageToken: null },
          },
          {
            status: 200,
            body: { simulations: [first], nextPageToken: "sim_next" },
          },
        ],
        "never",
      ),
      "/v1/simulations/sim_2": "never",
      "/v1/runs/run_1/events": [
        {
          status: 200,
          body: {
            events: [],
            next: 0,
            caughtUp: true,
            done: false,
          },
        },
        {
          status: 200,
          body: {
            events: [
              {
                seq: 1,
                at: "2026-08-21T10:01:00.000Z",
                kind: "simulation",
                simulationId: "sim_2",
                testName: "Reschedules service",
                personaName: "Patient caller",
                status: "completed",
                reason: "persona_concluded",
              },
            ],
            next: 1,
            caughtUp: true,
            done: false,
          },
        },
        "never",
      ],
    });
    render(<RunDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    const laterChoice = await screen.findByRole("button", {
      name: /Reschedules service,/u,
    });
    fireEvent.click(laterChoice);
    expect(screen.getByRole("heading", { name: "Reschedules service" })).toBeTruthy();

    await waitFor(
      () => {
        const refreshed = screen.getByRole("button", {
          name: "Reschedules service, Patient caller, 2/3 passed",
        });
        expect(refreshed.getAttribute("aria-pressed")).toBe("true");
        expect(screen.getByRole("heading", { name: "Reschedules service" })).toBeTruthy();
      },
      { timeout: 4000 },
    );
  });

  it("still cancels an active run but offers no retry or rerun", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const active = runDetail({
      status: "running",
      finishedAt: null,
      gradedCount: 0,
      gradableCount: 1,
      simulationCounts: { ...NO_SIMULATIONS, running: 1 },
    });
    answers({
      ...detailStubs(
        active,
        {
          status: 200,
          body: {
            simulations: [
              simulation({
                status: "running",
                gradingState: null,
                gradeTally: null,
              }),
            ],
            nextPageToken: null,
          },
        },
        /* Evidence for a running simulation has not landed yet. */
        "never",
      ),
      "/v1/runs/run_1/events": "never",
    });
    render(<RunDetailPage />);

    /*
     * The run's own status left this page with the strip. What is still here
     * is each simulation's square, and a running one pulses.
     */
    const runningRow = await screen.findByRole("button", {
      name: "Books service, Patient caller, Running",
    });
    const runningSquare = runningRow.querySelector('[data-slot="state-mark"]');
    expect(runningSquare?.getAttribute("data-state-mark")).toBe("active");
    expect(runningSquare?.getAttribute("data-motion")).toBe("pulse");
    expect(document.querySelector('[data-slot="run-status"]')).toBeNull();

    const cancelButton = await screen.findByRole("button", { name: "Cancel run" });
    expect(cancelButton.closest('[data-slot="page-topbar"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="page-toolbar"]')).toBeNull();
    fireEvent.click(cancelButton);
    const dialog = await screen.findByRole("dialog", { name: "Cancel run “Release check”?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));
    await waitFor(() => {
      expect(
        sent.some(
          (request) =>
            request.method === "POST" && request.path === "/v1/runs/run_1/cancel",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(
        sent.filter((request) => request.path === "/v1/runs/run_1/simulations"),
      ).toHaveLength(2);
    });
    expect(screen.queryByRole("button", { name: /run again|retry/i })).toBeNull();
  });
});
