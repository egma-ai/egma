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
  fireEvent.change(await screen.findByLabelText("Test suite*"), {
    target: { value: "ste_1" },
  });
  fireEvent.change(screen.getByLabelText("Agent*"), { target: { value: "agt_1" } });
  await screen.findByRole("option", { name: "Production · Voice" });
  fireEvent.change(screen.getByLabelText("Connection*"), {
    target: { value: "con_1" },
  });
}

beforeEach(() => {
  /*
   * Stub ResizeObserver and scrollIntoView for cmdk in jsdom. These tests
   * exercise selection, not layout measurements or scrolling.
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
  // The `Saved` indicator's own wait is the only fake clock in this file, and
  // a test that used one must not hand it to the next.
  vi.useRealTimers();
});

describe("the suite-first Tests route", () => {
  /**
   * **The support table, one lane at a time.**
   *
   * A phone lane warns that mock tools and dynamic variables cannot be used,
   * the LiveKit SDK requirement comes with its mock-tools sentence, token-endpoint
   * dispatch metadata needs no warning while the requirement is still said, and
   * a Retell lane quietly says LiveKit's word is not one it uses.
   */
  it("says what each remaining lane will and will not use", async () => {
    routed.pathname = "/projects/prj_1/runs/new";
    routed.params = { projectId: "prj_1" };

    /** One lane, chosen in a fresh sheet, and the note it draws. */
    async function noteOn(
      connection: Record<string, unknown>,
      tests: readonly Record<string, unknown>[],
      expected: readonly string[],
      /** The box's own volume, which its edge is the whole of. */
      accent: "warning" | "brand" | "quiet" = "brand",
    ): Promise<void> {
      runBuilderAnswers({
        connections: [
          {
            id: "con_1",
            name: "Lane",
            productLabel: "Lane",
            modality: "voice",
            environment: null,
            archived: false,
            ...connection,
          },
        ],
        tests,
      });
      const { unmount } = render(<NewRunPage />);
      const sheet = await screen.findByRole("dialog", { name: "Create a run" });
      fireEvent.change(within(sheet).getByLabelText("Test suite*"), {
        target: { value: "ste_1" },
      });
      fireEvent.change(within(sheet).getByLabelText("Agent*"), {
        target: { value: "agt_1" },
      });
      await within(sheet).findByLabelText("Connection*");
      fireEvent.change(within(sheet).getByLabelText("Connection*"), {
        target: { value: "con_1" },
      });
      if (expected.length === 0) {
        expect(await screen.findByLabelText("Run name")).toBeTruthy();
        expect(sheet.querySelector('[data-slot="run-note"]')).toBeNull();
      } else {
        const note = await waitFor(() => {
          const held = sheet.querySelector('[data-slot="run-note"]');
          if (held === null) throw new Error("no run note yet");
          expect(
            [...held.querySelectorAll("p")].map((line) => line.textContent),
          ).toEqual(expected);
          return held;
        });
        // The warning colour rides the box where a lane cannot use what a test
        // holds, and the house hairline everywhere else.
        expect(note.getAttribute("data-accent")).toBe(accent);
        expect(note.className).toContain(
          accent === "warning" ? "border-warning" : "border-border",
        );
      }
      unmount();
      cleanup();
    }

    const MOCKING = testBody({
      mockTools: [{ tool: "get_availability", answer: { slots: [] } }],
    });
    const PLAIN = testBody({
      id: "tst_2",
      versionId: "tstv_2",
      name: "Cancels service",
    });
    const VARYING = testBody({
      id: "tst_2",
      versionId: "tstv_2",
      name: "Cancels service",
      env: { retell_dynamic_variables: { caller_name: "Margaret" } },
    });
    const DISPATCHING = testBody({
      env: { job_dispatch_metadata: { tenant: "acme" } },
    });
    const ALSO_DISPATCHING = testBody({
      id: "tst_2",
      versionId: "tstv_2",
      name: "Cancels service",
      env: { job_dispatch_metadata: { tenant: "acme" } },
    });

    // A phone number is the customer's own published line, answered by Retell.
    // It carries neither a mock nor a dynamic variable, and each line says
    // "cannot" itself, so no summary sentence stands over them: the box's
    // warning edge is the only other thing that says it. No line names the
    // Egma SDK, because a call Retell answers never asks for it.
    await noteOn(
      {
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
      },
      [MOCKING, VARYING],
      [
        "1 of 2 tests carries mock tools. A Retell phone connection cannot mock tools, so those simulations reach your real tools.",
        "1 of 2 tests carries Retell dynamic variables. A phone call is answered by Retell, not created by Egma, so they cannot be passed.",
      ],
      "warning",
    );

    // A key-pair room mocks through the customer's own agent, so the note
    // names the one thing that agent must be running.
    await noteOn(
      {
        connectionType: "livekit_room",
        accessVariant: "livekit_room.project_credentials",
      },
      [MOCKING, PLAIN],
      [
        "A LiveKit simulation needs the Egma SDK in your agent.",
        "1 of 2 tests carries mock tools. They are served only when your agent runs simulation(...). Tools a test does not mock run real, and every call is on the transcript.",
      ],
    );

    // On a token endpoint the customer's own endpoint dispatches the worker,
    // and Egma hands it the test's dispatch metadata inside the token
    // request — so nothing is left unused and no line counts it. The SDK
    // requirement still stands, alone, because it is true of every LiveKit run.
    await noteOn(
      {
        connectionType: "livekit_room",
        accessVariant: "livekit_room.customer_token_endpoint",
      },
      [DISPATCHING, PLAIN],
      ["A LiveKit simulation needs the Egma SDK in your agent."],
    );

    // A Retell lane says the same fact quietly: nothing is lost, because
    // LiveKit's word was never for this platform in the first place.
    await noteOn(
      {
        connectionType: "retell_text_mode",
        accessVariant: "retell_text_mode.api_key",
        modality: "chat",
      },
      [DISPATCHING, ALSO_DISPATCHING],
      [
        "2 tests carry job_dispatch_metadata, which a Retell connection does not use.",
      ],
      "quiet",
    );

    // And text mode with mock tools has nothing to say at all: it serves them
    // on the request, so no version is branched and nothing is left unused.
    await noteOn(
      {
        connectionType: "retell_text_mode",
        accessVariant: "retell_text_mode.api_key",
        modality: "chat",
      },
      [MOCKING, PLAIN],
      [],
    );
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

  it("waits for an in-flight save and deletes against the guards it returned", async () => {
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
            scenario: "The caller books the next service slot.",
            version: 2,
            versionId: "tstv_2",
            revision: "rev_2",
          }),
          waitFor: held,
        },
        { status: 204, body: null },
      ],
      "/v1/personas": {
        status: 200,
        body: { personas: [PERSONA], nextPageToken: null },
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
      expect(sent.filter((request) => request.method === "PATCH")).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Open the menu for Books service" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete test" }));
    const asked = await screen.findByRole("dialog", { name: "Delete this test?" });
    fireEvent.click(within(asked).getByRole("button", { name: "Delete test" }));

    expect(sent.some((request) => request.method === "DELETE")).toBe(false);
    release();

    await waitFor(() => {
      expect(sent.filter((request) => request.method === "DELETE")).toHaveLength(1);
    });
    const requests = await Promise.all(
      vi.mocked(fetch).mock.calls.map(([input, init]) =>
        observeRequest(input as FetchInput, init),
      ),
    );
    expect(requests.find((request) => request.method === "DELETE")?.url).toBe(
      "/v1/tests/tst_1?projectId=prj_1&expectedVersionId=tstv_2&expectedRevision=rev_2",
    );
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
      screen.getByRole("button", { name: "Add mock tools for Books service" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Mock tools" });
    const editor = within(dialog).getByLabelText("Mock tools");
    /*
     * The example is the empty editor's own placeholder, not a stored value —
     * and it is pretty-printed, because that is the shape this editor writes
     * back.
     */
    expect((editor as HTMLTextAreaElement).value).toBe("");
    expect(editor.getAttribute("placeholder")).toBe(
      JSON.stringify(
        [
          { tool: "get_availability", answer: { slots: [] } },
          { tool: "book", error: "calendar down" },
        ],
        null,
        2,
      ),
    );

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
    fireEvent.click(
      screen.getByRole("button", { name: "Add env variables for Books service" }),
    );
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

  /**
   * **A press elsewhere is leaving the cell, and most of a page takes no
   * focus.**
   *
   * Blur closed a woken cell only when the browser had somewhere else to put
   * the caret. The canvas beside the table, the table's own headings and the
   * page title take none, so a cell was left open over words nobody had saved
   * (founder, 2026-09-04). The press runs the same commit the blur runs.
   */
  it("commits and closes a woken cell when the press lands on the page itself", async () => {
    gridAnswers({
      saved: {
        status: 200,
        body: testBody({
          personas: [PERSONA],
          version: 2,
          versionId: "tstv_2",
          scenario: "The caller books a service visit.",
        }),
      },
    });

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    fireEvent.click(screen.getByText("The caller books service."));
    fireEvent.change(screen.getByLabelText("Scenario"), {
      target: { value: "The caller books a service visit." },
    });
    expect(document.querySelector("[data-woken-cell]")).not.toBeNull();

    // The page's own background takes no focus, so nothing here blurs.
    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toEqual([
        {
          path: "/v1/tests/tst_1",
          method: "PATCH",
          body: {
            scenario: "The caller books a service visit.",
            expectedVersionId: "tstv_1",
          },
        },
      ]);
    });
    // One request, one closed cell, and the row showing what was saved.
    await waitFor(() => {
      expect(document.querySelector("[data-woken-cell]")).toBeNull();
    });
    expect(screen.queryByLabelText("Scenario")).toBeNull();
    expect(screen.getByText("The caller books a service visit.")).toBeTruthy();
  });

  it("says nothing over the grid when a save is refused", async () => {
    const REFUSED = "Somebody else moved this test. Read it again.";
    gridAnswers({
      saved: { status: 409, body: { error: "conflict", message: REFUSED } },
    });

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    fireEvent.click(screen.getByText("Books service"));
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Books a service" } });
    fireEvent.keyDown(name, { key: "Enter" });

    // The refusal is in the cell, where the person is looking, and the header
    // says nothing at all: nothing was saved.
    expect(await screen.findByText(REFUSED)).toBeTruthy();
    expect(screen.queryByText("Saved")).toBeNull();
    expect(document.querySelector("[data-slot='save-indicator']")).toBeNull();
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

    // And the caret is already in the copy's name, because renaming it is the
    // first thing anybody does with a duplicate.
    await waitFor(() => {
      expect(document.activeElement).toBe(within(entry).getByLabelText("Name"));
    });

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
    expect(within(entry).getByText("View env variables")).toBeTruthy();

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
     * This jsdom event sequence needs a second press to open the next picker
     * after dismissal. Check which picker is open through its trigger because
     * the panel is portaled outside the row.
     */
    fireEvent.click(entryTrigger);
    expect(screen.getAllByRole("dialog", { name: "Choose personas" })).toHaveLength(1);
    expect(entryTrigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("takes a persona off a woken cell and commits the rest in their order", async () => {
    const BEN = { id: "prs_2", name: "Calm Ben", archivedAt: null };
    const CHRIS = { id: "prs_3", name: "Careful Chris", archivedAt: null };
    gridAnswers({
      tests: [testBody({ personas: [PERSONA, BEN, CHRIS] })],
      saved: {
        status: 200,
        body: testBody({
          personas: [PERSONA, CHRIS],
          version: 2,
          versionId: "tstv_2",
        }),
      },
    });

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    const written = screen.getByText("Books service").closest("tr");
    if (written === null) throw new Error("the test's row is not on screen");
    fireEvent.click(within(written).getByText("Impatient Rita"));

    fireEvent.click(within(written).getByRole("button", { name: "Remove Calm Ben" }));

    // Taking somebody off a test is an edit, not a destruction: nothing is
    // asked, and nothing is sent until the cell is left, exactly as unticking.
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
    expect(sent.some((request) => request.method === "PATCH")).toBe(false);
    expect(
      within(written)
        .getAllByRole("listitem")
        .map((chip) => chip.textContent),
    ).toEqual(["Impatient Rita", "Careful Chris"]);

    // The page's own background takes no focus, so leaving is the press itself.
    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toEqual([
        {
          path: "/v1/tests/tst_1",
          method: "PATCH",
          body: { personas: ["prs_1", "prs_3"], expectedVersionId: "tstv_1" },
        },
      ]);
    });
  });

  it("shows a deleted persona a test still names, and takes it off", async () => {
    const GONE = {
      id: "prs_9",
      name: "Retired Rae",
      archivedAt: "2026-09-01T10:00:00.000Z",
    };
    gridAnswers({
      tests: [testBody({ personas: [PERSONA, GONE] })],
      saved: {
        status: 200,
        body: testBody({ personas: [PERSONA], version: 2, versionId: "tstv_2" }),
      },
    });

    render(<TestSuitePage />);

    expect(await screen.findByText("Books service")).toBeTruthy();
    const written = screen.getByText("Books service").closest("tr");
    if (written === null) throw new Error("the test's row is not on screen");
    fireEvent.click(within(written).getByText("Impatient Rita"));

    // The chip says the persona is gone, which is what makes its cross make
    // sense: the add list holds the project's available personas and nothing
    // else, so the chip is the only place this one was ever reachable.
    expect(within(written).getByText("(deleted)")).toBeTruthy();
    fireEvent.click(within(written).getByRole("button", { name: "Remove Retired Rae" }));

    fireEvent.click(within(written).getByRole("button", { name: "+ Add a persona" }));
    const panel = await screen.findByRole("dialog", { name: "Choose personas" });
    expect(await within(panel).findByRole("option", { name: "Impatient Rita" }))
      .toBeTruthy();
    expect(within(panel).queryByRole("option", { name: "Retired Rae" })).toBeNull();

    // The deleted persona is what refuses every later edit of this test, and
    // the cross is the one way it comes off.
    fireEvent.click(within(panel).getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(sent.filter((request) => request.method === "PATCH")).toEqual([
        {
          path: "/v1/tests/tst_1",
          method: "PATCH",
          body: { personas: ["prs_1"], expectedVersionId: "tstv_1" },
        },
      ]);
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
    fireEvent.click(within(row).getByText(/Offers an available time/u));
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
    expect(screen.getByText(/Reads the price back/u)).toBeTruthy();
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

  it("keeps the chosen inputs after a failed start and sends each later attempt", async () => {
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
    fireEvent.change(screen.getByLabelText("Run name"), {
      target: { value: "Morning check" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    expect(await screen.findByText("Egma could not answer.")).toBeTruthy();
    expect((screen.getByLabelText("Test suite*") as HTMLSelectElement).value).toBe("ste_1");
    expect((screen.getByLabelText("Agent*") as HTMLSelectElement).value).toBe("agt_1");
    expect((screen.getByLabelText("Connection*") as HTMLSelectElement).value).toBe("con_1");
    expect((screen.getByLabelText("Run name") as HTMLInputElement).value).toBe(
      "Morning check",
    );

    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => {
      expect(
        sent.filter((request) => request.path === "/v1/runs" && request.method === "POST"),
      ).toHaveLength(2);
    });
    fireEvent.change(screen.getByLabelText("Run name"), {
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
    expect(first).toEqual({
      suiteId: "ste_1",
      agentId: "agt_1",
      connectionId: "con_1",
      name: "Morning check",
    });
    expect(retry).toEqual(first);
    expect(changed).toEqual({ ...first, name: "Evening check" });
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/runs/run_1");
  });

  it("keeps Start run disabled while a start request is pending", async () => {
    routed.pathname = "/projects/prj_1/runs/new";
    routed.params = { projectId: "prj_1" };
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    runBuilderAnswers({
      started: {
        status: 201,
        body: { id: "run_1" },
        waitFor: pending,
      },
    });

    render(<NewRunPage />);
    await chooseRunTarget();
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    const starting = await screen.findByRole("button", { name: "Starting…" });
    expect((starting as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(starting);
    await waitFor(() => {
      expect(
        sent.filter((request) => request.path === "/v1/runs" && request.method === "POST"),
      ).toHaveLength(1);
    });

    await act(async () => { finish(); });
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/runs/run_1");
  });
});
