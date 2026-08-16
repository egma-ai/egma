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

import RunDetailPage from "../app/projects/[projectId]/runs/[runId]/page.tsx";
import RunsPage from "../app/projects/[projectId]/runs/page.tsx";
import type { Me } from "../lib/me.ts";
import { retryKeyFor } from "../lib/runs.ts";

/**
 * The run history and one run's page, rendered and driven.
 *
 * **Every test here is about the same thing said four ways**: machinery is not
 * judgment. A run that finished is not a run that went well; a conversation egma
 * declined to conduct is not a conversation that failed; a conversation egma
 * could not conduct is egma's problem and not the agent's; and a verdict nobody
 * has reached is nothing at all rather than a red mark.
 *
 * Nothing here asserts that a component exists or that a source file contains a
 * string. Each drives the real page the way somebody with a keyboard would and
 * reads what the DOM then says.
 */

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  pathname: "/projects/prj_1/runs",
  params: { projectId: "prj_1", runId: "run_1" } as Record<string, string>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: routed.push, replace: routed.replace, back: vi.fn() }),
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

function apiAnswers(answers: Record<string, Stubbed | readonly Stubbed[]>): void {
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
 * The method is not optional here and the reason is the whole point: this page
 * reads the address it writes to. A wait on "anything sent to `/api/runs/run_1`"
 * is satisfied by the page's own load and says nothing whatever about a cancel
 * or a retry — and under load the assertion then runs against the `GET`, whose
 * body is undefined, and arrives as `Cannot read properties of undefined`.
 */
function sentWith(path: string, method: string): Recorded[] {
  return sent.filter((one) => one.path === path && one.method === method);
}

/** Every address asked for by GET, so a filter can be read out of one. */
function readsOf(path: string): string[] {
  return sent.filter((one) => one.path === path && one.method === "GET").map((one) => one.url);
}

const NO_SIMULATIONS = {
  queued: 0,
  claimed: 0,
  running: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
  skipped: 0,
};

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    project_id: "prj_1",
    status: "completed",
    label: "Nightly smoke",
    agent_id: "agt_1",
    connection_id: "con_1",
    connection_type: "retell",
    modality: "chat",
    environment: "staging",
    retry_of_run_id: null,
    expected_simulation_count: 2,
    completed_count: 1,
    failed_count: 0,
    canceled_count: 0,
    skipped_count: 1,
    simulation_counts: { ...NO_SIMULATIONS, completed: 1, skipped: 1 },
    finished_count: 2,
    gradable_count: 1,
    graded_count: 1,
    verdict: "passed",
    score: 1,
    verdict_counts: { passed: 1, failed: 0, skipped: 1, errored: 0, total: 2 },
    created_at: "2026-08-15T10:00:00.000Z",
    started_at: "2026-08-15T10:00:01.000Z",
    finished_at: "2026-08-15T10:01:00.000Z",
    ...overrides,
  };
}

function simulationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sim_1",
    position: 1,
    test_id: "tst_1",
    test_name: "Reschedules a booked appointment",
    test_version_id: "tstv_1",
    persona_id: "prs_1",
    persona_name: "Impatient Rita",
    persona_version_id: "prsv_7",
    status: "completed",
    grading: "graded",
    verdict: "passed",
    score: 1,
    counts: { passed: 1, failed: 0, skipped: 0, errored: 0, total: 1 },
    reason: null,
    skip_reason: null,
    skipped_capabilities: null,
    modality: "chat",
    has_recording: false,
    ...overrides,
  };
}

function runDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    project_id: "prj_1",
    status: "completed",
    label: "Nightly smoke",
    agent_id: "agt_1",
    connection_id: "con_1",
    connection_type: "retell",
    modality: "chat",
    connection_snapshot: {
      type: "retell",
      modality: "chat",
      topology: "hosted-broker",
      environment: "staging",
      config: { retellAgentId: "agent_abc" },
    },
    retry_of_run_id: null,
    test_versions: ["tstv_1"],
    mock_tools: { defaults: [], overrides: {} },
    expected_simulation_count: 1,
    completed_count: 1,
    failed_count: 0,
    canceled_count: 0,
    skipped_count: 0,
    simulation_counts: { ...NO_SIMULATIONS, completed: 1 },
    finished_count: 1,
    gradable_count: 1,
    graded_count: 1,
    verdict: "passed",
    score: 1,
    counts: { passed: 1, failed: 0, skipped: 0, errored: 0, total: 1 },
    created_at: "2026-08-15T10:00:00.000Z",
    finished_at: "2026-08-15T10:01:00.000Z",
    simulations: [simulationRow()],
    grading_plan: {
      state: "run_start",
      captured_at: "2026-08-15T10:00:00.000Z",
      groups: [
        {
          tag: "version",
          test_id: "tst_1",
          test_version_id: "tstv_1",
          test_name: "Reschedules a booked appointment",
          items: [
            // A running copy, like every item in a frozen plan: the
            // expected-behaviors grader is a seeded copy of a predefined
            // library entry now, not a rowless sentinel with an engine
            // version, so one shape describes the whole plan.
            {
              kind: "authored",
              grader_id: "grd_seeded",
              grader_version_id: "grv_1",
              name: "Expected behaviors",
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
      ],
    },
    agent: { id: "agt_1", name: "Front desk", archived: false },
    connection: {
      id: "con_1",
      name: "retell-staging",
      type: "retell",
      archived: false,
    },
    ...overrides,
  };
}

const NO_EVENTS = { status: 200, body: { events: [], next: 0, done: true } };

/**
 * The two sentences a verdict badge and a conversation-status badge carry.
 *
 * Asserted by sentence rather than by the word on the badge, because the words
 * overlap on purpose: `failed` is a legitimate thing for a conversation's
 * *machinery* to say — egma could not conduct it — and is also an option in the
 * verdict filter. Only the sentence says which of the four facts is speaking.
 */
const JUDGED_THE_AGENT = "At least one check failed. This is a judgement about the agent.";
const COULD_NOT_CONDUCT =
  "Egma could not conduct this simulation. This is an execution problem, not a failed grader verdict, and it says nothing about the agent.";

beforeEach(() => {
  sent = [];
  routed.push.mockReset();
  routed.replace.mockReset();
  routed.pathname = "/projects/prj_1/runs";
  routed.params = { projectId: "prj_1", runId: "run_1" };
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

/* ------------------------------------------------------------------------ *
 * The list.
 * ------------------------------------------------------------------------ */

function history(
  rows: readonly Record<string, unknown>[],
  options: {
    readonly role?: string;
    readonly nextCursor?: string | null;
    readonly cancel?: Stubbed | readonly Stubbed[];
  } = {},
): void {
  apiAnswers({
    "/api/me": { status: 200, body: meWith(options.role ?? "admin") },
    "/api/agents": {
      status: 200,
      body: {
        items: [
          {
            id: "agt_1",
            project_id: "prj_1",
            name: "Front desk",
            description: null,
            revision: "rev_a",
            archived: false,
            archived_at: null,
            created_at: "2026-08-01T10:00:00.000Z",
            updated_at: "2026-08-01T10:00:00.000Z",
          },
        ],
        next_cursor: null,
      },
    },
    "/api/runs": {
      status: 200,
      body: { items: rows, next_cursor: options.nextCursor ?? null },
    },
    "/api/runs/run_1/cancel": options.cancel ?? {
      status: 200,
      body: runRow({ status: "canceled" }),
    },
    "/api/runs/run_2/cancel": options.cancel ?? {
      status: 200,
      body: runRow({ id: "run_2", status: "canceled" }),
    },
  });
}

describe("the run list", () => {
  it("keeps the four facts apart on one row", async () => {
    history([
      runRow({
        status: "completed",
        verdict: "failed",
        simulation_counts: { ...NO_SIMULATIONS, completed: 1, skipped: 1 },
        graded_count: 1,
        gradable_count: 1,
      }),
    ]);
    render(<RunsPage />);

    // The machinery finished, and what it found was bad. Both are on the row,
    // and neither is the other.
    await screen.findAllByText("completed");
    await screen.findAllByText("failed");
    // The skipped conversation is counted as itself and never as a failure.
    const tallies = await screen.findAllByText(/1 completed · 1 skipped/u);
    expect(tallies.length).toBeGreaterThan(0);
    for (const tally of tallies) {
      expect(tally.textContent).not.toContain("failed");
    }
  });

  it("says a run nobody has judged has no verdict, rather than showing a failure", async () => {
    history([
      runRow({
        status: "running",
        verdict: null,
        graded_count: 0,
        gradable_count: 1,
        finished_at: null,
      }),
    ]);
    render(<RunsPage />);

    const said = await screen.findAllByText("Not judged yet");
    expect(said.length).toBeGreaterThan(0);
    // Nothing on the row claims a judgement about the agent. Asked by the
    // verdict badge's own sentence rather than by the word "failed", which the
    // verdict filter also offers as an option and which a machinery badge is
    // entitled to say.
    expect(screen.queryAllByTitle(JUDGED_THE_AGENT)).toEqual([]);
  });

  it("puts every filter in the address of the request, never in the browser", async () => {
    history([runRow()]);
    render(<RunsPage />);
    await screen.findAllByText("Nightly smoke");

    fireEvent.change(
      screen.getByLabelText("Show only runs with one verdict"),
      { target: { value: "failed" } },
    );

    await waitFor(() => {
      expect(readsOf("/api/runs").some((one) => one.includes("verdict=failed"))).toBe(
        true,
      );
    });

    fireEvent.change(
      screen.getByLabelText("Show only runs whose machinery is in one state"),
      { target: { value: "canceled" } },
    );
    await waitFor(() => {
      const latest = readsOf("/api/runs").at(-1) ?? "";
      expect(latest).toContain("status=canceled");
      expect(latest).toContain("verdict=failed");
    });
  });

  it("offers a viewer no way to stop a run, because the server would refuse it", async () => {
    history([runRow({ status: "running", finished_at: null })], { role: "viewer" });
    render(<RunsPage />);

    await screen.findAllByText("Nightly smoke");
    expect(screen.queryAllByRole("button", { name: "Cancel" })).toEqual([]);
    expect(screen.queryAllByRole("link", { name: "Plan a run" })).toEqual([]);
  });

  it("sends a cancel for the row it was opened on", async () => {
    history([runRow({ status: "running", finished_at: null })]);
    render(<RunsPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Cancel" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));

    // The method is named because this page reads the address it writes to: a
    // wait on "anything sent here" is satisfied by its own load.
    await waitFor(() => {
      expect(sentWith("/api/runs/run_1/cancel", "POST")).toHaveLength(1);
    });
  });
});

/**
 * The panel is drawn once under the table, for whichever row is open, so
 * everything it holds is shared by every row. These are two defects and not one:
 * clearing the sentence does not clear the retry, and the retry is the one that
 * stops a run nobody is looking at.
 */
describe("what belongs to the open run row", () => {
  /** Two runs, the first one's cancel refused, so the panel holds a failure. */
  function twoRuns(): void {
    history(
      [
        runRow({ id: "run_1", label: "First", status: "running", finished_at: null }),
        runRow({ id: "run_2", label: "Second", status: "running", finished_at: null }),
      ],
      {
        cancel: {
          status: 409,
          body: {
            error: "conflict",
            message: "Egma could not stop run_1.",
          },
        },
      },
    );
  }

  it("empties a refused cancel's sentence when a different row opens", async () => {
    twoRuns();
    render(<RunsPage />);

    const stops = await screen.findAllByRole("button", { name: "Cancel" });
    fireEvent.click(stops[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    // **Wait for the write that produces the sentence** before asserting it is
    // gone. Asserting an absence before the request has answered would pass for
    // the wrong reason and keep passing after the behaviour was deleted.
    await screen.findByText("Egma could not stop run_1.");

    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]!);

    await waitFor(() => {
      expect(screen.queryByText("Egma could not stop run_1.")).toBeNull();
    });
    // The heading is the only thing on screen saying which run the panel is
    // about, so a sentence left behind would be read as being about this one.
    await screen.findByText("Cancel Second?");
  });

  it("drops a refused cancel's Try again when a different row opens", async () => {
    twoRuns();
    render(<RunsPage />);

    const stops = await screen.findAllByRole("button", { name: "Cancel" });
    fireEvent.click(stops[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    await screen.findByRole("button", { name: "Try again" });

    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]!);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
    // The panel is open on the second run, which is what makes a retry left
    // behind dangerous: pressing it would stop the first while the panel
    // reported about the second.
    await screen.findByText("Cancel Second?");
    expect(sentWith("/api/runs/run_1/cancel", "POST")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ *
 * One run.
 * ------------------------------------------------------------------------ */

function detail(
  options: {
    readonly role?: string;
    /** One answer, or a list answered in order — a cancel is read back after. */
    readonly run?: Record<string, unknown> | readonly Record<string, unknown>[];
    readonly events?: Stubbed | readonly Stubbed[];
    readonly cancel?: Stubbed;
    readonly retry?: Stubbed;
    readonly secondRun?: Record<string, unknown>;
  } = {},
): void {
  apiAnswers({
    "/api/me": { status: 200, body: meWith(options.role ?? "admin") },
    "/api/runs/run_1": Array.isArray(options.run)
      ? options.run.map((body) => ({ status: 200, body }))
      : { status: 200, body: (options.run as Record<string, unknown>) ?? runDetail() },
    "/api/runs/run_1/events": options.events ?? NO_EVENTS,
    "/api/runs/run_1/cancel": options.cancel ?? {
      status: 200,
      body: runDetail({ status: "canceled" }),
    },
    "/api/runs/run_1/retry": options.retry ?? {
      status: 201,
      body: runDetail({ id: "run_9" }),
    },
    "/api/runs/run_2": {
      status: 200,
      body: options.secondRun ?? runDetail({ id: "run_2", label: "Second" }),
    },
    "/api/runs/run_2/events": NO_EVENTS,
  });
}

describe("one run's page", () => {
  it("keeps machinery, grading and verdict apart on every simulation", async () => {
    detail({
      run: runDetail({
        status: "completed",
        expected_simulation_count: 3,
        simulation_counts: {
          ...NO_SIMULATIONS,
          completed: 1,
          failed: 1,
          skipped: 1,
        },
        verdict: "errored",
        simulations: [
          simulationRow(),
          simulationRow({
            id: "sim_2",
            position: 2,
            status: "failed",
            grading: "pending",
            verdict: "errored",
            counts: null,
            score: null,
            reason: "not_answered",
          }),
          simulationRow({
            id: "sim_3",
            position: 3,
            status: "skipped",
            grading: "not_required",
            verdict: "skipped",
            counts: null,
            score: null,
            skip_reason: "required_capability_unsupported",
            skipped_capabilities: ["raw_audio"],
          }),
        ],
      }),
    });
    render(<RunDetailPage />);

    await screen.findAllByText("errored");
    await screen.findAllByText("skipped");
    const table = await screen.findByRole("table", {
      name: "Simulations in this run",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .slice(0, 2)
        .map((header) => header.textContent),
    ).toEqual(["Simulation", "Status"]);

    // Egma could not conduct one of them, and the page says so in those words
    // rather than calling it a failed verdict.
    const execution = await screen.findAllByText(/not an?\s*failed grader verdict/u);
    expect(execution.length).toBeGreaterThan(0);

    // And it declined to conduct another, naming what decided it.
    const declined = await screen.findAllByText(/does not support raw_audio/u);
    expect(declined.length).toBeGreaterThan(0);
    for (const said of declined) {
      expect(said.textContent).toContain("says nothing about the agent");
    }

    /*
     * The machinery genuinely says `failed` about one conversation — egma could
     * not conduct it — and that word is allowed to be on the page. What must
     * never be on it is a **verdict** saying the agent failed, and that is what
     * this asks, by the verdict badge's own sentence.
     */
    expect((await screen.findAllByTitle(COULD_NOT_CONDUCT)).length).toBeGreaterThan(0);
    expect(screen.queryAllByTitle(JUDGED_THE_AGENT)).toEqual([]);
  });

  it("shows the frozen plan and says when it was decided", async () => {
    detail();
    render(<RunDetailPage />);

    await screen.findByText("Expected behaviors");
    await screen.findByText(/Frozen when this run started/u);
    // A judge choice names a credential reference and never a key.
    await screen.findByText(/openai\/gpt-4\.1-mini · credential jcr_1/u);
  });

  it("says an unrecorded plan was never recorded, and reconstructs nothing", async () => {
    detail({
      run: runDetail({
        grading_plan: { state: "not_recorded", captured_at: null, groups: [] },
      }),
    });
    render(<RunDetailPage />);

    await screen.findByText(/predates frozen grading plans/u);
    await screen.findByText("No grading plan was recorded");
    expect(screen.queryByText("Expected behaviors")).toBeNull();
  });

  it("names what it ran against after both have been archived", async () => {
    detail({
      run: runDetail({
        agent: { id: "agt_1", name: "Front desk", archived: true },
        connection: {
          id: "con_1",
          name: "retell-staging",
          type: "retell",
          archived: true,
        },
      }),
    });
    render(<RunDetailPage />);

    await screen.findByText("Front desk");
    await screen.findByText("retell-staging");
    expect((await screen.findAllByText("Archived")).length).toBe(2);
  });

  /**
   * The page follows the numbered feed rather than re-reading the run, so a
   * conversation landing has to reach the screen with no reload at all.
   */
  it("moves a conversation from the feed without reading the run again", async () => {
    detail({
      run: runDetail({
        status: "running",
        finished_at: null,
        expected_simulation_count: 1,
        simulation_counts: { ...NO_SIMULATIONS, running: 1 },
        graded_count: 0,
        gradable_count: 0,
        verdict: null,
        simulations: [
          simulationRow({
            status: "running",
            grading: "waiting",
            verdict: null,
            counts: null,
            score: null,
          }),
        ],
      }),
      events: [
        {
          status: 200,
          body: {
            events: [
              {
                seq: 1,
                at: "2026-08-15T10:00:30.000Z",
                kind: "simulation",
                simulation_id: "sim_1",
                test_name: "Reschedules a booked appointment",
                persona_name: "Impatient Rita",
                status: "completed",
                verdict: "failed",
                reason: "persona_concluded",
              },
            ],
            next: 1,
            done: false,
          },
        },
        NO_EVENTS,
      ],
    });
    render(<RunDetailPage />);

    // It starts as the read described it…
    await screen.findAllByText("running");
    // …and the feed moves it, with no second read of the run.
    await screen.findAllByText("failed");
    await waitFor(() => {
      expect(sentWith("/api/runs/run_1", "GET").length).toBeGreaterThanOrEqual(1);
    });
    expect(readsOf("/api/runs/run_1")).toHaveLength(1);
  });

  it("offers a viewer no Cancel and no Retry, and still lets them read everything", async () => {
    detail({ role: "viewer" });
    render(<RunDetailPage />);

    // **Wait for the read that would supply the controls** before asserting
    // they are absent. Asserting the absence first would pass because nothing
    // had rendered yet, and would keep passing after the rule was deleted.
    await screen.findByRole("heading", { name: "Nightly smoke" });
    await screen.findByText("Expected behaviors");

    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(sentWith("/api/runs/run_1/retry", "POST")).toEqual([]);
    expect(sentWith("/api/runs/run_1/cancel", "POST")).toEqual([]);

    // Everything else on the page is theirs: the progress, the pins, the
    // identities, and the sentence saying what a Retry would do.
    await screen.findAllByText(/prsv_7/u);
    await screen.findByText(/not an exact replay of the original conditions/u);
    await screen.findByText(/cannot start or stop runs/u);
  });

  it("shows the pins a conversation actually executed", async () => {
    detail();
    render(<RunDetailPage />);

    const pinned = await screen.findAllByText(/tstv_1 · prsv_7/u);
    expect(pinned.length).toBeGreaterThan(0);
  });

  it("offers no Cancel for a run that has already finished", async () => {
    detail();
    render(<RunDetailPage />);

    const cancel = await screen.findByRole("button", { name: "Cancel run" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText(/already finished/u);
  });

  it("cancels an active run, and never reports it completed afterwards", async () => {
    const stopped = runDetail({
      status: "canceled",
      finished_at: "2026-08-15T10:00:30.000Z",
      expected_simulation_count: 1,
      simulation_counts: { ...NO_SIMULATIONS, canceled: 1 },
      gradable_count: 0,
      graded_count: 0,
      verdict: "skipped",
      simulations: [
        simulationRow({
          status: "canceled",
          grading: "not_required",
          verdict: "skipped",
          counts: null,
          score: null,
        }),
      ],
    });
    detail({
      // The page reads the run again after the cancel lands, so the second
      // answer is the run as the cancel left it.
      run: [
        runDetail({
          status: "running",
          finished_at: null,
          expected_simulation_count: 1,
          simulation_counts: { ...NO_SIMULATIONS, running: 1 },
          gradable_count: 0,
          graded_count: 0,
          verdict: null,
          simulations: [
            simulationRow({
              status: "running",
              grading: "waiting",
              verdict: null,
              counts: null,
              score: null,
            }),
          ],
        }),
        stopped,
      ],
      /*
       * **A feed that is not finished**, and that matters here.
       * `done: true` is the server saying the run has ended, and the page
       * answers it by reading the run again — which would consume the second
       * answer above before anybody pressed anything, and leave this test
       * clicking a control that had already become inert. One run in five.
       */
      events: { status: 200, body: { events: [], next: 0, done: false } },
      cancel: { status: 200, body: stopped },
    });
    render(<RunDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    // Wait for the dialog itself before reaching for its control: the header
    // carries a button of the same name, so taking "the last one" before the
    // dialog has rendered would press the header again and send nothing.
    await screen.findByRole("dialog", { name: "Cancel this run?" });
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Cancel run" })).at(-1)!,
    );

    await waitFor(() => {
      expect(sentWith("/api/runs/run_1/cancel", "POST")).toHaveLength(1);
    });
    await screen.findByText(/This run was canceled/u);
    // Stopping early never reads as a suite that went green.
    expect(screen.queryAllByText("completed")).toEqual([]);
    expect(screen.queryAllByText("passed")).toEqual([]);
  });

  it("says Retry is not a replay before it starts one, and carries one key", async () => {
    detail();
    render(<RunDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    // The page carries the same sentence, so the one inside the confirmation is
    // asked for by the dialog it belongs to rather than by text alone.
    const asking = await screen.findByRole("dialog", { name: "Retry this run?" });
    expect(asking.textContent).toContain(
      "not an exact replay of the original conditions",
    );

    fireEvent.click(await screen.findByRole("button", { name: "Start the retry" }));
    await waitFor(() => {
      expect(sentWith("/api/runs/run_1/retry", "POST")).toHaveLength(1);
    });
    const [asked] = sentWith("/api/runs/run_1/retry", "POST");
    /*
     * **The key is derived from the run, not minted fresh on every press.** A
     * non-empty assertion passes for a per-press random key, which is exactly
     * the failure the idempotency fix was written about: two presses on a slow
     * answer would become two runs against a real agent. So the key is asserted
     * by value, against the one function that decides it.
     */
    expect(asked?.body?.idempotency_key).toBe(retryKeyFor("run_1"));
    expect(retryKeyFor("run_1")).toBe(retryKeyFor("run_1"));
    // The new run is where somebody lands, and the old one is not touched.
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/runs/run_9");
  });

  it("shows a refused Retry's own sentence and the way back to the builder", async () => {
    detail({
      retry: {
        status: 409,
        body: {
          error: "retry_unavailable",
          message:
            "Run run_1 cannot be retried because connection con_1 is not active or no longer applies. Open the run builder and choose active resources; the original run was not changed.",
        },
      },
    });
    render(<RunDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start the retry" }));

    await screen.findByText(/connection con_1 is not active or no longer applies/u);
    const back = await screen.findByRole("link", { name: "Open the run builder" });
    expect(back.getAttribute("href")).toBe("/projects/prj_1/runs/new");
    // Nothing was started, so nothing navigated.
    expect(routed.push).not.toHaveBeenCalled();
  });

  /**
   * Opening a different run in the same page: two clears, and each survives the
   * other's fix. The feed's accumulation belongs to the run it was read for, and
   * so does a pending refusal.
   */
  it("drops a refused Retry when a different run is opened", async () => {
    detail({
      retry: {
        status: 409,
        body: {
          error: "retry_unavailable",
          message: "Run run_1 cannot be retried because agent agt_1 is not active.",
        },
      },
    });
    const view = render(<RunDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start the retry" }));
    // Wait for the refusal to be on screen before switching, so the assertion
    // below is about the clearing rather than about the timing.
    await screen.findByText(/agent agt_1 is not active/u);

    routed.params = { projectId: "prj_1", runId: "run_2" };
    view.rerender(<RunDetailPage />);

    // Wait for the read that draws the other run before asserting an absence,
    // so this cannot pass because nothing had rendered yet.
    await screen.findByRole("heading", { name: "Second" });
    await waitFor(() => {
      expect(screen.queryByText(/agent agt_1 is not active/u)).toBeNull();
    });
  });

  it("drops what one run's feed moved when a different run is opened", async () => {
    detail({
      run: runDetail({
        status: "running",
        finished_at: null,
        expected_simulation_count: 1,
        simulation_counts: { ...NO_SIMULATIONS, running: 1 },
        gradable_count: 0,
        graded_count: 0,
        verdict: null,
        simulations: [
          simulationRow({
            status: "running",
            grading: "waiting",
            verdict: null,
            counts: null,
            score: null,
          }),
        ],
      }),
      events: [
        {
          status: 200,
          body: {
            events: [
              {
                seq: 1,
                at: "2026-08-15T10:00:30.000Z",
                kind: "simulation",
                simulation_id: "sim_1",
                test_name: "Reschedules a booked appointment",
                persona_name: "Impatient Rita",
                status: "failed",
                verdict: "errored",
                reason: "not_answered",
              },
            ],
            next: 1,
            done: false,
          },
        },
        NO_EVENTS,
      ],
      // The second run holds a conversation of the same id, which is exactly how
      // a leaked feed would be invisible: it would draw the first run's landing
      // under the second run's row.
      secondRun: runDetail({
        id: "run_2",
        label: "Second",
        simulations: [simulationRow()],
      }),
    });
    const view = render(<RunDetailPage />);

    await screen.findAllByText("errored");

    routed.params = { projectId: "prj_1", runId: "run_2" };
    view.rerender(<RunDetailPage />);

    await screen.findByRole("heading", { name: "Second" });
    await waitFor(() => {
      expect(screen.queryAllByText("errored")).toEqual([]);
    });
    expect((await screen.findAllByText("passed")).length).toBeGreaterThan(0);
  });
});
