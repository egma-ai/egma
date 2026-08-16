// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SimulationEvidencePage from "../app/projects/[projectId]/runs/[runId]/simulations/[simulationId]/page.tsx";
import type { Me } from "../lib/me.ts";

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
    vi.fn(async (input: string, options?: RequestInit) => {
      const address = new URL(input, "http://egma.test");
      const path = address.pathname;
      sent.push({
        url: `${path}${address.search}`,
        path,
        method: options?.method ?? "GET",
        body:
          typeof options?.body === "string"
            ? (JSON.parse(options.body) as Record<string, unknown>)
            : undefined,
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
 * address it writes under. A wait on "anything sent to `/api/simulations/sim_1`"
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
    span_id: id,
    parent_span_id: "root",
    name: kind,
    kind,
    status: "ok",
    started_at: `2026-08-15T10:00:${String(offsetSeconds).padStart(2, "0")}.000000Z`,
    duration_ns: "1000000000",
    text,
    audio_url: "",
    tool_name: "",
    tool_arguments: "",
    tool_result: "",
    spans: [],
  };
}

/**
 * One judgment, as the read carries it: the assertion by **key**, the words
 * behind that key resolved from the pinned version, and which lane the row is
 * in. `judged_by` retired with human corrections (ADR-0009) and `priority`
 * with the P0/P1/P2 ladder, so neither is here to be drawn.
 */
function machineVerdict(overrides: Record<string, unknown> = {}) {
  return {
    grader_id: "grd_1",
    assertion: "behavior_1",
    assertion_text: "confirms the new time back before finishing",
    required: true,
    verdict: "failed",
    score: 0,
    rationale: "The agent never said the new time back.",
    cited_turns: ["span_agent"],
    judged_at: "2026-08-15T10:05:00.000000Z",
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    id: "sim_1",
    project_id: "prj_1",
    run_id: "run_1",
    run_label: "Nightly smoke",
    position: 1,
    status: "completed",
    grading: "graded",
    verdict: "failed",
    score: 0,
    counts: { ...NO_COUNTS, failed: 1, total: 1 },
    reason: null,
    skip_reason: null,
    skipped_capabilities: null,
    modality: "voice",
    created_at: "2026-08-15T09:59:00.000Z",
    started_at: "2026-08-15T10:00:00.000Z",
    ended_at: "2026-08-15T10:00:40.000Z",
    provider_reference: "call_abc123",
    has_recording: false,
    measures: { duration_ms: 40000, turn_count: 2, tool_call_count: 1 },
    test: {
      id: "tst_1",
      version_id: "tstv_1",
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expected_behaviors: ["confirms the new time back before finishing"],
      required_capabilities: [],
    },
    persona: {
      id: "prs_1",
      name: "Impatient Rita",
      version_id: "prsv_7",
      traits: { personality: "Speaks plainly." },
    },
    agent: { id: "agt_1", name: "Front desk", archived: false },
    connection: { id: "con_1", name: "retell-staging", archived: false },
    connection_snapshot: {
      type: "retell",
      modality: "voice",
      topology: "hosted-broker",
      environment: "staging",
      config: { retellAgentId: "agent_abc" },
    },
    mock_tool_coverage: {
      discovered: ["book_appointment", "charge_card"],
      covered: ["book_appointment"],
      uncovered: ["charge_card"],
    },
    mock_tools: { defaults: [{ tool_name: "book_appointment" }], overrides: [] },
    grading_plan: {
      state: "run_start",
      captured_at: "2026-08-15T09:59:00.000Z",
      items: [
        {
          kind: "authored",
          grader_id: "grd_1",
          grader_version_id: "grv_1",
          name: "expected_behaviors",
          library_id: "grl_01M01MH8KAE8ZB19B0YJ7Z7EYW",
          required: true,
          scope: "simulations",
          judge: {
            tag: "configured",
            provider: "openai",
            model: "gpt-4.1-mini",
            source: "jcr_1",
          },
        },
      ],
    },
    grading_jobs: [
      {
        status: "graded",
        regrade_grader_id: null,
        attempts: 1,
        last_error: null,
        finished_at: "2026-08-15T10:05:00.000Z",
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
    by_grader: [
      {
        grader_id: "grd_1",
        required: true,
        verdict: "failed",
        score: 0,
        counts: { ...NO_COUNTS, failed: 1, total: 1 },
      },
    ],
    transcript: {
      trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      started_at: "2026-08-15T10:00:00.000000Z",
      ended_at: "2026-08-15T10:00:40.000000Z",
      duration_ns: "40000000000",
      span_count: 3,
      turn_counts: { human: 1, agent: 1 },
      tool_span_count: 1,
      errored_span_count: 0,
      turns: [
        turn("span_human", "turn:human", "Move Thursday's clean to next week.", 1),
        turn("span_agent", "turn:agent", "You are all set.", 4),
      ],
      spans: [],
      spans_truncated: false,
    },
    ...overrides,
  };
}

function page(
  options: {
    readonly role?: string;
    readonly read?: Record<string, unknown> | readonly Record<string, unknown>[];
    /** One answer, or one per ask in order — a page may regrade twice. */
    readonly regrade?: Stubbed | readonly Stubbed[];
  } = {},
): void {
  const read = options.read ?? evidence();
  apiAnswers({
    "/api/me": { status: 200, body: meWith(options.role ?? "admin") },
    "/api/simulations/sim_1": Array.isArray(read)
      ? read.map((body) => ({ status: 200, body }))
      : { status: 200, body: read },
    "/api/simulations/sim_1/regrade": options.regrade ?? {
      status: 200,
      body: {
        simulation_id: "sim_1",
        grader_id: null,
        reopened: 1,
        already_waiting: 0,
      },
    },
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("one simulation's evidence", () => {
  it("reads the whole page in one request", async () => {
    page();
    render(<SimulationEvidencePage />);

    // Wait for the read that produces everything below, then count what was
    // asked for. `/api/me` is the shell's own and is not this page's read.
    await screen.findByText("call_abc123");
    expect(sentWith("/api/simulations/sim_1", "GET")).toHaveLength(1);
    expect(
      sent.filter((one) => one.path.startsWith("/api/simulations")),
    ).toHaveLength(1);
    // The project travels with it, because a simulation is read inside one.
    expect(sentWith("/api/simulations/sim_1", "GET")[0]?.url).toContain(
      "project=prj_1",
    );
  });

  it("shows the pins, the identities and the provider's own reference", async () => {
    page();
    render(<SimulationEvidencePage />);

    // The exact frozen versions, which never move, beside names that read as
    // they stand today.
    await screen.findByText("tstv_1");
    await screen.findByText("prsv_7");
    await screen.findByText("Their cleaning has to move to any afternoon next week.");
    // The one join between egma's record and the agent's own telemetry.
    await screen.findByText("call_abc123");
    await screen.findByText("retell · voice · hosted-broker");
    expect(
      (await screen.findAllByText("Expected behaviors")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("expected_behaviors")).toBeNull();
  });

  it("puts verdict evidence before technical detail and calls the unit a simulation", async () => {
    page();
    render(<SimulationEvidencePage />);

    await screen.findByText("The agent never said the new time back.");
    const verdicts = screen.getByRole("heading", { name: "Verdicts" });
    const transcript = screen.getByRole("heading", { name: "Transcript" });

    expect(
      verdicts.compareDocumentPosition(transcript) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(screen.getByText("Simulation")).not.toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Conversation" }),
    ).toBeNull();
  });

  it("keeps the transcript, the timing and the measures three separate things", async () => {
    page();
    render(<SimulationEvidencePage />);

    // The transcript is what was said, at reading density, with the two
    // speakers the domain model labels.
    const said = await screen.findByText("You are all set.");
    expect(screen.getAllByText("human:").length).toBeGreaterThan(0);
    expect(screen.getAllByText("agent:").length).toBeGreaterThan(0);

    // What was measured is its own block and is never inside a turn.
    const outcome = screen.getByRole("heading", { name: "Outcome" });
    expect(outcome).not.toBe(null);
    await screen.findByText("40.0 s");
    // The measure is not drawn inside the transcript's turn.
    expect(said.closest("section")).not.toBe(outcome.closest("section"));

    // And the timed view exists as its own section rather than being folded in.
    expect(screen.getByRole("heading", { name: "Execution" })).not.toBe(null);
  });

  it("says which tools ran for real, and never offers to author one", async () => {
    page();
    render(<SimulationEvidencePage />);

    await screen.findByText("Answered by Egma");
    await screen.findByText("charge_card");
    // A record of what was served, not an editor of the project's world.
    expect(
      screen.queryByRole("button", { name: /mock tool/iu }),
    ).toBeNull();
  });

  it("says a plan was not recorded rather than showing today's graders", async () => {
    page({
      read: evidence({
        grading_plan: { state: "not_recorded", captured_at: null, items: [] },
      }),
    });
    render(<SimulationEvidencePage />);

    await screen.findByText(/No plan was recorded when this run started/u);
    await screen.findByText(
      "No grading plan was recorded for this simulation",
    );
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
      by_grader: [],
      grading_jobs: [
        {
          status: "pending",
          regrade_grader_id: null,
          attempts: 0,
          last_error: null,
          finished_at: null,
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
      sentWith("/api/simulations/sim_1", "GET").length,
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
      expect(sentWith("/api/simulations/sim_1/regrade", "POST")).toHaveLength(1);
    });
    // No grader was named, so the whole applicable set is resolved again.
    expect(
      sentWith("/api/simulations/sim_1/regrade", "POST")[0]?.body,
    ).toEqual({});
    // The project travels in the address, which is where this browser's write
    // helper puts it and where the route looks first.
    expect(sentWith("/api/simulations/sim_1/regrade", "POST")[0]?.url).toContain(
      "project=prj_1",
    );
    await screen.findByText(/queued to be judged again/u);
  });

  it("shows egma's own sentence when a regrade is refused", async () => {
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

    await screen.findByText("simulation sim_1 has no grading to ask for again.");
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
            simulation_id: "sim_1",
            grader_id: null,
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
      expect(sentWith("/api/simulations/sim_1/regrade", "POST")).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Regrade" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Judge it again" }),
    );

    await screen.findByText(inFlight);
    // And the reassurance from the first ask is gone rather than sitting above
    // the refusal that contradicts it.
    expect(screen.queryByText(/queued to be judged again/u)).toBeNull();
  });
});

/**
 * **Three proofs about disagreeing with a judgement used to stand here.** They
 * opened a Disagree form on a verdict row, sent a `POST` to
 * `/api/simulations/:id/corrections`, and held that a person's word replaced
 * the machine's with the machine's still readable underneath.
 *
 * ADR-0009 takes corrections and their calibration data out of v0: the form,
 * the endpoint and the `judged_by` column that carried the second author are
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
    await screen.findByText("call_abc123");

    // **Waited for the read that would have supplied them**: the two lines
    // above only exist once the answer landed, so an absence here is an
    // absence and not an early assertion.
    expect(screen.queryByRole("button", { name: "Regrade" })).toBeNull();
    // And it says why, rather than leaving somebody hunting for a control.
    await screen.findByText(/viewer role can read every piece of evidence/u);
  });
});
