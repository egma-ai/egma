// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MonitoringTranscriptsPage from "../app/projects/[projectId]/monitoring/transcripts/page.tsx";
import { asListInstant } from "../lib/instants.ts";
import type { Me } from "../lib/me.ts";
import { LIST, QUIET, TRACE_COLUMNS } from "../lib/transcript-copy.ts";
import type { Facts, Listed } from "../lib/transcripts.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/**
 * **Monitoring**, rendered and driven the way somebody with a keyboard drives
 * it.
 *
 * Two claims this file exists to defend, and neither can be made by reading a
 * source file:
 *
 * 1. **The project in the address is the project asked about, and the traffic
 *    asked for is production.** Both ride in the request, so the first thing
 *    asked of the read is what it named. A page that resolved either for itself
 *    would show one project's traffic under another's address, or a simulation
 *    on the surface that exists to keep the two apart.
 * 2. **A quiet page shows one guidance and only one.** The three answer
 *    different questions and point in different directions, so each is asserted
 *    present *and* the other two absent — showing two at once is the failure,
 *    and only a rendered page can be asked about it.
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

function seenAs(role: typeof seenRole): void {
  seenRole = role;
}

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
  emitter: "agent",
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
 * One page, with every read answered.
 *
 * `rows`, `everRecorded`, `graders` and `keys` are the four inputs the quiet
 * states are decided from, so a case says only which of them it is about.
 *
 * `everRecorded` is the widest-window probe — *has this project ever recorded
 * anything* — and it defaults to whatever `rows` says, which is the ordinary
 * case of a project that is empty everywhere or busy everywhere. A case about
 * the window sets the two apart. Any read can be refused instead, which is a
 * case of its own: a refusal is not a zero.
 */
function stub(options: {
  readonly rows?: readonly Listed[];
  readonly everRecorded?: readonly Listed[] | "refused";
  readonly graders?: readonly ReturnType<typeof grader>[] | "refused";
  readonly keys?: readonly ReturnType<typeof key>[] | "refused";
  readonly detail?: unknown;
}) {
  const rows = options.rows ?? [];
  const ever = options.everRecorded ?? rows;

  return apiAnswers({
    "/api/me": { status: 200, body: meIs() },
    // One path, two questions. The probe is the one asking for a single row.
    "/v1/traces": (at) =>
      at.searchParams.get("pageSize") === "1"
        ? ever === "refused"
          ? REFUSED
          : page(ever)
        : page(rows),
    [`/v1/traces/${FACTS.traceId}`]: {
      status: 200,
      body: options.detail ?? TRACE_DETAIL,
    },
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

/** The widest the control offers. */
const WIDEST = "30d";

/** Which read this page made of the list, as the address it sent. */
function listedAt(asked: readonly string[]): URLSearchParams {
  const sent = asked.find((one) => one.startsWith("/v1/traces?")) ?? "";
  return new URLSearchParams(sent.slice(sent.indexOf("?")));
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

/**
 * **The level is the wait, not decoration.** The sidebar's Monitoring group
 * label is a heading reading the same word, and it is drawn before any read
 * answers — so an unlevelled wait here would be satisfied by the shell and
 * would assert the query against a page that had not asked for anything yet.
 * `level: 1` is the page's own heading, which only the settled page draws.
 */
describe("what the Monitoring list asks egma for", () => {
  it("names the project in the address, never one resolved for it", async () => {
    routed.projectId = "prj_1";
    const { asked } = stub({ rows: [ONE_ROW] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { level: 1, name: LIST.title });
    expect(listedAt(asked).get("projectId")).toBe("prj_1");
  });

  /**
   * The filter is the server's. Narrowing what came back would answer
   * differently depending on what had already been fetched, and would quietly
   * break paging.
   */
  it("asks for production traffic and nothing else", async () => {
    const { asked } = stub({ rows: [ONE_ROW] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { level: 1, name: LIST.title });
    const query = listedAt(asked);
    expect(query.get("source")).toBe("production");
    // And a window, because the store refuses a read that bounded nothing.
    expect(query.get("from")).not.toBeNull();
    expect(query.get("to")).not.toBeNull();
  });

  /**
   * **Traces, not Monitoring.** OBSERVABILITY is the sidebar group; this is
   * the one page under it, and since the separate monitoring screen retired it
   * is where the one monitoring verb lives too (board `JGS-0`). A title bar
   * repeating the group's word said the section's name twice over.
   */
  it("heads the page Traces", async () => {
    stub({ rows: [ONE_ROW] });
    render(<MonitoringTranscriptsPage />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Traces" }),
    ).toBeDefined();
  });
});

describe("what the Monitoring list shows", () => {
  it("shows the compact call index in the approved order", async () => {
    stub({ rows: [ONE_ROW] });
    render(<MonitoringTranscriptsPage />);

    const table = await screen.findByRole("table", { name: LIST.tableLabel });
    const headings = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);

    expect(headings).toEqual([
      TRACE_COLUMNS.agent,
      TRACE_COLUMNS.time,
      TRACE_COLUMNS.duration,
      TRACE_COLUMNS.p90TurnLatency,
      TRACE_COLUMNS.traceId,
      TRACE_COLUMNS.actions,
    ]);
    expect(within(table).getByText("4.78s")).toBeDefined();
    expect(within(table).getByText("kelly")).toBeDefined();
    expect(table.style.minWidth).toBe("62rem");
  });

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

  it("keeps a platform-reported P90 complete on a truncated trace", async () => {
    stub({
      rows: [{ ...ONE_ROW, turnResponseLatencyP90Partial: false }],
      detail: {
        ...TRACE_DETAIL,
        spansTruncated: true,
        metrics: TRACE_DETAIL.metrics.map((metric) => ({
          ...metric,
          partial: false,
          reportedBy: "retell",
        })),
      },
    });
    render(<MonitoringTranscriptsPage />);

    const table = await screen.findByRole("table", { name: LIST.tableLabel });
    expect(within(table).getByText("4.78s")).toBeDefined();
    expect(within(table).queryByText("4.78s · partial")).toBeNull();

    fireEvent.click(
      within(table).getByRole("button", { name: FACTS.traceId }),
    );
    const sheet = await screen.findByRole("dialog", { name: /Trace/u });
    expect(within(sheet).getByText("4.78s")).toBeDefined();
    expect(within(sheet).queryByText("4.78s · partial")).toBeNull();
  });

  /**
   * A row leads to the transcript inside this project, carrying the window the
   * exchange happened in — which is what makes one transcript a link somebody
  * can send.
  */
  it("opens one continuous trace sheet from the row", async () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const { asked } = stub({
      rows: [
        {
          ...ONE_ROW,
          startedAt: startedAt,
          endedAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
        },
      ],
    });
    render(<MonitoringTranscriptsPage />);

    const table = await screen.findByRole("table", { name: LIST.tableLabel });
    /*
     * The exchange's own moment, absolute and to the second. A list column is
     * an absolute short date (ticket 09, item a): a column of ages cannot be
     * scanned, and two exchanges a minute apart read the same for the whole of
     * the first hour. The precision this column has always had is kept.
     */
    const started = within(table).getByText(
      asListInstant(startedAt, "second"),
    );

    expect(started.closest("time")?.dateTime).toBe(startedAt);
    expect(started.closest("time")?.title).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /u,
    );

    fireEvent.click(
      within(table).getByRole("button", { name: FACTS.traceId }),
    );

    const sheet = await screen.findByRole("dialog", { name: /Trace/u });
    expect(within(sheet).getByRole("heading", { name: "Call overview" })).toBeDefined();
    expect(within(sheet).getByText("4.78s")).toBeDefined();
    expect(within(sheet).getAllByRole("term").map((one) => one.textContent)).toEqual([
      "Started",
      "Duration",
      "Turns",
      "P90 turn latency",
    ]);
    expect(
      within(sheet)
        .getAllByRole("term")
        .find((term) => term.textContent === "P90 turn latency")
        ?.classList.contains("whitespace-nowrap"),
    ).toBe(true);
    expect(within(sheet).queryByRole("heading", { name: "Latency" })).toBeNull();
    expect(within(sheet).getByText("No grades for this trace")).toBeDefined();
    expect(
      within(sheet).getByText(
        "No project grader was active when this trace was recorded.",
      ),
    ).toBeDefined();
    expect(
      within(sheet).getByText(
        "No audio recording is available for this trace.",
      ),
    ).toBeDefined();
    const transcriptAnchor = within(sheet).getByRole("button", {
      name: "Transcript",
    });
    expect(transcriptAnchor.getAttribute("aria-current")).toBeNull();
    fireEvent.click(transcriptAnchor);
    expect(transcriptAnchor.getAttribute("aria-current")).toBe("location");
    expect(
      within(sheet).getByRole("heading", { name: "Call overview" }),
    ).toBeDefined();

    // A short last section reaches the bottom before its own top can reach
    // the nav rail. The bottom still means Transcript, so the scroll-spy must
    // not undo the anchor the person just chose.
    const transcriptSection = sheet.querySelector("#trace-transcript");
    expect(transcriptSection).toBeInstanceOf(HTMLElement);
    if (!(transcriptSection instanceof HTMLElement)) {
      throw new Error("The transcript section was not rendered.");
    }
    const scroller = transcriptSection.parentElement;
    expect(scroller).not.toBeNull();
    if (scroller === null) {
      throw new Error("The trace sheet scroller was not rendered.");
    }
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 700 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0 }) as DOMRect,
      },
    });
    Object.defineProperty(transcriptSection, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 650 }) as DOMRect,
    });
    fireEvent.scroll(scroller);
    expect(transcriptAnchor.getAttribute("aria-current")).toBe("location");

    const detailRead = asked.find((one) =>
      one.startsWith(`/v1/traces/${FACTS.traceId}?`),
    );
    expect(detailRead).toBeDefined();
    const sent = new URLSearchParams(detailRead?.slice(detailRead.indexOf("?")));
    expect(sent.get("projectId")).toBe("prj_2");
    expect(sent.get("from")).not.toBeNull();
    expect(sent.get("to")).not.toBeNull();
  });

  it("keeps a changed window when the open trace sheet is closed", async () => {
    atWindow("24h");
    stub({ rows: [ONE_ROW] });
    render(<MonitoringTranscriptsPage />);

    const table = await screen.findByRole("table", { name: LIST.tableLabel });
    fireEvent.click(
      within(table).getByRole("button", { name: FACTS.traceId }),
    );
    const sheet = await screen.findByRole("dialog", { name: /Trace/u });
    expect(new URL(globalThis.location.href).searchParams.get("trace")).toBe(
      FACTS.traceId,
    );

    fireEvent.change(screen.getByLabelText(LIST.window), {
      target: { value: "7d" },
    });
    expect(new URL(globalThis.location.href).searchParams.get("window")).toBe(
      "7d",
    );

    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    const closed = new URL(globalThis.location.href);
    expect(closed.searchParams.get("window")).toBe("7d");
    expect(closed.searchParams.get("trace")).toBeNull();
    expect((screen.getByLabelText(LIST.window) as HTMLSelectElement).value).toBe(
      "7d",
    );
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

    /*
     * **The empty state carries the one monitoring verb, and it opens a sheet
     * over this page rather than leading to one.** The address it points at is
     * this page's own with the picker asked for in the query, which is what
     * makes Back close it and a copied link reopen it (board `JGS-0`).
     */
    const offered = screen.getAllByRole("link", { name: LIST.monitorAgent });
    // Two of them, and deliberately: the header carries the action wherever
    // this page is, and the empty card carries the same one where somebody is
    // actually reading about it. Both are the same address, and both carry the
    // window this page is on rather than dropping it.
    expect(offered).toHaveLength(2);
    for (const one of offered) {
      expect(one.getAttribute("href")).toBe(
        "/projects/prj_2/monitoring/transcripts?window=24h&sheet=monitor",
      );
    }
  });

  /**
   * **A refused read is not a zero.** Folding it into a count would put "no
   * grader watches production" on screen on the strength of an answer egma
   * never got — the same collapse `ui/page-state.tsx` forbids between failed and
   * empty. A supporting read that did not land means one thing less is said.
   */
  it("claims nothing about graders when the grader read was refused", async () => {
    const { asked } = stub({
      rows: [ONE_ROW],
      keys: [key("prj_2")],
      graders: "refused",
    });
    render(<MonitoringTranscriptsPage />);

    // The rows are the page, and they arrive whatever the supporting read did.
    await screen.findByRole("table", { name: LIST.tableLabel });
    expect(guidance()).toEqual([]);
    // And a page with rows on it never asks the wider question.
    expect(probed(asked)).toEqual([]);
  });

  /** And the same for the keys read, which decides between two empty states. */
  it("teaches the setup, claiming no key, when the key read was refused", async () => {
    stub({ rows: [], everRecorded: [], keys: "refused", graders: [] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { name: QUIET.setUp.title });
    expect(guidance()).toEqual(["set-up-capture"]);
  });

  /**
   * **The refused probe is that rule at its sharpest**, because both sentences
   * it decides between are confident ones. *Nothing here, try a wider window* is
   * true whatever the answer would have been; the teaching would be telling
   * somebody with a working export to go and build one.
   */
  it("falls back to the window line, never the teaching, when the probe was refused", async () => {
    stub({
      rows: [],
      everRecorded: "refused",
      keys: [key(null)],
      graders: [grader("simulations")],
    });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { name: QUIET.narrowWindow.title });
    expect(guidance()).toEqual(["nothing-in-this-window"]);
    expect(screen.queryByText(/OTEL_EXPORTER_OTLP_ENDPOINT/)).toBeNull();
  });

  /**
   * At the widest window the list read has already answered the wider question,
   * so nothing is asked twice.
   */
  it("asks nothing extra when the window on screen is already the widest", async () => {
    atWindow(WIDEST);
    const { asked } = stub({ rows: [], keys: [key("prj_2")], graders: [] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { name: QUIET.setUp.title });
    expect(guidance()).toEqual(["set-up-capture"]);
    expect(probed(asked)).toEqual([]);
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

  it("keeps grader setup guidance out of the trace list", async () => {
    stub({
      rows: [ONE_ROW],
      keys: [key(null)],
      graders: [grader("simulations")],
    });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("table", { name: LIST.tableLabel });
    expect(guidance()).toEqual([]);
    expect(screen.queryByText(QUIET.unwatched.lead)).toBeNull();
    expect(
      screen.queryByRole("link", { name: QUIET.unwatched.graders }),
    ).toBeNull();
  });

  /** A healthy project is told nothing, which is the fourth answer. */
  it("says none of them when traffic is arriving and something judges it", async () => {
    stub({ rows: [ONE_ROW], keys: [key("prj_2")], graders: [grader("both")] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("table", { name: LIST.tableLabel });
    expect(guidance()).toEqual([]);
  });
});

/**
 * **Monitoring is one verb on this screen, and v0 shows nothing else about
 * it.**
 *
 * The separate monitoring screen is retired, so the action that used to lead
 * away from here now opens a sheet over it. And the management half — stop
 * pulling, turn it on again, when something last arrived — has no interface at
 * launch: the API keeps `stopMonitoring`, and surfacing it is its own effort.
 * A screen that grew a stop button would be that decision made by drift.
 */
describe("the one monitoring action this screen carries", () => {
  it("heads the page with it, and asks for the picker in the address", async () => {
    stub({ rows: [ONE_ROW], keys: [key("prj_2")], graders: [grader("both")] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("table", { name: LIST.tableLabel });
    const action = screen.getByRole("link", { name: LIST.monitorAgent });
    // The page it points at is the page it is on. Nothing navigates away, so
    // nothing reloads, and the query is the whole of what changes.
    expect(action.getAttribute("href")).toBe(
      "/projects/prj_2/monitoring/transcripts?window=24h&sheet=monitor",
    );
    // And the old address is not what it points at any more.
    expect(action.getAttribute("href")).not.toContain("/monitoring/start");
  });

  /**
   * **The sheet opens on the URL the person is already on, whole.**
   *
   * The window is a filter they chose, and it lives in the address. An action
   * that built a fresh query would throw it away on the way open: the list
   * behind the sheet would jump from thirty days back to one, and closing the
   * sheet would leave them there wondering what they pressed.
   */
  it("keeps the window the person chose in the address it opens on", async () => {
    atWindow(WIDEST);
    stub({ rows: [ONE_ROW], keys: [key("prj_2")], graders: [grader("both")] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("table", { name: LIST.tableLabel });
    expect(
      screen.getByRole("link", { name: LIST.monitorAgent }).getAttribute("href"),
    ).toBe(`/projects/prj_2/monitoring/transcripts?window=${WIDEST}&sheet=monitor`);
  });

  /**
   * **A viewer is told, rather than allowed to type a Retell key and find out
   * from the server.**
   *
   * Starting monitoring is `configure_monitoring`, which members and admins
   * have and viewers do not. The server refuses them either way — that is where
   * the boundary is — but the control says so first, which is the house
   * pattern: disabled, with the sentence on it, never removed.
   */
  it("disables the action for a viewer and says whose it is not", async () => {
    seenAs("viewer");
    stub({ rows: [ONE_ROW], keys: [key("prj_2")], graders: [grader("both")] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("table", { name: LIST.tableLabel });
    const action = await screen.findByRole("button", {
      name: LIST.monitorAgent,
    });
    expect(action.hasAttribute("disabled")).toBe(true);
    // Not a link, so there is nothing to open — and the reason is on the page
    // rather than only in a title attribute nobody hears.
    expect(screen.queryByRole("link", { name: LIST.monitorAgent })).toBeNull();
    expect(
      screen.getByText(/Your viewer role cannot start monitoring/u),
    ).toBeDefined();
  });

  it("offers no stop, no turn-on, and no last-received", async () => {
    stub({ rows: [ONE_ROW], keys: [key("prj_2")], graders: [grader("both")] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("table", { name: LIST.tableLabel });
    for (const absent of [
      /stop pulling/iu,
      /turn on/iu,
      /last received/iu,
    ]) {
      expect(screen.queryByText(absent), String(absent)).toBeNull();
    }
  });
});
