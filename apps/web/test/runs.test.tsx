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
 * fills the first one in, that tests stay compact and selectable, that a run
 * needs a name and a confirmation, and that Start carries one idempotency key
 * for one selection.
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
    agent_platform: "retell",
    connection_kind: "retell_chat_api",
    access_variant: "retell_chat_api.api_key",
    modality: "chat",
    product_label: "Retell chat",
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
      },
      {
        kind: "authored",
        grader_id: "grd_1",
        grader_version_id: "grv_2",
        name: "Never promises a price",
        library_id: "grl_01M01MH8KBE00TESCGQHVH0T8G",
        required: false,
        scope: "simulations",
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
      agent_platform: "retell",
      connection_kind: "retell_chat_api",
      access_variant: "retell_chat_api.api_key",
      modality: "chat",
      product_label: "Retell chat",
      environment: "staging",
      capabilities: {
        state: "known",
        measured: ["raw_audio", "dtmf"],
        supported: [],
        checked_at: "2026-08-01T10:00:00.000Z",
        source: "transport",
      },
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

/** The builder, with everything it reads stubbed. */
function builder(
  options: {
    readonly role?: string;
    readonly tests?: unknown[];
    readonly plan?: Stubbed | readonly Stubbed[];
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

/** Give the selected run the required name. */
function nameRun(name = "Morning check"): void {
  fireEvent.change(screen.getByLabelText("Run name"), {
    target: { value: name },
  });
}

/** Open the confirmation and accept it. */
async function confirmStart(count = 1): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Start run" }));
  const dialog = await screen.findByRole("dialog", { name: "Start this run?" });
  expect(
    within(dialog).getByText(
      `${String(count)} ${count === 1 ? "simulation" : "simulations"} will be conducted.`,
    ),
  ).toBeDefined();
  fireEvent.click(within(dialog).getByRole("button", { name: "Start run" }));
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

    await screen.findByRole("heading", { name: "Simulation runs" });
    expect(screen.queryAllByRole("link", { name: "Create a run" })).toEqual([]);
  });
});

describe("the steps", () => {
  it("keeps the three setup steps in one named order", async () => {
    builder();
    render(<NewRunPage />);

    expect(
      await screen.findByText(
        "Choose one agent, one connection and the tests to run.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/Every simulation it produces/u)).toBeNull();

    const setup = await screen.findByRole("list", { name: "Run setup" });
    const steps = within(setup).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    const names = ["Agent", "Connection", "Tests"];
    for (const [index, step] of steps.entries()) {
      const name = names[index]!;
      const region = within(step).getByRole("region", {
        name: `Step ${String(index + 1)} of 3: ${name}`,
      });
      const header = region.querySelector("header");
      expect(header).not.toBeNull();
      expect(header?.children[0]?.textContent).toBe(String(index + 1));
      expect(
        within(header as HTMLElement).getByRole("heading", { name }),
      ).toBeDefined();
    }
    expect(within(steps[0]!).getByText("Select the agent under test.")).toBeDefined();
    expect(within(steps[1]!).getByText("Select how Egma reaches the agent.")).toBeDefined();
    expect(within(steps[2]!).getByText("Select the tests to run.")).toBeDefined();
    expect(document.querySelector('label[for="run-agent"]')).toBeNull();
    expect(screen.queryByText(/Needs selection|Complete/u)).toBeNull();
  });

  it("asks for a connection only once an agent is chosen", async () => {
    builder();
    render(<NewRunPage />);

    await screen.findByLabelText("Agent");
    expect(screen.queryByLabelText("Connection")).toBeNull();

    fireEvent.change(screen.getByLabelText("Agent"), {
      target: { value: "agt_1" },
    });
    await screen.findByLabelText("Connection");
    expect(document.querySelector('label[for="run-connection"]')).toBeNull();
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

describe("the server-owned run plan", () => {
  it("keeps plan details and planned counts out of the builder", async () => {
    builder();
    render(<NewRunPage />);
    await chooseEverything();

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    expect(screen.queryByText("Plan details")).toBeNull();
    expect(screen.queryByText("tstv_1")).toBeNull();
    expect(screen.queryByText("prsv_7")).toBeNull();
    expect(screen.queryByText("simulations planned")).toBeNull();
    expect(screen.queryByText("would be conducted")).toBeNull();
    expect(screen.queryByText("would be skipped, not failed")).toBeNull();
  });

  it("keeps connection and capability facts out of the builder", async () => {
    builder({
      tests: [testRow({ required_capabilities: ["raw_audio"] })],
    });
    render(<NewRunPage />);
    await chooseEverything();

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    expect(screen.queryByText(/measured raw_audio/u)).toBeNull();
    expect(screen.queryByText(/^Capabilities$/u)).toBeNull();
    expect(screen.queryByText("Impatient Rita")).toBeNull();
    expect(screen.queryByText(/Version 3/u)).toBeNull();
    expect(screen.queryByText(/Requires raw_audio/u)).toBeNull();
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

  it("does not add a skipped-test summary to the builder", async () => {
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

    await screen.findByText(/would conduct nothing/u);
    expect(screen.queryByText(/does not support raw_audio/u)).toBeNull();
    expect(screen.queryByText("would be skipped, not failed")).toBeNull();
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
  it("shows the phone setup refusal and keeps every selected item", async () => {
    const phoneSetup =
      "this Egma instance has not been set up to place phone calls, so nothing was dialed and nothing was charged. It is missing the carrier trunk. Whoever runs this platform makes it ready with one command in the platform workspace: egma self-host setup.";
    builder({
      started: {
        status: 409,
        body: { error: "phone_setup_required", message: phoneSetup },
      },
    });
    render(<NewRunPage />);
    await chooseEverything();

    await screen.findByRole("button", { name: "Start run" });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    expect(await screen.findByText("Enter a run name.")).toBeDefined();
    expect(sentTo("/api/runs")).toEqual([]);
    expect(screen.queryByRole("dialog", { name: "Start this run?" })).toBeNull();

    nameRun("Phone check");
    await confirmStart();

    expect(await screen.findByText(phoneSetup)).toBeDefined();
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe(
      "agt_1",
    );
    expect(
      (screen.getByLabelText("Connection") as HTMLSelectElement).value,
    ).toBe("con_1");
    expect(
      (
        screen.getByLabelText(
          "Include Reschedules a booked appointment",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("reuses one key for a retry and mints another when the run name changes", async () => {
    builder({
      started: [
        { status: 502, body: { error: "unavailable", message: "Egma could not answer." } },
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

    await screen.findByRole("button", { name: "Start run" });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    nameRun();
    await confirmStart();
    await screen.findByText("Egma could not answer.");
    await confirmStart();

    await waitFor(() => {
      expect(sentTo("/api/runs")).toHaveLength(2);
    });
    nameRun("Evening check");
    await confirmStart();
    await waitFor(() => {
      expect(sentTo("/api/runs")).toHaveLength(3);
    });

    const [first, second, renamed] = sentTo("/api/runs");
    const key = (first?.body as { idempotency_key: string }).idempotency_key;
    expect(key).not.toBe("");
    expect((first?.body as { label: string }).label).toBe("Morning check");
    // The same selection under the same word: a lost answer becomes the run
    // that already exists rather than a second conversation with the agent.
    expect((second?.body as { idempotency_key: string }).idempotency_key).toBe(
      key,
    );
    expect(
      (renamed?.body as { idempotency_key: string }).idempotency_key,
    ).not.toBe(key);
    expect((renamed?.body as { label: string }).label).toBe("Evening check");
    expect((first?.body as { test_versions: string[] }).test_versions).toEqual([
      "tstv_1",
    ]);
  });

  it("starts the same selection as a new run from a fresh builder", async () => {
    builder({
      started: [
        {
          status: 201,
          body: {
            id: "run_1",
            status: "pending",
            expected_simulation_count: 1,
            skipped_count: null,
          },
        },
        {
          status: 201,
          body: {
            id: "run_2",
            status: "pending",
            expected_simulation_count: 1,
            skipped_count: null,
          },
        },
      ],
    });

    const firstBuilder = render(<NewRunPage />);
    await chooseEverything();
    nameRun("First run");
    await screen.findByRole("button", { name: "Start run" });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await confirmStart();
    await waitFor(() => expect(sentTo("/api/runs")).toHaveLength(1));
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/runs/run_1");
    expect(
      screen.getByRole("button", { name: "Starting…" }).getAttribute("aria-busy"),
    ).toBe("true");
    const firstKey = (
      sentTo("/api/runs")[0]?.body as { idempotency_key: string }
    ).idempotency_key;

    firstBuilder.unmount();
    render(<NewRunPage />);
    await chooseEverything();
    nameRun("Second run");
    await screen.findByRole("button", { name: "Start run" });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await confirmStart();
    await waitFor(() => expect(sentTo("/api/runs")).toHaveLength(2));
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/runs/run_2");
    const secondKey = (
      sentTo("/api/runs")[1]?.body as { idempotency_key: string }
    ).idempotency_key;

    expect(secondKey).not.toBe(firstKey);
  });

  it("mints a different key for a different selection, because it is a different run", async () => {
    builder({
      tests: [
        testRow(),
        testRow({ id: "tst_2", name: "Cancels", version_id: "tstv_2" }),
      ],
      started: [
        {
          status: 502,
          body: { error: "unavailable", message: "Egma could not answer." },
        },
        {
          status: 201,
          body: {
            id: "run_1",
            status: "pending",
            expected_simulation_count: 2,
            skipped_count: null,
          },
        },
      ],
    });
    render(<NewRunPage />);
    await chooseEverything();
    nameRun();

    await screen.findByRole("button", { name: "Start run" });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    await confirmStart();
    await waitFor(() => {
      expect(sentTo("/api/runs")).toHaveLength(1);
    });
    await screen.findByText("Egma could not answer.");

    fireEvent.click(screen.getAllByLabelText("Include Cancels")[0]!);
    await waitFor(() => {
      expect(
        (
          screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    await confirmStart();

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

describe("test selection", () => {
  function twoTests(): void {
    builder({
      tests: [
        testRow(),
        testRow({ id: "tst_2", name: "Cancels", version_id: "tstv_2" }),
      ],
    });
  }

  it("selects every test and clears every test", async () => {
    twoTests();
    render(<NewRunPage />);
    fireEvent.change(await screen.findByLabelText("Agent"), {
      target: { value: "agt_1" },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Select all" }));
    expect(
      (screen.getByLabelText("Include Reschedules a booked appointment") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect((screen.getByLabelText("Include Cancels") as HTMLInputElement).checked).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(
      (screen.getByLabelText("Include Reschedules a booked appointment") as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect((screen.getByLabelText("Include Cancels") as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("shows every test in one compact list without a details table", async () => {
    twoTests();
    render(<NewRunPage />);
    fireEvent.change(await screen.findByLabelText("Agent"), {
      target: { value: "agt_1" },
    });

    const list = await screen.findByRole("list", {
      name: "Tests that apply to this agent",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Reschedules a booked appointment")).toBeDefined();
    expect(within(list).getByText("Cancels")).toBeDefined();
    expect(within(list).queryByText(/Impatient Rita · Version 3/u)).toBeNull();
    expect(screen.queryByRole("table", { name: "Tests that apply to this agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });
});
