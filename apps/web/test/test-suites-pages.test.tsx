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
    overrideCount: 0,
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
} = {}): void {
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
      body: { tests: [testBody()], nextPageToken: null },
    },
    "/v1/runs": options.started ?? {
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
    },
  });
}

async function chooseRunTarget(): Promise<void> {
  fireEvent.change(await screen.findByLabelText("Test suite"), {
    target: { value: "ste_1" },
  });
  fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "agt_1" } });
  await screen.findByRole("option", { name: /Production/ });
  fireEvent.change(screen.getByLabelText("Connection"), { target: { value: "con_1" } });
}

beforeEach(() => {
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

  it("teaches the first test in the grid and carries only Write a test", async () => {
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": { status: 200, body: { tests: [], nextPageToken: null } },
    });

    render(<TestSuitePage />);

    expect(await screen.findByRole("heading", { name: "Northside Ford" })).toBeTruthy();
    for (const header of ["Name", "Scenario", "Expected behaviors", "Personas"]) {
      expect(screen.getByRole("columnheader", { name: header }), header).toBeTruthy();
    }
    // An empty suite is the grid and one teaching row, not an empty-state card.
    expect(screen.getByText("One situation to put the agent in…")).toBeTruthy();
    expect(screen.getByText("…and who calls.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Write a test" })).toBeTruthy();

    // Suite management moved to the suites list. Nothing here runs, renames or
    // deletes a suite, and there is no toolbar ⋮ left to hold them.
    expect(screen.getByRole("button", { name: "Write a test" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Run suite" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open the suite menu" })).toBeNull();
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
    const write = screen.getByRole("button", { name: "Write a test" });
    expect((write as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(write);

    // A viewer's grid never wakes: no ghost row to write into, and a click on a
    // cell leaves the cell as it was.
    expect(screen.queryByRole("button", { name: "+ Write a test" })).toBeNull();
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
    fireEvent.click(await screen.findByLabelText("Impatient Rita"));
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
    // The row offers one thing, and the four columns stay the test's content.
    expect(
      (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    ).toEqual(["Delete test"]);

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

  it("focuses the entry row from the toolbar and from the retired write address", async () => {
    gridAnswers({ tests: [] });

    render(<TestSuitePage />);

    // The toolbar's own button: the entry row opens with the caret in Name,
    // and the address does not move.
    fireEvent.click(await screen.findByRole("button", { name: "Write a test" }));
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
    fireEvent.change(screen.getByLabelText("Run name (optional)"), {
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
    });

    render(<NewRunPage />);
    fireEvent.change(await screen.findByLabelText("Test suite"), {
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
    fireEvent.change(screen.getByLabelText("Run name (optional)"), {
      target: { value: "Morning check" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    expect(await screen.findByText("Egma could not answer.")).toBeTruthy();
    expect((screen.getByLabelText("Test suite") as HTMLSelectElement).value).toBe("ste_1");
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("agt_1");
    expect((screen.getByLabelText("Connection") as HTMLSelectElement).value).toBe("con_1");
    expect((screen.getByLabelText("Run name (optional)") as HTMLInputElement).value).toBe(
      "Morning check",
    );

    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => {
      expect(
        sent.filter((request) => request.path === "/v1/runs" && request.method === "POST"),
      ).toHaveLength(2);
    });
    fireEvent.change(screen.getByLabelText("Run name (optional)"), {
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
          tests: [{ id: "tst_1", suiteId: "ste_1", versionId: "tv_1" }],
          nextPageToken: null,
        },
      },
      "/v1/runs": {
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
    });

    render(<NewRunPage />);
    await screen.findByRole("option", { name: "Northside Ford" });
    fireEvent.change(screen.getByLabelText("Test suite"), { target: { value: "ste_1" } });
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "agt_1" } });
    await screen.findByRole("option", { name: /Production/ });
    fireEvent.change(screen.getByLabelText("Connection"), { target: { value: "con_1" } });

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
