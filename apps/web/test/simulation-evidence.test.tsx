// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SimulationEvidencePage from "../app/projects/[projectId]/runs/[runId]/simulations/[simulationId]/page.tsx";
import type { Me } from "../lib/me.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

const routed = vi.hoisted(() => ({
  pathname: "/projects/prj_1/runs/run_1/simulations/sim_1",
  params: {
    projectId: "prj_1",
    runId: "run_1",
    simulationId: "sim_1",
  } as Record<string, string>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useParams: () => routed.params,
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

function meWith(role: string): Me {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ id: "org_1", name: "Acme", slug: "acme", role }],
    projects: [{ id: "prj_1", name: "Default", slug: "default" }],
  };
}

type Stubbed = { readonly status: number; readonly body: unknown };
type Recorded = {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown> | undefined;
};

let sent: Recorded[] = [];

function apiAnswers(answers: Record<string, Stubbed>): void {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, options?: RequestInit) => {
      const request = await observeRequest(input, options);
      sent.push({
        path: request.path,
        method: request.method,
        body: request.body as Record<string, unknown> | undefined,
      });
      const answer = answers[request.path];
      if (answer === undefined) {
        throw new Error(`nothing stubbed for ${request.path}`);
      }
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function turn(
  spanId: string,
  kind: "turn:human" | "turn:agent",
  text: string,
  offsetSeconds: number,
) {
  return {
    spanId,
    parentSpanId: "root",
    name: kind,
    kind,
    status: "ok",
    startedAt: `2026-08-15T10:00:${String(offsetSeconds).padStart(2, "0")}.000000Z`,
    durationNs: "1000000000",
    text,
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    spans: [],
  };
}

function grade(overrides: Record<string, unknown> = {}) {
  return {
    projectGraderId: "grd_1",
    graderDefinitionId: "grl_1",
    graderDefinitionVersion: 3,
    graderName: "expected_behaviors",
    score: 0.5,
    details: {
      rationale: "One of two expected behaviors was present.",
      assertions: [
        {
          key: "behavior_1",
          score: 1,
          rationale: "The agent confirmed the new day.",
          citedSpanIds: ["span_agent"],
        },
        {
          key: "behavior_2",
          score: 0,
          rationale: "The agent did not repeat the new time.",
          citedSpanIds: [],
        },
      ],
    },
    passThreshold: 0.8,
    result: "failed",
    gradedAt: "2026-08-15T10:05:00.000Z",
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    id: "sim_1",
    projectId: "prj_1",
    runId: "run_1",
    runName: "Nightly smoke",
    position: 1,
    status: "completed",
    gradingState: "complete",
    grades: [grade()],
    gradeHistory: [
      grade({
        score: 1,
        result: "passed",
        gradedAt: "2026-08-15T09:05:00.000Z",
      }),
    ],
    combinedScore: 0.5,
    reason: null,
    modality: "voice",
    createdAt: "2026-08-15T09:59:00.000Z",
    startedAt: "2026-08-15T10:00:00.000Z",
    endedAt: "2026-08-15T10:00:40.000Z",
    providerReference: "call_abc123",
    hasRecording: false,
    measures: { durationMs: 40_000, turnCount: 2, toolCallCount: 0 },
    metrics: [
      {
        measure: "turn_response_latency",
        unit: "milliseconds",
        derived: false,
        samples: [420, 1100],
        spanIds: ["span_agent_1", "span_agent_2"],
        mean: 760,
        p50: 420,
        p90: 1100,
        partial: false,
      },
    ],
    test: {
      id: "tst_1",
      versionId: "tstv_1",
      name: "Reschedules a booked appointment",
      scenario: "Move the cleaning to next week.",
      expectedBehaviors: [
        "Confirms the new day",
        "Repeats the new time before finishing",
      ],
    },
    persona: {
      id: "prs_1",
      name: "Impatient Rita",
      versionId: "prsv_7",
      traits: { personality: "Speaks plainly.", language: "English" },
    },
    agent: { id: "agt_1", name: "Front desk", archived: false },
    connection: { id: "con_1", name: "retell-staging", archived: false },
    connectionSnapshot: {
      agentPlatform: "retell",
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
      topology: "egma-dials-in",
      environment: "staging",
      config: { phoneNumber: "+15551234567" },
    },
    mockToolCoverage: null,
    mockTools: { defaults: [], overrides: [] },
    gradingPlan: {
      state: "run_start",
      capturedAt: "2026-08-15T09:59:00.000Z",
      items: [
        {
          projectGraderId: "grd_1",
          graderDefinitionId: "grl_1",
          graderDefinitionVersion: 3,
          graderName: "expected_behaviors",
          passThreshold: 0.8,
        },
      ],
    },
    transcript: {
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      startedAt: "2026-08-15T10:00:00.000000Z",
      endedAt: "2026-08-15T10:00:40.000000Z",
      durationNs: "40000000000",
      spanCount: 2,
      turnCounts: { human: 1, agent: 1 },
      toolSpanCount: 0,
      erroredSpanCount: 0,
      turns: [
        turn("span_human", "turn:human", "Move Thursday's clean.", 1),
        turn("span_agent", "turn:agent", "You are all set for Tuesday.", 4),
      ],
      spans: [],
      spansTruncated: false,
    },
    ...overrides,
  };
}

function page({
  role = "admin",
  read = evidence(),
  regrade = { simulationId: "sim_1", reopened: 1, alreadyWaiting: 0 },
}: {
  readonly role?: string;
  readonly read?: Record<string, unknown>;
  readonly regrade?: Record<string, unknown>;
} = {}): void {
  apiAnswers({
    "/api/me": { status: 200, body: meWith(role) },
    "/v1/simulations/sim_1": { status: 200, body: read },
    "/v1/simulations/sim_1/regrade": { status: 200, body: regrade },
  });
}

beforeEach(() => {
  sent = [];
  vi.stubGlobal("scrollTo", vi.fn());
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, search: "", replace: vi.fn() },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("one simulation's grades", () => {
  it("shows the combined score without creating an overall pass or fail", async () => {
    page();
    render(<SimulationEvidencePage />);

    const summary = await screen.findByRole("region", {
      name: "Simulation summary",
    });
    expect(within(summary).getByText("Combined score")).toBeTruthy();
    expect(within(summary).getByText("0.50")).toBeTruthy();
    expect(within(summary).getByText("Duration")).toBeTruthy();
    expect(within(summary).getByText("40s")).toBeTruthy();
    expect(within(summary).getByText("Total turns")).toBeTruthy();
    expect(within(summary).queryByText(/overall|verdict/iu)).toBeNull();
  });

  /**
   * The observed metrics, under the three facts and apart from the grades:
   * the same p90 the transcript page leads with, worded by the one shared
   * formatter, so the two surfaces cannot describe one conversation two ways.
   */
  it("shows what was measured, p90-led, apart from the grades", async () => {
    page();
    render(<SimulationEvidencePage />);

    const measured = await screen.findByRole("region", {
      name: "What was measured",
    });
    expect(within(measured).getByText("Turn response latency")).toBeTruthy();
    expect(
      within(measured).getByText("1100 milliseconds · p90 of 2 measurements"),
    ).toBeTruthy();
  });

  it("keeps assertions inside their grade and keeps earlier grades in history", async () => {
    page();
    render(<SimulationEvidencePage />);

    const grades = await screen.findByRole("region", { name: "Grades" });
    const expected = within(grades).getByRole("region", {
      name: "Expected behaviors",
    });
    expect(within(expected).getByText("Score 0.50 · pass threshold 0.80 · definition v3"))
      .toBeTruthy();
    expect(within(expected).getByText("One of two expected behaviors was present."))
      .toBeTruthy();
    expect(within(expected).getByText("Confirms the new day")).toBeTruthy();
    expect(within(expected).getByText("Repeats the new time before finishing"))
      .toBeTruthy();
    expect(within(expected).getByText("The agent did not repeat the new time."))
      .toBeTruthy();
    expect(within(expected).getByText("1 earlier grade")).toBeTruthy();

    const history = within(expected).getByText("1 earlier grade").closest("details");
    expect(history).not.toBeNull();
    fireEvent.click(within(expected).getByText("1 earlier grade"));
    expect(within(history!).getByText(/score 1.00/iu)).toBeTruthy();
    expect(within(history!).getByText("passed")).toBeTruthy();

    fireEvent.click(within(expected).getByRole("button", { name: "Read turn 2" }));
    expect(await screen.findByRole("dialog", { name: "Transcript and audio" }))
      .toBeTruthy();
    await waitFor(() => {
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: "center",
      });
    });

    const visible = document.body.textContent ?? "";
    for (const retired of ["Required grader", "Reports only", "skipped", "gate"]) {
      expect(visible).not.toContain(retired);
    }
  });

  it("shows the exact frozen grader version and threshold", async () => {
    page();
    render(<SimulationEvidencePage />);

    const plan = await screen.findByRole("region", {
      name: "Frozen grading plan",
    });
    expect(within(plan).getByText("Expected behaviors")).toBeTruthy();
    expect(within(plan).getByText("Definition v3 · pass threshold 0.80"))
      .toBeTruthy();
    expect(document.body.textContent).not.toContain("grd_1");
    expect(document.body.textContent).not.toContain("grl_1");
  });

  it("shows progress from gradingState without reading grading jobs", async () => {
    page({
      read: evidence({
        gradingState: "running",
        grades: [],
        gradeHistory: [],
        combinedScore: null,
      }),
    });
    render(<SimulationEvidencePage />);

    expect(await screen.findByText("Grading is still running. Grades appear here as they finish."))
      .toBeTruthy();
    expect(screen.getByText("Waiting for this grader to return a grade."))
      .toBeTruthy();
    expect(screen.getByText("Not available")).toBeTruthy();
    expect(document.body.textContent).not.toContain("gradingJobs");
  });

  it("keeps a grader error separate from a failed grade", async () => {
    page({
      read: evidence({
        gradingState: "error",
        grades: [
          grade({
            score: null,
            result: "errored",
            details: { error: "The model did not return a usable score." },
          }),
        ],
        combinedScore: null,
      }),
    });
    render(<SimulationEvidencePage />);

    expect(await screen.findByText("The model did not return a usable score."))
      .toBeTruthy();
    expect(screen.getByText(/could not complete every requested grade/iu))
      .toBeTruthy();
    expect(screen.getAllByText("errored").length).toBeGreaterThan(0);
    expect(screen.getByText("Not available")).toBeTruthy();
  });

  it("regrades the whole simulation and keeps the action from viewers", async () => {
    page();
    render(<SimulationEvidencePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Regrade" }));
    const dialog = screen.getByRole("dialog", {
      name: "Regrade “Reschedules a booked appointment”?",
    });
    expect(within(dialog).getByText(/every grader in this simulation's frozen plan/iu))
      .toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Regrade simulation" }));

    await waitFor(() => {
      expect(
        sent.filter(
          (request) =>
            request.path === "/v1/simulations/sim_1/regrade" &&
            request.method === "POST",
        ),
      ).toHaveLength(1);
    });
    expect(await screen.findByText(/queued for a whole-simulation regrade/iu))
      .toBeTruthy();

    cleanup();
    page({ role: "viewer" });
    render(<SimulationEvidencePage />);
    await screen.findByRole("region", { name: "Grades" });
    expect(screen.queryByRole("button", { name: "Regrade" })).toBeNull();
    expect(screen.getByText(/can read every grade here but cannot request a regrade/iu))
      .toBeTruthy();
  });

  it("uses not_requested instead of a skipped grade", async () => {
    page({
      read: evidence({
        status: "canceled",
        gradingState: "not_requested",
        grades: [],
        gradeHistory: [],
        combinedScore: null,
        gradingPlan: null,
        transcript: null,
      }),
    });
    render(<SimulationEvidencePage />);

    expect(await screen.findByText("No grading was requested")).toBeTruthy();
    expect(screen.getByText("No grader was asked to grade this simulation."))
      .toBeTruthy();
    expect(document.body.textContent?.toLocaleLowerCase()).not.toContain("skipped");
  });
});
