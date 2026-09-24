// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TranscriptPage from "../app/projects/[projectId]/monitoring/transcripts/[transcriptId]/page.tsx";
import type { Me } from "../lib/me.ts";
import { DETAIL, MEASURES } from "../lib/transcript-copy.ts";
import type {
  Detail,
  Facts as TraceFacts,
  Grade,
  Measured,
  Step,
} from "../lib/transcripts.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/**
 * Drive transcript detail states through rendered headings, roles, labels,
 * and text. Source checks alone cannot establish that a state is visible.
 */

const routed = vi.hoisted(() => ({
  pathname: "/projects/prj_2/monitoring/transcripts/trace_1",
  projectId: "prj_2",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: routed.projectId }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: unknown;
  }) => <a href={href} {...rest}>{children as never}</a>,
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const ME: Me = {
  user: { id: "usr_1", email: "ada@acme.example" },
  organizations: [{ id: "org_1", name: "Acme", slug: "acme", role: "admin" }],
  projects: [
    { id: "prj_1", name: "Default", slug: "default" },
    { id: "prj_2", name: "Outbound", slug: "outbound" },
  ],
};

const TRACE_ID = "5c1e4b0f8d2a4e6b9f0c1d2e3a4b5c6d";

const TRACE: TraceFacts = {
  traceId: TRACE_ID,
  startedAt: "2026-08-02T18:04:40.281989Z",
  endedAt: "2026-08-02T18:05:53.776865Z",
  durationNs: "73494876403",
  spanCount: 6,
  turnCounts: { human: 1, agent: 1 },
  toolSpanCount: 1,
  erroredSpanCount: 0,
  source: "production",
  pov: "agent",
  environment: "default",
  // Nothing egma dialled: production telemetry arrives by export, so a
  // monitored exchange names the platform that ran the agent and no egma
  // connection. `transcripts.test.ts` reads the same shape off the API.
  connectionType: "",
  providerCallId: "egma-fixture-capture-1",
  agentPlatform: "livekit",
  platformAgentId: "agent_7f3c",
  platformAgentName: "kelly",
  platformAgentVersion: "2026.08.02",
  runId: "",
  agentId: "",
};

/** One timed step, with only what a case cares about spelled out. */
function step(over: Partial<Step> & { readonly spanId: string }): Step {
  return {
    parentSpanId: "",
    name: "",
    kind: "other",
    status: "ok",
    startedAt: "2026-08-02T18:04:41.000000Z",
    durationNs: "1000000000",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    pov: "agent",
    spans: [],
    ...over,
  };
}

const TOOL = step({
  spanId: "span_tool",
  name: "lookup_appointment",
  kind: "tool",
  toolName: "lookup_appointment",
  toolArguments: '{"id":"apt_9"}',
  toolResult: '{"when":"Tuesday"}',
});

const HUMAN_TURN = step({
  spanId: "span_turn_human",
  kind: "turn:human",
  text: "I need to move my appointment",
  startedAt: "2026-08-02T18:04:41.000000Z",
});

const AGENT_TURN = step({
  spanId: "span_turn_agent",
  kind: "turn:agent",
  text: "Of course — when would suit you?",
  startedAt: "2026-08-02T18:04:44.000000Z",
  spans: [TOOL],
});

const OUTSIDE_STEP = step({
  spanId: "span_outside",
  name: "worker.startup",
  kind: "other",
});

const MEASURE: Measured = {
  measure: "agent_response_latency",
  unit: "ms",
  derived: false,
  pov: "persona",
  samples: [420, 1100],
  spanIds: ["span_turn_agent", "span_turn_agent"],
  mean: 760,
  p50: 420,
  p90: 1100,
  partial: false,
};

const GRADE: Grade = {
  projectGraderId: "grd_1",
  graderDefinitionId: "grl_expected",
  graderDefinitionVersion: 1,
  graderName: "expected_behaviors",
  parameterValues: { llm_provider: "openai", llm_model: "gpt-4o-mini" },
  score: 1,
  details: {
    rationale: "The agent offered Tuesday and the caller agreed.",
    assertions: [{
      key: "behavior_1",
      score: 1,
      rationale: "The agent offered Tuesday and the caller agreed.",
      citedSpanIds: ["span_turn_agent"],
    }],
  },
  passThreshold: 1,
  result: "passed",
  gradedAt: "2026-08-02T18:06:00.000000Z",
};

/** The whole answer, with a case naming only the part it is about. */
function detail(over: Partial<Detail> = {}): Detail {
  return {
    workBlock: null,
    trace: TRACE,
    turns: [HUMAN_TURN, AGENT_TURN],
    spans: [OUTSIDE_STEP],
    spansTruncated: false,
    metrics: [MEASURE],
    simulationId: null,
    gradingState: "complete",
    grades: [GRADE],
    gradeHistory: [GRADE],
    combinedScore: 1,
    ...over,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Whatever egma is standing in for, keyed by the path a page asks for.
 *
 * The read of one transcript is the only answer most cases set. `/api/me` is
 * the shell's, and the recording route is asked for only by an exchange egma
 * conducted — a case that does not mount a player never reaches it.
 */
function apiAnswers(
  answers: Record<string, { status: number; body: unknown }>,
): { readonly asked: string[] } {
  const asked: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput) => {
      const { address: at } = await observeRequest(input);
      asked.push(`${at.pathname}${at.search}`);
      const held = answers[at.pathname];
      if (held === undefined) {
        throw new Error(`nothing stubbed for ${at.pathname}`);
      }
      return json(held.status, held.body);
    }),
  );

  return { asked };
}

const SIMULATION_ID = "sim_01j9z3k5m7n8p9q0r1s2t3u4v5";

/**
 * The read of this transcript, answered however the case needs — and, for the
 * cases that mount a player, the recording route beside it.
 *
 * The recording defaults to *this conversation recorded nothing*, which is the
 * ordinary answer for a transcript and the one the player is allowed to answer
 * with silence.
 */
function stub(
  answer: { status: number; body: unknown },
  recording: { status: number; body: unknown } = {
    status: 404,
    body: { error: "not_found", message: "Nothing was recorded." },
  },
) {
  return apiAnswers({
    "/api/me": { status: 200, body: ME },
    [`/v1/traces/${TRACE_ID}`]: answer,
    [`/v1/simulations/${SIMULATION_ID}/recording`]: recording,
  });
}

/**
 * The window this page was opened on, which is in the address rather than in
 * the page's state — the read refuses a lookup that bounded nothing.
 */
function atWindow(): void {
  globalThis.history.replaceState(
    null,
    "",
    "/?from=2026-08-02T18:04:39.281Z&to=2026-08-02T18:05:54.776Z",
  );
}

/**
 * The page, at the address the list links to.
 *
 * Rendered inside an awaited `act` and behind a `Suspense`, because the page
 * reads its own route parameters through React's `use`: its first paint is a
 * suspension rather than a page, and `render`'s own synchronous act cannot wait
 * for one. `components.test.tsx` renders the terminal's run address the same
 * way and for the same reason.
 */
async function open(): Promise<void> {
  await act(async () => {
    render(
      <Suspense fallback={<p>waiting</p>}>
        <TranscriptPage
          params={Promise.resolve({ projectId: "prj_2", transcriptId: TRACE_ID })}
        />
      </Suspense>,
    );
  });
}

/** The settled page, waited for by its own heading rather than by a tick. */
async function settled(): Promise<HTMLElement> {
  return screen.findByRole("heading", { level: 1, name: DETAIL.title });
}

/**
 * The view on top, which is the one panel of the three that is not `hidden`.
 *
 * All three are in the DOM at once — that is what keeps a turn's open state
 * across a switch — and only one is in the accessibility tree, so asking for
 * the panel by role is asking for the view a person is looking at.
 */
function shownPanel(): HTMLElement {
  return screen.getByRole("tabpanel");
}

/** What each turn on the exchange reads as, in the order they were said. */
function turnsIn(panel: HTMLElement): string[] {
  return [...panel.querySelectorAll('[data-turn="true"]')].map(
    (turn) => turn.textContent ?? "",
  );
}

beforeEach(() => {
  routed.projectId = "prj_2";
  routed.pathname = `/projects/prj_2/monitoring/transcripts/${TRACE_ID}`;
  atWindow();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** What is above the exchange: the header, the facts, and the state chip. */
describe("the transcript that was read", () => {
  it("says the reading is only the beginning when the store cut it short", async () => {
    stub({ status: 200, body: detail({ spansTruncated: true }) });
    await open();
    await settled();

    expect(screen.getByText(DETAIL.truncated)).toBeTruthy();
  });
});

/**
 * The metrics display, which is the one part of this page a reader is most
 * likely to act on — and the part with the most ways to be quietly wrong.
 */
describe("what the exchange measured", () => {
  it("shows the reduction the platform handed over, with its unit", async () => {
    stub({ status: 200, body: detail() });
    await open();
    await settled();

    const measures = screen.getByLabelText(MEASURES.label);
    expect(within(measures).getByText("Agent response latency")).toBeTruthy();
    expect(
      within(measures).getByText(
        `1100 ms · ${MEASURES.p90} of ${MEASURES.counted(2)}`,
      ),
    ).toBeTruthy();
  });

  it("qualifies the figure when the reading is part of the exchange", async () => {
    stub({
      status: 200,
      body: detail({ metrics: [{ ...MEASURE, partial: true }] }),
    });
    await open();
    await settled();

    expect(
      within(screen.getByLabelText(MEASURES.label)).getByText(
        `1100 ms · ${MEASURES.partialP90}`,
      ),
    ).toBeTruthy();
  });
});

describe("what egma made of the exchange", () => {
  it("shows an errored grader without turning it into a zero score", async () => {
    const errored: Grade = {
      ...GRADE,
      score: null,
      result: "errored",
      details: { error: "The model did not return a valid score." },
    };
    stub({
      status: 200,
      body: detail({
        gradingState: "error",
        grades: [errored],
        gradeHistory: [errored],
        combinedScore: null,
      }),
    });
    await open();
    await settled();

    const grades = screen.getByLabelText("Grades");
    expect(within(grades).getByText("errored")).toBeTruthy();
    expect(grades.textContent).toContain("The model did not return a valid score.");
  });

  it("offers credits and provider keys for blocked production grading", async () => {
    stub({ status: 200, body: detail({
      gradingState: "pending", grades: [], gradeHistory: [], combinedScore: null,
      workBlock: { error: "providers_unfunded", message: "The inference balance is $0.00." },
    }) });
    await open();
    await settled();
    const message = screen.getByText("Grading is waiting. The inference balance is $0.00.");
    const block = within(message.closest('[role="alert"]') as HTMLElement);
    expect(block.getByRole("link", { name: "Add credits" }).getAttribute("href"))
      .toBe("/projects/prj_2/settings/billing");
    expect(block.getByRole("link", { name: "Manage provider API keys" }).getAttribute("href"))
      .toBe("/projects/prj_2/settings/provider-api-keys");
  });
});

/** The three views, which are one tablist over one set of steps. */
describe("the three views of what happened", () => {
  it("says no turns were recorded, and still shows what did arrive", async () => {
    stub({ status: 200, body: detail({ turns: [], grades: [], gradeHistory: [] }) });
    await open();
    await settled();

    const exchange = shownPanel();
    expect(within(exchange).getByText(DETAIL.noTurns)).toBeTruthy();
    expect(turnsIn(exchange)).toHaveLength(0);
    // The steps that happened outside a turn are still reachable.
    expect(within(exchange).getByText(DETAIL.otherSteps)).toBeTruthy();
    expect(within(exchange).getByText(DETAIL.otherStepsLead)).toBeTruthy();
  });

  /**
   * Switching views is what the tabs are for, and each of the other two is a
   * different reading of the same steps: the timeline is where time went, the
   * execution view is the hierarchy the framework reported.
   */
  it("moves to the timeline, one row per recorded step", async () => {
    stub({ status: 200, body: detail() });
    await open();
    await settled();

    fireEvent.click(screen.getByRole("tab", { name: DETAIL.views.timeline }));

    const timeline = shownPanel();
    expect(
      within(timeline).getByRole("heading", { name: DETAIL.views.timeline }),
    ).toBeTruthy();
    expect(within(timeline).getByText(DETAIL.timelineLead)).toBeTruthy();
    // Two turns and the tool inside one of them, plus the step outside them.
    expect(within(timeline).getAllByRole("button")).toHaveLength(4);
    expect(
      within(timeline).getByRole("button", { name: /lookup_appointment/u }),
    ).toBeTruthy();
  });
});

/**
 * The audio egma recorded, which is mounted only for an exchange egma
 * conducted — and which shows nothing at all when that conversation recorded
 * nothing, because a disabled control would promise audio that does not exist.
 */
describe("what Egma heard", () => {
  /**
   * Silence is bought for a conversation with no audio and for nothing else. A
   * refusal that is about egma rather than about the conversation is said out
   * loud, because a broken deployment that looks like a working product is the
   * failure the recordings work exists to end.
   */
  it("says so out loud when the refusal is about egma", async () => {
    stub(
      { status: 200, body: detail({ simulationId: SIMULATION_ID }) },
      {
        status: 503,
        body: {
          error: "store_unavailable",
          message: "Egma could not reach the store the audio lives in.",
        },
      },
    );
    await open();
    await settled();

    expect(
      await screen.findByText(
        "Egma could not reach the store the audio lives in.",
      ),
    ).toBeTruthy();
  });
});
