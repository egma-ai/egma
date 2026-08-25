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
  pathname: "/projects/prj_1/tests",
  params: { projectId: "prj_1" } as Record<string, string>,
  search: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useParams: () => routed.params,
  useSearchParams: () => new URLSearchParams(routed.search),
  useRouter: () => ({ push: routed.push, replace: vi.fn(), back: vi.fn() }),
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
    personas: [],
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

function detailAnswers(options: {
  readonly role?: "admin" | "member" | "viewer";
  readonly me?: Me;
  readonly test?: Record<string, unknown>;
  readonly saved?: Stub;
} = {}): void {
  const test = options.test ?? testBody();
  // No version list is stubbed, and that is the point: versioning is hidden
  // from the interface for launch, so the test page reads the test and its
  // suite and nothing else. A read of `/v1/tests/tst_1/versions` would fail
  // here, which is what keeps that true.
  answers({
    "/api/me": { status: 200, body: options.me ?? meWith(options.role ?? "admin") },
    "/v1/tests/tst_1":
      options.saved === undefined
        ? { status: 200, body: test }
        : [{ status: 200, body: test }, options.saved],
    "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
    "/v1/personas": { status: 200, body: { personas: [], nextPageToken: null } },
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

  it("keeps an empty suite and starts its first test in that suite", async () => {
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/test-suites/ste_1": {
        status: 200,
        body: {
          id: "ste_1",
          projectId: "prj_1",
          name: "Northside Ford",
          createdAt: "2026-08-21T10:00:00.000Z",
          updatedAt: "2026-08-21T10:00:00.000Z",
        },
      },
      "/v1/tests": { status: 200, body: { tests: [], nextPageToken: null } },
    });

    render(<TestSuitePage />);

    expect(await screen.findByRole("heading", { name: "Northside Ford" })).toBeTruthy();
    // The suite id left the page with the boards: it is a fact about the
    // record, and it lives in the rename panel where somebody who needs to
    // quote it goes to find it.
    expect(screen.queryByText("ste_1")).toBeNull();
    expect(screen.getByText("No tests in this suite")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Write a test" })[0]?.getAttribute("href")).toBe(
      "/projects/prj_1/tests/new?suite=ste_1",
    );
    // "Run suite" opens the run builder carrying this suite. Nothing on this
    // screen starts a run, so there is no control that could.
    expect(screen.queryByRole("button", { name: /^run/i })).toBeNull();
    expect(screen.getByRole("link", { name: "Run suite" }).getAttribute("href")).toBe(
      "/projects/prj_1/runs/new?suite=ste_1",
    );
  });

  it("lets a viewer read a suite while every suite write stays inert", async () => {
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    answers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/tests": {
        status: 200,
        body: { tests: [testBody()], nextPageToken: null },
      },
    });

    render(<TestSuitePage />);

    expect(await screen.findByRole("link", { name: "Books service" })).toBeTruthy();
    const write = screen.getByRole("button", { name: "Write a test" });
    expect((write as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(write);

    // Renaming and deleting moved into the suite's own ⋮ menu, so a viewer
    // meets them there — offered, inert, and with the reason beside them.
    fireEvent.click(screen.getByRole("button", { name: "Open the suite menu" }));
    for (const name of ["Rename suite", "Delete suite"]) {
      const item = await screen.findByRole("menuitem", { name });
      expect((item as HTMLButtonElement).disabled, name).toBe(true);
      fireEvent.click(item);
    }
    expect(
      screen.getByText(
        "Your viewer role cannot change test suites. Ask an organization admin to change your role.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
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

  it("renames a suite in place and warns before permanent deletion", async () => {
    routed.pathname = "/projects/prj_1/tests/suites/ste_1";
    routed.params = { projectId: "prj_1", suiteId: "ste_1" };
    const original = {
      id: "ste_1",
      projectId: "prj_1",
      name: "Northside Ford",
      createdAt: "2026-08-21T10:00:00.000Z",
      updatedAt: "2026-08-21T10:00:00.000Z",
    };
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/test-suites/ste_1": [
        { status: 200, body: original },
        {
          status: 200,
          body: {
            ...original,
            name: "Northside Ford Service",
            updatedAt: "2026-08-21T10:01:00.000Z",
          },
        },
        { status: 204, body: null },
      ],
      "/v1/tests": { status: 200, body: { tests: [], nextPageToken: null } },
    });

    render(<TestSuitePage />);
    expect(await screen.findByRole("heading", { name: "Northside Ford" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open the suite menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename suite" }));
    // The rename surface is a side sheet named by the suite it is about, so
    // the list behind it stays on screen while the name is changed.
    const rename = await screen.findByRole("dialog", { name: "Northside Ford" });
    fireEvent.change(within(rename).getByLabelText("Suite name"), {
      target: { value: "Northside Ford Service" },
    });
    fireEvent.click(within(rename).getByRole("button", { name: "Save name" }));

    expect(await screen.findByRole("heading", { name: "Northside Ford Service" })).toBeTruthy();
    expect(sent.find((request) => request.method === "PATCH")).toEqual({
      path: "/v1/test-suites/ste_1",
      method: "PATCH",
      body: { name: "Northside Ford Service" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Open the suite menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete suite" }));
    const deletion = await screen.findByRole("dialog", {
      name: "Delete Northside Ford Service?",
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
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/tests");
  });

  it("writes a test directly into the suite named by the route", async () => {
    routed.pathname = "/projects/prj_1/tests/new";
    routed.params = { projectId: "prj_1" };
    routed.search = "suite=ste_1";
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/test-suites/ste_1": {
        status: 200,
        body: {
          id: "ste_1",
          projectId: "prj_1",
          name: "Northside Ford",
          createdAt: "2026-08-21T10:00:00.000Z",
          updatedAt: "2026-08-21T10:00:00.000Z",
        },
      },
      "/v1/personas": { status: 200, body: { personas: [], nextPageToken: null } },
      // The address draws the suite with the write panel over it, so the suite's
      // own tests are read before anything is written into it.
      "/v1/tests": [
        { status: 200, body: { tests: [], nextPageToken: null } },
        {
          status: 201,
          body: {
            id: "tst_1",
            projectId: "prj_1",
            suiteId: "ste_1",
            name: "Books service",
          },
        },
      ],
    });

    render(<NewTestPage />);

    expect(await screen.findByText("In suite Northside Ford")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Books service" } });
    fireEvent.change(screen.getByLabelText("Scenario"), {
      target: { value: "The caller asks to book the next service slot." },
    });
    fireEvent.change(screen.getByLabelText("Expected behavior 1"), {
      target: { value: "Offers a real available time" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Write the test" }));

    await waitFor(() => {
      expect(sent.find((request) => request.path === "/v1/tests" && request.method === "POST"))
        .toEqual({
          path: "/v1/tests",
          method: "POST",
          body: {
            suiteId: "ste_1",
            name: "Books service",
            scenario: "The caller asks to book the next service slot.",
            expectedBehaviors: ["Offers a real available time"],
            personas: [],
          },
        });
    });
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/tests/tst_1");
  });

  it("keeps a test in its suite and permanently deletes only that test", async () => {
    routed.pathname = "/projects/prj_1/tests/tst_1";
    routed.params = { projectId: "prj_1", testId: "tst_1" };
    const test = {
      id: "tst_1",
      projectId: "prj_1",
      suiteId: "ste_1",
      name: "Books service",
      description: null,
      version: 1,
      versionId: "tv_1",
      scenario: "The caller books service.",
      expectedBehaviors: ["Offers an available time"],
      personas: [],
      overrideCount: 0,
      revision: "rev_1",
      createdAt: "2026-08-21T10:00:00.000Z",
      updatedAt: "2026-08-21T10:00:00.000Z",
    };
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/tests/tst_1": [
        { status: 200, body: test },
        { status: 204, body: null },
      ],
      "/v1/test-suites/ste_1": {
        status: 200,
        body: {
          id: "ste_1",
          projectId: "prj_1",
          name: "Northside Ford",
          createdAt: "2026-08-21T10:00:00.000Z",
          updatedAt: "2026-08-21T10:00:00.000Z",
        },
      },
      "/v1/personas": { status: 200, body: { personas: [], nextPageToken: null } },
    });

    render(<TestDetailPage />);

    const suiteLink = await screen.findByRole("link", { name: "Northside Ford" });
    expect(suiteLink.getAttribute("href")).toBe("/projects/prj_1/tests/suites/ste_1");
    expect(screen.queryByRole("button", { name: "Clone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move test" })).toBeNull();
    expect(screen.queryByText(/applies to agents/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete test" }));
    const deletion = await screen.findByRole("dialog", { name: "Delete this test?" });
    expect(
      within(deletion).getByText(
        "“Books service” leaves the Northside Ford suite. Nobody can author or run it after this.",
      ),
    ).toBeTruthy();
    expect(
      within(deletion).getByText(
        "Runs that already ran it keep their results and transcripts.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(deletion).getByRole("button", { name: "Delete test" }));

    await waitFor(() => expect(sent.find((request) => request.method === "DELETE")).toEqual({
      path: "/v1/tests/tst_1",
      method: "DELETE",
      body: undefined,
    }));
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/tests/suites/ste_1");
  });

  it("saves identity with its revision and keeps newer typing in both edit areas", async () => {
    routed.pathname = "/projects/prj_1/tests/tst_1";
    routed.params = { projectId: "prj_1", testId: "tst_1" };
    let finishSave: () => void = () => undefined;
    const saving = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    answers({
      "/api/me": { status: 200, body: ME },
      "/v1/tests/tst_1": [
        { status: 200, body: testBody() },
        {
          status: 200,
          body: testBody({ name: "Renamed", revision: "rev_2" }),
          waitFor: saving,
        },
      ],
      "/v1/test-suites/ste_1": { status: 200, body: suiteBody() },
      "/v1/personas": { status: 200, body: { personas: [], nextPageToken: null } },
    });

    render(<TestDetailPage />);
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    fireEvent.change(screen.getByLabelText("Scenario"), {
      target: { value: "Keep this unsaved scenario" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(
        sent.filter(
          (request) => request.path === "/v1/tests/tst_1" && request.method === "PATCH",
        ),
      ).toHaveLength(1);
    });
    const body = sent.find(
      (request) => request.path === "/v1/tests/tst_1" && request.method === "PATCH",
    )?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "Renamed",
      description: null,
      expectedRevision: "rev_1",
    });
    expect(body).not.toHaveProperty("expectedVersionId");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Keep this in-flight identity edit" },
    });
    finishSave();

    await waitFor(() => {
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
        "Keep this in-flight identity edit",
      );
    });
    expect((screen.getByLabelText("Scenario") as HTMLTextAreaElement).value).toBe(
      "Keep this unsaved scenario",
    );
  });

  it("lets a viewer read a test while every test write stays inert", async () => {
    routed.pathname = "/projects/prj_1/tests/tst_1";
    routed.params = { projectId: "prj_1", testId: "tst_1" };
    detailAnswers({ role: "viewer" });

    render(<TestDetailPage />);

    const name = await screen.findByLabelText("Name");
    expect((name as HTMLInputElement).value).toBe("Books service");
    expect((name as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Scenario") as HTMLTextAreaElement).disabled).toBe(true);
    for (const label of ["Save settings", "Save version", "Delete test"]) {
      const control = screen.getByRole("button", { name: label });
      expect((control as HTMLButtonElement).disabled, label).toBe(true);
      expect(control.getAttribute("title"), label).toContain("viewer role cannot");
      fireEvent.click(control);
    }
    for (const retired of ["Clone", "Archive", "Restore", "Move test"]) {
      expect(screen.queryByRole("button", { name: retired })).toBeNull();
    }
    expect(sent.some((request) => ["POST", "PATCH", "DELETE"].includes(request.method))).toBe(
      false,
    );
  });

  it("sends the content version token and keeps the refused draft intact", async () => {
    routed.pathname = "/projects/prj_1/tests/tst_1";
    routed.params = { projectId: "prj_1", testId: "tst_1" };
    const message = "This test version changed after you opened it.";
    detailAnswers({
      saved: {
        status: 409,
        body: { error: "version_conflict", message },
      },
    });

    render(<TestDetailPage />);
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Keep this identity draft" },
    });
    fireEvent.change(screen.getByLabelText("Scenario"), {
      target: { value: "Keep this refused scenario" },
    });
    fireEvent.change(screen.getByLabelText("Expected behavior 1"), {
      target: { value: "Keeps this refused behavior" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    expect(await screen.findByText(message)).toBeTruthy();
    expect(
      screen.getByText("Cannot save · the test changed since you opened it"),
    ).toBeTruthy();
    const body = sent.find(
      (request) => request.path === "/v1/tests/tst_1" && request.method === "PATCH",
    )?.body as Record<string, unknown>;
    expect(body).toEqual({
      scenario: "Keep this refused scenario",
      expectedBehaviors: ["Keeps this refused behavior"],
      personas: [],
      expectedVersionId: "tstv_1",
    });
    expect(body).not.toHaveProperty("expectedRevision");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Keep this identity draft",
    );
    expect((screen.getByLabelText("Scenario") as HTMLTextAreaElement).value).toBe(
      "Keep this refused scenario",
    );
    expect((screen.getByLabelText("Expected behavior 1") as HTMLTextAreaElement).value).toBe(
      "Keeps this refused behavior",
    );
  });

  it("protects a dirty test across links, project switches, and browser unload", async () => {
    routed.pathname = "/projects/prj_1/tests/tst_1";
    routed.params = { projectId: "prj_1", testId: "tst_1" };
    detailAnswers({
      me: meWith("admin", [
        { id: "prj_1", name: "Receptionists", slug: "receptionists" },
        { id: "prj_2", name: "Outbound", slug: "outbound" },
      ]),
    });

    render(<TestDetailPage />);
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Keep this test edit" },
    });

    const parent = within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole(
      "link",
      { name: "Tests" },
    );
    fireEvent.click(parent);
    expect(routed.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Leave without saving?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    const projectSelector = screen.getAllByRole("button", {
      name: /^Organization Acme, project Receptionists/u,
    })[0];
    if (projectSelector === undefined) throw new Error("project selector missing");
    fireEvent.click(projectSelector);
    fireEvent.click(within(screen.getByRole("menu")).getByText("Outbound"));

    expect(routed.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Leave without saving?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_2/tests");
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
