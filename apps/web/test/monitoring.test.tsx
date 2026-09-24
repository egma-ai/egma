// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MonitoringTranscriptsPage from "../app/projects/[projectId]/monitoring/transcripts/page.tsx";
import type { Me } from "../lib/me.ts";
import { LIST, QUIET } from "../lib/transcript-copy.ts";
import type { Facts, Listed } from "../lib/transcripts.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/**
 * Drive the Traces page with stubbed reads. Check project and source request
 * parameters, and require each guidance state to exclude the others.
 */

const routed = vi.hoisted(() => ({
  pathname: "/projects/prj_2/monitoring/transcripts",
  projectId: "prj_2",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: routed.projectId }),
  /*
   * Read off the address the test put this page on, which is how the real hook
   * behaves — and it is what makes the picker's query state assertable here:
   * the sheet is open because `?sheet=monitor` is in the address, and for no
   * other reason.
   */
  useSearchParams: () => new URLSearchParams(globalThis.location.search),
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

/**
 * Which role the session read answers with.
 *
 * Admin for every case that is not about roles, because that is the reader who
 * sees the whole page. The one case that is about roles says so out loud.
 */
let seenRole: "admin" | "member" | "viewer" = "admin";

function meIs(): Me {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [
      { id: "org_1", name: "Acme", slug: "acme", role: seenRole },
    ],
    projects: [
      { id: "prj_1", name: "Default", slug: "default" },
      { id: "prj_2", name: "Outbound", slug: "outbound" },
    ],
  };
}

const FACTS: Facts = {
  traceId: "5c1e4b0f8d2a4e6b9f0c1d2e3a4b5c6d",
  startedAt: "2026-08-02T18:04:40.281989Z",
  endedAt: "2026-08-02T18:05:53.776865Z",
  durationNs: "73494876403",
  spanCount: 133,
  turnCounts: { human: 5, agent: 8 },
  toolSpanCount: 2,
  erroredSpanCount: 0,
  source: "production",
  pov: "agent",
  environment: "default",
  connectionType: "",
  providerCallId: "egma-fixture-capture-1",
  agentPlatform: "livekit",
  platformAgentId: "",
  platformAgentName: "kelly",
  platformAgentVersion: "",
  runId: "",
  agentId: "",
};

const ONE_ROW: Listed = {
  ...FACTS,
  preview: "I need to move my appointment",
  turnResponseLatencyP90Milliseconds: 4780,
  turnResponseLatencyP90Partial: false,
};

const TRACE_DETAIL = {
  trace: FACTS,
  turns: [],
  spans: [],
  spansTruncated: false,
  metrics: [
    {
      measure: "turn_response_latency",
      unit: "milliseconds",
      derived: true,
      samples: [4200, 4780],
      spanIds: ["spn_1", "spn_2"],
      mean: 4490,
      p50: 4200,
      p90: 4780,
      partial: false,
    },
  ],
  simulationId: null,
  gradingState: "not_requested",
  workBlock: null,
  grades: [],
  gradeHistory: [],
  combinedScore: null,
} as const;

/** A project grader, with or without production in its scope. */
function grader(scope: "simulations" | "both") {
  return {
    id: "grd_1",
    projectId: "prj_2",
    graderDefinitionId: "grl_expected",
    name: "expected_behaviors",
    description: "Grades a completed simulation against its expected behaviors.",
    scopeEditable: false,
    scope: {
      simulations: [{ kind: "all" }],
      production: scope === "both" ? { samplePercent: 100 } : null,
    },
    passThreshold: 1,
    createdAt: "2026-08-01T00:00:00.000000Z",
    updatedAt: "2026-08-01T00:00:00.000000Z",
  };
}

/** A key, either the project's own or one that names the whole organization. */
function key(projectId: string | null) {
  return {
    id: "key_1",
    name: "livekit-agent",
    scope: projectId === null ? "organization" : "project",
    organizationId: "org_1",
    projectId,
    looksLike: "egma_sk_…9f2a",
    createdByUserId: "usr_1",
    createdAt: "2026-08-01T00:00:00.000000Z",
    lastUsedAt: null,
    revokedAt: null,
    createdByEmail: "ada@acme.example",
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Stubbed = { status: number; body: unknown };

/**
 * Whatever egma is standing in for, keyed by path, with every ask recorded.
 *
 * A path may answer with a function instead, which is how one path answers two
 * questions: `/v1/traces` carries both the page of the list and the
 * one-row probe that asks whether anything has ever been recorded.
 */
function apiAnswers(
  answers: Record<string, Stubbed | ((at: URL) => Stubbed)>,
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
      const answer = typeof held === "function" ? held(at) : held;
      return json(answer.status, answer.body);
    }),
  );

  return { asked };
}

const REFUSED = {
  status: 503,
  body: { error: "store_unavailable", message: "Egma could not read that." },
};

function page(rows: readonly Listed[]): Stubbed {
  return {
    status: 200,
    body: { traces: rows, nextPageToken: null },
  };
}

/**
 * Stub rows, wider recent history, graders, and keys independently.
 * everRecorded is the widest-window probe, not all-time history. Refused
 * reads remain unknown instead of becoming zero.
 */
function stub(options: {
  readonly rows?: readonly Listed[];
  readonly everRecorded?: readonly Listed[] | "refused";
  readonly graders?: readonly ReturnType<typeof grader>[] | "refused";
  readonly keys?: readonly ReturnType<typeof key>[] | "refused";
  readonly detail?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}) {
  const rows = options.rows ?? [];
  const ever = options.everRecorded ?? rows;
  const details =
    options.details === undefined
      ? {
          [`/v1/traces/${FACTS.traceId}`]: {
            status: 200,
            body: options.detail ?? TRACE_DETAIL,
          },
        }
      : Object.fromEntries(
          Object.entries(options.details).map(([traceId, detail]) => [
            `/v1/traces/${traceId}`,
            { status: 200, body: detail },
          ]),
        );

  return apiAnswers({
    "/api/me": { status: 200, body: meIs() },
    // One path, two questions. The probe is the one asking for a single row.
    "/v1/traces": (at) =>
      at.searchParams.get("pageSize") === "1"
        ? ever === "refused"
          ? REFUSED
          : page(ever)
        : page(rows),
    ...details,
    "/v1/graders":
      options.graders === "refused"
        ? REFUSED
        : {
            status: 200,
            body: { graders: options.graders ?? [], nextPageToken: null },
          },
    "/v1/keys":
      options.keys === "refused"
        ? REFUSED
        : { status: 200, body: { keys: options.keys ?? [] } },
  });
}

/** Whether the widest-window probe was fired at all. */
function probed(asked: readonly string[]): readonly string[] {
  return asked.filter(
    (one) => one.startsWith("/v1/traces?") && one.includes("pageSize=1"),
  );
}

/**
 * Which window the address this page opens on names.
 *
 * Most cases leave it alone, which is the default and the window a developer
 * who has just signed up actually lands on. It matters to exactly one thing
 * here: at the widest window the page needs no probe, because the list read it
 * just made asked the same question.
 */
function atWindow(choice: string): void {
  globalThis.history.replaceState(null, "", `/?window=${choice}`);
}

/** The default the control settles on when the address names no window. */
function atNoWindow(): void {
  globalThis.history.replaceState(null, "", "/");
}

beforeEach(() => {
  routed.projectId = "prj_2";
  seenRole = "admin";
  routed.pathname = "/projects/prj_2/monitoring/transcripts";
  atNoWindow();
  vi.stubGlobal("scrollTo", vi.fn());
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

describe("what the Monitoring list shows", () => {
  it("marks a P90 taken from a truncated trace as partial", async () => {
    stub({
      rows: [{ ...ONE_ROW, turnResponseLatencyP90Partial: true }],
      detail: {
        ...TRACE_DETAIL,
        spansTruncated: true,
        metrics: TRACE_DETAIL.metrics.map((metric) => ({
          ...metric,
          partial: true,
        })),
      },
    });
    render(<MonitoringTranscriptsPage />);

    const table = await screen.findByRole("table", { name: LIST.tableLabel });
    expect(within(table).getByText("4.78s · partial")).toBeDefined();

    fireEvent.click(
      within(table).getByRole("button", { name: FACTS.traceId }),
    );
    const sheet = await screen.findByRole("dialog", { name: /Trace/u });
    expect(within(sheet).getByText("4.78s · partial")).toBeDefined();
  });

  /**
   * A row leads to the transcript inside this project, carrying the window the
   * exchange happened in — which is what makes one transcript a link somebody
  * can send.
  */
  it("shows the funding action in a pending production trace sheet", async () => {
    stub({ rows: [ONE_ROW], detail: { ...TRACE_DETAIL, gradingState: "pending",
      workBlock: { error: "providers_unfunded", message: "The inference balance is $0.00." },
    } });
    render(<MonitoringTranscriptsPage />);
    const table = await screen.findByRole("table", { name: LIST.tableLabel });
    fireEvent.click(within(table).getByRole("button", { name: FACTS.traceId }));
    const sheet = await screen.findByRole("dialog", { name: /Trace/u });
    expect(await within(sheet).findByText("Grading is waiting. The inference balance is $0.00.")).toBeTruthy();
    expect(within(sheet).getByRole("link", { name: "Add credits" }).getAttribute("href"))
      .toBe("/projects/prj_2/settings/billing");
    expect(within(sheet).getByRole("link", { name: "Manage provider API keys" }).getAttribute("href"))
      .toBe("/projects/prj_2/settings/provider-api-keys");
  });

  it("switches to a different production transcript when that row is pressed", async () => {
    const nextFacts: Facts = {
      ...FACTS,
      traceId: "6d2f5c1a9e3b4f7081a2b3c4d5e6f708",
      startedAt: "2026-08-02T19:04:40.281989Z",
      endedAt: "2026-08-02T19:05:53.776865Z",
      platformAgentName: "morgan",
    };
    const nextRow: Listed = { ...ONE_ROW, ...nextFacts };
    stub({
      rows: [ONE_ROW, nextRow],
      details: {
        [FACTS.traceId]: TRACE_DETAIL,
        [nextFacts.traceId]: { ...TRACE_DETAIL, trace: nextFacts },
      },
    });
    render(<MonitoringTranscriptsPage />);

    const table = await screen.findByRole("table", { name: LIST.tableLabel });
    fireEvent.click(
      within(table).getByRole("button", { name: FACTS.traceId }),
    );
    expect(await screen.findByRole("dialog", { name: /Trace/u })).toBeTruthy();

    /* Let Radix install the document listener used by outside presses. */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const next = within(table).getByRole("button", {
      name: nextFacts.traceId,
    });
    fireEvent.pointerDown(next);
    fireEvent.click(next);

    await waitFor(() => {
      const sheet = screen.getByRole("dialog", { name: /Trace/u });
      expect(within(sheet).getByText(nextFacts.traceId)).toBeTruthy();
      expect(new URL(globalThis.location.href).searchParams.get("trace")).toBe(
        nextFacts.traceId,
      );
    });
  });

  it.each([
    {
      state: "pending",
      title: "Grading is still running",
      lead: "Project grades appear here as they finish.",
      role: "status",
    },
    {
      state: "error",
      title: "Grading could not be completed",
      lead: "Egma could not complete the requested grades for this trace.",
      role: "alert",
    },
  ] as const)(
    "does not describe $state grading as an inactive grader",
    async ({ state, title, lead, role }) => {
      stub({
        rows: [ONE_ROW],
        detail: { ...TRACE_DETAIL, gradingState: state },
      });
      render(<MonitoringTranscriptsPage />);

      const table = await screen.findByRole("table", { name: LIST.tableLabel });
      fireEvent.click(
        within(table).getByRole("button", { name: FACTS.traceId }),
      );

      const sheet = await screen.findByRole("dialog", { name: /Trace/u });
      const stateMessage = within(sheet).getByRole(role);
      expect(within(stateMessage).getByText(title)).toBeDefined();
      expect(within(stateMessage).getByText(lead)).toBeDefined();
      expect(
        within(sheet).queryByText(
          "No project grader was active when this trace was recorded.",
        ),
      ).toBeNull();
    },
  );

  it("shows one cached page at a time inside one fixed time window", async () => {
    const second = {
      ...ONE_ROW,
      traceId: "6d2f5c1a9e3b4d7f8a0b1c2d3e4f5061",
      preview: "The older conversation",
    };
    const { asked } = apiAnswers({
      "/api/me": { status: 200, body: meIs() },
      "/v1/traces": (at) =>
        at.searchParams.get("pageToken") === "older"
          ? {
              status: 200,
              body: {
                traces: [second],
                nextPageToken: null,
              },
            }
          : {
              status: 200,
              body: {
                traces: [ONE_ROW],
                nextPageToken: "older",
              },
            },
      "/v1/graders": {
        status: 200,
        body: { graders: [grader("both")], nextPageToken: null },
      },
      "/v1/keys": { status: 200, body: { keys: [key("prj_2")] } },
    });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("button", { name: ONE_ROW.traceId });
    expect(screen.getByText("Page 1")).toBeDefined();
    expect(screen.queryByRole("button", { name: second.traceId })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("button", { name: second.traceId });
    expect(screen.queryByRole("button", { name: ONE_ROW.traceId })).toBeNull();
    expect(screen.getByText("Page 2")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByRole("button", { name: ONE_ROW.traceId });
    expect(screen.queryByRole("button", { name: second.traceId })).toBeNull();

    const listReads = asked
      .filter((one) => one.startsWith("/v1/traces?"))
      .map((one) => new URLSearchParams(one.slice(one.indexOf("?"))));
    expect(listReads).toHaveLength(2);
    expect(listReads[1]?.get("pageToken")).toBe("older");
    expect(listReads[1]?.get("from")).toBe(listReads[0]?.get("from"));
    expect(listReads[1]?.get("to")).toBe(listReads[0]?.get("to"));
  });
});

/**
 * The three list-level quiet states, each asserted present and the others absent.
 *
 * Showing two at once is the failure this guards: somebody reading the last
 * hour of a busy project told to go and set up the export they already have,
 * somebody with no export told that no grader watches production, somebody
 * whose key names the whole organization told to point an export at egma a
 * second time.
 */
describe("what a quiet Monitoring page says", () => {
  /**
   * Which list-level state is on screen, read by its heading.
   */
  function guidance(): readonly string[] {
    return [
      ...(screen.queryByRole("heading", {
        name: QUIET.narrowWindow.title,
      }) === null
        ? []
        : ["nothing-in-this-window"]),
      ...(screen.queryByRole("heading", { name: QUIET.setUp.title }) === null
        ? []
        : ["set-up-capture"]),
      ...(screen.queryByRole("heading", {
        name: QUIET.organizationKey.title,
      }) === null
        ? []
        : ["key-names-the-organization"]),
    ];
  }

  /**
   * **An empty list is a fact about the window when something is recorded
   * further back.**
   *
   * A project with a week of traffic, read at the last hour, is empty and
   * perfectly healthy. Greeting that with the setup tutorial tells a developer
   * their working export is broken, so the page says the one thing it knows and
   * points at the control that fixes it.
   */
  it("blames the window, and teaches nothing, when there is traffic further back", async () => {
    atWindow("1h");
    const { asked } = stub({
      rows: [],
      everRecorded: [ONE_ROW],
      keys: [key(null)],
      graders: [grader("simulations")],
    });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { name: QUIET.narrowWindow.title });
    expect(guidance()).toEqual(["nothing-in-this-window"]);
    // No tutorial, and no sentence about a key — neither is known to be wrong.
    expect(screen.queryByText(/OTEL_EXPORTER_OTLP_ENDPOINT/)).toBeNull();
    expect(screen.getByText(QUIET.narrowWindow.lead)).toBeDefined();
    // The one extra read it took to know that, asked for a single row.
    expect(probed(asked)).toHaveLength(1);
  });

  /**
   * **A first-day project meets the teaching on the window it lands on.**
   *
   * The address a developer arrives at names no window, so the page settles on
   * the default — not the widest — and this is the moment the whole empty state
   * exists for. Deciding by the selected window alone would put a click between
   * them and the instructions written for them, so the page asks the wider
   * question instead.
   */
  it("opens the platform setup on the default window when nothing has ever arrived", async () => {
    const { asked } = stub({
      rows: [],
      everRecorded: [],
      keys: [key("prj_2")],
      graders: [grader("simulations")],
    });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { name: QUIET.setUp.title });
    expect(guidance()).toEqual(["set-up-capture"]);
    expect(probed(asked)).toHaveLength(1);

    /* The empty state enters the shared Agents-owned setup flow once. */
    const offered = screen.getAllByRole("link", { name: LIST.monitorAgent });
    expect(offered).toHaveLength(1);
    for (const one of offered) {
      expect(one.getAttribute("href")).toBe(
        "/projects/prj_2/agents?sheet=connect&goal=monitoring",
      );
    }
  });

  it("names the organization-wide key instead, when the organization holds one", async () => {
    stub({ rows: [], everRecorded: [], keys: [key(null)], graders: [] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { name: QUIET.organizationKey.title });
    expect(guidance()).toEqual(["key-names-the-organization"]);
    expect(
      screen
        .getByRole("link", { name: QUIET.organizationKey.key })
        .getAttribute("href"),
    ).toBe("/projects/prj_2/settings/keys");
  });
});
