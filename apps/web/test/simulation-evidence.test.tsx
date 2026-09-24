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
    recordingWaveform: null,
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
        {
          ...turn("span_human", "turn:human", "Move Thursday's clean.", 1),
          pov: "persona",
        },
        {
          ...turn("span_agent", "turn:agent", "You are all set for Tuesday.", 4),
          pov: "persona",
        },
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
    expect(within(summary).getByText("0/1")).toBeTruthy();
    /*
     * The bar's values read in the product's own sans face. Tabular figures
     * still hold the columns still; mono stays where it names a thing.
     */
    for (const value of ["0/1", "40s"]) {
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
    expect(within(summary).getByText("0/1")).toBeTruthy();
    expect(within(summary).getByText("0s")).toBeTruthy();
    expect(within(summary).getByText("0")).toBeTruthy();
    expect(within(summary).getByText("0 ms")).toBeTruthy();
    expect(within(summary).queryByText("-")).toBeNull();
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
});

describe("the transcript time rail", () => {
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

  it("keeps a tool nested under an unspoken native agent record visible", () => {
    const read = evidence();
    const tool = {
      spanId: "span_tool_only_reply",
      parentSpanId: "span_native_tool_only_reply",
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
      pov: "persona" as const,
      spans: [],
    };
    const nativeRecord = {
      spanId: "span_native_tool_only_reply",
      parentSpanId: "root",
      name: "agent_turn",
      kind: "other" as const,
      status: "ok" as const,
      startedAt: "2026-08-15T10:00:05.000000Z",
      durationNs: "1000000000",
      text: "",
      audioUrl: "",
      toolName: "",
      toolArguments: "",
      toolResult: "",
      spans: [tool],
    };
    const transcript = {
      ...read.transcript!,
      spans: [nativeRecord],
    };
    const shownTools = simulationToolCalls({
      ...read,
      transcript,
    } as never);

    render(
      <ChatTranscript
        transcript={transcript as never}
        toolCalls={shownTools}
      />,
    );

    expect(shownTools.map((one) => one.spanId)).toEqual([
      "span_tool_only_reply",
    ]);
    expect(
      screen.getByLabelText("Tool call, check_availability"),
    ).toBeTruthy();
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
      pov: "persona" as const,
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

  it("shows only the persona's account under the phone source label", async () => {
    page({
      read: evidence({
        connectionSnapshot: {
          ...evidence().connectionSnapshot,
          connectionType: "phone_number",
        },
        transcript: bothPovs([
          toolCall({ toolName: "customer_internal_tool" }),
          toolCall({
            spanId: "persona_phone_tool",
            toolName: "persona_observed_tool",
            pov: "persona",
          }),
        ]),
      }),
    });
    render(<SimulationEvidencePage />);

    expect(
      await screen.findByText("Conversation recorded by the persona"),
    ).toBeTruthy();
    expect(screen.getByText("Move Thursday's clean.")).toBeTruthy();
    expect(screen.getByText("You are all set for Tuesday.")).toBeTruthy();
    expect(screen.queryByText("Anything Tuesday?")).toBeNull();
    expect(screen.queryByText("Tuesday is fully booked.")).toBeNull();
    expect(screen.getByLabelText("Tool call, persona_observed_tool")).toBeTruthy();
    expect(screen.queryByLabelText("Tool call, customer_internal_tool")).toBeNull();
  });

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

  it.each(["livekit_room"])("keeps zero platform tools empty on the %s simulation page", async (connectionType) => {
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

  it.each(["retell_text_mode", "retell_chat_api"])("keeps the directly collected transcript on %s", async (connectionType) => {
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

  it("keeps the player and its seek bar for a recording measured before waveforms existed", async () => {
    apiAnswers({
      "/v1/simulations/sim_1/recording": {
        status: 200,
        body: {
          simulationId: "sim_1",
          url: "https://recordings.example/sim_1.wav",
          expiresAt: "2026-08-15T11:00:00.000Z",
        },
      },
    });

    const { result } = renderHook(() =>
      useSimulationEvidenceRecording(
        evidence({ hasRecording: true, recordingWaveform: null }) as never,
        "prj_1",
      ),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.waveform).toBeNull();
    expect(result.current.waveformLoading).toBe(false);
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
});
