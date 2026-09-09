// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SimulationEvidencePage from "../app/projects/[projectId]/runs/[runId]/simulations/[simulationId]/page.tsx";
import type { Me } from "../lib/me.ts";
import {
  ChatTranscript,
  RecordingEvidence,
  recordingOriginOf,
  recordingSpeakerTimeline,
  simulationToolCalls,
  transcriptToolCalls,
  type SimulationEvidenceRecording,
  useDirectEvidenceRecording,
  useSimulationEvidenceRecording,
} from "../ui/simulation-evidence.tsx";
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
    parameterValues: { llm_provider: "openai", llm_model: "gpt-4o-mini" },
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
    workBlock: null,
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
    executionFailure: null,
    modality: "voice",
    createdAt: "2026-08-15T09:59:00.000Z",
    startedAt: "2026-08-15T10:00:00.000Z",
    endedAt: "2026-08-15T10:00:40.000Z",
    providerReference: "call_abc123",
    agentPovComplete: false,
    agentPovIncomplete: false,
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
    gradingPlan: {
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
  it("shows the simulator's exact execution failure without exposing its raw category", async () => {
    page({
      read: evidence({
        status: "failed",
        gradingState: "not_requested",
        grades: [],
        gradeHistory: [],
        combinedScore: null,
        reason: "simulator_error",
        executionFailure:
          "OpenAI Realtime STT refused the request because the account has no credits remaining.",
        gradingPlan: null,
        transcript: null,
      }),
    });
    render(<SimulationEvidencePage />);

    expect(
      await screen.findByText(
        "OpenAI Realtime STT refused the request because the account has no credits remaining.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/execution problem, not a failed grade/iu)).toBeTruthy();
    expect(screen.queryByText("simulator_error")).toBeNull();
  });

  it("offers key repair for a proven simulation credential failure", async () => {
    page({ read: evidence({ status: "failed", reason: "provider_key_unavailable",
      executionFailure: "The saved OpenAI key cannot be used.", gradingPlan: null, transcript: null,
    }) });
    render(<SimulationEvidencePage />);
    expect(await screen.findByText("The saved OpenAI key cannot be used.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Manage provider API keys" }).getAttribute("href"))
      .toBe("/projects/prj_1/settings/provider-api-keys");
    expect(screen.queryByRole("link", { name: "Add credits" })).toBeNull();
  });

  it("offers key repair beside a grader's typed customer-key error", async () => {
    page({ read: evidence({ gradingState: "error", grades: [grade({ score: null, result: "errored",
      details: { errorCode: "provider_key_unavailable", error: "The saved OpenAI key cannot be used." },
    })], gradeHistory: [], combinedScore: null }) });
    render(<SimulationEvidencePage />);
    expect(await screen.findByText("The saved OpenAI key cannot be used.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Manage provider API keys" }).getAttribute("href"))
      .toBe("/projects/prj_1/settings/provider-api-keys");
    expect(screen.queryByRole("link", { name: "Add credits" })).toBeNull();
  });

  it("counts the graders that passed without creating an overall pass or fail", async () => {
    page();
    render(<SimulationEvidencePage />);

    const title = await screen.findByRole("heading", {
      name: "Reschedules a booked appointment",
    });
    const navigation = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(title.closest("nav")).toBe(navigation);
    expect(
      within(navigation).getByRole("link", { name: "Runs" }).getAttribute("href"),
    ).toBe("/projects/prj_1/runs");
    expect(
      within(navigation).getByRole("link", { name: "Nightly smoke" }).getAttribute(
        "href",
      ),
    ).toBe("/projects/prj_1/runs/run_1");
    expect(navigation.textContent).toBe(
      "Runs/Nightly smoke/Reschedules a booked appointment",
    );
    expect(within(navigation).queryByText("Simulation 01")).toBeNull();

    const summary = await screen.findByRole("region", {
      name: "Simulation summary",
    });
    expect(within(summary).getByText("Graders passed")).toBeTruthy();
    expect(within(summary).getByText("0/1 · 1 failed")).toBeTruthy();
    /*
     * The bar's values read in the product's own sans face. Tabular figures
     * still hold the columns still; mono stays where it names a thing.
     */
    for (const value of ["0/1 · 1 failed", "40s"]) {
      expect(within(summary).getByText(value).className).not.toContain("font-mono");
      expect(within(summary).getByText(value).className).toContain("tabular-nums");
    }
    expect(within(summary).getByText("Duration")).toBeTruthy();
    expect(within(summary).getByText("40s")).toBeTruthy();
    expect(within(summary).getByText("Total turns")).toBeTruthy();
    /*
     * The average of every grader's score has left the bar. One number over
     * graders that each answered their own question reads as an overall
     * verdict, and there is none: ADR-0017 stands.
     */
    expect(within(summary).queryByText("Total avg score")).toBeNull();
    expect(within(summary).queryByText("0.50")).toBeNull();
    expect(within(summary).queryByText(/overall|verdict/iu)).toBeNull();
    expect(within(summary).queryByText(/^(Passed|Failed|Error)$/u)).toBeNull();
  });

  it("presents chat as chat and leaves every audio control out", async () => {
    page({
      read: evidence({
        modality: "chat",
        providerReference: "egma-sim-chat-1",
        connection: {
          id: "con_1",
          name: "livekit_room-1",
          archived: false,
        },
        connectionSnapshot: {
          agentPlatform: "livekit",
          connectionType: "livekit_room",
          accessVariant: "livekit_room.project_credentials",
          modality: "chat",
          topology: "agent-dials-out",
          environment: null,
          config: {},
        },
        transcript: null,
      }),
    });
    render(<SimulationEvidencePage />);

    await screen.findByRole("heading", {
      name: "Reschedules a booked appointment",
    });
    expect(document.body.textContent).toContain(
      "Impatient Rita chatting with Front desk through livekit_room-1 · Chat",
    );
    expect(
      screen.getByRole("button", { name: "Open transcript" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open transcript and audio" }),
    ).toBeNull();
    const transcript = await screen.findByRole("dialog", { name: "Transcript" });
    expect(within(transcript).queryByRole("heading", { name: "Recording" })).toBeNull();
    expect(
      within(transcript).getByText("Waiting for LiveKit transcript"),
    ).toBeTruthy();
    expect(within(transcript).queryByText(/speech/iu)).toBeNull();
  });

  it("shows a dash for every summary value that was not recorded", async () => {
    page({
      read: evidence({
        gradingState: "not_requested",
        grades: [],
        gradeHistory: [],
        gradingPlan: null,
        combinedScore: null,
        measures: { durationMs: null, turnCount: null, toolCallCount: null },
        metrics: [],
        transcript: null,
      }),
    });
    render(<SimulationEvidencePage />);

    const summary = await screen.findByRole("region", {
      name: "Simulation summary",
    });
    expect(within(summary).getAllByText("-")).toHaveLength(4);
    expect(within(summary).queryByText("Not available")).toBeNull();
    expect(within(summary).getAllByText("Not recorded")).toHaveLength(4);
    for (const meaning of within(summary).getAllByText("Not recorded")) {
      expect(meaning.className).toContain("sr-only");
    }
  });

  it("keeps recorded zero summary values instead of treating them as empty", async () => {
    page({
      read: evidence({
        combinedScore: 0,
        measures: { durationMs: 0, turnCount: 0, toolCallCount: 0 },
        metrics: [
          {
            measure: "turn_response_latency",
            unit: "milliseconds",
            derived: false,
            samples: [0],
            spanIds: ["span_agent"],
            mean: 0,
            p50: 0,
            p90: 0,
            partial: false,
          },
        ],
        transcript: null,
      }),
    });
    render(<SimulationEvidencePage />);

    const summary = await screen.findByRole("region", {
      name: "Simulation summary",
    });
    expect(within(summary).getByText("0/1 · 1 failed")).toBeTruthy();
    expect(within(summary).getByText("0s")).toBeTruthy();
    expect(within(summary).getByText("0")).toBeTruthy();
    expect(within(summary).getByText("0 ms")).toBeTruthy();
    expect(within(summary).queryByText("-")).toBeNull();
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
    const evidenceSheet = await screen.findByRole("dialog", {
      name: "Transcript and audio",
    });
    expect(evidenceSheet.className).toContain("--sheet-width-wide");
    expect(evidenceSheet.className).not.toContain("--sheet-width-extra-wide");
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
    const summary = screen.getByRole("region", { name: "Simulation summary" });
    expect(within(summary).getByText("Graders passed")).toBeTruthy();
    /* A partial count while grading would read as a settled one. */
    expect(within(summary).getByText("—")).toBeTruthy();
    expect(within(summary).queryByText("Not available")).toBeNull();
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
    const summary = screen.getByRole("region", { name: "Simulation summary" });
    expect(within(summary).getByText("0/1 · 1 errored")).toBeTruthy();
    expect(within(summary).queryByText("Not available")).toBeNull();
  });

  it("shows the current funding block for a queued simulation", async () => {
    page({ read: evidence({
      status: "queued",
      workBlock: { error: "providers_unfunded", message: "The inference balance is $0.00." },
    }) });
    render(<SimulationEvidencePage />);
    const refusal = await screen.findByText("This simulation is waiting. The inference balance is $0.00.");
    const alert = within(refusal.closest('[role="alert"]') as HTMLElement);
    expect(alert.getByRole("link", { name: "Add credits" }).getAttribute("href"))
      .toBe("/projects/prj_1/settings/billing");
    expect(alert.getByRole("link", { name: "Manage provider API keys" }).getAttribute("href"))
      .toBe("/projects/prj_1/settings/provider-api-keys");
  });

  it("keeps a regrade funding refusal distinct from missing evidence and offers both funding paths", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/simulations/sim_1": { status: 200, body: evidence() },
      "/v1/simulations/sim_1/regrade": {
        status: 422,
        body: { error: "providers_unfunded", message: "The inference balance is $0.00." },
      },
    });
    render(<SimulationEvidencePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Regrade" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Regrade simulation" }));
    const refusal = await screen.findByText("The inference balance is $0.00.");
    const alert = within(refusal.closest('[role="alert"]') as HTMLElement);
    expect(alert.getByRole("link", { name: "Add credits" }).getAttribute("href"))
      .toBe("/projects/prj_1/settings/billing");
    expect(alert.getByRole("link", { name: "Manage provider API keys" }).getAttribute("href"))
      .toBe("/projects/prj_1/settings/provider-api-keys");
    expect(screen.queryByText(/did not finish with gradeable evidence/iu)).toBeNull();
    expect(screen.queryByText(/queued for a whole-simulation regrade/iu)).toBeNull();
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

describe("the transcript time rail", () => {
  it("shows one simple empty conversation state", () => {
    const read = evidence();
    const transcript = read.transcript as NonNullable<
      ReturnType<typeof evidence>["transcript"]
    >;

    render(
      <ChatTranscript
        transcript={{ ...transcript, turns: [], spans: [] } as never}
      />,
    );

    expect(screen.getByText("No conversation recorded")).toBeTruthy();
    expect(
      screen.getByText(
        "This simulation finished without a recorded conversation or tool calls.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("-")).toBeNull();
    expect(screen.queryByText("Nothing was said")).toBeNull();
    expect(
      screen.queryByText("Egma filed no spoken turns for this simulation."),
    ).toBeNull();
  });

  it("uses the compact continuous rail with shared time and speaker metadata", () => {
    const read = evidence();
    const transcript = read.transcript as NonNullable<
      ReturnType<typeof evidence>["transcript"]
    >;
    const tool = {
      spanId: "span_tool_compact",
      parentSpanId: "span_agent",
      name: "lookup_appointment",
      kind: "tool" as const,
      status: "ok" as const,
      startedAt: "2026-08-15T10:00:06.000000Z",
      durationNs: "250000000",
      text: "",
      audioUrl: "",
      toolName: "lookup_appointment",
      toolArguments: "{}",
      toolResult: "{}",
      spans: [],
    };
    const rendered = render(
      <ChatTranscript
        transcript={transcript as never}
        toolCalls={[tool as never]}
        onSeek={vi.fn()}
      />,
    );

    const rail = screen.getByRole("list", { name: "Transcript messages" });
    expect(rail.className).toContain("border");
    expect(rail.className).not.toContain("gap-3");

    const userTurn = screen.getByLabelText("Turn 1, User");
    const time = within(userTurn).getByText("0:01");
    const speaker = within(userTurn).getByText("User");
    const sentence = within(userTurn).getByText("Move Thursday's clean.");
    expect(time.parentElement).toBe(speaker.parentElement);
    expect(sentence.parentElement).not.toBe(time.parentElement);

    const agentTurn = screen.getByLabelText("Turn 2, Agent");
    const toolRow = screen.getByLabelText("Tool call, lookup_appointment");
    expect(agentTurn.contains(toolRow)).toBe(true);
    expect(within(toolRow).getByText("Tool").parentElement).toBe(
      within(toolRow).getByText("0:06").parentElement,
    );
    expect(toolRow.querySelector('[data-slot="state-mark"]')).toBeNull();

    rendered.rerender(
      <ChatTranscript
        transcript={transcript as never}
        toolCalls={[{ ...tool, status: "error" } as never]}
        onSeek={vi.fn()}
      />,
    );
    expect(
      screen
        .getByLabelText("Tool call, lookup_appointment")
        .querySelector('[data-state-mark="error"]'),
    ).not.toBeNull();
  });

  /**
   * Render the supplied mocked provenance mark without repeating the tool name.
   * An unmarked tool call gets no extra label. This does not verify tool execution.
   */
  it("marks a call a mock tool answered, and leaves a real one unmarked", () => {
    const read = evidence();
    const transcript = read.transcript as NonNullable<
      ReturnType<typeof evidence>["transcript"]
    >;
    const tool = {
      spanId: "span_tool_provenance",
      parentSpanId: "span_agent",
      name: "lookup_appointment",
      kind: "tool" as const,
      status: "ok" as const,
      startedAt: "2026-08-15T10:00:06.000000Z",
      durationNs: "250000000",
      text: "",
      audioUrl: "",
      toolName: "lookup_appointment",
      toolArguments: "{}",
      toolResult: "{}",
      spans: [],
    };
    const rendered = render(
      <ChatTranscript
        transcript={transcript as never}
        toolCalls={[{ ...tool, toolProvenance: "mocked" } as never]}
        onSeek={vi.fn()}
      />,
    );

    const mocked = screen.getByLabelText("Tool call, lookup_appointment");
    expect(mocked.textContent).toContain("mocked · Succeeded");

    rendered.rerender(
      <ChatTranscript
        transcript={transcript as never}
        toolCalls={[tool as never]}
        onSeek={vi.fn()}
      />,
    );
    const real = screen.getByLabelText("Tool call, lookup_appointment");
    expect(real.textContent).toContain("Succeeded");
    expect(real.textContent).not.toContain("mocked");
  });

  it("seeks speech without autoplay and expands exact tool requests and responses", () => {
    const read = evidence();
    const tool = {
      spanId: "span_tool",
      parentSpanId: "span_agent",
      name: "lookup_appointment",
      kind: "tool" as const,
      status: "ok" as const,
      startedAt: "2026-08-15T10:00:06.000000Z",
      durationNs: "250000000",
      text: "",
      audioUrl: "",
      toolName: "lookup_appointment",
      toolArguments: '{"customer":"Ada"}',
      toolResult: '{"appointment":"Tuesday at 10"}',
      spans: [],
    };
    const seek = vi.fn();
    const rendered = render(
      <ChatTranscript
        transcript={read.transcript as never}
        toolCalls={[tool as never]}
        currentTime={1}
        onSeek={seek}
      />,
    );

    const user = screen.getByRole("button", { name: /Move Thursday's clean/u });
    fireEvent.click(user);
    expect(seek).toHaveBeenCalledWith(1);
    expect(user.getAttribute("aria-pressed")).toBe("true");

    rendered.rerender(
      <ChatTranscript
        transcript={read.transcript as never}
        toolCalls={[tool as never]}
        currentTime={4.5}
        onSeek={seek}
      />,
    );
    const agent = screen.getByRole("button", { name: /You are all set for Tuesday/u });
    expect(agent.getAttribute("aria-current")).toBe("true");
    expect(screen.queryByText("Playing")).toBeNull();
    expect(screen.getByRole("button", { name: /Move Thursday's clean/u }).getAttribute("aria-pressed"))
      .toBe("true");

    const toolName = screen.getByText("lookup_appointment");
    const details = toolName.closest("details");
    fireEvent.click(toolName.closest("summary")!);
    expect(details?.open).toBe(true);
    expect(seek).toHaveBeenLastCalledWith(6);
    expect(within(details!).getByRole("region", { name: "lookup_appointment request" }).textContent)
      .toContain('{"customer":"Ada"}');
    expect(within(details!).getByRole("region", { name: "lookup_appointment response" }).textContent)
      .toContain('{"appointment":"Tuesday at 10"}');

    fireEvent.click(
      within(details!.parentElement!).getByRole("button", {
        name: "Seek recording to tool call lookup_appointment at 0:06",
      }),
    );
    expect(seek).toHaveBeenLastCalledWith(6);

    rendered.rerender(
      <ChatTranscript
        transcript={read.transcript as never}
        toolCalls={[{ ...tool, status: "unset" } as never]}
        currentTime={6}
        onSeek={seek}
      />,
    );
    expect(screen.getByText(/Status not recorded ·/u)).toBeTruthy();
  });

  it.each([
    {
      source: "Retell",
      agentStartedAt: "2026-08-15T10:00:39.606000Z",
      toolStartedAt: "2026-08-15T10:00:37.362000Z",
      shownOffset: "0:37",
      toolBeforeSpeech: true,
      throughIntermediateSpan: false,
    },
    {
      source: "OTLP",
      agentStartedAt: "2026-08-15T10:00:04.000000Z",
      toolStartedAt: "2026-08-15T10:00:06.000000Z",
      shownOffset: "0:06",
      toolBeforeSpeech: false,
      throughIntermediateSpan: true,
    },
  ])(
    "shows a $source tool at its real offset inside the invoking agent turn",
    ({
      agentStartedAt,
      toolStartedAt,
      shownOffset,
      toolBeforeSpeech,
      throughIntermediateSpan,
    }) => {
      const read = evidence();
      const original = read.transcript as NonNullable<typeof read.transcript>;
      const tool = {
        spanId: "span_tool_owned",
        parentSpanId: throughIntermediateSpan
          ? "span_model_owned"
          : "span_agent_owned",
        name: "get_availability",
        kind: "tool" as const,
        status: "ok" as const,
        startedAt: toolStartedAt,
        durationNs: "250000000",
        text: "",
        audioUrl: "",
        toolName: "get_availability",
        toolArguments: "{}",
        toolResult: "{}",
        spans: [],
      };
      const model = {
        spanId: "span_model_owned",
        parentSpanId: "span_agent_owned",
        name: "model_response",
        kind: "model" as const,
        status: "ok" as const,
        startedAt: "2026-08-15T10:00:05.000000Z",
        durationNs: "2000000000",
        text: "",
        audioUrl: "",
        toolName: "",
        toolArguments: "",
        toolResult: "",
        spans: [tool],
      };
      const agent = {
        ...turn(
          "span_agent_owned",
          "turn:agent",
          "I found an opening.",
          4,
        ),
        startedAt: agentStartedAt,
        spans: throughIntermediateSpan ? [model] : [tool],
      };
      const transcript = {
        ...original,
        endedAt: "2026-08-15T10:01:00.000000Z",
        durationNs: "60000000000",
        spanCount: throughIntermediateSpan ? 5 : 4,
        toolSpanCount: 1,
        turns: [
          turn(
            "span_human_owned",
            "turn:human",
            "Find an appointment.",
            1,
          ),
          agent,
        ],
      };

      render(
        <ChatTranscript
          transcript={transcript as never}
          toolCalls={transcriptToolCalls(transcript as never)}
          onSeek={vi.fn()}
        />,
      );

      const toolRow = screen.getByLabelText("Tool call, get_availability");
      const agentTurn = screen.getByLabelText("Turn 2, Agent");
      const spokenContent = within(agentTurn).getByText("I found an opening.");
      expect(
        screen.getByRole("button", {
          name:
            `Seek recording to tool call get_availability at ${shownOffset}`,
        }),
      ).toBeTruthy();
      expect(agentTurn.contains(toolRow)).toBe(true);
      expect(
        Boolean(
          toolRow.compareDocumentPosition(spokenContent) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(toolBeforeSpeech);
    },
  );

  it("keeps intervening speech ahead of an Agent group whose tool started early", () => {
    const read = evidence();
    const original = read.transcript as NonNullable<typeof read.transcript>;
    const tool = {
      spanId: "span_tool_early",
      parentSpanId: "span_agent_after_interruption",
      name: "get_availability",
      kind: "tool" as const,
      status: "ok" as const,
      startedAt: "2026-08-15T10:00:37.362000Z",
      durationNs: "531000000",
      text: "",
      audioUrl: "",
      toolName: "get_availability",
      toolArguments: "{}",
      toolResult: "{}",
      spans: [],
    };
    const agent = {
      ...turn(
        "span_agent_after_interruption",
        "turn:agent",
        "I found an opening.",
        39,
      ),
      startedAt: "2026-08-15T10:00:39.606000Z",
      spans: [tool],
    };
    const transcript = {
      ...original,
      endedAt: "2026-08-15T10:01:00.000000Z",
      durationNs: "60000000000",
      spanCount: 5,
      toolSpanCount: 1,
      turns: [
        turn("span_human_first", "turn:human", "Find an appointment.", 1),
        turn("span_human_between", "turn:human", "Any provider is fine.", 38),
        agent,
      ],
    };

    render(
      <ChatTranscript
        transcript={transcript as never}
        toolCalls={transcriptToolCalls(transcript as never)}
      />,
    );

    const turns = screen.getAllByLabelText(/^Turn \d+,/u);
    expect(turns.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Turn 1, User",
      "Turn 2, User",
      "Turn 3, Agent",
    ]);
    const agentTurn = turns[2];
    const toolRow = screen.getByLabelText("Tool call, get_availability");
    expect(agentTurn?.contains(toolRow)).toBe(true);
    expect(
      Boolean(
        toolRow.compareDocumentPosition(
          within(agentTurn!).getByText("I found an opening."),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  it("keeps a tool without an owning Agent turn visible on the time rail", () => {
    const read = evidence();
    const orphan = {
      spanId: "span_tool_orphan",
      parentSpanId: "span_missing_parent",
      name: "send_reminder",
      kind: "tool" as const,
      status: "ok" as const,
      startedAt: "2026-08-15T10:00:06.000000Z",
      durationNs: "250000000",
      text: "",
      audioUrl: "",
      toolName: "send_reminder",
      toolArguments: "{}",
      toolResult: "{}",
      spans: [],
    };

    render(
      <ChatTranscript
        transcript={read.transcript as never}
        toolCalls={[orphan as never]}
      />,
    );

    const toolRow = screen.getByLabelText("Tool call, send_reminder");
    expect(toolRow).toBeTruthy();
    expect(
      screen
        .getAllByLabelText(/^Turn \d+,/u)
        .every((turnRow) => !turnRow.contains(toolRow)),
    ).toBe(true);
  });

  it("uses the recording span for transcript timestamps and seeking", () => {
    const read = evidence();
    const transcript = read.transcript as NonNullable<
      ReturnType<typeof evidence>["transcript"]
    >;
    const recording = {
      spanId: "span_recording",
      parentSpanId: "root",
      name: "recording",
      kind: "recording" as const,
      status: "ok" as const,
      startedAt: "2026-08-15T10:00:00.500000Z",
      durationNs: "0",
      text: "",
      audioUrl: "",
      toolName: "",
      toolArguments: "",
      toolResult: "",
      spans: [],
    };
    const root = {
      spanId: "root",
      parentSpanId: "",
      name: "simulation",
      kind: "root" as const,
      status: "ok" as const,
      startedAt: transcript.startedAt,
      durationNs: transcript.durationNs,
      text: "",
      // A provider may put audio on the root. The simulator's explicit marker
      // still wins because the root began before its recorder.
      audioUrl: "https://recordings.example/root.wav",
      toolName: "",
      toolArguments: "",
      toolResult: "",
      spans: [recording],
    };
    const withRecording = {
      ...transcript,
      spans: [root],
    };
    const seek = vi.fn();

    render(
      <ChatTranscript
        transcript={withRecording as never}
        toolCalls={[]}
        recordingStartedAt={recordingOriginOf(withRecording as never)}
        currentTime={0.75}
        onSeek={seek}
      />,
    );

    const firstTurn = screen.getByRole("button", {
      name: /Move Thursday's clean/u,
    });
    expect(firstTurn.getAttribute("aria-current")).toBe("true");
    fireEvent.click(firstTurn);
    expect(seek).toHaveBeenCalledWith(0.5);
  });

  it("can name monitoring speakers and keeps one shared tool-call walk", () => {
    const read = evidence();
    const transcript = read.transcript as NonNullable<
      ReturnType<typeof evidence>["transcript"]
    >;
    const tool = {
      spanId: "span_tool_shared",
      parentSpanId: "span_agent",
      name: "lookup_appointment",
      kind: "tool" as const,
      status: "ok" as const,
      startedAt: "2026-08-15T10:00:06.000000Z",
      durationNs: "250000000",
      text: "",
      audioUrl: "",
      toolName: "lookup_appointment",
      toolArguments: "{}",
      toolResult: "{}",
      spans: [],
    };
    const firstTurn = transcript.turns[0];
    if (firstTurn === undefined) throw new Error("fixture needs one turn");
    const withTool = {
      ...transcript,
      turns: [
        { ...firstTurn, spans: [tool] },
        ...transcript.turns.slice(1),
      ],
      spans: [tool],
    };

    expect(transcriptToolCalls(withTool as never)).toEqual([tool]);
    expect(
      simulationToolCalls({ ...read, transcript: withTool } as never),
    ).toEqual([tool]);

    const rendered = render(
      <ChatTranscript
        transcript={transcript as never}
        speakerLabels={{ human: "Caller", agent: "Voice agent" }}
      />,
    );
    expect(screen.getByText("Caller")).toBeTruthy();
    expect(screen.getByText("Voice agent")).toBeTruthy();
    expect(screen.getByLabelText("Turn 1, Caller")).toBeTruthy();

    rendered.rerender(
      <ChatTranscript
        transcript={{ ...transcript, turns: [], spans: [] } as never}
        emptyState={{
          title: "No transcript",
          description: "No spoken turns were recorded for this trace.",
        }}
      />,
    );
    expect(screen.getByText("No transcript")).toBeTruthy();
    expect(
      screen.getByText("No spoken turns were recorded for this trace."),
    ).toBeTruthy();
  });
});

/**
 * Use the agent POV for the readable transcript. The persona POV supplies
 * recording evidence and the seek origin. This fixture contains a booking
 * with three tool calls, including mocked and refused results.
 */
describe("the agent's POV is what a reader is shown", () => {
  const AGENT_TURNS = [
    { ...turn("lk_human", "turn:human", "Anything Tuesday?", 1), pov: "agent" },
    {
      ...turn("lk_agent", "turn:agent", "Tuesday is fully booked.", 4),
      pov: "agent",
    },
  ];

  function toolCall(over: Record<string, unknown>) {
    return {
      spanId: "lk_tool",
      parentSpanId: "lk_agent",
      name: "function_tool",
      kind: "tool" as const,
      status: "ok" as const,
      startedAt: "2026-08-15T10:00:06.000000Z",
      durationNs: "60000000",
      text: "",
      audioUrl: "",
      toolName: "check_availability",
      toolArguments: '{"preferred_date":"Tuesday"}',
      toolResult: "The next free slot is Thursday at 10:00 AM.",
      pov: "agent",
      spans: [],
      ...over,
    };
  }

  /** Both accounts of one conversation, under one trace. */
  function bothPovs(tools: readonly Record<string, unknown>[]) {
    const read = evidence();
    const transcript = read.transcript as NonNullable<
      ReturnType<typeof evidence>["transcript"]
    >;
    return {
      ...transcript,
      turns: [
        // The persona's account: what egma's simulator heard.
        ...transcript.turns.map((one) => ({ ...one, pov: "persona" })),
        ...AGENT_TURNS,
      ],
      spans: [...tools],
    };
  }

  it("shows a failed Retell web call's missing transcript without simulator speech or mock rows", async () => {
    const read = evidence();
    page({
      read: evidence({
        status: "failed",
        gradingState: "not_requested",
        agentPovIncomplete: true,
        connectionSnapshot: {
          ...read.connectionSnapshot,
          connectionType: "retell_web_call",
        },
        transcript: {
          ...read.transcript,
          turns: read.transcript.turns.map((one) => ({ ...one, pov: "persona" })),
          spans: [toolCall({ toolName: "book_appointment", pov: "persona", toolProvenance: "mocked" })],
        },
      }),
    });
    render(<SimulationEvidencePage />);

    expect(await screen.findByText("Retell transcript unavailable")).toBeTruthy();
    expect(screen.queryByText("Move Thursday's clean.")).toBeNull();
    expect(screen.queryByText("You are all set for Tuesday.")).toBeNull();
    expect(screen.queryByLabelText("Tool call, book_appointment")).toBeNull();
  });

  it("refreshes a failed LiveKit simulation while its platform transcript is still pending", async () => {
    const read = evidence({
      status: "failed",
      gradingState: "not_requested",
      agentPovIncomplete: false,
      transcript: null,
      connectionSnapshot: { ...evidence().connectionSnapshot, connectionType: "livekit_room" },
    });
    page({ read });
    render(<SimulationEvidencePage />);
    expect(await screen.findByText("Waiting for LiveKit transcript")).toBeTruthy();

    page({ read: { ...read, agentPovIncomplete: true } });
    expect(await screen.findByText("LiveKit transcript unavailable", {}, { timeout: 4000 })).toBeTruthy();
  });

  it("keeps reading a partial LiveKit transcript until its final record arrives", async () => {
    const read = evidence({
      agentPovComplete: false,
      connectionSnapshot: {
        ...evidence().connectionSnapshot,
        connectionType: "livekit_room",
      },
      transcript: bothPovs([]),
    });
    page({ read });
    render(<SimulationEvidencePage />);

    expect(await screen.findByText("Tuesday is fully booked.")).toBeTruthy();
    expect(screen.getByText(/Waiting for LiveKit transcript/u)).toBeTruthy();
    page({
      read: {
        ...read,
        agentPovComplete: true,
        transcript: bothPovs([toolCall({ toolName: "get_availability" })]),
      },
    });

    expect(await screen.findByLabelText("Tool call, get_availability", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText(/Waiting for LiveKit transcript/u)).toBeNull();
    expect(screen.queryByText("You are all set for Tuesday.")).toBeNull();
  });

  it.each(["retell_web_call", "livekit_room"])("shows only platform evidence on the %s simulation page", async (connectionType) => {
    page({
      read: evidence({
        agentPovComplete: true,
        agentPovIncomplete: false,
        connectionSnapshot: { ...evidence().connectionSnapshot, connectionType },
        transcript: bothPovs([
          toolCall({ toolName: "get_availability" }),
          toolCall({ spanId: "mock_booking", toolName: "book_appointment", pov: "persona" }),
        ]),
      }),
    });
    render(<SimulationEvidencePage />);

    expect(await screen.findByText("Tuesday is fully booked.")).toBeTruthy();
    expect(screen.getByLabelText("Tool call, get_availability")).toBeTruthy();
    expect(screen.queryByText("You are all set for Tuesday.")).toBeNull();
    expect(screen.queryByLabelText("Tool call, book_appointment")).toBeNull();
  });

  it.each(["retell_web_call", "livekit_room"])("keeps zero platform tools empty on the %s simulation page", async (connectionType) => {
    page({
      read: evidence({
        agentPovComplete: true,
        agentPovIncomplete: false,
        connectionSnapshot: { ...evidence().connectionSnapshot, connectionType },
        transcript: bothPovs([
          toolCall({ toolName: "book_appointment", pov: "persona" }),
        ]),
      }),
    });
    render(<SimulationEvidencePage />);

    expect(await screen.findByText("Tuesday is fully booked.")).toBeTruthy();
    expect(screen.queryByLabelText(/^Tool call, /u)).toBeNull();
  });

  it("marks a failed simulation's partial Retell transcript without filling its missing tools", async () => {
    page({
      read: evidence({
        status: "failed",
        agentPovIncomplete: true,
        connectionSnapshot: { ...evidence().connectionSnapshot, connectionType: "retell_web_call" },
        transcript: bothPovs([toolCall({ toolName: "book_appointment", pov: "persona" })]),
      }),
    });
    render(<SimulationEvidencePage />);

    expect(await screen.findByText(/Retell transcript incomplete/u)).toBeTruthy();
    expect(screen.getByText("Tuesday is fully booked.")).toBeTruthy();
    expect(screen.queryByLabelText("Tool call, book_appointment")).toBeNull();
  });

  it.each(["retell_text_mode", "retell_chat_api", "phone_number"])("keeps the directly collected transcript on %s", async (connectionType) => {
    const read = evidence();
    page({
      read: evidence({
        connectionSnapshot: { ...read.connectionSnapshot, connectionType },
        transcript: {
          ...read.transcript,
          turns: read.transcript.turns.map((one) => ({ ...one, pov: "persona" })),
          spans: [toolCall({ pov: "persona" })],
        },
      }),
    });
    render(<SimulationEvidencePage />);

    expect(await screen.findByText("You are all set for Tuesday.")).toBeTruthy();
    expect(screen.getByLabelText("Tool call, check_availability")).toBeTruthy();
    expect(screen.queryByText(/transcript unavailable|Waiting for .* transcript/u)).toBeNull();
  });

  it("lists the agent's turns and tool calls, and none of the persona's", () => {
    const withBoth = bothPovs([
      toolCall({ spanId: "lk_tool_1", toolName: "list_providers" }),
      // egma's own row for the same conversation, from the lane where a
      // platform serves egma's answers. It is not shown beside the agent's.
      {
        ...toolCall({
          spanId: "egma_tool",
          toolName: "check_availability",
          pov: "persona",
        }),
      },
    ]);

    // The tool calls a reader is shown are the shared walk's, which is what
    // the run view hands this component.
    const shown = transcriptToolCalls(withBoth as never);
    render(
      <ChatTranscript transcript={withBoth as never} toolCalls={shown} />,
    );

    // The agent's words, and not the persona simulator's copy of the same
    // conversation.
    expect(screen.getByText("Anything Tuesday?")).toBeTruthy();
    expect(screen.getByText("Tuesday is fully booked.")).toBeTruthy();
    expect(screen.queryByText("Move Thursday's clean.")).toBeNull();
    expect(screen.queryByText("You are all set for Tuesday.")).toBeNull();

    // And the agent's tool call, once. egma's own row for the same call is
    // not drawn beside it.
    expect(screen.getAllByLabelText(/^Tool call, /u)).toHaveLength(1);
    expect(screen.getByLabelText("Tool call, list_providers")).toBeTruthy();
  });

  it("never fills an agent transcript's empty tool list with simulator tools", () => {
    const withBoth = bothPovs([]);
    render(
      <ChatTranscript
        transcript={withBoth as never}
        requiredPov="agent"
        toolCalls={[toolCall({ pov: "persona", toolName: "book_appointment" }) as never]}
      />,
    );

    expect(screen.getByText("Tuesday is fully booked.")).toBeTruthy();
    expect(screen.queryByLabelText("Tool call, book_appointment")).toBeNull();
    expect(screen.queryByText("You are all set for Tuesday.")).toBeNull();
  });

  it("keeps egma's own tool rows when the agent reported none", () => {
    const read = evidence();
    const transcript = read.transcript as NonNullable<
      ReturnType<typeof evidence>["transcript"]
    >;
    const onlyEgma = {
      ...transcript,
      turns: transcript.turns.map((one) => ({ ...one, pov: "persona" })),
      spans: [
        toolCall({
          spanId: "egma_only",
          toolName: "get_availability",
          pov: "persona",
        }),
      ],
    };

    expect(
      transcriptToolCalls(onlyEgma as never).map((one) => one.toolName),
    ).toEqual(["get_availability"]);
  });

  it("shows every call's arguments and result, and marks the mocked one by name", () => {
    const withBoth = bothPovs([]);
    const tools = [
      toolCall({ spanId: "lk_1", toolName: "list_providers", toolArguments: "" }),
      toolCall({ spanId: "lk_2", toolProvenance: "mocked" }),
      toolCall({
        spanId: "lk_3",
        toolName: "book_appointment",
        toolArguments: '{"provider":"Doctor Alvarez"}',
        toolResult: "Booked.",
      }),
    ];

    render(
      <ChatTranscript transcript={withBoth as never} toolCalls={tools as never} />,
    );

    // One mark, on the one tool the pinned test version answers for. The mock
    // tool's own name is the tool's name, already on the row.
    expect(
      screen.getByLabelText("Tool call, check_availability").textContent,
    ).toContain("mocked ·");
    expect(
      screen.getByLabelText("Tool call, list_providers").textContent,
    ).not.toContain("mocked");
    expect(
      screen.getByLabelText("Tool call, book_appointment").textContent,
    ).not.toContain("mocked");

    // The arguments the model emitted and the result it received, on the call
    // that carries them. `list_providers` takes none, and an absent fact stays
    // absent rather than becoming an empty object nobody wrote.
    fireEvent.click(
      screen.getByLabelText("Tool call, book_appointment").querySelector("summary")!,
    );
    const booking = screen.getByLabelText("Tool call, book_appointment");
    expect(booking.textContent).toContain('{"provider":"Doctor Alvarez"}');
    expect(booking.textContent).toContain("Booked.");
    fireEvent.click(
      screen.getByLabelText("Tool call, list_providers").querySelector("summary")!,
    );
    expect(
      screen.getByLabelText("Tool call, list_providers").textContent,
    ).toContain("No request was recorded.");
  });

  /**
   * A call egma refused never reached a backend: the SDK raised, the model saw
   * that tool fail, and the agent's own span for the call carries the error.
   * The transcript shows it as a failed call, which is where a reader finds a
   * protocol mistake instead of a silent real run.
   */
  it("shows a call egma refused as the error on the agent's own tool span", () => {
    const withBoth = bothPovs([]);
    const refused = toolCall({
      spanId: "lk_refused",
      toolName: "charge_card",
      status: "error",
      toolArguments: '{"amount_cents":4200}',
      toolResult: "this simulation has no mock tool for 'charge_card'",
    });

    render(
      <ChatTranscript
        transcript={withBoth as never}
        toolCalls={[refused as never]}
      />,
    );

    const row = screen.getByLabelText("Tool call, charge_card");
    expect(row.querySelector('[data-state-mark="error"]')).not.toBeNull();
    expect(row.textContent).toContain("Failed");
    // Unmarked: nothing answered it, so no mock tool is named.
    expect(row.textContent).not.toContain("mocked");
  });

  /**
   * The persona's POV is what recorded the audio, so its turns are the ones
   * measured on the recording's own clock — the bands drawn over the waveform
   * stay hers even while the transcript beside them is the agent's.
   */
  it("draws the waveform's speaker bands from the persona's POV", () => {
    const withBoth = bothPovs([]);
    const timeline = recordingSpeakerTimeline(withBoth as never);
    expect(timeline.turns.map((one) => one.startedAt)).toEqual([
      "2026-08-15T10:00:01.000000Z",
      "2026-08-15T10:00:04.000000Z",
    ]);
    expect(timeline.endedAt).toBe("2026-08-15T10:00:40.000000Z");
  });
});

describe("recording evidence", () => {
  it("applies an early transcript seek after media metadata arrives", () => {
    const { result } = renderHook(() =>
      useSimulationEvidenceRecording(
        evidence({ hasRecording: false }) as never,
        "prj_1",
      ),
    );
    const audio = { currentTime: 0, duration: Number.NaN } as HTMLAudioElement;
    (result.current.audioRef as { current: HTMLAudioElement | null }).current = audio;

    act(() => result.current.seek(29));
    expect(audio.currentTime).toBe(0);

    Object.defineProperty(audio, "duration", {
      configurable: true,
      value: 78,
    });
    act(() => result.current.onLoadedMetadata());

    expect(audio.currentTime).toBe(29);
    expect(result.current.currentTime).toBe(29);
  });

  it("uses one 44px play control and keeps stereo seeking keyboard accessible", () => {
    const audioRef: { current: HTMLAudioElement | null } = { current: null };
    const seek = vi.fn();
    const recording: SimulationEvidenceRecording = {
      status: "ready",
      message: null,
      url: "https://recordings.example/sim_1.wav",
      audioRef,
      currentTime: 5,
      duration: 60,
      playing: false,
      waveform: {
        kind: "stereo",
        human: [0.2, 0.6, 0.3],
        agent: [0.1, 0.4, 0.2],
      },
      waveformLoading: false,
      seek,
      onTimeUpdate: vi.fn(),
      onLoadedMetadata: vi.fn(),
      onError: vi.fn(),
      onPlay: vi.fn(),
      onPause: vi.fn(),
    };
    const rendered = render(
      <RecordingEvidence recording={recording} active={false} />,
    );

    const audio = screen.getByLabelText("Simulation recording") as HTMLAudioElement;
    const play = vi.fn(async () => undefined);
    Object.defineProperty(audio, "play", { configurable: true, value: play });
    const playButton = screen.getByRole("button", { name: "Play recording" });
    expect(playButton.className).toContain("min-h-(--control-lg)");
    expect(audio.hasAttribute("controls")).toBe(false);
    expect(screen.getByText("User")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    const speakers = screen.getByLabelText("Waveform speakers");
    const seekControl = screen.getByRole("slider", { name: "Seek the recording" });
    expect(seekControl.parentElement?.querySelectorAll("svg path")).toHaveLength(2);
    const waveform = seekControl.parentElement;
    expect(waveform).not.toBeNull();
    expect(
      waveform !== null &&
        (waveform.compareDocumentPosition(speakers) &
          Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBeTruthy();

    fireEvent.click(playButton);
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.change(seekControl, {
      target: { value: "12" },
    });
    expect(seek).toHaveBeenCalledWith(12);

    rendered.rerender(
      <RecordingEvidence
        recording={recording}
        active={false}
        labels={{
          title: "Call recording",
          human: "Caller",
          agent: "Voice agent",
        }}
      />,
    );
    expect(screen.getByLabelText("Call recording")).toBeTruthy();
    expect(screen.getByText("Caller")).toBeTruthy();
    expect(screen.getByText("Voice agent")).toBeTruthy();
  });

  it("keeps the fallback seek control at the 44px coarse-pointer target", () => {
    const recording: SimulationEvidenceRecording = {
      status: "ready",
      message: null,
      url: "https://recordings.example/sim_1.wav",
      audioRef: { current: null },
      currentTime: 5,
      duration: 60,
      playing: false,
      waveform: null,
      waveformLoading: false,
      seek: vi.fn(),
      onTimeUpdate: vi.fn(),
      onLoadedMetadata: vi.fn(),
      onError: vi.fn(),
      onPlay: vi.fn(),
      onPause: vi.fn(),
    };
    render(<RecordingEvidence recording={recording} active={false} />);

    expect(
      screen.getByRole("slider", { name: "Seek the recording" }).className,
    ).toContain("h-(--tap-target)");
    expect(
      screen.queryByText(
        "The recording is playable, but its stereo channel map is unavailable.",
      ),
    ).toBeNull();
  });

  it("draws one mono waveform and colors it from spoken-turn timestamps", () => {
    const recording: SimulationEvidenceRecording = {
      status: "ready",
      message: null,
      url: "https://recordings.example/trace.wav",
      audioRef: { current: null },
      currentTime: 5,
      duration: 10,
      playing: false,
      waveform: { kind: "mono", peaks: [0.2, 0.6, 0.3] },
      waveformLoading: false,
      seek: vi.fn(),
      onTimeUpdate: vi.fn(),
      onLoadedMetadata: vi.fn(),
      onError: vi.fn(),
      onPlay: vi.fn(),
      onPause: vi.fn(),
    };
    render(
      <RecordingEvidence
        recording={recording}
        active={false}
        labels={{ human: "Caller", agent: "Agent" }}
        speakerTimeline={{
          startedAt: "2026-08-15T10:00:00.000Z",
          endedAt: "2026-08-15T10:00:10.000Z",
          turns: [
            turn("human", "turn:human", "Hello", 1),
            turn("agent", "turn:agent", "Hi", 4),
          ],
        }}
      />,
    );

    const seek = screen.getByRole("slider", { name: "Seek the recording" });
    const mono = seek.parentElement?.querySelector(
      '[data-waveform-channels="mono"]',
    );
    expect(mono).not.toBeNull();
    expect(mono?.querySelectorAll('rect[data-speaker="human"]')).toHaveLength(1);
    expect(mono?.querySelectorAll('rect[data-speaker="agent"]')).toHaveLength(1);
    expect(
      mono?.querySelector('rect[data-speaker="human"]')?.getAttribute("x"),
    ).toBe("100");
    expect(
      mono?.querySelector('rect[data-speaker="agent"]')?.getAttribute("x"),
    ).toBe("400");
    const humanRange = mono?.querySelector('rect[data-speaker="human"]');
    const agentRange = mono?.querySelector('rect[data-speaker="agent"]');
    expect(humanRange?.getAttribute("width")).toBe("100");
    expect(agentRange?.getAttribute("width")).toBe("100");
    expect(
      Number(agentRange?.getAttribute("x")) -
        Number(humanRange?.getAttribute("x")) -
        Number(humanRange?.getAttribute("width")),
    ).toBe(200);
    expect(mono?.querySelector("path.fill-faint")).not.toBeNull();
    expect(screen.getByText("Caller")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
  });

  it("uses the next turn only when a mono speaker duration is unavailable", () => {
    const recording: SimulationEvidenceRecording = {
      status: "ready",
      message: null,
      url: "https://recordings.example/trace.wav",
      audioRef: { current: null },
      currentTime: 0,
      duration: 10,
      playing: false,
      waveform: { kind: "mono", peaks: [0.2, 0.6, 0.3] },
      waveformLoading: false,
      seek: vi.fn(),
      onTimeUpdate: vi.fn(),
      onLoadedMetadata: vi.fn(),
      onError: vi.fn(),
      onPlay: vi.fn(),
      onPause: vi.fn(),
    };
    render(
      <RecordingEvidence
        recording={recording}
        active={false}
        speakerTimeline={{
          startedAt: "2026-08-15T10:00:00.000Z",
          endedAt: "2026-08-15T10:00:10.000Z",
          turns: [
            {
              ...turn("human", "turn:human", "Hello", 1),
              durationNs: "unavailable",
            },
            turn("agent", "turn:agent", "Hi", 4),
          ],
        }}
      />,
    );

    const mono = screen
      .getByRole("slider", { name: "Seek the recording" })
      .parentElement?.querySelector('[data-waveform-channels="mono"]');
    expect(
      mono?.querySelector('rect[data-speaker="human"]')?.getAttribute("width"),
    ).toBe("300");
  });

  it("keeps a decoded mono channel as waveform evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );
    vi.stubGlobal(
      "AudioContext",
      class {
        async decodeAudioData(): Promise<AudioBuffer> {
          return {
            duration: 10,
            numberOfChannels: 1,
            getChannelData: () => new Float32Array([0.2, -0.7, 0.4]),
          } as unknown as AudioBuffer;
        }

        async close(): Promise<void> {}
      },
    );

    const { result } = renderHook(() =>
      useDirectEvidenceRecording("https://recordings.example/trace.wav"),
    );

    await waitFor(() => expect(result.current.waveformLoading).toBe(false));
    expect(result.current.waveform?.kind).toBe("mono");
    if (result.current.waveform?.kind !== "mono") {
      throw new Error("The mono recording lost its waveform.");
    }
    expect(result.current.waveform.peaks.slice(0, 3)).toEqual([
      expect.closeTo(0.2),
      expect.closeTo(0.7),
      expect.closeTo(0.4),
    ]);
  });

  it("keeps a direct recording playable when waveform decoding is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Blocked by CORS");
      }),
    );
    const { result } = renderHook(() =>
      useDirectEvidenceRecording("https://recordings.example/trace.wav"),
    );

    expect(result.current.status).toBe("ready");
    expect(result.current.url).toBe(
      "https://recordings.example/trace.wav",
    );
    await waitFor(() => expect(result.current.waveformLoading).toBe(false));
    expect(result.current.waveform).toBeNull();
    expect(result.current.status).toBe("ready");

    act(() => result.current.onError());
    expect(result.current.status).toBe("failed");
    expect(result.current.message).toBe("The recording could not be played.");
  });

  it("uses the supplied copy when a direct recording is absent", () => {
    const { result } = renderHook(() => useDirectEvidenceRecording(null));
    expect(result.current.status).toBe("absent");

    render(
      <RecordingEvidence
        recording={result.current}
        active={false}
        labels={{
          absent: "No audio recording is available for this trace.",
        }}
      />,
    );
    expect(
      screen.getByText("No audio recording is available for this trace."),
    ).toBeTruthy();
  });
});

it("keeps simulation evidence free of billing reads and cost elements", async () => {
  page();
  render(<SimulationEvidencePage />);
  expect(await screen.findByText("You are all set for Tuesday.")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Cost" })).toBeNull();
  expect(sent.some((request) => request.path.includes("/usage") || request.path.includes("/billing"))).toBe(false);
});
