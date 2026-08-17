// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MonitoringTranscriptsPage from "../app/projects/[projectId]/monitoring/transcripts/page.tsx";
import type { Me } from "../lib/me.ts";
import { COLUMNS, LIST, QUIET } from "../lib/transcript-copy.ts";
import type { Facts, Listed } from "../lib/transcripts.ts";

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

const FACTS: Facts = {
  trace_id: "5c1e4b0f8d2a4e6b9f0c1d2e3a4b5c6d",
  started_at: "2026-08-02T18:04:40.281989Z",
  ended_at: "2026-08-02T18:05:53.776865Z",
  duration_ns: "73494876403",
  span_count: 133,
  turn_counts: { human: 5, agent: 8 },
  tool_span_count: 2,
  errored_span_count: 0,
  source: "production",
  emitter: "agent",
  environment: "default",
  connection_type: "livekit",
  provider_call_id: "egma-fixture-capture-1",
  run_id: "",
  agent_id: "",
};

const ONE_ROW: Listed = { ...FACTS, preview: "I need to move my appointment" };

/** A running grader, at whichever scope the case under test needs. */
function grader(scope: string) {
  return {
    id: "grd_1",
    library_id: "gld_1",
    name: "Expected behaviors",
    description: null,
    type: "llm_as_judge",
    required: true,
    scope,
    production_sample_rate: 100,
    config: null,
    created_at: "2026-08-01T00:00:00.000000Z",
    updated_at: "2026-08-01T00:00:00.000000Z",
  };
}

/** A key, either the project's own or one that names the whole organization. */
function key(projectId: string | null) {
  return {
    id: "key_1",
    name: "livekit-agent",
    prefix: "egma_sk",
    last_four: "9f2a",
    project_id: projectId,
    created_at: "2026-08-01T00:00:00.000000Z",
    created_by: "usr_1",
    revoked_at: null,
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
    vi.fn(async (input: string) => {
      const at = new URL(String(input), "http://egma.test");
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
    body: { traces: rows, next_cursor: null, window: { from: "", to: "" } },
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
}) {
  const rows = options.rows ?? [];
  const ever = options.everRecorded ?? rows;

  return apiAnswers({
    "/api/me": { status: 200, body: ME },
    // One path, two questions. The probe is the one asking for a single row.
    "/v1/traces": (at) =>
      at.searchParams.get("limit") === "1"
        ? ever === "refused"
          ? REFUSED
          : page(ever)
        : page(rows),
    "/api/graders":
      options.graders === "refused"
        ? REFUSED
        : {
            status: 200,
            body: { items: options.graders ?? [], next_cursor: null },
          },
    "/api/keys":
      options.keys === "refused"
        ? REFUSED
        : { status: 200, body: { keys: options.keys ?? [] } },
  });
}

/** Whether the widest-window probe was fired at all. */
function probed(asked: readonly string[]): readonly string[] {
  return asked.filter(
    (one) => one.startsWith("/v1/traces?") && one.includes("limit=1"),
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
  routed.pathname = "/projects/prj_2/monitoring/transcripts";
  atNoWindow();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what the Monitoring list asks egma for", () => {
  it("names the project in the address, never one resolved for it", async () => {
    routed.projectId = "prj_1";
    const { asked } = stub({ rows: [ONE_ROW] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { name: LIST.title });
    expect(listedAt(asked).get("project_id")).toBe("prj_1");
  });

  /**
   * The filter is the server's. Narrowing what came back would answer
   * differently depending on what had already been fetched, and would quietly
   * break paging.
   */
  it("asks for production traffic and nothing else", async () => {
    const { asked } = stub({ rows: [ONE_ROW] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { name: LIST.title });
    const query = listedAt(asked);
    expect(query.get("source")).toBe("production");
    // And a window, because the store refuses a read that bounded nothing.
    expect(query.get("from")).not.toBeNull();
    expect(query.get("to")).not.toBeNull();
  });

  it("heads the page Monitoring", async () => {
    stub({ rows: [ONE_ROW] });
    render(<MonitoringTranscriptsPage />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Monitoring" }),
    ).toBeDefined();
  });
});

describe("what the Monitoring list shows", () => {
  /**
   * Every row here is production by definition, so a column saying so on every
   * line would be furniture around a constant.
   */
  it("carries no source column", async () => {
    stub({ rows: [ONE_ROW] });
    render(<MonitoringTranscriptsPage />);

    const table = await screen.findByRole("table", { name: LIST.tableLabel });
    const headings = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);

    expect(headings).toContain(COLUMNS.started);
    expect(headings).toContain(COLUMNS.environment);
    expect(headings).not.toContain("Source");
    expect(Object.values(COLUMNS)).not.toContain("Source");
  });

  /**
   * A row leads to the transcript inside this project, carrying the window the
   * exchange happened in — which is what makes one transcript a link somebody
   * can send.
   */
  it("links each row into this project's transcript, window and all", async () => {
    stub({ rows: [ONE_ROW] });
    render(<MonitoringTranscriptsPage />);

    const table = await screen.findByRole("table", { name: LIST.tableLabel });
    const link = within(table).getAllByRole("link")[0];
    const href = link?.getAttribute("href") ?? "";

    expect(
      href.startsWith(
        `/projects/prj_2/monitoring/transcripts/${FACTS.trace_id}?`,
      ),
    ).toBe(true);
    const carried = new URLSearchParams(href.slice(href.indexOf("?")));
    expect(carried.get("from")).not.toBeNull();
    expect(carried.get("to")).not.toBeNull();
  });
});

/**
 * The four quiet states, each asserted present **and** the other three absent.
 *
 * Showing two at once is the failure this guards: somebody reading the last
 * hour of a busy project told to go and set up the export they already have,
 * somebody with no export told that no grader watches production, somebody
 * whose key names the whole organization told to point an export at egma a
 * second time.
 */
describe("what a quiet Monitoring page says", () => {
  /**
   * Which of the four is on screen, read by the one thing each puts there and
   * nothing else does: three headings and a link.
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
      ...(screen.queryByRole("link", { name: QUIET.unwatched.graders }) === null
        ? []
        : ["nothing-watches-production"]),
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
  it("teaches the export setup on the default window when nothing has ever arrived", async () => {
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
     * The two variables, carrying the address **this deployment** listens on —
     * read off the page rather than written down anywhere, because a
     * self-hoster's egma is wherever they put it and a printed example would be
     * somebody else's. The origin is only knowable in a browser, so it arrives
     * one render after the block does and this waits for it.
     */
    const shown = await screen.findByText(
      (text) =>
        text.includes("OTEL_EXPORTER_OTLP_ENDPOINT") &&
        text.includes(globalThis.location.origin),
      { selector: "pre" },
    );
    expect(shown.textContent).toContain("OTEL_EXPORTER_OTLP_HEADERS");
    expect(shown.textContent).toContain("Bearer%20");
    // And somewhere to mint the key it carries.
    expect(
      screen.getByRole("link", { name: QUIET.setUp.key }).getAttribute("href"),
    ).toBe("/projects/prj_2/settings/keys");
    /*
     * The caution rides with the teaching, and this is why. The key list
     * answers for an admin and for whoever minted the key, so a member whose
     * project is fed by somebody else's organization-wide key never reaches the
     * state below — and that key is the one step of this setup that fails
     * without saying anything.
     */
    expect(screen.getByText(QUIET.setUp.caution)).toBeDefined();
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

  /**
   * Every new grader starts scoped to simulations and the seeded one is
   * structurally simulations-only, so this is the ordinary first state of a
   * project whose traffic has just started flowing — not a fault.
   */
  it("says no grader watches production once traffic is arriving", async () => {
    stub({
      rows: [ONE_ROW],
      keys: [key(null)],
      graders: [grader("simulations")],
    });
    render(<MonitoringTranscriptsPage />);

    const graders = await screen.findByRole("link", {
      name: QUIET.unwatched.graders,
    });
    expect(guidance()).toEqual(["nothing-watches-production"]);
    expect(graders.getAttribute("href")).toBe("/projects/prj_2/graders/running");
    expect(screen.getByText(QUIET.unwatched.lead)).toBeDefined();
    // The rows are still the page. Guidance sits above them rather than
    // replacing them.
    expect(screen.getByRole("table", { name: LIST.tableLabel })).toBeDefined();
  });

  /** A healthy project is told nothing, which is the fourth answer. */
  it("says none of them when traffic is arriving and something judges it", async () => {
    stub({ rows: [ONE_ROW], keys: [key("prj_2")], graders: [grader("both")] });
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("table", { name: LIST.tableLabel });
    expect(guidance()).toEqual([]);
  });
});
