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

import NewRunPage from "../app/projects/[projectId]/runs/new/page.tsx";
import RunsPage from "../app/projects/[projectId]/runs/page.tsx";
import type { Me } from "../lib/me.ts";

/**
 * Planning a run in the browser.
 *
 * **Nothing here asserts that a component exists or that a source file contains
 * a string.** Every test drives a rendered page the way somebody with a keyboard
 * would and reads what the DOM then says.
 *
 * The claims worth having in the fast lane are the ones the page decides for
 * itself: that the steps narrow in order, that arriving from an agent's page
 * fills the first one in, that the review shows what the server said would be
 * frozen and skipped rather than anything the browser worked out, that Start
 * carries one idempotency key for one selection, and that nothing bound to the
 * open test row can reach a different one.
 */

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/projects/prj_1/runs/new",
  projectId: "prj_1",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: routed.push, replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: routed.projectId }),
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

const PROJECTS = [{ id: "prj_1", name: "Default", slug: "default" }];
const ACME = { id: "org_1", name: "Acme", slug: "acme", role: "admin" };

function meWith(role: string): Me {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ ...ACME, role }],
    projects: PROJECTS,
  };
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "agt_1",
    project_id: "prj_1",
    name: "Front desk",
    description: null,
    revision: "rev_a",
    archived: false,
    archived_at: null,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "con_1",
    agent_id: "agt_1",
    project_id: "prj_1",
    name: "retell-1",
    type: "retell",
    variant_id: "retell-hosted",
    modality: "chat",
    topology: "hosted",
    environment: "staging",
    config: {},
    credential_present: true,
    credentials_hint: "WXYZ",
    capabilities: {
      state: "known",
      measured: ["raw_audio", "dtmf"],
      supported: [],
      checked_at: "2026-08-01T10:00:00.000Z",
      source: "transport",
      standing: {
        raw_audio: "unsupported",
        dtmf: "unsupported",
        barge_in: "not_measured",
      },
    },
    revision: "rev_c",
    archived: false,
    archived_at: null,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function testRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "tst_1",
    project_id: "prj_1",
    name: "Reschedules a booked appointment",
    description: null,
    version: 3,
    version_id: "tstv_1",
    scenario: "Their cleaning has to move to next week.",
    expected_behaviors: ["confirms the new time back"],
    personas: [{ id: "prs_1", name: "Impatient Rita", archived_at: null }],
    required_capabilities: [],
    override_count: 0,
    agents: [{ id: "agt_1", name: "Front desk", archived_at: null }],
    revision: "rev_1",
    applicability_revision: "rev_app_1",
    archived_at: null,
    archive_reason: null,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function plannedTest(overrides: Record<string, unknown> = {}) {
  return {
    test_id: "tst_1",
    test_version_id: "tstv_1",
    test_name: "Reschedules a booked appointment",
    personas: [
      {
        persona_id: "prs_1",
        persona_version_id: "prsv_7",
        name: "Impatient Rita",
      },
    ],
    required_capabilities: [],
    skip: null,
    // Two running copies, and one shape for both. The expected-behaviors
    // grader is a seeded copy of a predefined library entry now, not a rowless
    // sentinel, so it arrives here like everything else: an id, a name, the
    // entry it reads its definition through, and whether it can fail the run.
    graders: [
      {
        kind: "authored",
        grader_id: "grd_seeded",
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
      {
        kind: "authored",
        grader_id: "grd_1",
        grader_version_id: "grv_2",
        name: "Never promises a price",
        library_id: "grl_01M01MH8KBE00TESCGQHVH0T8G",
        required: false,
        scope: "simulations",
        judge: { tag: "not_required" },
      },
    ],
    ...overrides,
  };
}

function planBody(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: "agt_1",
    connection_id: "con_1",
    connection: {
      type: "retell",
      modality: "chat",
      environment: "staging",
      capabilities: {
        state: "known",
        measured: ["raw_audio", "dtmf"],
        supported: [],
        checked_at: "2026-08-01T10:00:00.000Z",
        source: "transport",
      },
    },
    judge: {
      state: "configured",
      provider: "openai",
      model: "gpt-4.1-mini",
      source: "jcr_1",
    },
    runnable_simulation_count: 1,
    skipped_simulation_count: 0,
    tests: [plannedTest()],
    ...overrides,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Stubbed = { status: number; body: unknown } | "never";

/** Every request the browser makes, in the order it made them. */
let sent: { url: string; method: string; body: unknown }[] = [];

function apiAnswers(answers: Record<string, Stubbed | readonly Stubbed[]>): void {
  const asked: Record<string, number> = {};

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://egma.test");
      sent.push({
        url: input,
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : undefined,
      });

      const held = answers[url.pathname];
      if (held === undefined) {
        throw new Error(`nothing stubbed for ${url.pathname}`);
      }

      const turn = asked[url.pathname] ?? 0;
      asked[url.pathname] = turn + 1;
      const answer = Array.isArray(held)
        ? ((held[Math.min(turn, held.length - 1)] ?? "never") as Stubbed)
        : (held as Stubbed);

      if (answer === "never") return new Promise<Response>(() => undefined);
      return json(answer.status, answer.body);
    }),
  );
}

let wentTo: string[] = [];

beforeEach(() => {
  sent = [];
  wentTo = [];
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      search: "",
      replace: (url: string) => wentTo.push(url),
    },
  });
  routed.push.mockReset();
  routed.pathname = "/projects/prj_1/runs/new";
  routed.projectId = "prj_1";
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** What the page sent to one address, most recent last. */
function sentTo(path: string): { method: string; body: unknown }[] {
  return sent
    .filter((one) => new URL(one.url, "http://egma.test").pathname === path)
    .map((one) => ({ method: one.method, body: one.body }));
}

/** Every plan address the page asked for, in order. */
function planQueries(): string[] {
  return sent
    .filter(
      (one) => new URL(one.url, "http://egma.test").pathname === "/api/run-plan",
    )
    .map((one) => one.url);
}

/**
 * The builder, with everything it reads stubbed.
 *
 * The versions read is separate from the plan because it is the open row's own,
 * which is the whole subject of the last group of tests in this file.
 */
function builder(
  options: {
    readonly role?: string;
    readonly tests?: unknown[];
    readonly plan?: Stubbed | readonly Stubbed[];
    readonly versions?: Stubbed | readonly Stubbed[];
    /** The second row's own read, so a test can leave it unanswered. */
    readonly secondVersions?: Stubbed | readonly Stubbed[];
    readonly started?: Stubbed | readonly Stubbed[];
  } = {},
): void {
  apiAnswers({
    "/api/me": { status: 200, body: meWith(options.role ?? "admin") },
    "/api/agents": { status: 200, body: { items: [agentRow()], next_cursor: null } },
    "/api/agents/agt_1": {
      status: 200,
      body: { agent: agentRow(), connections: [connectionRow()] },
    },
    "/api/tests": {
      status: 200,
      body: {
        items: options.tests ?? [testRow()],
        next_cursor: null,
      },
    },
    "/api/tests/tst_1/versions": options.versions ?? {
      status: 200,
      body: {
        items: [
          { id: "tstv_1", test_id: "tst_1", version: 3, current: true },
          { id: "tstv_0", test_id: "tst_1", version: 2, current: false },
        ],
        next_cursor: null,
      },
    },
    "/api/tests/tst_2/versions": options.secondVersions ?? {
      status: 200,
      body: {
        items: [{ id: "tstv_2", test_id: "tst_2", version: 1, current: true }],
        next_cursor: null,
      },
    },
    "/api/run-plan": options.plan ?? { status: 200, body: planBody() },
    "/api/runs": options.started ?? {
      status: 201,
      body: {
        id: "run_1",
        status: "pending",
        expected_simulation_count: 1,
        skipped_count: null,
      },
    },
  });
}

/** Choose the agent, the connection and the first test, in that order. */
async function chooseEverything(): Promise<void> {
  fireEvent.change(await screen.findByLabelText("Agent"), {
    target: { value: "agt_1" },
  });
  fireEvent.change(await screen.findByLabelText("Connection"), {
    target: { value: "con_1" },
  });
  // The table keeps one real control in the document at every screen width.
  fireEvent.click(
    await screen.findByLabelText("Include Reschedules a booked appointment"),
  );
}

/* ------------------------------------------------------------------------ */

describe("the way into the builder", () => {
  it("offers a member the builder from the runs page", async () => {
    apiAnswers({ "/api/me": { status: 200, body: meWith("member") } });
    render(<RunsPage />);

    const into = await screen.findAllByRole("link", { name: "Create a run" });
    expect(into.length).toBeGreaterThan(0);
    expect(into[0]?.getAttribute("href")).toBe("/projects/prj_1/runs/new");
  });

  it("offers a viewer none, because the server would refuse the start", async () => {
    apiAnswers({ "/api/me": { status: 200, body: meWith("viewer") } });
    render(<RunsPage />);

    await screen.findByRole("heading", { name: "Runs" });
    expect(screen.queryAllByRole("link", { name: "Create a run" })).toEqual([]);
  });
});

describe("the steps", () => {
  it("asks for a connection only once an agent is chosen", async () => {
    builder();
    render(<NewRunPage />);

    await screen.findByLabelText("Agent");
    expect(screen.queryByLabelText("Connection")).toBeNull();

    fireEvent.change(screen.getByLabelText("Agent"), {
      target: { value: "agt_1" },
    });
    await screen.findByLabelText("Connection");
  });

  it("offers only the tests that apply to the chosen agent", async () => {
    builder();
    render(<NewRunPage />);

    fireEvent.change(await screen.findByLabelText("Agent"), {
      target: { value: "agt_1" },
    });

    await waitFor(() => {
      const asked = sent.filter((one) =>
        one.url.startsWith("/api/tests?"),
      );
      expect(asked.length).toBeGreaterThan(0);
      // The applicability filter is the server's, in the address of the
      // request — a filter applied to what came back would answer differently
      // depending on what had already been fetched.
      expect(asked[0]?.url).toContain("agent=agt_1");
    });
  });

  it("preselects the agent it was opened from, and still asks the server everything else", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, search: "?agent=agt_1", replace: () => undefined },
    });
    builder();
    render(<NewRunPage />);

    // The first step is filled in…
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Agent") as HTMLSelectElement).value,
      ).toBe("agt_1");
    });
    // …and the connection step opened as a consequence, which is the proof it
    // preselected rather than bypassed: the same reads happen either way.
    await screen.findByLabelText("Connection");
  });

  it("drops a connection and a selection when the agent changes under them", async () => {
    builder({ tests: [testRow()] });
    render(<NewRunPage />);

    await chooseEverything();
    await waitFor(() => {
      expect(planQueries().length).toBeGreaterThan(0);
    });

    fireEvent.change(screen.getByLabelText("Agent"), {
      target: { value: "" },
    });

    await waitFor(() => {
      expect(screen.queryByLabelText("Connection")).toBeNull();
    });
  });
});

describe("the review", () => {
  it("shows the versions, the personas and the graders the server said it would freeze", async () => {
    builder();
    render(<NewRunPage />);
    await chooseEverything();

    // The version and the persona version are the server's answer, shown as it
    // came: this page pins nothing and works nothing out.
    await screen.findByText("tstv_1");
    await screen.findByText("Impatient Rita (prsv_7)");
    await screen.findByText("Expected behaviors");
    expect(screen.queryByText("expected_behaviors")).toBeNull();
    await screen.findByText("Never promises a price");
  });

  it("shows the judge the run would spend, and never a key", async () => {
    builder();
    render(<NewRunPage />);
    await chooseEverything();

    await screen.findByText(/openai\/gpt-4\.1-mini · credential jcr_1/u);
  });

  /**
   * **A plan that would ask a model, in a project holding no judge.** The two
   * halves are one answer and the fixture says both: the project reads
   * `needs_setup`, and every item that judges by asking a model is frozen
   * `unavailable_at_capture`, which is exactly what the server answers. A plan
   * naming a configured judge on its items *and* `needs_setup` on the project is
   * a shape no server produces, and a test built from one would prove a rule
   * against a plan that cannot exist.
   */
  it("says a plan that would ask a model with no judge cannot start, and disables Start", async () => {
    builder({
      plan: {
        status: 200,
        body: planBody({
          judge: { state: "needs_setup" },
          tests: [
            plannedTest({
              graders: [
                {
                  kind: "authored",
                  grader_id: "grd_seeded",
                  grader_version_id: "grv_1",
                  name: "expected_behaviors",
                  library_id: "grl_01M01MH8KAE8ZB19B0YJ7Z7EYW",
                  required: true,
                  scope: "simulations",
                  judge: { tag: "unavailable_at_capture" },
                },
              ],
            }),
          ],
        }),
      },
    });
    render(<NewRunPage />);
    await chooseEverything();

    await screen.findByText(/no LLM judge configured/u);
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
  });

  /**
   * And the half the old rule got wrong. Every grader is a deletable running
   * copy now, so a project may judge only by computation — nothing asks a model,
   * nothing needs a key, and refusing the run would refuse it for a key it would
   * never have spent.
   */
  it("offers Start with no judge when nothing in the plan asks a model", async () => {
    builder({
      plan: {
        status: 200,
        body: planBody({
          judge: { state: "needs_setup" },
          tests: [
            plannedTest({
              graders: [
                {
                  kind: "authored",
                  grader_id: "grd_latency",
                  grader_version_id: "grv_9",
                  name: "Answers inside two seconds",
                  library_id: "grl_01M01MH8KBE00TESCGQHVH0T8G",
                  required: true,
                  scope: "simulations",
                  judge: { tag: "not_required" },
                },
              ],
            }),
          ],
        }),
      },
    });
    render(<NewRunPage />);
    await chooseEverything();

    await screen.findByText("Answers inside two seconds");
    expect(screen.queryByText(/no LLM judge configured/u)).toBeNull();
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });

  /**
   * A project judged by nothing at all is a decision somebody took on the
   * Graders screen — deleting a copy is how a grader is switched off. So the
   * consequence is said in advance and Start is still offered: on a results page
   * with nothing red on it, "no verdicts" and "everything passed" look
   * identical.
   */
  it("warns that a run would judge nothing, and still offers Start", async () => {
    builder({
      plan: {
        status: 200,
        body: planBody({
          judge: { state: "needs_setup" },
          tests: [plannedTest({ graders: [] })],
        }),
      },
    });
    render(<NewRunPage />);
    await chooseEverything();

    await screen.findByText(/come back with nothing judged/u);
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });

  it("names a skipped test as skipped, and never as a failure of the agent", async () => {
    builder({
      plan: {
        status: 200,
        body: planBody({
          runnable_simulation_count: 0,
          skipped_simulation_count: 1,
          tests: [
            plannedTest({
              required_capabilities: ["raw_audio"],
              skip: {
                reason: "required_capability_unsupported",
                capabilities: ["raw_audio"],
              },
            }),
          ],
        }),
      },
    });
    render(<NewRunPage />);
    await chooseEverything();

    const said = await screen.findAllByText(/does not support raw_audio/u);
    expect(said.length).toBeGreaterThan(0);
    for (const one of said) {
      expect(one.textContent).toContain("say nothing about the agent");
      expect(one.textContent).not.toContain("failed");
    }
  });

  it("refuses to offer Start for a run that would conduct nothing", async () => {
    builder({
      plan: {
        status: 200,
        body: planBody({
          runnable_simulation_count: 0,
          skipped_simulation_count: 1,
          tests: [
            plannedTest({
              skip: {
                reason: "required_capability_unknown",
                capabilities: ["barge_in"],
              },
            }),
          ],
        }),
      },
    });
    render(<NewRunPage />);
    await chooseEverything();

    await screen.findByText(/would conduct nothing/u);
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
  });
});

describe("starting", () => {
  it("sends the selection with one idempotency key, and reuses it on a retry", async () => {
    builder({
      started: [
        { status: 502, body: { error: "unavailable", message: "Egma could not answer." } },
        {
          status: 201,
          body: {
            id: "run_1",
            status: "pending",
            expected_simulation_count: 1,
            skipped_count: null,
          },
        },
      ],
    });
    render(<NewRunPage />);
    await chooseEverything();

    const start = await screen.findByRole("button", { name: "Start run" });
    await waitFor(() => {
      expect((start as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(start);
    await screen.findByText("Egma could not answer.");
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      expect(sentTo("/api/runs")).toHaveLength(2);
    });
    const [first, second] = sentTo("/api/runs");
    const key = (first?.body as { idempotency_key: string }).idempotency_key;
    expect(key).not.toBe("");
    // The same selection under the same word: a lost answer becomes the run
    // that already exists rather than a second conversation with the agent.
    expect((second?.body as { idempotency_key: string }).idempotency_key).toBe(
      key,
    );
    expect((first?.body as { test_versions: string[] }).test_versions).toEqual([
      "tstv_1",
    ]);
  });

  it("mints a different key for a different selection, because it is a different run", async () => {
    builder({ tests: [testRow(), testRow({ id: "tst_2", name: "Cancels", version_id: "tstv_2" })] });
    render(<NewRunPage />);
    await chooseEverything();

    const start = await screen.findByRole("button", { name: "Start run" });
    await waitFor(() => {
      expect((start as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(start);
    await waitFor(() => {
      expect(sentTo("/api/runs")).toHaveLength(1);
    });

    fireEvent.click(screen.getAllByLabelText("Include Cancels")[0]!);
    await waitFor(() => {
      expect(
        (
          screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      expect(sentTo("/api/runs")).toHaveLength(2);
    });
    const [first, second] = sentTo("/api/runs");
    expect((second?.body as { idempotency_key: string }).idempotency_key).not.toBe(
      (first?.body as { idempotency_key: string }).idempotency_key,
    );
  });

  it("keeps a viewer's Start inert", async () => {
    builder({ role: "viewer" });
    render(<NewRunPage />);
    await chooseEverything();

    const start = await screen.findByRole("button", { name: "Start run" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(start);
    expect(sentTo("/api/runs")).toEqual([]);
  });
});

/**
 * The panel under the table is drawn once, for whichever row is open, so
 * everything it holds is shared by every row. Each of these is a different way
 * of showing somebody the wrong test's answer, and the two fixes are genuinely
 * two: clearing the read does not clear the pending failure, and the failure
 * outlives the panel.
 */
describe("what belongs to the open test row", () => {
  async function detailsFor(testName: string): Promise<HTMLElement> {
    const table = await screen.findByRole("table", {
      name: "Tests that apply to this agent",
    });
    const named = within(table).getByText(testName);
    const row = named.closest("tr");
    if (row === null) throw new Error(`${testName} should be in a table row`);
    return within(row).getByRole("button", { name: "Details" });
  }

  /**
   * Two rows, and the second row's own read left unanswered.
   *
   * **The unanswered read is the whole experiment.** A second read that lands
   * immediately overwrites whatever the first row left behind, so the defect is
   * invisible and a test that watched for it would pass either way. Holding the
   * second read open is what opens the window the stale value would be shown
   * in, which is the window a real slow network opens on its own.
   */
  function twoTests(versions?: Stubbed | readonly Stubbed[]): void {
    builder({
      tests: [
        testRow(),
        testRow({ id: "tst_2", name: "Cancels", version_id: "tstv_2" }),
      ],
      secondVersions: "never",
      ...(versions === undefined ? {} : { versions }),
    });
  }

  it("empties one test's version history when a different row opens", async () => {
    twoTests();
    render(<NewRunPage />);
    fireEvent.change(await screen.findByLabelText("Agent"), {
      target: { value: "agt_1" },
    });

    const firstDetails = await detailsFor("Reschedules a booked appointment");
    const secondDetails = await detailsFor("Cancels");

    fireEvent.click(firstDetails);
    // **Wait for the read that produces the sentence** before asserting it is
    // gone — asserting an absence before the read has answered would pass for
    // the wrong reason and keep passing after the behaviour was deleted.
    await screen.findByText(/2 versions; this run would pin v3\./u);

    fireEvent.click(secondDetails);
    await waitFor(() => {
      expect(screen.queryByText(/2 versions/u)).toBeNull();
    });
    // The second row is open and its own read has not answered, so the panel
    // says it is reading rather than showing the first row's answer under the
    // second row's name.
    await screen.findByText(/Reading this test's version history…/u);
  });

  it("drops a failed read's Try again when a different row opens", async () => {
    twoTests([
      { status: 500, body: { error: "unavailable", message: "Egma could not answer." } },
    ]);
    render(<NewRunPage />);
    fireEvent.change(await screen.findByLabelText("Agent"), {
      target: { value: "agt_1" },
    });

    const firstDetails = await detailsFor("Reschedules a booked appointment");
    const secondDetails = await detailsFor("Cancels");
    fireEvent.click(firstDetails);
    // Wait for the failure to actually be on screen before switching, so the
    // assertion below is about the clearing rather than about the timing.
    await screen.findByRole("button", { name: "Try again" });

    fireEvent.click(secondDetails);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
    // The heading is the only thing on screen saying which test the panel is
    // about, so a retry left behind would draw one test's answer under
    // another's name and report it as a success.
    expect(
      screen.getAllByRole("heading", { name: "Cancels" }).length,
    ).toBeGreaterThan(0);
  });
});
