// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SimulationEvidencePage from "../app/projects/[projectId]/runs/[runId]/simulations/[simulationId]/page.tsx";
import type { Me } from "../lib/me.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/**
 * One simulation's evidence page, rendered and driven.
 *
 * **Every test here is about the same thing said several ways**: what happened,
 * what egma made of it, and what a person said afterwards are three different
 * facts, and none of them may be drawn as another. Grading that is still running
 * is not a failure. A machine's verdict a person disagreed with is still on the
 * page. A viewer sees everything and is offered nothing to change.
 *
 * Nothing here asserts that a component exists or that a source file contains a
 * string. Each drives the real page the way somebody with a keyboard would and
 * reads what the DOM then says.
 */

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  pathname: "/projects/prj_1/runs/run_1/simulations/sim_1",
  params: {
    projectId: "prj_1",
    runId: "run_1",
    simulationId: "sim_1",
  } as Record<string, string>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({
    push: routed.push,
    replace: routed.replace,
    back: vi.fn(),
  }),
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

type Stubbed = { status: number; body: unknown } | "never";

type Recorded = {
  readonly url: string;
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown> | undefined;
};

/** Every request the page made, in the order it made them. */
let sent: Recorded[] = [];

function apiAnswers(
  answers: Record<string, Stubbed | readonly Stubbed[]>,
): void {
  const asked: Record<string, number> = {};
  sent = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, options?: RequestInit) => {
      const request = await observeRequest(input, options);
      const { address, path } = request;
      sent.push({
        url: `${path}${address.search}`,
        path,
        method: request.method,
        body: request.body as Record<string, unknown> | undefined,
      });

      const held = answers[path];
      if (held === undefined) throw new Error(`nothing stubbed for ${path}`);

      const turn = asked[path] ?? 0;
      asked[path] = turn + 1;
      const answer = Array.isArray(held)
        ? ((held[Math.min(turn, held.length - 1)] ?? "never") as Stubbed)
        : (held as Stubbed);

      if (answer === "never") return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

/**
 * What the page sent to one address **by one method**.
 *
 * The method is not optional and that is the whole point: this page reads the
 * address it writes under. A wait on "anything sent to `/v1/simulations/sim_1`"
 * is satisfied by the page's own load and says nothing whatever about a regrade
 * or a correction — and under load the assertion then runs against the `GET`,
 * whose body is undefined.
 */
function sentWith(path: string, method: string): Recorded[] {
  return sent.filter((one) => one.path === path && one.method === method);
}

const NO_COUNTS = { passed: 0, failed: 0, skipped: 0, errored: 0, total: 0 };

function turn(
  id: string,
  kind: "turn:human" | "turn:agent",
  text: string,
  offsetSeconds: number,
) {
  return {
    spanId: id,
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

/**
 * One judgment, as the read carries it: the assertion by **key**, the words
 * behind that key resolved from the pinned version, and which lane the row is
 * in. `judgedBy` retired with human corrections (ADR-0009) and `priority`
 * with the P0/P1/P2 ladder, so neither is here to be drawn.
 */
function machineVerdict(overrides: Record<string, unknown> = {}) {
  return {
    graderId: "grd_1",
    assertion: "behavior_1",
    assertionText: "confirms the new time back before finishing",
    required: true,
    verdict: "failed",
    score: 0,
    rationale: "The agent never said the new time back.",
    citedTurns: ["span_agent"],
    judgedAt: "2026-08-15T10:05:00.000000Z",
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
    grading: "graded",
    verdict: "failed",
    score: 0,
    counts: { ...NO_COUNTS, failed: 1, total: 1 },
    reason: null,
    modality: "voice",
    createdAt: "2026-08-15T09:59:00.000Z",
    startedAt: "2026-08-15T10:00:00.000Z",
    endedAt: "2026-08-15T10:00:40.000Z",
    providerReference: "call_abc123",
    hasRecording: false,
    measures: { durationMs: 40000, turnCount: 2, toolCallCount: 1 },
    test: {
      id: "tst_1",
      versionId: "tstv_1",
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
    },
    persona: {
      id: "prs_1",
      name: "Impatient Rita",
      versionId: "prsv_7",
      traits: { personality: "Speaks plainly." },
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
    mockToolCoverage: {
      discovered: ["book_appointment", "charge_card"],
      covered: ["book_appointment"],
      uncovered: ["charge_card"],
    },
    mockTools: { defaults: [{ toolName: "book_appointment" }], overrides: [] },
    gradingPlan: {
      state: "run_start",
      capturedAt: "2026-08-15T09:59:00.000Z",
      items: [
        {
          kind: "authored",
          graderId: "grd_1",
          graderVersionId: "grv_1",
          name: "expected_behaviors",
          libraryId: "grl_01M01MH8KAE8ZB19B0YJ7Z7EYW",
          required: true,
          scope: "simulations",
        },
      ],
    },
    gradingJobs: [
      {
        status: "graded",
        regradeGraderId: null,
        attempts: 1,
        lastError: null,
        finishedAt: "2026-08-15T10:05:00.000Z",
      },
    ],
    verdicts: [machineVerdict()],
    // The simulation's own answer is folded over the required copies alone,
    // and the diagnostic lane sits beside it. Nothing diagnostic judged this
    // one, so that lane is absent rather than an empty 0/0.
    outcome: {
      verdict: "failed",
      score: 0,
      counts: { ...NO_COUNTS, failed: 1, total: 1 },
    },
    diagnostics: null,
    byGrader: [
      {
        graderId: "grd_1",
        required: true,
        verdict: "failed",
        score: 0,
        counts: { ...NO_COUNTS, failed: 1, total: 1 },
      },
    ],
    transcript: {
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      startedAt: "2026-08-15T10:00:00.000000Z",
      endedAt: "2026-08-15T10:00:40.000000Z",
      durationNs: "40000000000",
      spanCount: 5,
      turnCounts: { human: 1, agent: 1 },
      toolSpanCount: 1,
      erroredSpanCount: 1,
      turns: [
        turn("span_human", "turn:human", "Move Thursday's clean to next week.", 1),
        {
          ...turn("span_agent", "turn:agent", "You are all set.", 4),
          spans: [
            {
              spanId: "span_tool",
              parentSpanId: "span_agent",
              name: "reschedule_appointment",
              kind: "tool",
              status: "error",
              startedAt: "2026-08-15T10:00:05.000000Z",
              durationNs: "500000000",
              text: "",
              audioUrl: "",
              toolName: "reschedule_appointment",
              toolArguments: "{}",
              toolResult: "{}",
              spans: [],
            },
          ],
        },
      ],
      spans: [
        {
          ...turn("span_root", "turn:agent", "", 0),
          parentSpanId: "",
          name: "simulation",
          kind: "simulation",
          durationNs: "40000000000",
          spans: [
            {
              ...turn(
                "span_human",
                "turn:human",
                "Move Thursday's clean to next week.",
                1,
              ),
              parentSpanId: "span_root",
            },
            {
              ...turn("span_agent", "turn:agent", "You are all set.", 4),
              parentSpanId: "span_root",
            },
          ],
        },
        {
          ...turn("span_system", "turn:agent", "", 3),
          parentSpanId: "",
          name: "dispatch",
          kind: "system",
        },
      ],
      spansTruncated: false,
    },
    ...overrides,
  };
}

function page(
  options: {
    readonly role?: string;
    readonly read?: Record<string, unknown> | readonly Record<string, unknown>[];
    readonly recording?: boolean;
    /** One answer, or one per ask in order — a page may regrade twice. */
    readonly regrade?: Stubbed | readonly Stubbed[];
  } = {},
): void {
  const read = options.read ?? evidence();
  apiAnswers({
    "/api/me": { status: 200, body: meWith(options.role ?? "admin") },
    "/v1/simulations/sim_1": Array.isArray(read)
      ? read.map((body) => ({ status: 200, body }))
      : { status: 200, body: read },
    "/v1/simulations/sim_1/regrade": options.regrade ?? {
      status: 200,
      body: {
        simulationId: "sim_1",
        graderId: null,
        reopened: 1,
        already_waiting: 0,
      },
    },
    ...(options.recording === true
      ? {
          "/v1/simulations/sim_1/recording": {
            status: 200,
            body: { url: "http://egma.test/recording.wav" },
          },
          "/recording.wav": { status: 200, body: "stereo audio fixture" },
        }
      : {}),
  });
}

beforeEach(() => {
  sent = [];
  routed.push.mockReset();
  routed.replace.mockReset();
  routed.params = {
    projectId: "prj_1",
    runId: "run_1",
    simulationId: "sim_1",
  };
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, search: "", replace: vi.fn() },
  });
  vi.stubGlobal("scrollTo", vi.fn());
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("one simulation's evidence", () => {
  it("shows the run hierarchy before the simulation actions", async () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    page({
      read: evidence({
        status: "running",
        grading: "waiting",
        verdict: null,
        counts: null,
        startedAt: startedAt,
        endedAt: null,
        hasRecording: false,
        gradingJobs: [],
        verdicts: [],
        byGrader: [],
      }),
    });
    render(<SimulationEvidencePage />);

    const breadcrumb = await screen.findByRole("navigation", {
      name: "Breadcrumb",
    });
    expect(within(breadcrumb).getByRole("link", { name: "Runs" }).getAttribute("href"))
      .toBe("/projects/prj_1/runs");
    expect(
      within(breadcrumb).getByRole("link", { name: "Nightly smoke" }).getAttribute("href"),
    ).toBe("/projects/prj_1/runs/run_1");
    expect(within(breadcrumb).getByText("Simulation 01").getAttribute("aria-current"))
      .toBe("page");
    const started = screen.getByText("5 minutes ago");
    expect(started.closest("time")?.dateTime).toBe(startedAt);
    expect(started.closest("time")?.title).toMatch(/^\d{4}-\d{2}-\d{2} /u);
    expect(screen.queryByRole("link", { name: "Back to the run" })).toBeNull();
    expect(screen.getByRole("button", { name: "Regrade" })).toBeTruthy();
    expect(
      screen.getByText("Recording will be available after the call ends."),
    ).toBeTruthy();
  });

  it("reads the whole page in one request", async () => {
    page();
    render(<SimulationEvidencePage />);

    // Wait for the read that produces everything below, then count what was
    // asked for. `/api/me` is the shell's own and is not this page's read.
    await screen.findByRole("region", { name: "Simulation summary" });
    expect(sentWith("/v1/simulations/sim_1", "GET")).toHaveLength(1);
    expect(
      sent.filter((one) => one.path.startsWith("/v1/simulations")),
    ).toHaveLength(1);
    // The project travels with it, because a simulation is read inside one.
    expect(sentWith("/v1/simulations/sim_1", "GET")[0]?.url).toContain(
      "projectId=prj_1",
    );
  });

  it("shows only the three useful summary facts above the evidence", async () => {
    page();
    render(<SimulationEvidencePage />);

    const summary = await screen.findByRole("region", {
      name: "Simulation summary",
    });
    expect(within(summary).getByText("Overall verdict")).toBeTruthy();
    expect(within(summary).getByText("Duration")).toBeTruthy();
    expect(within(summary).getByText("40s")).toBeTruthy();
    expect(within(summary).getByText("Total turns")).toBeTruthy();
    expect(within(summary).getByText("2")).toBeTruthy();

    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Measures" })).toBeNull();
    expect(screen.queryByText("tstv_1")).toBeNull();
    expect(screen.queryByText("prsv_7")).toBeNull();
    expect(screen.queryByText("call_abc123")).toBeNull();
    expect(
      screen.queryByText("Their cleaning has to move to any afternoon next week."),
    ).toBeNull();
    expect(
      (await screen.findAllByText("Expected behaviors")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("expected_behaviors")).toBeNull();
  });

  it("puts human-named graders behind default-open transcript and audio", async () => {
    const read = evidence({ hasRecording: true });
    page({
      recording: true,
      read: {
        ...read,
        gradingPlan: {
          ...read.gradingPlan,
          items: [
            ...read.gradingPlan.items,
            {
              ...read.gradingPlan.items[0],
              graderId: "grd_2",
              graderVersionId: "grv_2",
              name: "brand_tone",
              required: false,
            },
          ],
        },
        verdicts: [
          ...read.verdicts,
          machineVerdict({
            graderId: "grd_2",
            assertion: "keeps_brand_voice",
            assertionText: null,
            required: false,
            verdict: "passed",
            score: 1,
            rationale: "The agent kept the approved voice.",
            citedTurns: [],
          }),
        ],
        byGrader: [
          ...read.byGrader,
          {
            graderId: "grd_2",
            required: false,
            verdict: "passed",
            score: 1,
            counts: { ...NO_COUNTS, passed: 1, total: 1 },
          },
          {
            graderId: "grd_without_plan",
            required: false,
            verdict: null,
            score: null,
            counts: NO_COUNTS,
          },
        ],
      },
    });
    let audioContextClosed = false;
    class StereoAudioContext {
      async decodeAudioData() {
        return {
          duration: 2,
          numberOfChannels: 2,
          getChannelData: (channel: number) =>
            new Float32Array(channel === 0 ? [0, 0.8, 0] : [0, 0.4, 0]),
        };
      }

      close() {
        if (audioContextClosed) {
          throw new DOMException(
            "Cannot close a closed AudioContext.",
            "InvalidStateError",
          );
        }
        audioContextClosed = true;
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", StereoAudioContext);
    const { unmount } = render(<SimulationEvidencePage />);

    await screen.findByText("The agent never said the new time back.");
    const workspace = screen.getByRole("region", {
      name: "Simulation evidence",
    });
    const graders = within(workspace).getByRole("region", {
      name: "Grader results",
    });
    const evidenceSheet = await screen.findByRole("dialog", {
      name: "Transcript and audio",
    });
    const transcript = within(evidenceSheet).getByRole("region", {
      name: "Transcript",
    });
    const messages = within(transcript).getByRole("list", {
      name: "Transcript messages",
    });
    const turns = within(messages).getAllByRole("listitem");

    // A sheet is a panel docked beside this page rather than a layer over it,
    // so the grader results stay reachable while the transcript is open. What
    // it keeps from a dialog is its own label, focus, and Escape.
    expect(evidenceSheet.getAttribute("data-kind")).toBe("sheet");
    expect(evidenceSheet.contains(document.activeElement)).toBe(true);
    expect(turns).toHaveLength(2);
    expect(within(turns[0]!).getByText("Human")).toBeTruthy();
    expect(within(turns[1]!).getByText("Agent")).toBeTruthy();
    expect(within(graders).getByRole("heading", { name: "Expected behaviors" }))
      .toBeTruthy();
    expect(within(graders).getAllByRole("heading", { name: "Expected behavior" }))
      .toHaveLength(2);
    expect(within(graders).getAllByRole("heading", { name: "Judge finding" }))
      .toHaveLength(2);
    const customGrader = within(graders).getByRole("region", {
      name: "Brand tone",
    });
    expect(within(customGrader).getByText("Criterion 1")).toBeTruthy();
    expect(within(customGrader).getByText("The agent kept the approved voice."))
      .toBeTruthy();
    expect(
      within(graders).getByRole("region", { name: "Grader name unavailable" }),
    ).toBeTruthy();
    const visibleEvidence = document.body.textContent ?? "";
    for (const internal of [
      "grd_1",
      "grd_2",
      "grd_without_plan",
      "grv_1",
      "grv_2",
      "grl_01M01MH8KAE8ZB19B0YJ7Z7EYW",
      "keeps_brand_voice",
      "Keeps brand voice",
      "tstv_1",
      "prsv_7",
      "call_abc123",
      "0.00",
      "1.00",
    ]) {
      expect(visibleEvidence).not.toContain(internal);
    }
    expect(await within(evidenceSheet).findByLabelText("Simulation recording"))
      .toBeTruthy();
    const seek = await within(evidenceSheet).findByRole("slider", {
      name: "Seek the recording",
    });
    fireEvent.change(seek, { target: { value: "1" } });
    await waitFor(() => expect((seek as HTMLInputElement).value).toBe("1"));
    fireEvent.click(within(evidenceSheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Transcript and audio" })).toBeNull();

    const opener = within(graders).getByRole("button", {
      name: "Open transcript and audio",
    });
    opener.focus();
    fireEvent.click(opener);
    const reopened = screen.getByRole("dialog", { name: "Transcript and audio" });
    fireEvent.click(within(reopened).getByRole("button", { name: "Close" }));
    expect(document.activeElement).toBe(opener);

    fireEvent.click(within(graders).getByRole("button", { name: "Read turn 2" }));
    expect(screen.getByRole("dialog", { name: "Transcript and audio" })).toBeTruthy();
    await waitFor(() => {
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: "center",
      });
    });
    expect(screen.getByText("Simulation 01")).not.toBeNull();
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.queryByText("Frozen record")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Execution flow" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Test setup" })).toBeNull();
    expect(screen.queryByText("Provider reference")).toBeNull();
    expect(screen.queryByText("Credential")).toBeNull();
    expect(screen.queryByText("Model")).toBeNull();
    expect(screen.queryByText("Score")).toBeNull();
    expect(() => unmount()).not.toThrow();
  });

  it("can leave the recording view after its waveform is ready", async () => {
    for (const failure of ["throws", "rejects"] as const) {
      page({ recording: true, read: evidence({ hasRecording: true }) });
      let opened = 0;
      let closeAttempts = 0;
      class ClosingAudioContext {
        private isClosed = false;

        constructor() {
          opened += 1;
        }

        async decodeAudioData() {
          return {
            duration: 2,
            numberOfChannels: 2,
            getChannelData: (channel: number) =>
              new Float32Array(channel === 0 ? [0, 0.8, 0] : [0, 0.4, 0]),
          };
        }

        close() {
          closeAttempts += 1;
          if (this.isClosed) {
            throw new DOMException(
              "Cannot close a closed AudioContext.",
              "InvalidStateError",
            );
          }
          this.isClosed = true;
          const failureReason = new DOMException(
            "The AudioContext could not close.",
            "OperationError",
          );
          if (failure === "throws") throw failureReason;
          return Promise.reject(failureReason);
        }
      }
      vi.stubGlobal("AudioContext", ClosingAudioContext);

      const rendered = render(
        <StrictMode>
          <SimulationEvidencePage />
        </StrictMode>,
      );
      await screen.findByRole("slider", { name: "Seek the recording" });

      expect(() => rendered.unmount()).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(closeAttempts).toBe(opened);
    }
  });

  it("uses one evidence workspace without separate setup or execution sections", async () => {
    page();
    render(<SimulationEvidencePage />);

    const workspace = await screen.findByRole("region", {
      name: "Simulation evidence",
    });
    // The transcript is drawn in the sheet, and a sheet is drawn at the end of
    // the page so its position never depends on what it sits inside.
    expect(screen.getByText("You are all set.")).toBeTruthy();
    expect(
      within(workspace).getByText("The agent never said the new time back."),
    ).toBeTruthy();
    expect(screen.getByText("No audio was recorded.")).toBeTruthy();
    expect(screen.getAllByRole("region", { name: "Simulation evidence" })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Test setup" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Execution" })).toBeNull();
  });

  it("keeps raw timing and nested execution data out of the transcript", async () => {
    page();
    render(<SimulationEvidencePage />);

    await screen.findByText("You are all set.");
    expect(screen.queryByText("+4.0 s")).toBeNull();
    expect(screen.queryByText("1.0 s")).toBeNull();
    expect(screen.queryByText("something failed inside")).toBeNull();
    expect(screen.queryByText("charge_card")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Mock tools" })).toBeNull();
  });

  it("does not turn a recorded plan into verdicts when nothing was judged", async () => {
    page({
      read: evidence({
        status: "skipped",
        grading: "not_required",
        verdict: "skipped",
        score: null,
        counts: { ...NO_COUNTS, skipped: 1, total: 1 },
        verdicts: [],
        byGrader: [],
        gradingJobs: [],
      }),
    });
    render(<SimulationEvidencePage />);

    const graders = await screen.findByRole("region", {
      name: "Grader results",
    });
    await within(graders).findByText("There was nothing to judge");
    expect(
      within(graders).queryByRole("heading", { name: "Expected behaviors" }),
    ).toBeNull();
    expect(screen.queryByText("Technical details")).toBeNull();
  });
});

describe("grading that is still running", () => {
  it("says so, and draws no failure while it is", async () => {
    const pending = evidence({
      grading: "pending",
      verdict: null,
      score: null,
      counts: null,
      verdicts: [],
      byGrader: [],
      gradingJobs: [
        {
          status: "pending",
          regradeGraderId: null,
          attempts: 0,
          lastError: null,
          finishedAt: null,
        },
      ],
    });
    // Two answers: the first still judging, the second landed. The page asks
    // again on its own while anything is outstanding.
    page({ read: [pending, evidence()] });
    render(<SimulationEvidencePage />);

    await screen.findByText(/Grading is still running/u);
    // **The negative assertion waits for the read that could contradict it.**
    // The line above is only drawn once the first answer has landed, so by here
    // the page has been told everything it knows — and it says nothing failed.
    expect(screen.queryByText("The agent never said the new time back.")).toBeNull();
    expect(
      screen.getAllByText("Not judged yet").length,
    ).toBeGreaterThan(0);

    // And the verdict arrives on its own, without the page having been reloaded
    // by anybody.
    await screen.findByText("The agent never said the new time back.", undefined, {
      timeout: 5000,
    });
    expect(
      sentWith("/v1/simulations/sim_1", "GET").length,
    ).toBeGreaterThan(1);
  });
});

describe("asking for it to be judged again", () => {
  it("sends one regrade for the simulation in the address", async () => {
    page();
    render(<SimulationEvidencePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Regrade" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Judge it again" }),
    );

    // The method is named because this page reads the address it writes under.
    await waitFor(() => {
      expect(sentWith("/v1/simulations/sim_1/regrade", "POST")).toHaveLength(1);
    });
    // No grader was named, so the whole applicable set is resolved again.
    expect(
      sentWith("/v1/simulations/sim_1/regrade", "POST")[0]?.body,
    ).toBeUndefined();
    // The project travels in the address, which is where this browser's write
    // helper puts it and where the route looks first.
    expect(sentWith("/v1/simulations/sim_1/regrade", "POST")[0]?.url).toContain(
      "projectId=prj_1",
    );
    await screen.findByText(/queued to be judged again/u);
  });

  it("shows a regrade refusal without its storage identifier", async () => {
    page({
      regrade: {
        status: 422,
        body: {
          error: "unprocessable",
          message: "simulation sim_1 has no grading to ask for again.",
        },
      },
    });
    render(<SimulationEvidencePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Regrade" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Judge it again" }),
    );

    await screen.findByText(
      "This simulation has no grading to ask for again. It was not conducted or did not finish, so there is nothing to judge again.",
    );
    expect(screen.queryByText(/sim_1/u)).toBeNull();
  });

  /**
   * The reassurance from the first ask has to go when the second is refused.
   *
   * `narrower_grading_in_flight` is the answer that says *nothing was queued*,
   * and it is exactly the answer a second ask can meet after a first one
   * succeeded — the engine takes the first job, narrowed, and the second ask
   * falls outside what it is judging. Two boxes then disagree about the same
   * simulation, and the comforting one is drawn first.
   */
  it("drops the sentence about the last ask when the next one is refused", async () => {
    const inFlight =
      "simulation sim_1 is being judged right now, for one grader that does " +
      "not cover what you asked for. Ask again once those verdicts land.";
    page({
      regrade: [
        {
          status: 200,
          body: {
            simulationId: "sim_1",
            graderId: null,
            reopened: 1,
            already_waiting: 0,
          },
        },
        {
          status: 409,
          body: { error: "narrower_grading_in_flight", message: inFlight },
        },
      ],
    });
    render(<SimulationEvidencePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Regrade" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Judge it again" }),
    );
    // Wait for the first answer to have landed and been drawn, so the second
    // ask is genuinely a second one rather than a race with the first.
    await screen.findByText(/queued to be judged again/u);
    await waitFor(() => {
      expect(sentWith("/v1/simulations/sim_1/regrade", "POST")).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Regrade" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Judge it again" }),
    );

    await screen.findByText(
      "One grader is already judging this simulation and does not cover what you asked for. Nothing was queued. Ask again after those verdicts arrive.",
    );
    expect(screen.queryByText(inFlight)).toBeNull();
    // And the reassurance from the first ask is gone rather than sitting above
    // the refusal that contradicts it.
    expect(screen.queryByText(/queued to be judged again/u)).toBeNull();
  });
});

/**
 * **Three proofs about disagreeing with a judgement used to stand here.** They
 * opened a Disagree form on a verdict row, sent a `POST` to
 * `/v1/simulations/:id/corrections`, and held that a person's word replaced
 * the machine's with the machine's still readable underneath.
 *
 * ADR-0009 takes corrections and their calibration data out of v0: the form,
 * the endpoint and the `judgedBy` column that carried the second author are
 * all gone. The capability returns as the reserved `human` grader type, which
 * writes its own verdict rows under its own grader id — so what supersedes
 * what becomes the ordinary supersession this page already draws, and needs no
 * second author on a row. The proofs return with it, at that shape.
 */

describe("what a viewer sees", () => {
  it("gets all of the evidence and none of the controls", async () => {
    page({ role: "viewer" });
    render(<SimulationEvidencePage />);

    // Every piece of evidence is theirs to read.
    await screen.findByText("The agent never said the new time back.");
    await screen.findByText("You are all set.");
    await screen.findByRole("region", { name: "Simulation summary" });

    // **Waited for the read that would have supplied them**: the two lines
    // above only exist once the answer landed, so an absence here is an
    // absence and not an early assertion.
    expect(screen.queryByRole("button", { name: "Regrade" })).toBeNull();
    // And it says why, rather than leaving somebody hunting for a control.
    await screen.findByText(/viewer role can read every piece of evidence/u);
    expect(screen.queryByText("Technical details")).toBeNull();
  });
});
