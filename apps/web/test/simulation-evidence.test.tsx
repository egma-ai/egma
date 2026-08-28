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
  it("shows a generic execution failure without exposing its raw reason", async () => {
    page({
      read: evidence({
        status: "failed",
        gradingState: "not_requested",
        grades: [],
        gradeHistory: [],
        combinedScore: null,
        reason: "simulator_error",
        gradingPlan: null,
        transcript: null,
      }),
    });
    render(<SimulationEvidencePage />);

    expect(
      await screen.findByText("Egma could not conduct this simulation."),
    ).toBeTruthy();
    expect(screen.getByText(/execution problem, not a failed grade/iu)).toBeTruthy();
    expect(screen.queryByText("simulator_error")).toBeNull();
  });

  it("shows the total average score without creating an overall pass or fail", async () => {
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
    expect(within(summary).getByText("Total avg score")).toBeTruthy();
    expect(within(summary).getByText("0.50")).toBeTruthy();
    expect(within(summary).getByText("Duration")).toBeTruthy();
    expect(within(summary).getByText("40s")).toBeTruthy();
    expect(within(summary).getByText("Total turns")).toBeTruthy();
    expect(within(summary).queryByText(/overall|verdict/iu)).toBeNull();
  });

  it("shows a dash for every summary value that was not recorded", async () => {
    page({
      read: evidence({
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
    expect(within(summary).getByText("0.00")).toBeTruthy();
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
    const summary = screen.getByRole("region", { name: "Simulation summary" });
    expect(within(summary).getByText("-")).toBeTruthy();
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
    expect(within(summary).getByText("-")).toBeTruthy();
    expect(within(summary).queryByText("Not available")).toBeNull();
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

    expect(screen.getByText("-")).toBeTruthy();
    expect(screen.getByText("No conversation recorded")).toBeTruthy();
    expect(screen.queryByText("Nothing was said")).toBeNull();
    expect(
      screen.queryByText("Egma filed no spoken turns for this simulation."),
    ).toBeNull();
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
