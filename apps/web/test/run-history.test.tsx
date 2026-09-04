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
  | { readonly deferred: Promise<Response> }
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
      if ("deferred" in answer) return answer.deferred;
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

/** One pinned test version, as the run note reads it. */
function testVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: "tstv_1",
    testId: "tst_1",
    suiteId: "ste_1",
    testName: "Books service",
    version: 1,
    current: true,
    scenario: "The caller books service.",
    expectedBehaviors: ["Offers an available time"],
    personas: [{ id: "prs_1", name: "Patient caller", archivedAt: null }],
    mockTools: [],
    env: null,
    createdAt: "2026-08-21T10:00:00.000Z",
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
      state: "run_start",
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
  it("keeps one Create a run action on the empty page", async () => {
    answers({
      ...shellStubs(),
      "/v1/runs": {
        status: 200,
        body: { runs: [], nextPageToken: null },
      },
    });
    render(<RunsPage />);

    expect(await screen.findByText("Create your first simulation run")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Create a run" })).toHaveLength(1);
  });

  it("shows the run name and the suite's current name as separate facts", async () => {
    answers({
      ...shellStubs(),
      "/v1/runs": {
        status: 200,
        body: { runs: [runHeader()], nextPageToken: null },
      },
    });
    render(<RunsPage />);

    const table = await screen.findByRole("table", { name: "Runs in this project" });
    expect(within(table).getByRole("link", { name: "Release check" }).getAttribute("href")).toBe(
      "/projects/prj_1/runs/run_1",
    );
    expect(within(table).getByText("Northside Ford")).toBeTruthy();
    expect(within(table).queryByRole("link", { name: "Northside Ford" })).toBeNull();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toContain("Test suite");
  });

  it("keeps historical runs readable after their suite is deleted", async () => {
    answers({
      ...shellStubs(),
      "/v1/runs": {
        status: 200,
        body: {
          runs: [runHeader({ suiteName: "Northside Ford", suiteDeleted: true })],
          nextPageToken: null,
        },
      },
    });
    render(<RunsPage />);

    const table = await screen.findByRole("table", { name: "Runs in this project" });
    expect(within(table).getByText("Northside Ford (deleted)")).toBeTruthy();
    expect(within(table).queryByRole("link", { name: "Northside Ford (deleted)" })).toBeNull();
  });

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
      // The run note reads the versions this run's rows pinned. A test that
      // says nothing about the note still asks for them, because the page
      // does.
      "/v1/test-versions/tstv_1": {
        status: 200,
        body: testVersion(),
      },
    };
  }

  it("reads simulations from their bounded endpoint and offers no rerun control", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(detailStubs());
    render(<RunDetailPage />);

    const title = await screen.findByRole("heading", { name: "Release check" });
    const navigation = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(title.closest("nav")).toBe(navigation);
    expect(
      within(navigation).getByRole("link", { name: "Runs" }).getAttribute("href"),
    ).toBe("/projects/prj_1/runs");
    expect(navigation.textContent).toBe("Runs/Release check");
    const suite = screen.getByRole("link", { name: "Northside Ford" });
    expect(suite.getAttribute("href")).toBe("/projects/prj_1/tests/suites/ste_1");
    for (const link of [
      suite,
      screen.getByRole("link", { name: "Front desk" }),
      screen.getByRole("link", { name: "retell-staging" }),
    ]) {
      expect(link.className).toContain("no-underline");
      expect(link.className).toContain("pointer-hover:underline");
    }
    const first = await screen.findByRole("button", { name: /Books service,/u });
    expect(first.getAttribute("aria-label")).toBe(
      "Books service, Patient caller, Completed",
    );
    expect(within(first).queryByText(/Score|59s/u)).toBeNull();
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(first.className).toContain("bg-selected");
    expect(first.className).toContain("before:bg-brand");
    expect(first.querySelector('[data-slot="state-mark"]')).toBeNull();
    expect(screen.getByText("1 simulation")).toBeTruthy();
    const summary = screen.getByRole("group", { name: "Run summary" });
    for (const label of ["Status", "Started", "Test suite", "Agent", "Connection"]) {
      expect(within(summary).getByText(label)).toBeTruthy();
    }
    expect(within(summary).getByText("Chat")).toBeTruthy();
    const completedStatus = within(summary)
      .getByText("Completed")
      .closest('[data-slot="run-status"]');
    expect(completedStatus).not.toBeNull();
    expect(completedStatus?.querySelector('[data-slot="state-mark"]')).toBeNull();
    expect(completedStatus?.querySelector('[data-slot="run-status-loader"]')).toBeNull();
    const resultsTab = screen.getByRole("tab", { name: "Results summary" });
    expect(resultsTab.getAttribute("data-state")).toBe("active");
    expect(resultsTab.className).toContain(
      "group-data-[variant=line]/tabs-list:after:-bottom-px",
    );
    expect(resultsTab.className).not.toContain("bg-selected");
    const graderResults = await screen.findByRole("region", { name: "Grader results" });
    const expected = within(graderResults).getByRole("region", {
      name: "Expected behaviors",
    });
    const graderLink = within(expected).getByRole("link", {
      name: "Expected behaviors",
    });
    expect(graderLink.getAttribute("href")).toBe(
      `/projects/prj_1/graders?graderDefinition=${EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID}&definitionVersion=2`,
    );
    expect(graderLink.className).toContain("pointer-hover:underline");
    const graderHeading = within(expected).getByRole("heading", {
      name: "Grader Expected behaviors",
    });
    expect(graderHeading.textContent).toBe("Grader · Expected behaviors");
    const passed = within(expected).getByText("Passed");
    expect(passed.className).toContain("text-success");
    expect(passed.parentElement?.textContent).toBe("Result · Passed");
    expect(within(expected).getByText("Total Score 1")).toBeTruthy();
    const behaviorTable = within(expected).getByRole("table", {
      name: "Expected behaviors results",
    });
    expect(
      within(behaviorTable)
        .getAllByRole("cell")
        .map((cell) => cell.getAttribute("data-label")),
    ).toEqual(["Expected behavior", "Grader result", "Total Score"]);
    expect(
      within(behaviorTable).getByRole("columnheader", { name: "Total Score" })
        .className,
    ).toContain("text-center");
    expect(within(behaviorTable).getAllByRole("cell")[2]?.className).toContain(
      "text-center",
    );
    expect(within(behaviorTable).getByText("Finds and confirms the appointment"))
      .toBeTruthy();
    expect(within(behaviorTable).getByText("The agent found and confirmed the appointment."))
      .toBeTruthy();
    const simulationSummary = screen.getByRole("region", {
      name: "Simulation summary",
    });
    for (const label of [
      "Total avg score",
      "Duration",
      "Total turns",
      "P90 turn latency",
    ]) {
      expect(within(simulationSummary).getByText(label)).toBeTruthy();
    }
    expect(within(simulationSummary).getByText("-")).toBeTruthy();
    expect(within(simulationSummary).queryByText("Not available")).toBeNull();
    expect(within(simulationSummary).getByText("Not recorded").className).toContain(
      "sr-only",
    );
    expect(
      simulationSummary.compareDocumentPosition(expected) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "What was measured" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Frozen grading plan" })).toBeNull();
    const resultsPanel = screen.getByRole("tabpanel", { name: "Results summary" });
    expect(resultsPanel.className).toContain("overflow-y-auto");
    expect(resultsPanel.parentElement?.className).toContain("overflow-hidden");
    expect(screen.getByRole("button", { name: "Regrade" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open full simulation" })).toBeNull();
    const selectedHeader = document.querySelector(
      '[data-slot="selected-simulation-header"]',
    );
    expect(selectedHeader?.textContent).toBe("Books service");
    expect(selectedHeader?.textContent).not.toContain("completed");
    expect(selectedHeader?.textContent).not.toContain("Graded");
    expect(screen.queryByRole("button", { name: /run again|retry/i })).toBeNull();
    expect(
      sent.some(
        (request) =>
          request.method === "GET" && request.path === "/v1/runs/run_1/simulations",
      ),
    ).toBe(true);
  });

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
    expect(within(expected).getByText("Total Score -")).toBeTruthy();
    expect(within(expected).queryAllByText(/—/u)).toHaveLength(0);
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
    const history = screen.getByText("1 earlier grade");
    fireEvent.click(history);
    const historyDetails = within(history.closest("details")!);
    expect(historyDetails.getByText(/score -$/iu)).toBeTruthy();
    expect(historyDetails.queryAllByText(/—/u)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Regrade" }));
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

  it("uses the suite name as the title when the optional run name is absent", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(detailStubs(runDetail({ name: null })));
    render(<RunDetailPage />);

    expect(await screen.findByRole("heading", { name: "Northside Ford" })).toBeTruthy();
  });

  it("does not claim that a pending run has started", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(
      detailStubs(
        runDetail({
          status: "pending",
          startedAt: null,
          finishedAt: null,
          expectedSimulationCount: 0,
        }),
        { status: 200, body: { simulations: [], nextPageToken: null } },
      ),
    );
    render(<RunDetailPage />);

    const summary = await screen.findByRole("group", { name: "Run summary" });
    expect(within(summary).getByText("Not started")).toBeTruthy();
  });

  it("shows a deleted suite as history, not as a live link", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(detailStubs(runDetail({ suiteDeleted: true, name: null })));
    render(<RunDetailPage />);

    const summary = await screen.findByRole("group", { name: "Run summary" });
    expect(within(summary).getByText("Northside Ford (deleted)")).toBeTruthy();
    expect(within(summary).queryByRole("link", { name: /Northside Ford/u })).toBeNull();
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

    expect(await screen.findByText("2 simulations")).toBeTruthy();
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
    expect(
      document.querySelector('[data-slot="selected-simulation-header"]')?.textContent,
    ).not.toContain("Execution failed");
    expect(await screen.findByText("No grading was requested")).toBeTruthy();
    expect(screen.queryByText("No score")).toBeNull();
    expect(screen.queryByText(/capabilit/u)).toBeNull();

    const summary = screen.getByRole("region", { name: "Simulation summary" });
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
    expect(within(conversation!).getByText("-")).toBeTruthy();
    expect(within(conversation!).getByText("No conversation recorded")).toBeTruthy();
    expect(within(conversation!).queryByText("Nothing was said")).toBeNull();
    expect(
      within(conversation!).queryByText("Egma filed no spoken turns for this simulation."),
    ).toBeNull();
  });

  it("does not expose a raw failure reason when older evidence has no detail", async () => {
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
                reason: "simulator_error",
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
            reason: "simulator_error",
            gradingPlan: null,
            transcript: null,
          }),
        },
      ),
    );
    render(<RunDetailPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "The simulator encountered an error and could not continue.",
    );
    expect(alert.textContent).not.toContain("simulator_error");
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

  it("toasts a new failure that arrives while a long history is still paging", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const notify = vi.spyOn(toast, "error");
    const activeRun = runDetail({
      status: "running",
      // The page became visible with 200 historical events. Failure 201 then
      // landed before the first bounded feed request could reach it.
      eventThrough: 200,
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
      combinedScore: null,
      endedAt: null,
    });
    const history = Array.from({ length: 200 }, (_, index) => ({
      seq: index + 1,
      at: "2026-08-21T10:00:00.000Z",
      kind: "run",
      status: "running",
    }));
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
                  executionFailure: "The media connection closed unexpectedly.",
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
            events: history,
            next: 200,
            caughtUp: false,
            done: false,
          },
        },
        {
          status: 200,
          body: {
            events: [
              {
                seq: 201,
                at: "2026-08-21T10:01:00.000Z",
                kind: "simulation",
                simulationId: "sim_2",
                testName: "Reschedules service",
                personaName: "Patient caller",
                status: "failed",
                reason: "simulator_error",
                executionFailure: "The media connection closed unexpectedly.",
              },
            ],
            next: 201,
            caughtUp: true,
            done: false,
          },
        },
        "never",
      ],
    });
    render(<RunDetailPage />);

    await waitFor(
      () => {
        expect(notify).toHaveBeenCalledTimes(1);
      },
      { timeout: 4000 },
    );
    expect(notify).toHaveBeenCalledWith("Simulation execution failed", {
      id: "run_1:201",
      description:
        "Reschedules service · Patient caller: The media connection closed unexpectedly.",
    });
  });

  it("keeps the first detail boundary while a feed request is delayed", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const notify = vi.spyOn(toast, "error");
    const firstDetail = runDetail({
      status: "running",
      eventThrough: 0,
      finishedAt: null,
      expectedSimulationCount: 2,
      simulationCounts: { ...NO_SIMULATIONS, running: 2 },
      finishedCount: 0,
      gradableCount: 1,
      gradedCount: 0,
    });
    const refreshedDetail = { ...firstDetail, eventThrough: 1 };
    const first = simulation({
      status: "running",
      gradingState: null,
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
      combinedScore: null,
      endedAt: null,
    });
    answers({
      ...detailStubs(
        firstDetail,
        {
          status: 200,
          body: { simulations: [first, second], nextPageToken: null },
        },
        "never",
      ),
      "/v1/runs/run_1": [
        { status: 200, body: firstDetail },
        { status: 200, body: refreshedDetail },
      ],
      "/v1/runs/run_1/events": [
        // The first feed request stays open. Grading polling refreshes the run
        // detail to eventThrough 1 and restarts the follower.
        "never",
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
                executionFailure: "The media connection closed unexpectedly.",
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

    await waitFor(
      () => {
        expect(notify).toHaveBeenCalledTimes(1);
      },
      { timeout: 4000 },
    );
    expect(notify).toHaveBeenCalledWith("Simulation execution failed", {
      id: "run_1:1",
      description:
        "Reschedules service · Patient caller: The media connection closed unexpectedly.",
    });
  });

  it("temporarily toasts until the initial selection can show the persistent message", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const notify = vi.spyOn(toast, "error");
    const dismiss = vi.spyOn(toast, "dismiss");
    let answerSimulationList!: (response: Response) => void;
    const refreshedSimulationList = new Promise<Response>((resolve) => {
      answerSimulationList = resolve;
    });
    let answerEvidence!: (response: Response) => void;
    const evidenceRead = new Promise<Response>((resolve) => {
      answerEvidence = resolve;
    });
    const activeRun = runDetail({
      status: "running",
      finishedAt: null,
      expectedSimulationCount: 1,
      completedCount: 0,
      simulationCounts: { ...NO_SIMULATIONS, running: 1 },
      finishedCount: 0,
      gradableCount: 0,
      gradedCount: 0,
    });
    const failed = simulation({
      status: "failed",
      gradingState: "not_requested",
      combinedScore: null,
      reason: "simulator_error",
      executionFailure: "The media connection closed unexpectedly.",
      endedAt: "2026-08-21T10:01:00.000Z",
    });
    answers({
      ...detailStubs(
        activeRun,
        ["never", { deferred: refreshedSimulationList }],
        { deferred: evidenceRead },
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
                simulationId: "sim_1",
                testName: "Books service",
                personaName: "Patient caller",
                status: "failed",
                reason: "simulator_error",
                executionFailure: "The media connection closed unexpectedly.",
              },
            ],
            next: 1,
            // The failure landed after the run detail captured its history
            // boundary, while the simulation list was still loading.
            caughtUp: true,
            done: false,
          },
        },
        "never",
      ],
    });
    render(<RunDetailPage />);

    await waitFor(
      () => {
        expect(
          sent.filter(
            (request) => request.path === "/v1/runs/run_1/simulations",
          ),
        ).toHaveLength(2);
      },
      { timeout: 4000 },
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Simulation execution failed", {
      id: "run_1:1",
      description:
        "Books service · Patient caller: The media connection closed unexpectedly.",
    });

    answerSimulationList(
      new Response(
        JSON.stringify({ simulations: [failed], nextPageToken: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Loading this simulation's results…",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "The media connection closed unexpectedly. This is an execution problem, not a failed grade.",
      ).closest('[role="alert"]'),
    ).not.toBeNull();
    expect(dismiss).toHaveBeenCalledWith("run_1:1");
    await waitFor(() => {
      expect(screen.queryByText("Simulation execution failed")).toBeNull();
    });

    answerEvidence(
      new Response(
        JSON.stringify(
          simulationEvidence({
            status: "failed",
            gradingState: "not_requested",
            combinedScore: null,
            reason: "simulator_error",
            executionFailure: "The media connection closed unexpectedly.",
            endedAt: "2026-08-21T10:01:00.000Z",
            grades: [],
            gradeHistory: [],
            gradingPlan: null,
            transcript: null,
          }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "Loading this simulation's results…",
        }),
      ).toBeNull();
    });
    const persistentMessage = screen.getByText(
      "The media connection closed unexpectedly. This is an execution problem, not a failed grade.",
    );
    expect(persistentMessage.closest('[role="alert"]')).not.toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledWith("run_1:1");
  });

  it("toasts while the simulation list is unavailable and selects normally on retry", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const notify = vi.spyOn(toast, "error");
    const dismiss = vi.spyOn(toast, "dismiss");
    let answerEvent!: (response: Response) => void;
    const eventRead = new Promise<Response>((resolve) => {
      answerEvent = resolve;
    });
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
      combinedScore: null,
      endedAt: null,
    });
    const second = simulation({
      id: "sim_2",
      position: 2,
      testId: "tst_2",
      testName: "Reschedules service",
      status: "failed",
      gradingState: "not_requested",
      combinedScore: null,
      reason: "simulator_error",
      executionFailure:
        "LiveKit refused the room because the token had expired.",
      endedAt: "2026-08-21T10:01:00.000Z",
    });
    answers({
      ...detailStubs(
        activeRun,
        [
          {
            status: 500,
            body: {
              error: "read_failed",
              message: "The simulation list could not be read.",
            },
          },
          // The terminal event starts a quiet refresh. Keep that read open so
          // only the person's explicit retry returns the list.
          "never",
          {
            status: 200,
            body: { simulations: [first, second], nextPageToken: null },
          },
        ],
        "never",
      ),
      "/v1/runs/run_1/events": [
        { deferred: eventRead },
        "never",
      ],
    });
    render(<RunDetailPage />);

    expect(await screen.findByText("The simulation list could not be read.")).toBeTruthy();
    answerEvent(
      new Response(
        JSON.stringify({
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
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith("Simulation execution failed", {
      id: "run_1:1",
      description:
        "Reschedules service · Patient caller: LiveKit refused the room because the token had expired.",
    });

    await waitFor(() => {
      expect(
        sent.filter(
          (request) => request.path === "/v1/runs/run_1/simulations",
        ),
      ).toHaveLength(2);
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    const selected = await screen.findByRole("button", { name: /Books service,/u });
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalledWith("run_1:1");
  });

  it("uses the selected simulation's persistent alert instead of a duplicate toast", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const notify = vi.spyOn(toast, "error");
    let answerFailedEvidence!: (response: Response) => void;
    const failedEvidenceRead = new Promise<Response>((resolve) => {
      answerFailedEvidence = resolve;
    });
    const activeRun = runDetail({
      status: "running",
      finishedAt: null,
      expectedSimulationCount: 1,
      completedCount: 0,
      simulationCounts: { ...NO_SIMULATIONS, running: 1 },
      finishedCount: 0,
      gradableCount: 0,
      gradedCount: 0,
    });
    const running = simulation({
      status: "running",
      gradingState: null,
      combinedScore: null,
      endedAt: null,
    });
    const failed = {
      ...running,
      status: "failed",
      reason: "simulator_error",
      executionFailure: "LiveKit refused the room because the token had expired.",
      endedAt: "2026-08-21T10:01:00.000Z",
    };
    answers({
      ...detailStubs(
        activeRun,
        [
          {
            status: 200,
            body: { simulations: [running], nextPageToken: null },
          },
          {
            status: 200,
            body: { simulations: [failed], nextPageToken: null },
          },
        ],
        [
          {
            status: 200,
            body: simulationEvidence({
              status: "running",
              gradingState: null,
              combinedScore: null,
              endedAt: null,
            }),
          },
          { deferred: failedEvidenceRead },
        ],
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
                simulationId: "sim_1",
                testName: "Books service",
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

    const feedBackedMessage = await screen.findByText(
      "LiveKit refused the room because the token had expired. This is an execution problem, not a failed grade.",
      undefined,
      { timeout: 5000 },
    );
    expect(feedBackedMessage.closest('[role="alert"]')).not.toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(screen.queryByText("Simulation execution failed")).toBeNull();

    answerFailedEvidence(
      new Response(
        JSON.stringify(
          simulationEvidence({
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
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "Loading this simulation's results…",
        }),
      ).toBeNull();
    });
    const evidenceBackedMessage = screen.getByText(
      "LiveKit refused the room because the token had expired. This is an execution problem, not a failed grade.",
    );
    expect(evidenceBackedMessage.closest('[role="alert"]')).not.toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not toast a failed feed response after leaving the run", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const notify = vi.spyOn(toast, "error");
    let answerLate!: (response: Response) => void;
    const late = new Promise<Response>((resolve) => {
      answerLate = resolve;
    });
    const activeRun = runDetail({
      status: "running",
      finishedAt: null,
      expectedSimulationCount: 2,
      simulationCounts: { ...NO_SIMULATIONS, running: 2 },
      finishedCount: 0,
      gradableCount: 0,
      gradedCount: 0,
    });
    answers({
      ...detailStubs(
        activeRun,
        {
          status: 200,
          body: {
            simulations: [
              simulation({
                status: "running",
                gradingState: null,
                combinedScore: null,
                endedAt: null,
              }),
              simulation({
                id: "sim_2",
                position: 2,
                testId: "tst_2",
                testName: "Reschedules service",
                status: "running",
                gradingState: null,
                combinedScore: null,
                endedAt: null,
              }),
            ],
            nextPageToken: null,
          },
        },
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
        { deferred: late },
      ],
    });
    const view = render(<RunDetailPage />);

    await waitFor(
      () => {
        expect(
          sent.filter((request) => request.path === "/v1/runs/run_1/events"),
        ).toHaveLength(2);
      },
      { timeout: 4000 },
    );
    view.unmount();
    answerLate(
      new Response(
        JSON.stringify({
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
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notify).not.toHaveBeenCalled();
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
              score: 0.4,
              details: { rationale: "The requested day was not confirmed." },
              passThreshold: 0.8,
              result: "failed",
              gradedAt: "2026-08-21T10:02:00.000Z",
            },
          ],
          gradingPlan: {
            state: "run_start",
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

    expect(
      await screen.findAllByText("The agent found and confirmed the appointment."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Reschedules service,/u }));

    expect(screen.getByRole("heading", { name: "Reschedules service" })).toBeTruthy();
    expect(screen.queryAllByText("The agent found and confirmed the appointment."))
      .toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Grader results" })).toBeNull();
  });

  it("does not show a prior selection refusal under a new heading", async () => {
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
        {
          status: 500,
          body: { error: "read_failed", message: "The old simulation is unavailable." },
        },
      ),
      "/v1/simulations/sim_2": "never",
    });
    render(<RunDetailPage />);

    expect(await screen.findByText("The old simulation is unavailable.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Reschedules service,/u }));

    expect(screen.getByRole("heading", { name: "Reschedules service" })).toBeTruthy();
    expect(screen.queryByText("The old simulation is unavailable.")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Loading this simulation's results…" }),
    ).toBeTruthy();
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
      name: "Reschedules service, Patient caller, Completed",
    });
    expect(refreshed.getAttribute("aria-pressed")).toBe("false");
  });

  it("stacks every grader as its own full-width result card", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const firstEvidence = simulationEvidence();
    const policyGrade = {
      ...firstEvidence.grades[0],
      projectGraderId: "grd_policy",
      graderDefinitionId: "grl_policy",
      graderName: "policy_grader",
      score: 0.65,
      result: "failed",
      details: { rationale: "The agent did not confirm consent." },
    };
    const policyPlan = {
      ...firstEvidence.gradingPlan.items[0],
      projectGraderId: "grd_policy",
      graderDefinitionId: "grl_policy",
      graderName: "policy_grader",
    };
    answers(
      detailStubs(
        runDetail(),
        {
          status: 200,
          body: { simulations: [simulation()], nextPageToken: null },
        },
        {
          status: 200,
          body: simulationEvidence({
            grades: [...firstEvidence.grades, policyGrade],
            gradingPlan: {
              ...firstEvidence.gradingPlan,
              items: [...firstEvidence.gradingPlan.items, policyPlan],
            },
          }),
        },
      ),
    );
    render(<RunDetailPage />);

    const results = await screen.findByRole("region", { name: "Grader results" });
    const expected = within(results).getByRole("region", {
      name: "Expected behaviors",
    });
    const policy = within(results).getByRole("region", { name: "Policy grader" });
    expect(within(expected).getByText("Total Score 1")).toBeTruthy();
    expect(within(policy).getByText("Total Score 0.65")).toBeTruthy();
    const failed = within(policy).getByText("Failed");
    expect(failed.className).toContain("text-failure");
    expect(failed.parentElement?.textContent).toBe("Result · Failed");
    expect(within(policy).getByText("The agent did not confirm consent.")).toBeTruthy();
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

  it("keeps recording evidence on the voice simulation path", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const voiceSnapshot = {
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "voice",
      topology: "agent-dials-out",
      environment: null,
      config: {},
    };
    answers(
      detailStubs(
        runDetail({
          modality: "voice",
          connectionSnapshot: voiceSnapshot,
          connection: {
            id: "con_1",
            name: "livekit_voice-1",
            productLabel: "LiveKit project credentials",
            archived: false,
          },
        }),
        {
          status: 200,
          body: {
            simulations: [simulation({ modality: "voice" })],
            nextPageToken: null,
          },
        },
        {
          status: 200,
          body: simulationEvidence({
            modality: "voice",
            connectionSnapshot: voiceSnapshot,
          }),
        },
      ),
    );
    render(<RunDetailPage />);

    const evidence = await screen.findByRole("tab", {
      name: "Transcript & audio",
    });
    fireEvent.click(evidence);

    expect(await screen.findByRole("heading", { name: "Recording" })).toBeTruthy();
    expect(screen.getByText("No audio was recorded.")).toBeTruthy();
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
      combinedScore: null,
      endedAt: null,
    });
    const refreshedSecond = {
      ...second,
      status: "completed",
      gradingState: "complete",
      combinedScore: 0.7,
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
          name: "Reschedules service, Patient caller, Completed",
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
      ...detailStubs(active, {
        status: 200,
        body: {
          simulations: [
            simulation({ status: "running", gradingState: null }),
          ],
          nextPageToken: null,
        },
      }),
      "/v1/runs/run_1/events": "never",
    });
    render(<RunDetailPage />);

    const summary = await screen.findByRole("group", { name: "Run summary" });
    const runningStatus = within(summary)
      .getByText("Running")
      .closest('[data-slot="run-status"]');
    expect(runningStatus).not.toBeNull();
    expect(runningStatus?.querySelector('[data-slot="state-mark"]')).toBeNull();
    expect(
      runningStatus?.querySelector('[data-slot="run-status-loader"]'),
    ).not.toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
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
  /**
   * **The run note, on the run itself.**
   *
   * A run pins its tests' versions, so what it says is a fact about what was
   * actually conducted rather than about the suite as it stands today. The
   * connection decides the words: a phone lane cannot mock and cannot carry
   * Retell's variables, a web call makes one temporary version, and a LiveKit
   * room serves mocks only through the SDK.
   */
  describe("the run note", () => {
    function noteStubs(
      connection: { connectionType: string; accessVariant: string },
      versions: readonly Record<string, unknown>[],
    ): Record<string, Stub | readonly Stub[]> {
      const rows = versions.map((version, at) =>
        simulation({
          id: `sim_${String(at + 1)}`,
          position: at + 1,
          testId: `tst_${String(at + 1)}`,
          testName: `Test ${String(at + 1)}`,
          testVersionId: String(version.id),
        }),
      );
      return {
        "/api/me": { status: 200, body: ME },
        "/v1/runs/run_1": { status: 200, body: runDetail(connection) },
        "/v1/runs/run_1/simulations": {
          status: 200,
          body: { simulations: rows, nextPageToken: null },
        },
        "/v1/simulations/sim_1": { status: 200, body: simulationEvidence() },
        ...Object.fromEntries(
          versions.map((version) => [
            `/v1/test-versions/${String(version.id)}`,
            { status: 200, body: version },
          ]),
        ),
      };
    }

    /** Three tests: one mocking, one carrying each half of an env, one bare. */
    const MIXED = [
      testVersion({
        id: "tstv_1",
        mockTools: [{ tool: "get_availability", answer: { slots: [] } }],
      }),
      testVersion({
        id: "tstv_2",
        env: { retell_dynamic_variables: { caller_name: "Margaret" } },
      }),
      testVersion({ id: "tstv_3", env: { job_dispatch_metadata: { tenant: "acme" } } }),
    ];

    async function noteLines(): Promise<readonly HTMLElement[]> {
      await screen.findByRole("group", { name: "Run summary" });
      return await waitFor(() => {
        const note = document.querySelector('[data-slot="run-note"]');
        if (note === null) throw new Error("no run note yet");
        return [...note.querySelectorAll("p")] as HTMLElement[];
      });
    }

    beforeEach(() => {
      routed.pathname = "/projects/prj_1/runs/run_1";
    });

    it("says what a phone lane will not use, in the warning colour", async () => {
      answers(
        noteStubs(
          {
            connectionType: "phone_number",
            accessVariant: "phone_number.public_e164",
          },
          MIXED,
        ),
      );
      render(<RunDetailPage />);

      const lines = await noteLines();
      expect(lines.map((line) => line.textContent)).toEqual([
        "Some test data will not be used on this connection.",
        "1 of 3 tests carries mock tools. A Retell phone connection cannot mock tools, so those simulations reach your real tools.",
        "1 of 3 tests carries Retell dynamic variables. A phone call is answered by Retell, not created by Egma, so they cannot be passed.",
      ]);
      for (const line of lines) {
        expect(line.getAttribute("data-accent")).toBe("warning");
        expect(line.className).toContain("border-warning");
      }
    });

    it("says a web call makes one temporary version, in the brand colour", async () => {
      answers(
        noteStubs(
          {
            connectionType: "retell_web_call",
            accessVariant: "retell_web_call.api_key",
          },
          MIXED,
        ),
      );
      render(<RunDetailPage />);

      const lines = await noteLines();
      expect(lines.map((line) => line.textContent)).toEqual([
        "This run creates one temporary version of your Retell agent.",
        "Egma makes it at run start, points only the mocked tools at Egma, and deletes it when the run ends. Your serving version is never changed.",
        "1 of 3 tests carries mock tools. In those simulations, tools the test does not mock reach your real backend. The other 2 tests run on your serving version with all real tools.",
      ]);
      for (const line of lines) {
        expect(line.getAttribute("data-accent")).toBe("brand");
        expect(line.className).toContain("border-brand");
      }
    });

    it("warns about nothing on a token endpoint, which carries the dispatch metadata too", async () => {
      // Two facts apply on a token endpoint, the same two as on a key pair:
      // the brand pair about the SDK and the quiet line about Retell's
      // variables. The test's dispatch metadata rides the token request Egma
      // sends the endpoint, so the warning that used to lead this note is
      // gone, and three lines fit whole.
      answers(
        noteStubs(
          {
            connectionType: "livekit_room",
            accessVariant: "livekit_room.customer_token_endpoint",
          },
          MIXED,
        ),
      );
      render(<RunDetailPage />);

      const lines = await noteLines();
      expect(lines.map((line) => line.textContent)).toEqual([
        "Mock tools on LiveKit need the Egma SDK in your agent.",
        "1 of 3 tests carries mock tools. They are served only when your agent runs mockable(...). Tools a test does not mock run real.",
        "1 test carries retell_dynamic_variables, which a LiveKit connection does not use.",
      ]);
      expect(lines.map((line) => line.getAttribute("data-accent"))).toEqual([
        "brand",
        "brand",
        "quiet",
      ]);
      expect(
        lines.some((line) =>
          (line.textContent ?? "").includes("job_dispatch_metadata"),
        ),
      ).toBe(false);
    });

    it("says quietly what the other platform's data is, on a key-pair room", async () => {
      answers(
        noteStubs(
          {
            connectionType: "livekit_room",
            accessVariant: "livekit_room.project_credentials",
          },
          [
            testVersion({
              id: "tstv_1",
              env: { retell_dynamic_variables: { caller_name: "Margaret" } },
            }),
            testVersion({ id: "tstv_2" }),
          ],
        ),
      );
      render(<RunDetailPage />);

      const lines = await noteLines();
      expect(lines.map((line) => line.textContent)).toEqual([
        "1 test carries retell_dynamic_variables, which a LiveKit connection does not use.",
      ]);
      expect(lines[0]?.getAttribute("data-accent")).toBe("quiet");
      expect(lines[0]?.className).toContain("border-border");
    });

    it("counts every page of the run's simulations, not the page on screen", async () => {
      /*
       * The list shows the first page and grows on the reader's own Load more.
       * The note says "1 of 3", so it walks the run to the end itself: a
       * denominator read off the rows that happen to be on screen would be a
       * wrong number said quietly, and the one test that mocks is on page two.
       */
      const versions = [
        testVersion({ id: "tstv_1" }),
        testVersion({ id: "tstv_2" }),
        testVersion({
          id: "tstv_3",
          mockTools: [{ tool: "get_availability", answer: { slots: [] } }],
        }),
      ];
      const rows = versions.map((version, at) =>
        simulation({
          id: `sim_${String(at + 1)}`,
          position: at + 1,
          testId: `tst_${String(at + 1)}`,
          testName: `Test ${String(at + 1)}`,
          testVersionId: String(version.id),
        }),
      );
      answers({
        "/api/me": { status: 200, body: ME },
        "/v1/runs/run_1": {
          status: 200,
          body: runDetail({
            connectionType: "retell_web_call",
            accessVariant: "retell_web_call.api_key",
          }),
        },
        "/v1/runs/run_1/simulations": [
          {
            status: 200,
            body: { simulations: rows.slice(0, 2), nextPageToken: "sim_2" },
          },
          { status: 200, body: { simulations: rows.slice(2), nextPageToken: null } },
        ],
        "/v1/simulations/sim_1": { status: 200, body: simulationEvidence() },
        ...Object.fromEntries(
          versions.map((version) => [
            `/v1/test-versions/${String(version.id)}`,
            { status: 200, body: version },
          ]),
        ),
      });
      render(<RunDetailPage />);

      const lines = await noteLines();
      // Three tests, one of them mocking — and the first page held neither of
      // those facts.
      expect(lines.map((line) => line.textContent)).toEqual([
        "This run creates one temporary version of your Retell agent.",
        "Egma makes it at run start, points only the mocked tools at Egma, and deletes it when the run ends. Your serving version is never changed.",
        "1 of 3 tests carries mock tools. In those simulations, tools the test does not mock reach your real backend. The other 2 tests run on your serving version with all real tools.",
      ]);
    });

    it("draws no note at all when nothing applies", async () => {
      answers(
        noteStubs(
          {
            connectionType: "retell_web_call",
            accessVariant: "retell_web_call.api_key",
          },
          [testVersion({ id: "tstv_1" }), testVersion({ id: "tstv_2" })],
        ),
      );
      render(<RunDetailPage />);

      await screen.findByRole("group", { name: "Run summary" });
      await waitFor(() => {
        expect(
          sent.some((request) => request.path === "/v1/test-versions/tstv_2"),
        ).toBe(true);
      });
      expect(document.querySelector('[data-slot="run-note"]')).toBeNull();
    });
  });
});
