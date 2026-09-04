// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TestsPage from "../app/projects/[projectId]/tests/page.tsx";
import NewTestPage from "../app/projects/[projectId]/tests/new/page.tsx";
import TestDetailPage from "../app/projects/[projectId]/tests/[testId]/page.tsx";
import TestSuitePage from "../app/projects/[projectId]/tests/suites/[suiteId]/page.tsx";
import NewRunPage from "../app/projects/[projectId]/runs/new/page.tsx";
import type { Me } from "../lib/me.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  pathname: "/projects/prj_1/tests",
  params: { projectId: "prj_1" } as Record<string, string>,
  search: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useParams: () => routed.params,
  useSearchParams: () => new URLSearchParams(routed.search),
  useRouter: () => ({ push: routed.push, replace: routed.replace, back: vi.fn() }),
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

const ME: Me = {
  user: { id: "usr_1", email: "ada@acme.example" },
  organizations: [{ id: "org_1", name: "Acme", slug: "acme", role: "admin" }],
  projects: [{ id: "prj_1", name: "Receptionists", slug: "receptionists" }],
};

function meWith(
  role: "admin" | "member" | "viewer",
  projects: Me["projects"] = ME.projects,
): Me {
  return {
    ...ME,
    organizations: ME.organizations.map((organization) => ({ ...organization, role })),
    projects,
  };
}

function suiteBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "ste_1",
    projectId: "prj_1",
    name: "Northside Ford",
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T10:00:00.000Z",
    ...overrides,
  };
}

/** The one caller the grid's fixtures name, because a test says who calls. */
const PERSONA = { id: "prs_1", name: "Impatient Rita", archivedAt: null };

function testBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "tst_1",
    projectId: "prj_1",
    suiteId: "ste_1",
    name: "Books service",
    description: null,
    version: 1,
    versionId: "tstv_1",
    scenario: "The caller books service.",
    expectedBehaviors: ["Offers an available time"],
    personas: [PERSONA],
    mockTools: [],
    env: null,
    revision: "rev_1",
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T10:00:00.000Z",
    ...overrides,
  };
}

type Stub = {
  readonly status: number;
  readonly body: unknown;
  readonly waitFor?: Promise<void>;
};
let sent: { readonly path: string; readonly method: string; readonly body: unknown }[] = [];

function answers(stubs: Record<string, Stub | readonly Stub[]>): void {
  const turns: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = await observeRequest(input, init);
      sent.push({
        path: request.path,
        method: request.method,
        body: request.body,
      });
      const held = stubs[request.path];
      if (held === undefined) throw new Error(`nothing stubbed for ${request.path}`);
      const turn = turns[request.path] ?? 0;
      turns[request.path] = turn + 1;
      const response: Stub = Array.isArray(held)
        ? (held[Math.min(turn, held.length - 1)] as Stub)
        : (held as Stub);
      if (response.waitFor !== undefined) await response.waitFor;
      return new Response(response.status === 204 ? null : JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function gridAnswers(options: {
  readonly role?: "admin" | "member" | "viewer";
  readonly tests?: readonly Record<string, unknown>[];
  readonly saved?: Stub;
  readonly created?: Stub;
  readonly removed?: Stub;
} = {}): void {
  routed.pathname = "/projects/prj_1/tests/suites/ste_1";
  routed.params = { projectId: "prj_1", suiteId: "ste_1" };
  const listed = options.tests ?? [testBody({ personas: [PERSONA] })];
  answers({
    "/api/me": { status: 200, body: meWith(options.role ?? "admin") },
    "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
    "/v1/tests":
      options.created === undefined
        ? { status: 200, body: { tests: listed, nextPageToken: null } }
        : [
            { status: 200, body: { tests: listed, nextPageToken: null } },
            options.created,
          ],
    ...(options.saved === undefined ? {} : { "/v1/tests/tst_1": options.saved }),
    ...(options.removed === undefined ? {} : { "/v1/tests/tst_1": options.removed }),
    "/v1/personas": {
      status: 200,
      body: { personas: [PERSONA], nextPageToken: null },
    },
  });
}

function runBuilderAnswers(options: {
  readonly role?: "admin" | "member" | "viewer";
  readonly started?: Stub | readonly Stub[];
  /** The connections this agent holds when a walk needs named lanes. */
  readonly connections?: readonly Record<string, unknown>[];
  /** The suite's tests, which is what the run note counts. */
  readonly tests?: readonly Record<string, unknown>[];
} = {}): void {
  const started = options.started ?? {
    status: 201,
    body: {
      id: "run_1",
      projectId: "prj_1",
      status: "pending",
      suiteId: "ste_1",
      suiteName: "Northside Ford",
      suiteDeleted: false,
      name: null,
      expectedSimulationCount: 1,
    },
  };
  answers({
    "/api/me": { status: 200, body: meWith(options.role ?? "admin") },
    "/v1/test-suites": {
      status: 200,
      body: { testSuites: [suiteBody()], nextPageToken: null },
    },
    "/v1/agents": {
      status: 200,
      body: {
        agents: [{ id: "agt_1", name: "Receptionist", archived: false, connections: [] }],
        nextPageToken: null,
      },
    },
    "/v1/agents/agt_1": {
      status: 200,
      body: {
        agent: { id: "agt_1", name: "Receptionist", archived: false },
        connections: options.connections ?? [
          {
            id: "con_1",
            name: "Production",
            productLabel: "Retell",
            modality: "voice",
            environment: "production",
            archived: false,
          },
        ],
      },
    },
    "/v1/tests": {
      status: 200,
      body: { tests: options.tests ?? [testBody()], nextPageToken: null },
    },
    "/v1/runs": [
      { status: 200, body: { runs: [], nextPageToken: null } },
      ...(Array.isArray(started) ? started : [started]),
    ],
  });
}

async function chooseRunTarget(): Promise<void> {
  fireEvent.change(await screen.findByLabelText("Test suite *"), {
    target: { value: "ste_1" },
  });
  fireEvent.change(screen.getByLabelText("Agent *"), { target: { value: "agt_1" } });
  await screen.findByRole("option", { name: "Production · Voice" });
  fireEvent.change(screen.getByLabelText("Connection *"), {
    target: { value: "con_1" },
  });
}

beforeEach(() => {
  /*
   * `cmdk` measures its list with `ResizeObserver` and scrolls the row the
   * arrow keys are on into view. jsdom implements neither, and without them the
   * persona picker's panel throws the moment it opens or a row is picked — the
   * second one silently, from inside `cmdk`, so the row's click simply did
   * nothing.
   *
   * Stubs rather than polyfills, for the reason `design-system.test.tsx` gives:
   * nothing here asserts a measurement or a scroll, and real ones would only
   * let these tests lean on layout jsdom never computes.
   */
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  sent = [];
  routed.push.mockReset();
  routed.pathname = "/projects/prj_1/tests";
  routed.params = { projectId: "prj_1" };
  routed.search = "";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, replace: vi.fn() },
  });
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the suite-first Tests route", () => {
  it("creates the first suite before offering a place to write tests", async () => {
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/test-suites": [
        { status: 200, body: { testSuites: [], nextPageToken: null } },
        {
          status: 201,
          body: {
            id: "ste_1",
            projectId: "prj_1",
            name: "Northside Ford",
            createdAt: "2026-08-21T10:00:00.000Z",
            updatedAt: "2026-08-21T10:00:00.000Z",
          },
        },
      ],
    });

    render(<TestsPage />);

    expect(await screen.findByText("No test suites yet")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Write a test" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create suite" }));
    const dialog = await screen.findByRole("dialog", { name: "Create a suite" });
    fireEvent.change(within(dialog).getByLabelText("Suite name"), {
      target: { value: "Northside Ford" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create suite" }));

    await waitFor(() => {
      expect(
        sent.filter((request) => request.path === "/v1/test-suites" && request.method === "POST"),
      ).toEqual([
        { path: "/v1/test-suites", method: "POST", body: { name: "Northside Ford" } },
      ]);
    });
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/tests/suites/ste_1");
  });

  it("opens an empty suite on one way in, and one way to run it", async () => {
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": { status: 200, body: { tests: [], nextPageToken: null } },
    });

    render(<TestSuitePage />);

    expect(await screen.findByRole("heading", { name: "Northside Ford" })).toBeTruthy();
    // The trailing ⋮ lane is named out loud, like every other column.
    for (const header of [
      "Name",
      "Scenario",
      "Expected behaviors",
      "Personas",
      "Actions",
    ]) {
      expect(screen.getByRole("columnheader", { name: header }), header).toBeTruthy();
    }
    /*
     * An empty suite draws no faint picture of a test. That teaching row was
     * clicked instead of the line under it, because a row of grey words in a
     * grid of editable cells looks like a cell to type in and answered nothing
     * (developer decision, 2026-08-26).
     */
    expect(screen.queryByText("One situation to put the agent in…")).toBeNull();
    expect(screen.queryByText("…and who calls.")).toBeNull();

    // The one way in, and it opens the row where the row will stand — with
    // the caret already in it, which is what made the ghost row look editable.
    fireEvent.click(screen.getByRole("button", { name: "+ Write a test" }));
    const name = screen.getByLabelText("Name");
    expect(name).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(name));

    // Run suite stands over the tests it runs, and goes to the run builder
    // carrying this suite.
    expect(
      screen.getByRole("link", { name: "Run suite" }).getAttribute("href"),
    ).toBe("/projects/prj_1/runs/new?suite=ste_1");

    // Rename and Delete suite stay on the suites list, and there is no toolbar
    // ⋮ here to hold them.
    expect(screen.queryByRole("button", { name: "Write a test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open the suite menu" })).toBeNull();
  });

  /**
   * The one state that would otherwise say nothing at all.
   *
   * An author reads an empty suite off the line that writes the first test.
   * A viewer has no such line, so the grid was column headings over nothing —
   * neither what is here nor why it cannot be added to.
   */
  it("tells a viewer why an empty suite is empty for them", async () => {
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": { status: 200, body: { tests: [], nextPageToken: null } },
    });

    render(<TestSuitePage />);

    expect(
      await screen.findByText(
        "Your viewer role cannot write tests. Ask an organization admin to change your role.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ Write a test" })).toBeNull();
  });

  it("lets a viewer read a suite while every test write stays inert", async () => {
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": {
        status: 200,
        body: { tests: [testBody({ personas: [PERSONA] })], nextPageToken: null },
      },
    });

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();

    // A viewer's grid never wakes: no ghost row to write into, no toolbar
    // button standing in for it, and a click on a cell leaves the cell as it
    // was.
    expect(screen.queryByRole("button", { name: "+ Write a test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Write a test" })).toBeNull();
    fireEvent.click(screen.getByText("The caller books service."));
    expect(screen.queryByLabelText("Scenario")).toBeNull();
    expect(sent.some((request) => ["POST", "PATCH", "DELETE"].includes(request.method))).toBe(
      false,
    );
  });

  it("keeps duplicate suite names unchanged and identifies each row", async () => {
    const dates = {
      createdAt: "2026-08-21T10:00:00.000Z",
      updatedAt: "2026-08-21T10:00:00.000Z",
    };
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/test-suites": {
        status: 200,
        body: {
          testSuites: [
            { id: "ste_1", projectId: "prj_1", name: "Northside Ford", ...dates },
            { id: "ste_2", projectId: "prj_1", name: "Northside Ford", ...dates },
          ],
          nextPageToken: null,
        },
      },
    });

    render(<TestsPage />);

    expect(await screen.findAllByRole("link", { name: "Northside Ford" })).toHaveLength(2);
    expect(screen.getByText("ste_1")).toBeTruthy();
    expect(screen.getByText("ste_2")).toBeTruthy();
  });

  it("starts with only the suite and agent, then reveals their dependent choices", async () => {
    routed.pathname = "/projects/prj_1/runs/new";
    routed.params = { projectId: "prj_1" };
    runBuilderAnswers();

    render(<NewRunPage />);

    expect(
      await screen.findByRole("heading", { name: "Runs", hidden: true }),
    ).toBeTruthy();
    const sheet = await screen.findByRole("dialog", { name: "Create a run" });
    await waitFor(() => expect(document.activeElement).toBe(sheet));
    expect(sheet.style.outline).toBe("none");
    expect(Number.parseFloat(sheet.style.outlineOffset)).toBe(0);
    expect(within(sheet).getByRole("button", { name: "Close" })).not.toBe(
      document.activeElement,
    );
    expect(within(sheet).getByText("Run one test suite against one agent.")).toBeTruthy();
    const suite = within(sheet).getByLabelText("Test suite *");
    const agent = within(sheet).getByLabelText("Agent *");
    expect(suite.getAttribute("aria-required")).toBe("true");
    expect(agent.getAttribute("aria-required")).toBe("true");
    expect(suite.getAttribute("data-slot")).toBe("select");
    expect(agent.getAttribute("data-slot")).toBe("select");
    expect(suite.className).not.toContain("appearance-none");
    expect(agent.className).not.toContain("appearance-none");
    expect(sheet.querySelector('[data-slot="run-select-chevron"]')).toBeNull();
    expect(within(sheet).queryByLabelText("Connection *")).toBeNull();
    expect(screen.queryByLabelText("Run name [optional]")).toBeNull();
    expect(screen.queryByText("Choose an agent first.")).toBeNull();
    const body = sheet.querySelector('[data-slot="sheet-body"]');
    const footer = sheet.querySelector('[data-slot="sheet-footer"]');
    expect(body?.className).toContain("gap-6");
    expect(body?.className).toContain("p-6");
    expect(footer?.className).toContain("justify-end");
    expect(
      within(footer as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Start run"]);
    expect((within(sheet).getByRole("button", { name: "Start run" }) as HTMLButtonElement).disabled)
      .toBe(true);

    fireEvent.change(within(sheet).getByLabelText("Agent *"), {
      target: { value: "agt_1" },
    });
    const connection = await within(sheet).findByLabelText("Connection *");
    expect(connection.getAttribute("aria-required")).toBe("true");
    expect(
      within(sheet).getByRole("option", { name: "Production · Voice" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Run name [optional]")).toBeNull();

    fireEvent.change(within(sheet).getByLabelText("Connection *"), {
      target: { value: "con_1" },
    });
    expect(screen.getByLabelText("Run name [optional]")).toBeTruthy();
    expect(screen.queryByText("Leave blank to use the test suite name.")).toBeNull();
    expect((within(sheet).getByRole("button", { name: "Start run" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("says what the chosen connection will do with the suite's own test data", async () => {
    // The note reads the tests, not the connection's own settings: mock tools
    // and env belong to the test now. A web call that some test mocks makes
    // one temporary version, and the note says so before the run starts.
    routed.pathname = "/projects/prj_1/runs/new";
    routed.params = { projectId: "prj_1" };
    runBuilderAnswers({
      connections: [
        {
          id: "con_1",
          name: "Web call",
          productLabel: "Retell web call",
          connectionType: "retell_web_call",
          accessVariant: "retell_web_call.api_key",
          modality: "voice",
          environment: null,
          archived: false,
        },
      ],
      tests: [
        testBody({
          id: "tst_1",
          mockTools: [{ tool: "get_availability", answer: { slots: [] } }],
        }),
        testBody({ id: "tst_2" }),
      ],
    });

    const { unmount } = render(<NewRunPage />);
    const sheet = await screen.findByRole("dialog", { name: "Create a run" });
    fireEvent.change(within(sheet).getByLabelText("Test suite *"), {
      target: { value: "ste_1" },
    });
    fireEvent.change(within(sheet).getByLabelText("Agent *"), {
      target: { value: "agt_1" },
    });
    await within(sheet).findByLabelText("Connection *");
    fireEvent.change(within(sheet).getByLabelText("Connection *"), {
      target: { value: "con_1" },
    });

    const note = await waitFor(() => {
      const held = sheet.querySelector('[data-slot="run-note"]');
      if (held === null) throw new Error("no run note yet");
      return held;
    });
    expect([...note.querySelectorAll("p")].map((line) => line.textContent)).toEqual([
      "This run creates one temporary version of your Retell agent.",
      "egma makes it at run start, points only the mocked tools at egma, and deletes it when the run ends. Your serving version is never changed.",
      "1 of 2 tests carry mock tools. In those simulations, tools the test does not mock reach your real backend. The other 1 tests run on your serving version with all real tools.",
    ]);
    // The old per-connection lane note is gone, switch and all.
    expect(sheet.querySelector('[data-slot="run-lane-note"]')).toBeNull();

    unmount();
    cleanup();
    runBuilderAnswers({
      connections: [
        {
          id: "con_1",
          name: "Room",
          productLabel: "LiveKit room",
          connectionType: "livekit_room",
          accessVariant: "livekit_room.project_credentials",
          modality: "voice",
          environment: null,
          archived: false,
        },
      ],
    });

    render(<NewRunPage />);
    const room = await screen.findByRole("dialog", { name: "Create a run" });
    fireEvent.change(within(room).getByLabelText("Test suite *"), {
      target: { value: "ste_1" },
    });
    fireEvent.change(within(room).getByLabelText("Agent *"), {
      target: { value: "agt_1" },
    });
    await within(room).findByLabelText("Connection *");
    fireEvent.change(within(room).getByLabelText("Connection *"), {
      target: { value: "con_1" },
    });
    // A suite whose tests carry nothing has nothing to be told about.
    expect(await screen.findByLabelText("Run name [optional]")).toBeTruthy();
    expect(room.querySelector('[data-slot="run-note"]')).toBeNull();
  });

  it("distinguishes legacy LiveKit chat and voice names in the run picker", async () => {
    routed.pathname = "/projects/prj_1/runs/new";
    routed.params = { projectId: "prj_1" };
    runBuilderAnswers({
      connections: [
        {
          id: "con_chat",
          name: "livekit_room-1",
          productLabel: "LiveKit chat",
          modality: "chat",
          environment: null,
          archived: false,
        },
        {
          id: "con_voice",
          name: "livekit_room-2",
          productLabel: "LiveKit project credentials",
          modality: "voice",
          environment: null,
          archived: false,
        },
      ],
    });

    render(<NewRunPage />);
    fireEvent.change(await screen.findByLabelText("Agent *"), {
      target: { value: "agt_1" },
    });

    expect(
      await screen.findByRole("option", { name: "livekit_room-1 · Chat" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "livekit_room-2 · Voice" }),
    ).toBeTruthy();
  });

  it.each(["Close", "Cancel"])(
    "%s returns the clean Create run sheet to Runs",
    async (control) => {
      routed.pathname = "/projects/prj_1/runs/new";
      routed.params = { projectId: "prj_1" };
      runBuilderAnswers();

      render(<NewRunPage />);

      const sheet = await screen.findByRole("dialog", { name: "Create a run" });
      fireEvent.click(within(sheet).getByRole("button", { name: control }));
      expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/runs");
    },
  );

  it("keeps a changed run draft until its discard is confirmed", async () => {
    routed.pathname = "/projects/prj_1/runs/new";
    routed.params = { projectId: "prj_1" };
    runBuilderAnswers();

    render(<NewRunPage />);

    const sheet = await screen.findByRole("dialog", { name: "Create a run" });
    fireEvent.change(within(sheet).getByLabelText("Test suite *"), {
      target: { value: "ste_1" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));

    expect(routed.push).not.toHaveBeenCalled();
    const warning = await screen.findByRole("dialog", {
      name: "Leave without saving?",
    });
    fireEvent.click(within(warning).getByRole("button", { name: "Discard changes" }));
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/runs");
  });

  it("renames and permanently deletes a suite from the suites list row menu", async () => {
    routed.pathname = "/projects/prj_1/tests";
    routed.params = { projectId: "prj_1" };
    const original = suiteBody();
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/test-suites": {
        status: 200,
        body: { testSuites: [original], nextPageToken: null },
      },
      "/v1/test-suites/ste_1": [
        {
          status: 200,
          body: { ...original, name: "Northside Ford Service" },
        },
        { status: 204, body: null },
      ],
    });

    render(<TestsPage />);
    expect(await screen.findByRole("link", { name: "Northside Ford" })).toBeTruthy();

    // Suite management is here and only here: Rename, Run suite, Delete suite,
    // with no Open — the row's own name is the way in — and no Copy suite id.
    fireEvent.click(screen.getByRole("button", { name: "Open the menu for Northside Ford" }));
    expect(
      (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    ).toEqual(["Rename", "Run suite", "Delete suite"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    // The rename surface is a side sheet named by the suite it is about, so
    // the list behind it stays on screen while the name is changed.
    const rename = await screen.findByRole("dialog", { name: "Northside Ford" });
    fireEvent.change(within(rename).getByLabelText("Suite name"), {
      target: { value: "Northside Ford Service" },
    });
    fireEvent.click(within(rename).getByRole("button", { name: "Save name" }));

    await waitFor(() => {
      expect(sent.find((request) => request.method === "PATCH")).toEqual({
        path: "/v1/test-suites/ste_1",
        method: "PATCH",
        body: { name: "Northside Ford Service" },
      });
    });

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Open the menu for Northside Ford" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete suite" }));
    const deletion = await screen.findByRole("dialog", {
      name: "Delete Northside Ford?",
    });
    expect(
      within(deletion).getByText(
        "This deletes the suite and its tests. Nobody can author or run them after this.",
      ),
    ).toBeTruthy();
    expect(
      within(deletion).getByText(
        "Runs that already happened keep their results and transcripts.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(deletion).getByRole("button", { name: "Delete suite" }));

    await waitFor(() => {
      expect(sent.find((request) => request.method === "DELETE")).toEqual({
        path: "/v1/test-suites/ste_1",
        method: "DELETE",
        body: undefined,
      });
    });
  });

  it("leads the suites screen with Run a suite and shows exactly Name and Created", async () => {
    routed.pathname = "/projects/prj_1/tests";
    routed.params = { projectId: "prj_1" };
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/test-suites": {
        status: 200,
        body: { testSuites: [suiteBody()], nextPageToken: null },
      },
    });

    render(<TestsPage />);

    expect(await screen.findByRole("link", { name: "Northside Ford" })).toBeTruthy();
    expect(
      screen
        .getAllByRole("columnheader")
        .map((header) => header.textContent)
        .filter((header) => header !== "Suite actions"),
    ).toEqual(["Name", "Created"]);
    // Running is the screen's first verb, and it reaches the run builder with
    // no suite chosen — the builder is the screen that picks one.
    expect(screen.getByRole("link", { name: "Run a suite" }).getAttribute("href")).toBe(
      "/projects/prj_1/runs/new",
    );
    expect(screen.getByRole("button", { name: "Create suite" })).toBeTruthy();
  });

  it("commits one cell alone, carrying the version it read", async () => {
    gridAnswers({
      saved: {
        status: 200,
        body: testBody({
          personas: [PERSONA],
          scenario: "The caller books the next service slot.",
          version: 2,
          versionId: "tstv_2",
        }),
      },
    });

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    fireEvent.click(screen.getByText("The caller books service."));
    const scenario = screen.getByLabelText("Scenario");
    fireEvent.change(scenario, {
      target: { value: "The caller books the next service slot." },
    });
    fireEvent.keyDown(scenario, { key: "Enter" });
    // Enter causes the blur that follows it, and that blur commits the very
    // same value. One save, not two — this is the double-fire the same-cell
    // guard exists for, and the only commit it is allowed to drop.
    fireEvent.blur(scenario);

    await waitFor(() => {
      expect(
        sent.filter((request) => request.method === "PATCH"),
      ).toEqual([
        {
          path: "/v1/tests/tst_1",
          method: "PATCH",
          // One field, and the version it was read at. Nothing else travels,
          // so the stored name, behaviors and personas keep their values.
          body: {
            scenario: "The caller books the next service slot.",
            expectedVersionId: "tstv_1",
          },
        },
      ]);
    });
  });

  it("refuses in place a cell save that would empty a mandatory field", async () => {
    gridAnswers();

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    fireEvent.click(screen.getByText("The caller books service."));
    const scenario = screen.getByLabelText("Scenario");
    fireEvent.change(scenario, { target: { value: "   " } });
    fireEvent.keyDown(scenario, { key: "Enter" });

    expect(
      await screen.findByText(
        "A test needs a scenario: the situation the agent is put in. The stored scenario stands.",
      ),
    ).toBeTruthy();
    expect(sent.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("cannot save an entry row early, and writes exactly one test when it is whole", async () => {
    gridAnswers({
      tests: [],
      created: {
        status: 201,
        body: testBody({ personas: [PERSONA], name: "Books service" }),
      },
    });

    render(<TestSuitePage />);

    fireEvent.click(await screen.findByRole("button", { name: "+ Write a test" }));

    const save = screen.getByRole("button", { name: "Save test" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        "Needs a name, a scenario, one expected behavior, and one persona.",
      ),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Books service" },
    });
    fireEvent.change(screen.getByLabelText("Scenario"), {
      target: { value: "The caller books service." },
    });
    fireEvent.change(screen.getByLabelText("Expected behavior 1"), {
      target: { value: "Offers an available time" },
    });

    // The sentence shortens as the row fills, and it is always true.
    expect(await screen.findByText("Needs one persona.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save test" }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "+ Add a persona" }));
    fireEvent.click(await screen.findByRole("option", { name: "Impatient Rita" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(screen.queryByText("Needs one persona.")).toBeNull();
    });
    const ready = screen.getByRole("button", { name: "Save test" });
    expect((ready as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(ready);

    await waitFor(() => {
      expect(
        sent.filter((request) => request.path === "/v1/tests" && request.method === "POST"),
      ).toEqual([
        {
          path: "/v1/tests",
          method: "POST",
          body: {
            suiteId: "ste_1",
            name: "Books service",
            scenario: "The caller books service.",
            expectedBehaviors: ["Offers an available time"],
            personas: ["prs_1"],
          },
        },
      ]);
    });
  });

  it("asks once before discarding what was typed into an entry row", async () => {
    gridAnswers({ tests: [] });

    render(<TestSuitePage />);

    fireEvent.click(await screen.findByRole("button", { name: "+ Write a test" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Books service" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const asked = await screen.findByRole("dialog", { name: "Discard this test?" });
    expect(
      within(asked).getByText(
        "What you typed is not saved.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(asked).getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Save test" })).toBeNull();
    });
    expect(sent.some((request) => request.method === "POST")).toBe(false);
  });

  it("deletes one test from its row menu, after naming what would go", async () => {
    gridAnswers({ removed: { status: 204, body: null } });

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the menu for Books service" }));
    // Two items: the one that makes another test, and the one that takes this
    // one away. The columns stay the test's own content.
    expect(
      (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    ).toEqual(["Duplicate", "Delete test"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete test" }));
    const asked = await screen.findByRole("dialog", { name: "Delete this test?" });
    expect(
      within(asked).getByText(
        "“Books service” leaves this suite. Nobody can author or run it after this.",
      ),
    ).toBeTruthy();
    expect(
      within(asked).getByText(
        "Runs that already ran it keep their results and transcripts.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(asked).getByRole("button", { name: "Delete test" }));

    await waitFor(() => {
      expect(sent.find((request) => request.method === "DELETE")).toEqual({
        path: "/v1/tests/tst_1",
        method: "DELETE",
        body: undefined,
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("Books service")).toBeNull();
    });
  });

  /**
   * **The two JSON fields, in a table that has to stay scannable.**
   *
   * A mock tool's answer is arbitrary JSON and an env is two nested objects.
   * Neither fits beside a scenario, so the cell carries one quiet summary and
   * the writing happens in the smallest dialog that holds an editor, a reason
   * and two buttons.
   */
  it("summarizes mock tools and env in their cells, and says nothing where there are none", async () => {
    gridAnswers({
      tests: [
        testBody({
          personas: [PERSONA],
          mockTools: [
            { tool: "get_availability", answer: { slots: [] } },
            { tool: "book", error: "calendar down" },
          ],
          env: {
            retell_dynamic_variables: { caller_name: "Margaret" },
            job_dispatch_metadata: { tenant: "acme" },
          },
        }),
        testBody({
          id: "tst_2",
          versionId: "tstv_2",
          name: "Cancels service",
          personas: [PERSONA],
          mockTools: [{ tool: "cancel", answer: true }],
        }),
      ],
    });

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual([
      "Name",
      "Scenario",
      "Expected behaviors",
      "Personas",
      "Mock tools",
      "Env",
      "Actions",
    ]);

    expect(screen.getByText("2 mock tools")).toBeTruthy();
    expect(
      screen.getByText("retell_dynamic_variables, job_dispatch_metadata"),
    ).toBeTruthy();
    // One is one, and a test with no env says nothing at all.
    expect(screen.getByText("1 mock tool")).toBeTruthy();
    const second = screen.getByRole("button", { name: "Env for Cancels service" });
    expect(second.textContent).toBe("");
  });

  it("refuses bad JSON in place, keeps the dialog open, and saves what the platform takes", async () => {
    gridAnswers({
      saved: {
        status: 200,
        body: testBody({
          personas: [PERSONA],
          version: 2,
          versionId: "tstv_2",
          mockTools: [{ tool: "get_availability", answer: { slots: [] } }],
        }),
      },
    });

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Mock tools for Books service" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Mock tools" });
    const editor = within(dialog).getByLabelText("Mock tools");
    // The example is the empty editor's own placeholder, not a stored value.
    expect(editor.getAttribute("placeholder")).toContain('"get_availability"');

    fireEvent.change(editor, { target: { value: "[{ tool: nope }]" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      (await within(dialog).findByRole("alert")).textContent,
    ).toContain("Not valid JSON:");
    expect(sent.some((request) => request.method === "PATCH")).toBe(false);
    // The dialog stays, with what was typed still in it to fix.
    expect(screen.getByRole("dialog", { name: "Mock tools" })).toBeTruthy();

    // A shape the platform refuses is refused here too, in its own words.
    fireEvent.change(editor, {
      target: { value: '[{ "tool": "book", "answer": 1, "error": "x" }]' },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      (await within(dialog).findByRole("alert")).textContent,
    ).toBe(
      'mock tool "book" answers with one thing: this one sent both answer and ' +
        "error. Send whichever branch the test needs.",
    );
    expect(sent.some((request) => request.method === "PATCH")).toBe(false);

    fireEvent.change(editor, {
      target: {
        value: '[{ "tool": "get_availability", "answer": { "slots": [] } }]',
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toEqual([
        {
          path: "/v1/tests/tst_1",
          method: "PATCH",
          body: {
            mockTools: [{ tool: "get_availability", answer: { slots: [] } }],
            expectedVersionId: "tstv_1",
          },
        },
      ]);
    });
    // The row shows what was saved, and the dialog is gone.
    expect(await screen.findByText("1 mock tool")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Mock tools" })).toBeNull();
  });

  it("shows the platform's own refusal of an env in place", async () => {
    const REFUSED =
      'env.retell_dynamic_variables names "egma_caller", and Egma keeps every ' +
      'variable beginning "egma_" for the facts it writes into the ' +
      "conversation itself. Name the variable something else.";
    gridAnswers({
      saved: {
        status: 422,
        body: { error: "unprocessable", message: REFUSED },
      },
    });

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Env for Books service" }));
    const dialog = await screen.findByRole("dialog", { name: "Env" });
    // Read here first, in the platform's own sentence, so no round trip is
    // needed to learn that the prefix is kept back.
    fireEvent.change(within(dialog).getByLabelText("Env"), {
      target: {
        value: '{ "retell_dynamic_variables": { "egma_caller": "Margaret" } }',
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(REFUSED);
    expect(sent.some((request) => request.method === "PATCH")).toBe(false);

    // And a refusal that only the platform can make is shown in the same
    // place, with the dialog and the words still standing.
    fireEvent.change(within(dialog).getByLabelText("Env"), {
      target: {
        value: '{ "retell_dynamic_variables": { "caller_name": "Margaret" } }',
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent.some((request) => request.method === "PATCH")).toBe(true);
    });
    expect((await within(dialog).findByRole("alert")).textContent).toBe(REFUSED);
    expect(screen.getByRole("dialog", { name: "Env" })).toBeTruthy();
  });

  it("duplicates a test into a prefilled entry row below it, and writes nothing until Save", async () => {
    gridAnswers({
      tests: [
        testBody({
          personas: [PERSONA],
          mockTools: [{ tool: "book", error: "calendar down" }],
          env: { job_dispatch_metadata: { tenant: "acme" } },
        }),
      ],
    });

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Open the menu for Books service" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));

    const entry = await waitFor(() => {
      const held = document.querySelector("tr[data-entry-row]");
      if (held === null) throw new Error("no entry row yet");
      return held as HTMLTableRowElement;
    });
    // Directly under the row it came from, so the copy appears where the eye
    // already is rather than at the foot of the suite.
    const rows = [...(entry.parentElement?.children ?? [])];
    expect(rows.indexOf(entry)).toBe(1);

    expect((within(entry).getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Books service (copy)",
    );
    expect(
      (within(entry).getByLabelText("Scenario") as HTMLTextAreaElement).value,
    ).toBe("The caller books service.");
    expect(
      (within(entry).getByLabelText("Expected behavior 1") as HTMLInputElement)
        .value,
    ).toBe("Offers an available time");
    expect(within(entry).getByText("Impatient Rita")).toBeTruthy();
    // The content the platform stores travels whole, mock tools and env too.
    expect(within(entry).getByText("1 mock tool")).toBeTruthy();
    expect(within(entry).getByText("job_dispatch_metadata")).toBeTruthy();

    // Nothing has been written, and Cancel leaves the sheet exactly as it was.
    expect(sent.some((request) => request.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const asked = await screen.findByRole("dialog", { name: "Discard this test?" });
    fireEvent.click(within(asked).getByRole("button", { name: "Discard" }));
    await waitFor(() => {
      expect(document.querySelector("tr[data-entry-row]")).toBeNull();
    });
    expect(sent.some((request) => request.method === "POST")).toBe(false);
    expect(screen.getByText("Books service")).toBeTruthy();
  });

  it("focuses the entry row from the ghost row and from the retired write address", async () => {
    gridAnswers({ tests: [] });

    render(<TestSuitePage />);

    // The grid's own ghost row, which is the only way in now: the entry row
    // opens with the caret in Name, and the address does not move.
    fireEvent.click(await screen.findByRole("button", { name: "+ Write a test" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    });
    expect(routed.push).not.toHaveBeenCalled();

    cleanup();
    sent = [];

    // The retired write address lands on the same row, in the same place.
    routed.pathname = "/projects/prj_1/tests/new";
    routed.params = { projectId: "prj_1" };
    routed.search = "suite=ste_1";
    gridAnswers({ tests: [] });
    routed.pathname = "/projects/prj_1/tests/new";
    routed.params = { projectId: "prj_1" };

    render(<NewTestPage />);

    expect(await screen.findByRole("button", { name: "Save test" })).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    });
  });

  it("keeps a cell's Escape inside that cell while an entry row is open", async () => {
    gridAnswers();

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ Write a test" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "A row in progress" },
    });

    // Wake an existing test's cell, type into it, and press Escape there.
    // Scoped to that row: the open entry row has cells of the same names.
    const row = screen.getByText("The caller books service.").closest("tr");
    if (row === null) throw new Error("the test's row is not on screen");
    fireEvent.click(within(row).getByText("The caller books service."));
    const scenario = within(row).getByLabelText("Scenario");
    fireEvent.change(scenario, { target: { value: "Something else entirely." } });
    fireEvent.keyDown(scenario, { key: "Escape" });

    // The cell reverted and nothing was sent; the entry row is untouched and
    // no discard dialog was raised over a row nobody asked to throw away.
    expect(screen.getByText("The caller books service.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Save test" })).toBeTruthy();
    expect(
      (screen.getAllByLabelText("Name")[0] as HTMLInputElement).value,
    ).toBe("A row in progress");
    expect(sent.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("opens one persona picker at a time", async () => {
    gridAnswers();

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ Write a test" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add a persona" }));
    expect(await screen.findAllByRole("dialog", { name: "Choose personas" })).toHaveLength(1);

    // Waking the row's own Personas cell opens its picker and leaves exactly
    // one standing — the entry row's does not survive beside it.
    const written = screen.getByText("Books service").closest("tr");
    if (written === null) throw new Error("the test's row is not on screen");
    fireEvent.click(within(written).getByText("Impatient Rita"));
    fireEvent.click(within(written).getByRole("button", { name: "+ Add a persona" }));

    await waitFor(() => {
      expect(screen.getAllByRole("dialog", { name: "Choose personas" })).toHaveLength(1);
    });
  });

  it("commits an open picker before the other row's trigger takes the picking", async () => {
    const CALM = { id: "prs_2", name: "Calm Ben", archivedAt: null };
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": {
        status: 200,
        body: { tests: [testBody({ personas: [PERSONA] })], nextPageToken: null },
      },
      "/v1/tests/tst_1": {
        status: 200,
        body: testBody({
          personas: [PERSONA, CALM],
          version: 2,
          versionId: "tstv_2",
        }),
      },
      "/v1/personas": {
        status: 200,
        body: { personas: [PERSONA, CALM], nextPageToken: null },
      },
    });

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "+ Write a test" }));

    // Wake the stored row's Personas cell, open its picker, tick a second
    // caller there. Nothing is saved yet — Done is what saves.
    const written = screen.getByText("Books service").closest("tr");
    if (written === null) throw new Error("the test's row is not on screen");
    fireEvent.click(within(written).getByText("Impatient Rita"));
    fireEvent.click(within(written).getByRole("button", { name: "+ Add a persona" }));
    fireEvent.click(await screen.findByRole("option", { name: "Calm Ben" }));
    expect(sent.some((request) => request.method === "PATCH")).toBe(false);

    // Now press the *entry row's* trigger. It wears the same picker marker, so
    // an unowned marker read this as a click inside the open picker: the
    // picking moved and the tick above went with no save and no word said.
    const entryRow = screen.getByLabelText("Name").closest("tr");
    if (entryRow === null) throw new Error("the entry row is not on screen");
    const entryTrigger = within(entryRow).getByRole("button", {
      name: "+ Add a persona",
    });
    /*
     * A real press is a pointerdown before the click, and pointerdown is what
     * the popover dismisses on. The two lines below it are the rest of that one
     * press, not a second one.
     */
    /*
     * A real press is a pointerdown before the click, and pointerdown is what
     * dismisses the open panel. The lines below it are the rest of that one
     * press, not a second one.
     */
    fireEvent.pointerDown(entryTrigger);
    fireEvent.mouseDown(entryTrigger);
    fireEvent.click(entryTrigger);

    // The press dismissed the open picker, and nothing is standing behind it.
    expect(screen.queryAllByRole("dialog", { name: "Choose personas" })).toHaveLength(0);

    // The mousedown ran the open picker's Done first: exactly what the Done
    // button sends, carrying the version the cell read.
    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toEqual([
        {
          path: "/v1/tests/tst_1",
          method: "PATCH",
          body: { personas: ["prs_1", "prs_2"], expectedVersionId: "tstv_1" },
        },
      ]);
    });

    /*
     * …and that answer lands on a cell whose picking is long gone, so the entry
     * row is free to open its own and be the only one standing.
     *
     * **The press above dismissed rather than swapped, and that is this
     * renderer rather than the product.** In a browser one press on another
     * trigger closes the open panel and opens that one; jsdom is given the
     * three events by hand and the click that follows a dismissal does not
     * reach the trigger, so the swap takes a second press here. What the first
     * press had to prove — that shutting is what saves, and that the ticks went
     * with it — is proved above, and that is the defect this test is named for.
     *
     * Whose picker is open is read off the trigger, not off the row: the panel
     * is drawn in a portal now, which is what let the grid keep its sideways
     * scrolling, so `within(row)` can no longer see it.
     */
    fireEvent.click(entryTrigger);
    expect(screen.getAllByRole("dialog", { name: "Choose personas" })).toHaveLength(1);
    expect(entryTrigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("saves a name against the revision it read, not the version", async () => {
    gridAnswers({
      saved: {
        status: 200,
        body: testBody({ personas: [PERSONA], name: "Books a service", revision: "rev_2" }),
      },
    });

    render(<TestSuitePage />);

    // A blur commits exactly as Enter does, and a name is identity: it carries
    // the revision it was read at and mints no version.
    fireEvent.click(await screen.findByText("Books service"));
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Books a service" } });
    fireEvent.blur(name);

    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toEqual([
        {
          path: "/v1/tests/tst_1",
          method: "PATCH",
          body: { name: "Books a service", expectedRevision: "rev_1" },
        },
      ]);
    });
  });

  it("queues words typed after Enter when the caret leaves for another cell", async () => {
    // B is committed by Enter and its PATCH is held open. C is typed into the
    // same cell, and then the caret leaves for another cell — the blur commits
    // C, which is a real edit and not the resubmit the guard exists for.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": {
        status: 200,
        body: { tests: [testBody({ personas: [PERSONA] })], nextPageToken: null },
      },
      "/v1/tests/tst_1": [
        {
          status: 200,
          body: testBody({
            personas: [PERSONA],
            scenario: "B, sent by Enter.",
            version: 2,
            versionId: "tstv_2",
            revision: "rev_2",
          }),
          waitFor: held,
        },
        {
          status: 200,
          body: testBody({
            personas: [PERSONA],
            scenario: "C, typed after Enter.",
            version: 3,
            versionId: "tstv_3",
            revision: "rev_3",
          }),
        },
      ],
      "/v1/personas": {
        status: 200,
        body: { personas: [PERSONA], nextPageToken: null },
      },
    });

    render(<TestSuitePage />);

    const row = (await screen.findByText("Books service")).closest("tr");
    if (row === null) throw new Error("the test's row is not on screen");

    fireEvent.click(within(row).getByText("The caller books service."));
    const cell = within(row).getByLabelText("Scenario");
    fireEvent.change(cell, { target: { value: "B, sent by Enter." } });
    fireEvent.keyDown(cell, { key: "Enter" });

    // Keep typing in the same cell, then leave it for another one.
    fireEvent.change(cell, { target: { value: "C, typed after Enter." } });
    fireEvent.blur(cell);
    fireEvent.click(within(row).getByText("Books service"));

    // C is queued rather than dropped, so it waits for B and no more.
    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toHaveLength(1);
    });

    release();

    // Both land, and C carries the version B minted.
    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toEqual([
        {
          path: "/v1/tests/tst_1",
          method: "PATCH",
          body: { scenario: "B, sent by Enter.", expectedVersionId: "tstv_1" },
        },
        {
          path: "/v1/tests/tst_1",
          method: "PATCH",
          body: { scenario: "C, typed after Enter.", expectedVersionId: "tstv_2" },
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.getByText("C, typed after Enter.")).toBeTruthy();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("seeds a re-woken cell from its own unfinished save, so a blur reverts nothing", async () => {
    // B is typed over A and committed; the PATCH is held open. The cell is
    // left and entered again while that save is still in flight — the row
    // still shows A, because A is exactly what the save is replacing.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": {
        status: 200,
        body: { tests: [testBody({ personas: [PERSONA] })], nextPageToken: null },
      },
      "/v1/tests/tst_1": {
        status: 200,
        body: testBody({
          personas: [PERSONA],
          scenario: "B, the newer words.",
          version: 2,
          versionId: "tstv_2",
          revision: "rev_2",
        }),
        waitFor: held,
      },
      "/v1/personas": {
        status: 200,
        body: { personas: [PERSONA], nextPageToken: null },
      },
    });

    render(<TestSuitePage />);

    const row = (await screen.findByText("Books service")).closest("tr");
    if (row === null) throw new Error("the test's row is not on screen");

    // Type B over A and commit it. The request hangs.
    fireEvent.click(within(row).getByText("The caller books service."));
    const first = within(row).getByLabelText("Scenario");
    fireEvent.change(first, { target: { value: "B, the newer words." } });
    fireEvent.keyDown(first, { key: "Enter" });

    // Leave the cell and come back into it while the save is still in flight.
    fireEvent.click(within(row).getByText("Books service"));
    fireEvent.click(within(row).getByText("The caller books service."));

    // The seed itself: the woken cell holds B — what the person last meant —
    // and not A, which is only what the row has not caught up with yet.
    const again = within(row).getByLabelText("Scenario") as HTMLTextAreaElement;
    expect(again.value).toBe("B, the newer words.");

    // Blur without typing a thing, then let the first save answer.
    fireEvent.blur(again);
    release();

    // Nothing second goes out: the blur committed a value already stored, and
    // the unchanged path absorbed it. A revert would have been a second PATCH.
    await waitFor(() => {
      expect(screen.getByText("B, the newer words.")).toBeTruthy();
    });
    expect(sent.filter((request) => request.method === "PATCH")).toEqual([
      {
        path: "/v1/tests/tst_1",
        method: "PATCH",
        body: { scenario: "B, the newer words.", expectedVersionId: "tstv_1" },
      },
    ]);
    expect(screen.queryByText("The caller books service.")).toBeNull();
  });

  it("leaves a re-woken cell alone when the save it started answers late", async () => {
    // Scenario is committed and its PATCH is held open. The cell is left and
    // entered again — a new edit session over the same two coordinates — and
    // typed into. The answer from the first session must neither close that
    // session nor put the older saved value back over what is being typed.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": {
        status: 200,
        body: { tests: [testBody({ personas: [PERSONA] })], nextPageToken: null },
      },
      "/v1/tests/tst_1": [
        {
          status: 200,
          body: testBody({
            personas: [PERSONA],
            scenario: "First saved value.",
            version: 2,
            versionId: "tstv_2",
            revision: "rev_2",
          }),
          waitFor: held,
        },
        {
          status: 200,
          body: testBody({
            personas: [PERSONA],
            scenario: "Second session's words.",
            version: 3,
            versionId: "tstv_3",
            revision: "rev_3",
          }),
        },
      ],
      "/v1/personas": {
        status: 200,
        body: { personas: [PERSONA], nextPageToken: null },
      },
    });

    render(<TestSuitePage />);

    const row = (await screen.findByText("Books service")).closest("tr");
    if (row === null) throw new Error("the test's row is not on screen");

    // Session one: type, and commit by Enter. The request hangs.
    fireEvent.click(within(row).getByText("The caller books service."));
    const first = within(row).getByLabelText("Scenario");
    fireEvent.change(first, { target: { value: "First saved value." } });
    fireEvent.keyDown(first, { key: "Enter" });

    // Leave the cell and come back to it: a second session over the same cell.
    // The save has not landed, so the cell still shows the stored value.
    fireEvent.click(within(row).getByText("Books service"));
    fireEvent.click(within(row).getByText("The caller books service."));
    const second = within(row).getByLabelText("Scenario");
    fireEvent.change(second, { target: { value: "Second session's words." } });

    // The first save answers. The second session keeps its wake and its words.
    release();
    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toHaveLength(1);
    });
    const stillOpen = within(row).getByLabelText("Scenario") as HTMLTextAreaElement;
    expect(stillOpen.value).toBe("Second session's words.");
    expect(screen.queryByRole("alert")).toBeNull();

    // And when that session commits, it saves the newer words against the
    // version the first save minted.
    fireEvent.keyDown(stillOpen, { key: "Enter" });
    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toHaveLength(2);
    });
    expect(sent.filter((request) => request.method === "PATCH")[1]).toEqual({
      path: "/v1/tests/tst_1",
      method: "PATCH",
      body: {
        scenario: "Second session's words.",
        expectedVersionId: "tstv_2",
      },
    });
    await waitFor(() => {
      expect(screen.getByText("Second session's words.")).toBeTruthy();
    });
  });

  it("keeps words typed after Enter, rather than closing the cell over them", async () => {
    // The same promise one level in: Enter commits, the person carries on
    // typing in the cell they never left, and the answer arrives. One session
    // throughout, so only the draft itself can say the answer is stale.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": {
        status: 200,
        body: { tests: [testBody({ personas: [PERSONA] })], nextPageToken: null },
      },
      "/v1/tests/tst_1": {
        status: 200,
        body: testBody({
          personas: [PERSONA],
          scenario: "What Enter sent.",
          version: 2,
          versionId: "tstv_2",
          revision: "rev_2",
        }),
        waitFor: held,
      },
      "/v1/personas": {
        status: 200,
        body: { personas: [PERSONA], nextPageToken: null },
      },
    });

    render(<TestSuitePage />);

    const row = (await screen.findByText("Books service")).closest("tr");
    if (row === null) throw new Error("the test's row is not on screen");
    fireEvent.click(within(row).getByText("The caller books service."));
    const cell = within(row).getByLabelText("Scenario");
    fireEvent.change(cell, { target: { value: "What Enter sent." } });
    fireEvent.keyDown(cell, { key: "Enter" });

    // Still in the cell, still typing, while the save is in flight.
    fireEvent.change(cell, { target: { value: "What Enter sent, and more." } });
    release();

    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toHaveLength(1);
    });
    // The cell is still open and still holds the newer words.
    const open = within(row).getByLabelText("Scenario") as HTMLTextAreaElement;
    expect(open.value).toBe("What Enter sent, and more.");
  });

  it("serializes two cells of one test, so the second carries the version the first minted", async () => {
    // Scenario is committed and its PATCH is held open. Behaviors of the SAME
    // test are then edited and blurred. Both carry a version guard, so sending
    // them together would hand the platform the same version twice and the
    // second would be refused for holding one the first had just replaced.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": {
        status: 200,
        body: { tests: [testBody({ personas: [PERSONA] })], nextPageToken: null },
      },
      "/v1/tests/tst_1": [
        {
          status: 200,
          body: testBody({
            personas: [PERSONA],
            scenario: "The caller books a service slot.",
            version: 2,
            versionId: "tstv_2",
            revision: "rev_2",
          }),
          waitFor: held,
        },
        {
          status: 200,
          body: testBody({
            personas: [PERSONA],
            scenario: "The caller books a service slot.",
            expectedBehaviors: ["Offers an available time", "Reads the price back"],
            version: 3,
            versionId: "tstv_3",
            revision: "rev_3",
          }),
        },
      ],
      "/v1/personas": {
        status: 200,
        body: { personas: [PERSONA], nextPageToken: null },
      },
    });

    render(<TestSuitePage />);

    const row = (await screen.findByText("Books service")).closest("tr");
    if (row === null) throw new Error("the test's row is not on screen");

    // Commit the scenario. Its request hangs.
    fireEvent.click(within(row).getByText("The caller books service."));
    const scenario = within(row).getByLabelText("Scenario");
    fireEvent.change(scenario, {
      target: { value: "The caller books a service slot." },
    });
    fireEvent.keyDown(scenario, { key: "Enter" });

    // Edit the behaviors of the same test and blur, while scenario is pending.
    fireEvent.click(within(row).getByText("Offers an available time"));
    fireEvent.click(within(row).getByRole("button", { name: "+ Add a behavior" }));
    fireEvent.change(within(row).getByLabelText("Expected behavior 2"), {
      target: { value: "Reads the price back" },
    });
    fireEvent.blur(within(row).getByLabelText("Expected behavior 2"));

    // The second request waits: one test saves in order, so nothing carries a
    // version another save has already replaced.
    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toHaveLength(1);
    });
    expect(sent.filter((request) => request.method === "PATCH")[0]).toEqual({
      path: "/v1/tests/tst_1",
      method: "PATCH",
      body: {
        scenario: "The caller books a service slot.",
        expectedVersionId: "tstv_1",
      },
    });

    release();

    // Then it goes, carrying the version the first save minted — so it lands
    // rather than being refused for holding a version that no longer exists.
    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toHaveLength(2);
    });
    expect(sent.filter((request) => request.method === "PATCH")[1]).toEqual({
      path: "/v1/tests/tst_1",
      method: "PATCH",
      body: {
        expectedBehaviors: ["Offers an available time", "Reads the price back"],
        expectedVersionId: "tstv_2",
      },
    });

    // Both values read back, and no refusal was ever shown.
    await waitFor(() => {
      expect(screen.getByText("The caller books a service slot.")).toBeTruthy();
    });
    expect(screen.getByText("Reads the price back")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends a second cell's edit while the first is still in flight", async () => {
    // A's PATCH is held open. B is committed while it hangs — two different
    // cells, each carrying only its own field and its own guard, so there is
    // nothing to serialize and nothing may be dropped.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": {
        status: 200,
        body: {
          tests: [
            testBody({ personas: [PERSONA] }),
            testBody({
              id: "tst_2",
              versionId: "tstv_2",
              revision: "rev_2",
              name: "Cancels service",
              scenario: "The caller cancels.",
              personas: [PERSONA],
            }),
          ],
          nextPageToken: null,
        },
      },
      "/v1/tests/tst_1": {
        status: 200,
        body: testBody({ personas: [PERSONA], scenario: "A saved late." }),
        waitFor: held,
      },
      "/v1/tests/tst_2": {
        status: 200,
        body: testBody({
          id: "tst_2",
          versionId: "tstv_2",
          revision: "rev_2",
          name: "Cancels service",
          scenario: "B saved while A hung.",
          personas: [PERSONA],
        }),
      },
      "/v1/personas": {
        status: 200,
        body: { personas: [PERSONA], nextPageToken: null },
      },
    });

    render(<TestSuitePage />);

    // Commit A by blurring it. Its request hangs.
    const rowA = (await screen.findByText("Books service")).closest("tr");
    if (rowA === null) throw new Error("row A is not on screen");
    fireEvent.click(within(rowA).getByText("The caller books service."));
    const scenarioA = within(rowA).getByLabelText("Scenario");
    fireEvent.change(scenarioA, { target: { value: "A saved late." } });
    fireEvent.keyDown(scenarioA, { key: "Enter" });

    // Wake B, type, and commit it while A is still pending.
    const rowB = screen.getByText("Cancels service").closest("tr");
    if (rowB === null) throw new Error("row B is not on screen");
    fireEvent.click(within(rowB).getByText("The caller cancels."));
    const scenarioB = within(rowB).getByLabelText("Scenario");
    fireEvent.change(scenarioB, { target: { value: "B saved while A hung." } });
    fireEvent.keyDown(scenarioB, { key: "Enter" });

    // B's request goes out at once rather than waiting on A or being dropped.
    await waitFor(() => {
      expect(
        sent.filter((request) => request.path === "/v1/tests/tst_2"),
      ).toEqual([
        {
          path: "/v1/tests/tst_2",
          method: "PATCH",
          body: {
            scenario: "B saved while A hung.",
            expectedVersionId: "tstv_2",
          },
        },
      ]);
    });

    release();

    // Both saves land, each carrying only its own field and its own guard.
    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toEqual([
        {
          path: "/v1/tests/tst_1",
          method: "PATCH",
          body: { scenario: "A saved late.", expectedVersionId: "tstv_1" },
        },
        {
          path: "/v1/tests/tst_2",
          method: "PATCH",
          body: {
            scenario: "B saved while A hung.",
            expectedVersionId: "tstv_2",
          },
        },
      ]);
    });

    // And both rows read back what was saved — nothing was lost on the way.
    await waitFor(() => {
      expect(screen.getByText("A saved late.")).toBeTruthy();
    });
    expect(screen.getByText("B saved while A hung.")).toBeTruthy();
  });

  it("lands a late cell save on its own cell, never on the one now being typed in", async () => {
    // A's PATCH is held open. While it hangs, the caret moves to B and types.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": {
        status: 200,
        body: {
          tests: [
            testBody({ personas: [PERSONA] }),
            testBody({
              id: "tst_2",
              versionId: "tstv_2",
              revision: "rev_2",
              name: "Cancels service",
              scenario: "The caller cancels.",
              personas: [PERSONA],
            }),
          ],
          nextPageToken: null,
        },
      },
      "/v1/tests/tst_1": {
        status: 200,
        body: testBody({ personas: [PERSONA], scenario: "A saved late." }),
        waitFor: held,
      },
      "/v1/personas": {
        status: 200,
        body: { personas: [PERSONA], nextPageToken: null },
      },
    });

    render(<TestSuitePage />);

    // Commit A — the request hangs.
    const rowA = (await screen.findByText("Books service")).closest("tr");
    if (rowA === null) throw new Error("row A is not on screen");
    fireEvent.click(within(rowA).getByText("The caller books service."));
    const scenarioA = within(rowA).getByLabelText("Scenario");
    fireEvent.change(scenarioA, { target: { value: "A saved late." } });
    fireEvent.keyDown(scenarioA, { key: "Enter" });

    // The caret moves to B and types, while A is still in flight.
    const rowB = screen.getByText("Cancels service").closest("tr");
    if (rowB === null) throw new Error("row B is not on screen");
    fireEvent.click(within(rowB).getByText("The caller cancels."));
    const scenarioB = within(rowB).getByLabelText("Scenario");
    fireEvent.change(scenarioB, { target: { value: "B, half typed" } });

    // Now A answers. B must keep both its wake and every word typed into it.
    release();
    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toHaveLength(1);
    });
    const stillB = screen.getByText("Cancels service").closest("tr");
    if (stillB === null) throw new Error("row B left the grid");
    expect((within(stillB).getByLabelText("Scenario") as HTMLTextAreaElement).value).toBe(
      "B, half typed",
    );
  });

  it("reads every page of personas, so a later one can be found and picked", async () => {
    const LATER = { id: "prs_2", name: "Careful Chris", archivedAt: null };
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": [
        { status: 200, body: { tests: [], nextPageToken: null } },
        {
          status: 201,
          body: testBody({ personas: [LATER], name: "Books service" }),
        },
      ],
      // Two pages, and the wanted persona is on the second one.
      "/v1/personas": [
        { status: 200, body: { personas: [PERSONA], nextPageToken: "prs_1" } },
        { status: 200, body: { personas: [LATER], nextPageToken: null } },
      ],
    });

    render(<TestSuitePage />);

    fireEvent.click(await screen.findByRole("button", { name: "+ Write a test" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add a persona" }));

    // A page-two persona is listed, findable by search, and pickable.
    expect(await screen.findByRole("option", { name: "Careful Chris" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Search personas" }), {
      target: { value: "Careful" },
    });
    expect(screen.queryByRole("option", { name: "Impatient Rita" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Careful Chris" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Books service" },
    });
    fireEvent.change(screen.getByLabelText("Scenario"), {
      target: { value: "The caller books service." },
    });
    fireEvent.change(screen.getByLabelText("Expected behavior 1"), {
      target: { value: "Offers an available time" },
    });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Save test" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));

    await waitFor(() => {
      expect(
        sent.find((request) => request.path === "/v1/tests" && request.method === "POST"),
      ).toMatchObject({ body: { personas: ["prs_2"] } });
    });
  });

  it("lands the retired test address on that test's suite grid", async () => {
    routed.pathname = "/projects/prj_1/tests/tst_1";
    routed.params = { projectId: "prj_1", testId: "tst_1" };
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/tests/tst_1": { status: 200, body: testBody({ personas: [PERSONA] }) },
    });

    render(<TestDetailPage />);

    await waitFor(() => {
      expect(routed.replace).toHaveBeenCalledWith(
        "/projects/prj_1/tests/suites/ste_1",
      );
    });
    // The full page is gone: nothing here edits the test it resolved.
    expect(screen.queryByLabelText("Scenario")).toBeNull();
  });

  it("keeps duplicate suite names and disambiguates them only in the run picker", async () => {
    routed.pathname = "/projects/prj_1/runs/new";
    routed.params = { projectId: "prj_1" };
    const dates = {
      createdAt: "2026-08-21T10:00:00.000Z",
      updatedAt: "2026-08-21T10:00:00.000Z",
    };
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/test-suites": {
        status: 200,
        body: {
          testSuites: [
            { id: "ste_1", projectId: "prj_1", name: "Northside Ford", ...dates },
            { id: "ste_2", projectId: "prj_1", name: "Northside Ford", ...dates },
          ],
          nextPageToken: null,
        },
      },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/runs": { status: 200, body: { runs: [], nextPageToken: null } },
    });

    render(<NewRunPage />);

    expect(await screen.findByRole("option", { name: "Northside Ford · ste_1" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Northside Ford · ste_2" })).toBeTruthy();
  });

  it("lets a viewer read the run builder while Start stays inert", async () => {
    routed.pathname = "/projects/prj_1/runs/new";
    routed.params = { projectId: "prj_1" };
    runBuilderAnswers({ role: "viewer" });

    render(<NewRunPage />);
    await chooseRunTarget();
    fireEvent.change(screen.getByLabelText("Run name [optional]"), {
      target: { value: "Viewer can inspect this intent" },
    });

    expect(screen.getByRole("option", { name: "Northside Ford" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Receptionist" })).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start run" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(start.getAttribute("title")).toContain("role cannot start a run");
    fireEvent.click(start);
    expect(sent.some((request) => request.path === "/v1/runs" && request.method === "POST"))
      .toBe(false);
  });

  it("refuses to start an empty suite", async () => {
    routed.pathname = "/projects/prj_1/runs/new";
    routed.params = { projectId: "prj_1" };
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/test-suites": {
        status: 200,
        body: {
          testSuites: [{
            id: "ste_1",
            projectId: "prj_1",
            name: "Northside Ford",
            createdAt: "2026-08-21T10:00:00.000Z",
            updatedAt: "2026-08-21T10:00:00.000Z",
          }],
          nextPageToken: null,
        },
      },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/tests": { status: 200, body: { tests: [], nextPageToken: null } },
      "/v1/runs": { status: 200, body: { runs: [], nextPageToken: null } },
    });

    render(<NewRunPage />);
    fireEvent.change(await screen.findByLabelText("Test suite *"), {
      target: { value: "ste_1" },
    });

    expect(
      (await screen.findAllByText(
        "This test suite is empty. Write at least one test before starting a run.",
      )).length,
    ).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(sent.some((request) => request.path === "/v1/runs" && request.method === "POST"))
      .toBe(false);
  });

  it("keeps one key and every input for a refused intent, then changes the key with the intent", async () => {
    routed.pathname = "/projects/prj_1/runs/new";
    routed.params = { projectId: "prj_1" };
    runBuilderAnswers({
      started: [
        { status: 502, body: { error: "unavailable", message: "Egma could not answer." } },
        { status: 502, body: { error: "unavailable", message: "Egma could not answer." } },
        {
          status: 201,
          body: {
            id: "run_1",
            projectId: "prj_1",
            status: "pending",
            suiteId: "ste_1",
            suiteName: "Northside Ford",
            suiteDeleted: false,
            name: "Evening check",
            expectedSimulationCount: 1,
          },
        },
      ],
    });

    render(<NewRunPage />);
    await chooseRunTarget();
    fireEvent.change(screen.getByLabelText("Run name [optional]"), {
      target: { value: "Morning check" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    expect(await screen.findByText("Egma could not answer.")).toBeTruthy();
    expect((screen.getByLabelText("Test suite *") as HTMLSelectElement).value).toBe("ste_1");
    expect((screen.getByLabelText("Agent *") as HTMLSelectElement).value).toBe("agt_1");
    expect((screen.getByLabelText("Connection *") as HTMLSelectElement).value).toBe("con_1");
    expect((screen.getByLabelText("Run name [optional]") as HTMLInputElement).value).toBe(
      "Morning check",
    );

    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => {
      expect(
        sent.filter((request) => request.path === "/v1/runs" && request.method === "POST"),
      ).toHaveLength(2);
    });
    fireEvent.change(screen.getByLabelText("Run name [optional]"), {
      target: { value: "Evening check" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => {
      expect(
        sent.filter((request) => request.path === "/v1/runs" && request.method === "POST"),
      ).toHaveLength(3);
    });

    const posts = sent.filter(
      (request) => request.path === "/v1/runs" && request.method === "POST",
    );
    const first = posts[0]?.body as Record<string, unknown>;
    const retry = posts[1]?.body as Record<string, unknown>;
    const changed = posts[2]?.body as Record<string, unknown>;
    expect(first).toMatchObject({
      suiteId: "ste_1",
      agentId: "agt_1",
      connectionId: "con_1",
      name: "Morning check",
    });
    expect(first.idempotencyKey).toBe(retry.idempotencyKey);
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(changed.name).toBe("Evening check");
    expect(first).not.toHaveProperty("label");
    expect(first).not.toHaveProperty("testVersions");
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/runs/run_1");
  });

  it("starts exactly one full suite without a test picker", async () => {
    routed.pathname = "/projects/prj_1/runs/new";
    routed.params = { projectId: "prj_1" };
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/test-suites": {
        status: 200,
        body: {
          testSuites: [{
            id: "ste_1",
            projectId: "prj_1",
            name: "Northside Ford",
            createdAt: "2026-08-21T10:00:00.000Z",
            updatedAt: "2026-08-21T10:00:00.000Z",
          }],
          nextPageToken: null,
        },
      },
      "/v1/agents": {
        status: 200,
        body: {
          agents: [{ id: "agt_1", name: "Receptionist", archived: false, connections: [] }],
          nextPageToken: null,
        },
      },
      "/v1/agents/agt_1": {
        status: 200,
        body: {
          agent: { id: "agt_1", name: "Receptionist", archived: false },
          connections: [{
            id: "con_1",
            name: "Production",
            productLabel: "Retell",
            modality: "voice",
            environment: "production",
            archived: false,
          }],
        },
      },
      "/v1/tests": {
        status: 200,
        body: {
          tests: [
            {
              id: "tst_1",
              suiteId: "ste_1",
              versionId: "tv_1",
              mockTools: [],
              env: null,
            },
          ],
          nextPageToken: null,
        },
      },
      "/v1/runs": [
        { status: 200, body: { runs: [], nextPageToken: null } },
        {
          status: 201,
          body: {
            id: "run_1",
            projectId: "prj_1",
            status: "pending",
            suiteId: "ste_1",
            suiteName: "Northside Ford",
            suiteDeleted: false,
            name: null,
            expectedSimulationCount: 2,
          },
        },
      ],
    });

    render(<NewRunPage />);
    await screen.findByRole("option", { name: "Northside Ford" });
    fireEvent.change(screen.getByLabelText("Test suite *"), { target: { value: "ste_1" } });
    fireEvent.change(screen.getByLabelText("Agent *"), { target: { value: "agt_1" } });
    await screen.findByRole("option", { name: "Production · Voice" });
    fireEvent.change(screen.getByLabelText("Connection *"), {
      target: { value: "con_1" },
    });

    expect(screen.queryByText(/select the tests/i)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      const body = sent.find((request) => request.path === "/v1/runs" && request.method === "POST")
        ?.body as Record<string, unknown> | undefined;
      expect(body).toMatchObject({
        suiteId: "ste_1",
        agentId: "agt_1",
        connectionId: "con_1",
      });
      expect(typeof body?.idempotencyKey).toBe("string");
      expect(body).not.toHaveProperty("name");
      expect(body).not.toHaveProperty("tests");
    });
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/runs/run_1");
  });
});

/**
 * One left edge per column, in the one table not drawn from the shared kit.
 *
 * `tests-grid.tsx` is a raw `<table>`, so it inherits nothing and had been
 * reading from 10px where every other list in the product reads from
 * `--row-padding-x`. This asserts the token on the header and on the cell's
 * own padded box, which is what stops the grid drifting off the lane again.
 */
describe("the suite grid's columns", () => {
  const LANE = "px-(--row-padding-x)";

  it("reads from the same edge as every other table in the product", async () => {
    gridAnswers();

    render(<TestSuitePage />);

    const name = await screen.findByText("Books service");
    for (const header of screen.getAllByRole("columnheader")) {
      expect(header.className, header.textContent ?? "").toContain(LANE);
    }
    const padded = name.closest("td")?.firstElementChild;
    /* Named rather than cast: a missing box should say which box is missing,
     * not read a property off `undefined` three lines later. */
    expect(padded, "the name cell's padded box").toBeInstanceOf(HTMLElement);
    expect((padded as HTMLElement).className).toContain(LANE);
  });
});
