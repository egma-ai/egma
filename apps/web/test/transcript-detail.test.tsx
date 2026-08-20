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
import { GRADING } from "../lib/grading-copy.ts";
import { DETAIL, FACTS, LIST, MEASURES, RECORDING } from "../lib/transcript-copy.ts";
import { SPEAKERS } from "../ui/evidence.tsx";
import type {
  Detail,
  Facts as TraceFacts,
  Judgment,
  Measured,
  Step,
} from "../lib/transcripts.ts";

/**
 * **One transcript**, rendered rather than read as source.
 *
 * This page had no rendered proof at all. Everything asserted about it lived in
 * `pages.test.ts` and `transcripts.test.ts` as source-text matches — the page
 * *contains* `outcome={detail.outcome}` — which is a real claim about wiring and
 * says nothing whatever about what a person ends up looking at. A page can hold
 * every one of those strings and draw an empty screen.
 *
 * That mattered the day its layout moved off the last CSS Module in the
 * application. A migration of 54 class names has one failure mode, and it is
 * silent: a state that used to draw now draws nothing, or draws twice, and no
 * source match notices. So the states are asserted here first, through the DOM,
 * and the migration is held against them.
 *
 * **What is asserted is what a reader can see and reach**, never a class list.
 * Class names are the thing being changed; a test that read them would fail on
 * every correct migration and pass on none of the wrong ones. So each case asks
 * for a heading, a role, a label, or a sentence — the page's own words, from
 * `transcript-copy.ts`, which is where they are checkable.
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
  trace_id: TRACE_ID,
  started_at: "2026-08-02T18:04:40.281989Z",
  ended_at: "2026-08-02T18:05:53.776865Z",
  duration_ns: "73494876403",
  span_count: 6,
  turn_counts: { human: 1, agent: 1 },
  tool_span_count: 1,
  errored_span_count: 0,
  source: "production",
  emitter: "agent",
  environment: "default",
  connection_type: "livekit",
  provider_call_id: "egma-fixture-capture-1",
  run_id: "",
  agent_id: "",
};

/** One timed step, with only what a case cares about spelled out. */
function step(over: Partial<Step> & { readonly span_id: string }): Step {
  return {
    parent_span_id: "",
    name: "",
    kind: "other",
    status: "ok",
    started_at: "2026-08-02T18:04:41.000000Z",
    duration_ns: "1000000000",
    text: "",
    audio_url: "",
    tool_name: "",
    tool_arguments: "",
    tool_result: "",
    spans: [],
    ...over,
  };
}

const TOOL = step({
  span_id: "span_tool",
  name: "lookup_appointment",
  kind: "tool",
  tool_name: "lookup_appointment",
  tool_arguments: '{"id":"apt_9"}',
  tool_result: '{"when":"Tuesday"}',
});

const HUMAN_TURN = step({
  span_id: "span_turn_human",
  kind: "turn:human",
  text: "I need to move my appointment",
  started_at: "2026-08-02T18:04:41.000000Z",
});

const AGENT_TURN = step({
  span_id: "span_turn_agent",
  kind: "turn:agent",
  text: "Of course — when would suit you?",
  started_at: "2026-08-02T18:04:44.000000Z",
  spans: [TOOL],
});

const OUTSIDE_STEP = step({
  span_id: "span_outside",
  name: "worker.startup",
  kind: "other",
});

const MEASURE: Measured = {
  measure: "agent_response_latency",
  unit: "ms",
  samples: [420, 1100],
  span_ids: ["span_turn_agent", "span_turn_agent"],
  worst: { value: 1100, span_id: "span_turn_agent" },
};

const JUDGMENT: Judgment = {
  grader_id: "grd_1",
  assertion: "behavior_1",
  assertion_text: "The agent offers a new time",
  required: true,
  verdict: "passed",
  score: 1,
  rationale: "The agent offered Tuesday and the caller agreed.",
  cited_turns: ["turn:2"],
  judged_at: "2026-08-02T18:06:00.000000Z",
};

/** The whole answer, with a case naming only the part it is about. */
function detail(over: Partial<Detail> = {}): Detail {
  return {
    trace: TRACE,
    turns: [HUMAN_TURN, AGENT_TURN],
    spans: [OUTSIDE_STEP],
    spans_truncated: false,
    measures: [MEASURE],
    outcome: {
      verdict: "passed",
      score: 1,
      counts: { passed: 2, failed: 0, skipped: 0, errored: 0, total: 2 },
    },
    verdicts: [JUDGMENT],
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
    vi.fn(async (input: string) => {
      const at = new URL(String(input), "http://egma.test");
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
    [`/api/simulations/${SIMULATION_ID}/recording`]: recording,
  });
}

/**
 * The window this page was opened on, which is in the address rather than in
 * the page's state — the read refuses a lookup that bounded nothing, so a page
 * opened without one is its own state and has its own case below.
 */
function atWindow(): void {
  globalThis.history.replaceState(
    null,
    "",
    "/?from=2026-08-02T18:04:39.281Z&to=2026-08-02T18:05:54.776Z",
  );
}

function atNoWindow(): void {
  globalThis.history.replaceState(null, "", "/");
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

/**
 * The facts strip at the top of the inspector, which is its first description
 * list. The technical-details disclosure below it is a second one, and both
 * name a status — so a case about the strip has to say which list it means.
 */
function inspectorFactsIn(inspector: HTMLElement): HTMLElement {
  const facts = inspector.querySelector("dl");
  if (facts === null) throw new Error("the inspector drew no facts");
  return facts as HTMLElement;
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

/**
 * **The five ways this page can fail to be a transcript**, each of which is a
 * different sentence to a person and none of which is an empty screen.
 *
 * `DESIGN.md`: "Make every state truthful. Loading, empty, failed, disabled,
 * saving, saved, skipped, and errored states must say what happened."
 */
describe("the states before there is a transcript", () => {
  it("says it is loading before the read answers", async () => {
    // A read that never answers, which is what the wait actually looks like.
    // Stubbing a resolved answer would settle inside the render's own `act`
    // and this case would assert the loading state of a page that had already
    // finished loading.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        String(input) === "/api/me"
          ? json(200, ME)
          : new Promise<Response>(() => undefined),
      ),
    );
    await open();

    expect(
      await screen.findByText(DETAIL.loading, { exact: false }),
    ).toBeTruthy();
  });

  /**
   * A window is two instants in the address, and a page reached without one
   * cannot ask for anything: the read refuses a lookup that bounded nothing.
   * So the page says where to open it from rather than showing a failure that
   * would read as egma being broken.
   */
  it("sends somebody back to the list when the address carries no window", async () => {
    atNoWindow();
    stub({ status: 200, body: detail() });
    await open();

    expect(await screen.findByText(DETAIL.needsWindow)).toBeTruthy();
    expect(screen.queryByText(DETAIL.missing)).toBeNull();
  });

  it("says a transcript is not here, and names the window as the other answer", async () => {
    stub({
      status: 404,
      body: { error: "not_found", message: "No such trace." },
    });
    await open();

    expect(await screen.findByText(DETAIL.missing)).toBeTruthy();
    expect(
      screen.getByText(DETAIL.missingLead, { exact: false }),
    ).toBeTruthy();
  });

  /** A refusal keeps egma's own sentence, which is what names the next move. */
  it("shows the refusal egma wrote, rather than a sentence of its own", async () => {
    stub({
      status: 503,
      body: { error: "store_unavailable", message: "Egma could not read that." },
    });
    await open();

    expect(await screen.findByText("Egma could not read that.")).toBeTruthy();
  });

  it("offers the two ways in when nobody is signed in", async () => {
    stub({ status: 401, body: { error: "signed_out", message: "Sign in." } });
    await open();

    expect(await screen.findByText(LIST.signedOut)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: LIST.signIn }).getAttribute("href"),
    ).toBe("/sign-in");
    expect(
      screen.getByRole("link", { name: LIST.setUp }).getAttribute("href"),
    ).toBe("/signup");
  });
});

/** What is above the exchange: the header, the facts, and the state chip. */
describe("the transcript that was read", () => {
  it("heads the page with the transcript and where it came from", async () => {
    stub({ status: 200, body: detail() });
    await open();

    expect((await settled()).textContent).toBe(DETAIL.title);
    expect(
      screen.getByText(`${TRACE.source} / ${TRACE.environment}`),
    ).toBeTruthy();
    // Nothing errored, so the chip says so rather than counting nothing.
    expect(screen.getByText(DETAIL.recorded)).toBeTruthy();
  });

  it("counts the errors in the chip when something went wrong", async () => {
    stub({
      status: 200,
      body: detail({ trace: { ...TRACE, errored_span_count: 2 } }),
    });
    await open();
    await settled();

    expect(screen.getByText(DETAIL.errors(2))).toBeTruthy();
    expect(screen.queryByText(DETAIL.recorded)).toBeNull();
  });

  it("summarizes the exchange in facts a reader can name", async () => {
    stub({ status: 200, body: detail() });
    await open();
    await settled();

    const summary = screen.getByLabelText(DETAIL.summary);
    for (const label of [
      FACTS.duration,
      FACTS.turns,
      FACTS.steps,
      FACTS.tools,
      FACTS.errors,
    ]) {
      expect(within(summary).getByText(label), label).toBeTruthy();
    }
    expect(
      within(summary).getByText(`1 ${LIST.human} · 1 ${LIST.agent}`),
    ).toBeTruthy();
  });

  it("says the reading is only the beginning when the store cut it short", async () => {
    stub({ status: 200, body: detail({ spans_truncated: true }) });
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
        `1100 ms · ${MEASURES.worst} of ${MEASURES.counted(2)}`,
      ),
    ).toBeTruthy();
  });

  it("qualifies the figure when the reading is part of the exchange", async () => {
    stub({
      status: 200,
      body: detail({ measures: [{ ...MEASURE, partial: true }] }),
    });
    await open();
    await settled();

    expect(
      within(screen.getByLabelText(MEASURES.label)).getByText(
        `1100 ms · ${MEASURES.partialWorst}`,
      ),
    ).toBeTruthy();
  });

  /**
   * A figure Egma worked out from the framework's own timings is marked on the
   * figure *and* caveated once for the panel. A figure a platform reported is
   * neither, because that wording would be a claim about an observation Egma
   * never made.
   */
  it("marks a worked-out figure, and says so once for the panel", async () => {
    stub({
      status: 200,
      body: detail({ measures: [{ ...MEASURE, derived: true }] }),
    });
    await open();
    await settled();

    const measures = screen.getByLabelText(MEASURES.label);
    expect(
      within(measures).getByText(MEASURES.derivedOne, { exact: false }),
    ).toBeTruthy();
    expect(within(measures).getByText(MEASURES.derived)).toBeTruthy();
  });

  it("renders a platform-reported figure bare", async () => {
    stub({
      status: 200,
      body: detail({
        measures: [{ ...MEASURE, derived: true, reported_by: "retell" }],
      }),
    });
    await open();
    await settled();

    const measures = screen.getByLabelText(MEASURES.label);
    expect(within(measures).queryByText(MEASURES.derived)).toBeNull();
    expect(measures.textContent).not.toContain(MEASURES.derivedOne);
    expect(measures.textContent).not.toContain("retell");
  });

  it("says nothing was measured rather than drawing a blank strip", async () => {
    stub({ status: 200, body: detail({ measures: [] }) });
    await open();
    await settled();

    expect(
      within(screen.getByLabelText(MEASURES.label)).getByText(MEASURES.none),
    ).toBeTruthy();
  });
});

/**
 * The verdict, and the lane beside it that reports and never decides.
 *
 * The arrangement is the point: folding a diagnostic into the outcome would
 * move a verdict it is not allowed to move, and leaving it out would strand the
 * failed cards further down the page.
 */
describe("what egma made of the exchange", () => {
  it("shows the verdict, the score and what was counted", async () => {
    stub({ status: 200, body: detail() });
    await open();
    await settled();

    const outcome = screen.getByLabelText("Grading outcome");
    expect(within(outcome).getByText("Verdict")).toBeTruthy();
    expect(within(outcome).getByText("passed")).toBeTruthy();
    expect(within(outcome).getByText("2/2 passed")).toBeTruthy();
  });

  it("shows the diagnostic lane beside the verdict when one judged", async () => {
    stub({
      status: 200,
      body: detail({
        diagnostics: {
          verdict: "failed",
          score: 0.5,
          counts: { passed: 1, failed: 1, skipped: 0, errored: 0, total: 2 },
        },
      }),
    });
    await open();
    await settled();

    const outcome = screen.getByLabelText("Grading outcome");
    const lane = within(outcome).getByText(GRADING.diagnosticLane);
    expect(lane).toBeTruthy();
    expect(outcome.textContent).toContain(GRADING.diagnosticScore);
    expect(outcome.textContent).toContain("1 failed");
  });

  it("draws no outcome at all before anything has judged", async () => {
    stub({ status: 200, body: detail({ outcome: null, verdicts: [] }) });
    await open();
    await settled();

    expect(screen.queryByLabelText("Grading outcome")).toBeNull();
  });

  /**
   * A judgment is drawn against the turn it read, which is what makes the
   * rationale worth anything: the sentence and the words it is about are on
   * one screen.
   */
  it("puts a judgment against the turn it cites", async () => {
    stub({ status: 200, body: detail() });
    await open();
    await settled();

    expect(screen.getByText(JUDGMENT.rationale)).toBeTruthy();
    expect(screen.getByText("The agent offers a new time")).toBeTruthy();
  });

  it("marks a judgment that only reports", async () => {
    stub({
      status: 200,
      body: detail({ verdicts: [{ ...JUDGMENT, required: false }] }),
    });
    await open();
    await settled();

    expect(screen.getByText(GRADING.diagnostic)).toBeTruthy();
  });

  it("marks nothing on an ordinary blocking grader", async () => {
    stub({ status: 200, body: detail() });
    await open();
    await settled();

    expect(screen.queryByText(GRADING.diagnostic)).toBeNull();
  });
});

/** The three views, which are one tablist over one set of steps. */
describe("the three views of what happened", () => {
  it("offers all three as tabs, with the exchange selected", async () => {
    stub({ status: 200, body: detail() });
    await open();
    await settled();

    const tabs = screen.getByRole("tablist", { name: DETAIL.viewLabel });
    for (const label of [
      DETAIL.views.transcript,
      DETAIL.views.timeline,
      DETAIL.views.execution,
    ]) {
      expect(within(tabs).getByRole("tab", { name: label }), label).toBeTruthy();
    }
    expect(
      within(tabs)
        .getByRole("tab", { name: DETAIL.views.transcript })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("draws what was said, with the turns in the order they were said", async () => {
    stub({ status: 200, body: detail() });
    await open();
    await settled();

    const said = turnsIn(shownPanel());
    expect(said).toHaveLength(2);
    expect(said[0]).toContain(SPEAKERS.human);
    expect(said[0]).toContain(HUMAN_TURN.text);
    expect(said[1]).toContain(SPEAKERS.agent);
    expect(said[1]).toContain(AGENT_TURN.text);
    // What happened inside a turn is counted rather than interleaved with what
    // was said, which is the whole reason a turn is a disclosure.
    expect(said[1]).toContain(DETAIL.steps(1));
  });

  it("says a turn held no speech rather than drawing an empty line", async () => {
    stub({
      status: 200,
      body: detail({ turns: [{ ...HUMAN_TURN, text: "" }] }),
    });
    await open();
    await settled();

    expect(within(shownPanel()).getByText(DETAIL.nothingSaid)).toBeTruthy();
  });

  it("marks a turn something failed inside", async () => {
    stub({
      status: 200,
      body: detail({
        turns: [{ ...AGENT_TURN, spans: [{ ...TOOL, status: "error" }] }],
      }),
    });
    await open();
    await settled();

    expect(within(shownPanel()).getByText(DETAIL.failedInside)).toBeTruthy();
  });

  it("says no turns were recorded, and still shows what did arrive", async () => {
    stub({ status: 200, body: detail({ turns: [], verdicts: [] }) });
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

  it("moves to the execution view, grouped by the turn each step was in", async () => {
    stub({ status: 200, body: detail() });
    await open();
    await settled();

    fireEvent.click(screen.getByRole("tab", { name: DETAIL.views.execution }));

    const execution = shownPanel();
    expect(
      within(execution).getByRole("heading", { name: DETAIL.views.execution }),
    ).toBeTruthy();
    // The agent's turn held the tool; the human's turn held nothing, so it is
    // not a group of nothing. The steps outside every turn are their own group.
    expect(
      within(execution).getByRole("heading", { name: DETAIL.otherSteps }),
    ).toBeTruthy();
    expect(
      within(execution).getByRole("button", { name: /lookup_appointment/u }),
    ).toBeTruthy();
  });

  it("says no timed work was recorded when there is none", async () => {
    stub({
      status: 200,
      body: detail({ turns: [], spans: [], verdicts: [], measures: [] }),
    });
    await open();
    await settled();

    fireEvent.click(screen.getByRole("tab", { name: DETAIL.views.timeline }));
    expect(
      within(shownPanel()).getByText(DETAIL.noStepsAtAll),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: DETAIL.views.execution }));
    expect(
      within(shownPanel()).getByText(DETAIL.noStepsAtAll),
    ).toBeTruthy();
  });

  /**
   * The problem navigator is the way through a long exchange with a fault in
   * it, and it exists only when there is one — a pair of arrows that move
   * between nothing would be furniture.
   */
  it("offers a way between the problems, and only when there are problems", async () => {
    stub({ status: 200, body: detail() });
    await open();
    await settled();
    expect(
      screen.queryByRole("button", { name: DETAIL.nextProblem }),
    ).toBeNull();
    cleanup();

    stub({
      status: 200,
      body: detail({
        turns: [HUMAN_TURN, { ...AGENT_TURN, spans: [{ ...TOOL, status: "error" }] }],
      }),
    });
    await open();
    await settled();

    expect(screen.getByText(DETAIL.problems(1))).toBeTruthy();
    expect(
      screen.getByRole("button", { name: DETAIL.previousProblem }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: DETAIL.nextProblem })).toBeTruthy();
  });
});

/** The panel beside the views, which is where one step is read in full. */
describe("the inspector", () => {
  it("opens on the first turn, and reads out its timing", async () => {
    stub({ status: 200, body: detail() });
    await open();
    await settled();

    const inspector = screen.getByLabelText(DETAIL.inspector);
    expect(
      within(inspector).getByRole("heading", { name: HUMAN_TURN.text }),
    ).toBeTruthy();

    const facts = within(inspectorFactsIn(inspector));
    for (const label of [FACTS.status, FACTS.started, FACTS.duration]) {
      expect(facts.getByText(label), label).toBeTruthy();
    }
    expect(facts.getByText(HUMAN_TURN.status)).toBeTruthy();
  });

  /** A status the provider left unset is said, not shown as an empty cell. */
  it("says a status was not reported rather than leaving it blank", async () => {
    stub({
      status: 200,
      body: detail({ turns: [{ ...HUMAN_TURN, status: "unset" }] }),
    });
    await open();
    await settled();

    expect(
      within(inspectorFactsIn(screen.getByLabelText(DETAIL.inspector))).getByText(
        DETAIL.notReported,
      ),
    ).toBeTruthy();
  });

  it("says to select something when there is nothing to select", async () => {
    stub({
      status: 200,
      body: detail({ turns: [], spans: [], verdicts: [], measures: [] }),
    });
    await open();
    await settled();

    expect(
      within(screen.getByLabelText(DETAIL.inspector)).getByText(
        DETAIL.nothingSelected,
      ),
    ).toBeTruthy();
  });

  it("shows a tool's own work, asked and answered", async () => {
    stub({ status: 200, body: detail({ turns: [], spans: [TOOL] }) });
    await open();
    await settled();

    const inspector = screen.getByLabelText(DETAIL.inspector);
    const work = within(inspector)
      .getByRole("heading", { name: DETAIL.toolWork })
      .closest("section");
    expect(work).toBeTruthy();

    const shown = within(work as HTMLElement);
    expect(shown.getByText(TOOL.tool_name)).toBeTruthy();
    expect(shown.getByText(FACTS.toolArguments)).toBeTruthy();
    expect(shown.getByText(TOOL.tool_arguments)).toBeTruthy();
    expect(shown.getByText(FACTS.toolResult)).toBeTruthy();
    expect(shown.getByText(TOOL.tool_result)).toBeTruthy();
  });

  /** A step that did no tool work draws no tool section at all. */
  it("draws no tool section for a step that called nothing", async () => {
    stub({ status: 200, body: detail({ turns: [HUMAN_TURN], spans: [] }) });
    await open();
    await settled();

    expect(
      within(screen.getByLabelText(DETAIL.inspector)).queryByRole("heading", {
        name: DETAIL.toolWork,
      }),
    ).toBeNull();
  });

  it("always offers where the exchange came from", async () => {
    stub({ status: 200, body: detail() });
    await open();
    await settled();

    const inspector = screen.getByLabelText(DETAIL.inspector);
    expect(within(inspector).getByText(DETAIL.whereItCameFrom)).toBeTruthy();
    expect(within(inspector).getByText(DETAIL.technicalDetails)).toBeTruthy();
  });
});

/**
 * The audio egma recorded, which is mounted only for an exchange egma
 * conducted — and which shows nothing at all when that conversation recorded
 * nothing, because a disabled control would promise audio that does not exist.
 */
describe("what Egma heard", () => {
  it("asks for nothing on an exchange egma did not conduct", async () => {
    const { asked } = stub({ status: 200, body: detail() });
    await open();
    await settled();

    expect(asked.some((one) => one.includes("/recording"))).toBe(false);
    expect(screen.queryByLabelText(RECORDING.label)).toBeNull();
  });

  it("stays silent when the conversation recorded nothing", async () => {
    stub({ status: 200, body: detail({ simulation_id: SIMULATION_ID }) });
    await open();
    await settled();

    expect(screen.queryByLabelText(RECORDING.label)).toBeNull();
    expect(screen.queryByText("Nothing was recorded.")).toBeNull();
  });

  /**
   * Silence is bought for a conversation with no audio and for nothing else. A
   * refusal that is about egma rather than about the conversation is said out
   * loud, because a broken deployment that looks like a working product is the
   * failure the recordings work exists to end.
   */
  it("says so out loud when the refusal is about egma", async () => {
    stub(
      { status: 200, body: detail({ simulation_id: SIMULATION_ID }) },
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

  it("draws a player, and says whose audio it is, when there is one", async () => {
    stub(
      { status: 200, body: detail({ simulation_id: SIMULATION_ID }) },
      {
        status: 200,
        body: { url: "https://store.example/recording.wav?signed" },
      },
    );
    await open();
    await settled();

    const heard = await screen.findByLabelText(RECORDING.label);
    expect(within(heard).getByText(RECORDING.caption)).toBeTruthy();
    expect(
      heard.querySelector("audio")?.getAttribute("src"),
    ).toBe("https://store.example/recording.wav?signed");
  });
});
