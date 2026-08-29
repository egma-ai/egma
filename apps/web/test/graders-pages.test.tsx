// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GradersPage from "../app/projects/[projectId]/graders/page.tsx";
import { ScopeFields } from "../app/projects/[projectId]/graders/scope-fields.tsx";
import {
  EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID,
  type GraderLibraryEntry,
  type ProjectGraderScope,
  type ProjectGrader,
} from "../lib/graders.ts";
import type { Me } from "../lib/me.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/*
 * The page must keep a controlled sheet mounted while Radix finishes its exit.
 * jsdom has no stylesheet, so this gives Radix the same animation names that
 * the product theme gives the real sheet.
 */
function withClosingSheetAnimation(): void {
  const real = window.getComputedStyle.bind(window);
  vi.stubGlobal(
    "getComputedStyle",
    (element: Element, pseudo?: string | null) => {
      const styles = real(element, pseudo);
      const slot =
        element instanceof HTMLElement ? (element.dataset.slot ?? "") : "";
      if (!slot.startsWith("sheet-")) return styles;
      return new Proxy(styles, {
        get(target, key, receiver) {
          if (key !== "animationName") {
            return Reflect.get(target, key, receiver);
          }
          const closed = (element as HTMLElement).dataset.state === "closed";
          return slot === "sheet-overlay"
            ? closed
              ? "egma-fade-out"
              : "egma-fade-in"
            : closed
              ? "egma-sheet-out"
              : "egma-sheet-in";
        },
      });
    },
  );
}

function finishSheetExit(surface: HTMLElement): void {
  const ended = new Event("animationend", { bubbles: false });
  Object.defineProperty(ended, "animationName", {
    value:
      surface.dataset.slot === "sheet-overlay"
        ? "egma-fade-out"
        : "egma-sheet-out",
  });
  fireEvent(surface, ended);
}

const routed = vi.hoisted(() => ({
  pathname: "/projects/prj_1/graders",
  projectId: "prj_1",
  search: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useParams: () => ({ projectId: routed.projectId }),
  useSearchParams: () => new URLSearchParams(routed.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
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

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? undefined : JSON.stringify(body), {
    status,
    headers: status === 204 ? undefined : { "content-type": "application/json" },
  });
}

type Stubbed = { readonly status: number; readonly body: unknown };

function apiAnswers(answers: Record<string, Stubbed | Stubbed[]>): {
  readonly asked: {
    readonly method: string;
    readonly path: string;
    readonly body: unknown;
  }[];
} {
  const turns: Record<string, number> = {};
  const asked: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = await observeRequest(input, init);
      const key = `${request.method} ${request.address.pathname}`;
      asked.push({
        method: request.method,
        path: `${request.address.pathname}${request.address.search}`,
        body: request.body,
      });
      const held = answers[key];
      if (held === undefined) throw new Error(`nothing stubbed for ${key}`);
      const at = turns[key] ?? 0;
      turns[key] = at + 1;
      const answer = Array.isArray(held)
        ? (held[Math.min(at, held.length - 1)] as Stubbed)
        : held;
      return json(answer.status, answer.body);
    }),
  );
  return { asked };
}

const DATES = {
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:00:00.000Z",
};

const EXPECTED: ProjectGrader = {
  id: "grd_expected",
  projectId: "prj_1",
  graderDefinitionId: EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID,
  name: "expected_behaviors",
  description: "Grades a completed simulation against its expected behaviors.",
  owner: "egma",
  type: "llm_as_judge",
  modalities: ["chat", "voice"],
  scopeEditable: false,
  removable: false,
  scope: { simulations: [{ kind: "all" }], production: null },
  settings: {},
  passThreshold: 1,
  ...DATES,
};

const LATENCY: ProjectGrader = {
  id: "grd_latency",
  projectId: "prj_1",
  graderDefinitionId: "grl_latency",
  name: "Response latency",
  description: "Grades the average response time for a trace.",
  owner: "egma",
  type: "code",
  modalities: ["chat", "voice"],
  scopeEditable: true,
  removable: true,
  scope: { simulations: [{ kind: "all" }], production: null },
  settings: { maximum_response_time_ms: 3_000 },
  passThreshold: 1,
  ...DATES,
};

/** A grader scoped to some of the project's work, and a share of production. */
const SELECTED: ProjectGrader = {
  ...LATENCY,
  id: "grd_selected",
  graderDefinitionId: "grl_selected",
  name: "Selected scope",
  scope: {
    simulations: [
      { kind: "test_suite", id: "ste_1" },
      { kind: "test", id: "tst_1" },
      { kind: "test", id: "tst_2" },
    ],
    production: { samplePercent: 25 },
  },
};

const EXPECTED_DEFINITION: GraderLibraryEntry = {
  id: EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID,
  name: "expected_behaviors",
  description: "Grades a completed simulation against its expected behaviors.",
  owner: "egma",
  type: "llm_as_judge",
  scopeEditable: false,
  currentDefinitionVersion: 1,
  definitionVersion: 1,
  modalities: ["chat", "voice"],
  gradingInstructions: null,
  requiredEvidence: ["transcript", "test_expected_behaviors"],
  settingDefinitions: [],
  activeProjectGraderId: EXPECTED.id,
  ...DATES,
};

const LATENCY_DEFINITION: GraderLibraryEntry = {
  id: "grl_latency",
  name: "Response latency",
  description: "Grades the average response time for a trace.",
  owner: "egma",
  type: "code",
  scopeEditable: true,
  currentDefinitionVersion: 1,
  definitionVersion: 1,
  modalities: ["chat", "voice"],
  gradingInstructions: null,
  requiredEvidence: ["turn_response_latency"],
  settingDefinitions: [
    {
      key: "maximum_response_time_ms",
      label: "Maximum response time (p90)",
      valueType: "integer",
      defaultValue: 3_000,
      unit: "milliseconds",
      minimum: 1,
      maximum: null,
    },
  ],
  activeProjectGraderId: null,
  ...DATES,
};

function standardAnswers(
  role = "admin",
  graders: readonly ProjectGrader[] = [EXPECTED],
  library: readonly GraderLibraryEntry[] = [
    EXPECTED_DEFINITION,
    LATENCY_DEFINITION,
  ],
): Record<string, Stubbed | Stubbed[]> {
  return {
    "GET /api/me": { status: 200, body: meWith(role) },
    "GET /v1/graders": {
      status: 200,
      body: { graders, nextPageToken: null },
    },
    "GET /v1/grader-library": {
      status: 200,
      body: { graderLibraryEntries: library, nextPageToken: null },
    },
  };
}

async function openRowMenu(name: string): Promise<HTMLElement> {
  fireEvent.click(
    await screen.findByRole("button", { name: `Open the menu for ${name}` }),
  );
  return await screen.findByRole("menu", { name: `Open the menu for ${name}` });
}

async function chooseRowMenuItem(name: string, item: string): Promise<void> {
  await openRowMenu(name);
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

/** The names a row's ⋮ offers, in the order it offers them. */
async function rowMenuItems(name: string): Promise<readonly string[]> {
  const menu = await openRowMenu(name);
  return within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

/** Opening a row the way the boards do: by pressing the row's own name. */
async function openRow(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name }));
}

/** The row a named grader is on, so one cell's word is read where it belongs. */
function rowOf(name: string): HTMLElement {
  const row = screen.getByRole("button", { name }).closest("tr");
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

function ScopeHarness() {
  const [scope, setScope] = useState<ProjectGraderScope>({
    simulations: [],
    production: null,
  });

  return (
    <>
      <ScopeFields projectId="prj_1" scope={scope} onChange={setScope} />
      <output aria-label="Selected grader scope">{JSON.stringify(scope)}</output>
    </>
  );
}

beforeEach(() => {
  routed.pathname = "/projects/prj_1/graders";
  routed.projectId = "prj_1";
  routed.search = "";
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the project Graders surface", () => {
  it("nests tests under their suite and stores one suite selector when the suite is chosen", async () => {
    apiAnswers({
      "GET /v1/test-suites": {
        status: 200,
        body: {
          testSuites: [
            {
              id: "ste_1",
              projectId: "prj_1",
              name: "Northside Ford",
              ...DATES,
            },
          ],
          nextPageToken: null,
        },
      },
      "GET /v1/tests": {
        status: 200,
        body: {
          tests: [
            {
              id: "tst_booking",
              projectId: "prj_1",
              suiteId: "ste_1",
              name: "Books service",
              description: null,
              version: 1,
              versionId: "tstv_booking",
              scenario: "The caller books service.",
              expectedBehaviors: ["Offers an available time"],
              personas: [],
              overrideCount: 0,
              revision: "rev_booking",
              ...DATES,
            },
            {
              id: "tst_cancel",
              projectId: "prj_1",
              suiteId: "ste_1",
              name: "Cancels service",
              description: null,
              version: 1,
              versionId: "tstv_cancel",
              scenario: "The caller cancels service.",
              expectedBehaviors: ["Confirms the cancellation"],
              personas: [],
              overrideCount: 0,
              revision: "rev_cancel",
              ...DATES,
            },
          ],
          nextPageToken: null,
        },
      },
    });
    render(<ScopeHarness />);

    fireEvent.click(screen.getByLabelText("Grades simulations"));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Choose test suites and tests",
      }),
    );

    const picker = await screen.findByRole("dialog", {
      name: "Choose test suites and tests",
    });
    const suiteGroup = within(picker).getByRole("group", {
      name: "Northside Ford test suite",
    });
    const suite = within(suiteGroup).getByRole("checkbox", {
      name: "Northside Ford, test suite",
    });
    const booking = within(suiteGroup).getByRole("checkbox", {
      name: "Books service, test",
    });
    const cancellation = within(suiteGroup).getByRole("checkbox", {
      name: "Cancels service, test",
    });

    fireEvent.click(suite);
    expect(suite.getAttribute("aria-checked")).toBe("true");
    expect(booking.getAttribute("aria-checked")).toBe("true");
    expect(cancellation.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("Selected grader scope").textContent).toBe(
      JSON.stringify({
        simulations: [{ kind: "test_suite", id: "ste_1" }],
        production: null,
      }),
    );

    fireEvent.click(booking);
    expect(suite.getAttribute("aria-checked")).toBe("mixed");
    expect(booking.getAttribute("aria-checked")).toBe("false");
    expect(cancellation.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("Selected grader scope").textContent).toBe(
      JSON.stringify({
        simulations: [{ kind: "test", id: "tst_cancel" }],
        production: null,
      }),
    );

    fireEvent.click(booking);
    expect(suite.getAttribute("aria-checked")).toBe("mixed");
    expect(booking.getAttribute("aria-checked")).toBe("true");
    expect(cancellation.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("Selected grader scope").textContent).toBe(
      JSON.stringify({
        simulations: [
          { kind: "test", id: "tst_booking" },
          { kind: "test", id: "tst_cancel" },
        ],
        production: null,
      }),
    );
  });

  it("opens a grader definition linked from evidence", async () => {
    routed.search = "grader=grd_expected";
    apiAnswers(standardAnswers());
    render(<GradersPage />);

    expect(
      await screen.findByRole("dialog", { name: "Expected behaviors" }),
    ).toBeTruthy();
  });

  it("opens the immutable grader definition linked from a historical result", async () => {
    routed.search =
      `graderDefinition=${EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID}&definitionVersion=1`;
    const current = {
      ...EXPECTED_DEFINITION,
      name: "Current renamed grader",
      description: "The current description was written after this result.",
      currentDefinitionVersion: 2,
      definitionVersion: 2,
    };
    const historical = {
      ...current,
      currentDefinitionVersion: 2,
      definitionVersion: 1,
    };
    const { asked } = apiAnswers({
      ...standardAnswers("admin", [], [current]),
      [`GET /v1/grader-library/${EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID}`]: {
        status: 200,
        body: historical,
      },
    });
    render(<GradersPage />);

    const dialog = await screen.findByRole("dialog", {
      name: "Grader definition v1",
    });
    expect(
      within(dialog).getByText("Definition v1 used for this recorded result."),
    ).toBeTruthy();
    expect(within(dialog).queryByText("Current renamed grader")).toBeNull();
    expect(
      within(dialog).queryByText(
        "The current description was written after this result.",
      ),
    ).toBeNull();
    expect(await within(dialog).findByText("v1")).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "View active grader" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Use in project" }),
    ).toBeNull();
    await waitFor(() => {
      const request = asked.find((one) =>
        one.path.startsWith(
          `/v1/grader-library/${EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID}?`,
        ),
      );
      const query = new URL(request?.path ?? "", "http://egma.test").searchParams;
      expect(query.get("projectId")).toBe("prj_1");
      expect(query.get("definitionVersion")).toBe("1");
    });
  });

  it("separates active project policy from the grader library without repeated headings", async () => {
    const { asked } = apiAnswers(standardAnswers());
    render(<GradersPage />);

    expect(await screen.findByText("Expected behaviors")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Active graders" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Grader library" })).toBeTruthy();
    expect(screen.getAllByText("Active graders")).toHaveLength(1);
    expect(screen.queryByText(/what active means/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /add predefined grader/i })).toBeNull();
    /* The scope is two columns now, never one dot-joined sentence. */
    expect(screen.queryByText(/·/)).toBeNull();
    expect(
      screen.getByRole("columnheader", { name: "Simulations" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("columnheader", { name: "Production" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Grader library" }));
    expect(await screen.findByText("Response latency")).toBeTruthy();
    expect(screen.getAllByText("Grader library")).toHaveLength(1);
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(asked.map((one) => one.path)).toEqual(
      expect.arrayContaining([
        "/v1/graders?projectId=prj_1",
        "/v1/grader-library?projectId=prj_1",
      ]),
    );
  });

  it("loads every page of active graders and the grader library", async () => {
    const { asked } = apiAnswers({
      ...standardAnswers(),
      "GET /v1/graders": [
        {
          status: 200,
          body: { graders: [EXPECTED], nextPageToken: "active_page_2" },
        },
        {
          status: 200,
          body: { graders: [LATENCY], nextPageToken: null },
        },
      ],
      "GET /v1/grader-library": [
        {
          status: 200,
          body: {
            graderLibraryEntries: [EXPECTED_DEFINITION],
            nextPageToken: "library_page_2",
          },
        },
        {
          status: 200,
          body: {
            graderLibraryEntries: [LATENCY_DEFINITION],
            nextPageToken: null,
          },
        },
      ],
    });
    render(<GradersPage />);

    expect(await screen.findByText("Expected behaviors")).toBeTruthy();
    expect(await screen.findByText("Response latency")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Grader library" }));
    expect(await screen.findByText("Expected behaviors")).toBeTruthy();
    expect(await screen.findByText("Response latency")).toBeTruthy();

    expect(asked.map((one) => one.path)).toEqual(
      expect.arrayContaining([
        "/v1/graders?projectId=prj_1&pageToken=active_page_2",
        "/v1/grader-library?projectId=prj_1&pageToken=library_page_2",
      ]),
    );
  });

  it("keeps a refusal from a later page instead of showing a partial list", async () => {
    apiAnswers({
      ...standardAnswers(),
      "GET /v1/graders": [
        {
          status: 200,
          body: { graders: [EXPECTED], nextPageToken: "active_page_2" },
        },
        {
          status: 403,
          body: {
            error: "forbidden",
            message: "The next page could not be read.",
          },
        },
      ],
    });
    render(<GradersPage />);

    expect(await screen.findByText("The next page could not be read.")).toBeTruthy();
    expect(screen.queryByText("Expected behaviors")).toBeNull();
  });

  it("uses the stable definition id to label only Egma's Expected behaviors grader", async () => {
    const collision: ProjectGrader = {
      ...EXPECTED,
      id: "grd_collision",
      graderDefinitionId: "grl_collision",
      owner: "organization",
      scopeEditable: true,
      removable: true,
    };
    const collisionDefinition: GraderLibraryEntry = {
      ...EXPECTED_DEFINITION,
      id: "grl_collision",
      owner: "organization",
      scopeEditable: true,
      gradingInstructions: "Check the organization's custom behavior.",
      activeProjectGraderId: collision.id,
    };
    apiAnswers({
      ...standardAnswers(
        "admin",
        [EXPECTED, collision],
        [EXPECTED_DEFINITION, collisionDefinition],
      ),
      "GET /v1/grader-library/grl_collision": {
        status: 200,
        body: collisionDefinition,
      },
    });
    render(<GradersPage />);

    expect(await screen.findByText("Expected behaviors")).toBeTruthy();
    expect(screen.getByText("expected_behaviors")).toBeTruthy();
    await chooseRowMenuItem("expected_behaviors", "Edit");
    expect(
      await screen.findByRole("dialog", { name: "expected_behaviors" }),
    ).toBeTruthy();
  });

  it("keeps all three grader sheets mounted until their close motion ends", async () => {
    withClosingSheetAnimation();
    apiAnswers({
      ...standardAnswers(),
      [`GET /v1/grader-library/${EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID}`]: {
        status: 200,
        body: EXPECTED_DEFINITION,
      },
      "GET /v1/grader-library/grl_latency": {
        status: 200,
        body: LATENCY_DEFINITION,
      },
    });
    render(<GradersPage />);

    async function closeAfterMotion(name: string): Promise<void> {
      const sheet = await screen.findByRole("dialog", { name });
      const overlay = document.querySelector<HTMLElement>(
        '[data-slot="sheet-overlay"]',
      );
      const closeButtons = within(sheet).getAllByRole("button", {
        name: "Close",
      });
      const close = closeButtons.at(-1);
      if (close === undefined) throw new Error("the sheet has no close button");
      fireEvent.click(close);
      expect(sheet.dataset.state).toBe("closed");
      expect(document.body.contains(sheet)).toBe(true);
      finishSheetExit(sheet);
      if (overlay !== null) finishSheetExit(overlay);
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name })).toBeNull();
      });
    }

    fireEvent.click(
      await screen.findByRole("button", { name: "Create custom grader" }),
    );
    await closeAfterMotion("Create custom grader");

    await openRow("Expected behaviors");
    await closeAfterMotion("Expected behaviors");

    fireEvent.click(screen.getByRole("tab", { name: "Grader library" }));
    await openRow("Response latency");
    await closeAfterMotion("Response latency");
  });

  it("shows library details before Use and converts Response latency seconds to milliseconds", async () => {
    const used = { ...LATENCY, scope: { simulations: [], production: null } };
    const { asked } = apiAnswers({
      ...standardAnswers(),
      "GET /v1/grader-library/grl_latency": {
        status: 200,
        body: LATENCY_DEFINITION,
      },
      "POST /v1/grader-library/grl_latency/use": {
        status: 201,
        body: used,
      },
    });
    render(<GradersPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Grader library" }));
    await openRow("Response latency");

    const details = await screen.findByRole("dialog", { name: "Response latency" });
    expect(
      within(details).getByText(
        "The evidence this grader needs from a simulation.",
      ),
    ).toBeTruthy();
    expect(within(details).getByText("Turn response latency")).toBeTruthy();
    expect(within(details).queryByLabelText("Maximum response time (p90)")).toBeNull();
    fireEvent.click(within(details).getByRole("button", { name: "Use in project" }));

    const maximum = within(details).getByLabelText("Maximum response time (p90)");
    expect((maximum as HTMLInputElement).value).toBe("3");
    fireEvent.change(maximum, { target: { value: "2.5" } });
    fireEvent.click(within(details).getByRole("button", { name: "Use in project" }));

    await waitFor(() => {
      expect(asked.find((one) => one.method === "POST")).toEqual({
        method: "POST",
        path: "/v1/grader-library/grl_latency/use?projectId=prj_1",
        body: {
          scope: { simulations: [], production: null },
          settings: { maximum_response_time_ms: 2_500 },
          passThreshold: 1,
        },
      });
    });
  });

  it("creates one judge from the boundary the sheet asks the author to draw", async () => {
    const customDefinition: GraderLibraryEntry = {
      ...LATENCY_DEFINITION,
      id: "grl_custom",
      name: "Polite resolution",
      description: null,
      owner: "organization",
      type: "llm_as_judge",
      gradingInstructions: "Decide whether: the agent resolved the request.",
      requiredEvidence: ["transcript"],
      settingDefinitions: [],
      activeProjectGraderId: "grd_custom",
    };
    const customGrader: ProjectGrader = {
      ...EXPECTED,
      id: "grd_custom",
      graderDefinitionId: "grl_custom",
      name: "Polite resolution",
      owner: "organization",
      scopeEditable: true,
      removable: true,
      scope: { simulations: [{ kind: "all" }], production: null },
    };
    const { asked } = apiAnswers({
      ...standardAnswers(),
      "POST /v1/grader-library/custom": {
        status: 201,
        body: { definition: customDefinition, grader: customGrader },
      },
    });
    render(<GradersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Create custom grader" }));

    const sheet = await screen.findByRole("dialog", { name: "Create custom grader" });
    expect(
      within(sheet).getByText(
        "Create a grader for this organization and use it in this project.",
      ),
    ).toBeTruthy();

    /* One line sends a rule that belongs to one test to the right surface. */
    expect(
      within(sheet).getByText(
        "This grader judges every conversation in its scope. For something " +
          "one test must do, write an expected behavior on that test instead.",
      ),
    ).toBeTruthy();
    /* And one line says what the judge can actually see. */
    expect(
      within(sheet).getByText(
        "The judge reads the transcript, the outcome, the tool calls, and " +
          "the metrics of one conversation.",
      ),
    ).toBeTruthy();

    /* Every mandatory label ends in a star, and says so to a screen reader. */
    for (const starred of [
      "Name*",
      "Grading instructions*",
      "Passes when*",
      "Fails when*",
      "Pass threshold*",
    ]) {
      const field = within(sheet).getByLabelText(starred);
      expect(field.getAttribute("aria-required"), starred).toBe("true");
    }

    /*
     * The score mapping is an annotation beside each label, not part of it:
     * the label still reads in plain words, and the control is described by
     * the annotation so the mapping reaches a screen reader too.
     */
    expect(within(sheet).getByText("scores · 1")).toBeTruthy();
    expect(within(sheet).getByText("scores · 0")).toBeTruthy();
    for (const [label, annotation] of [
      ["Passes when*", "scores · 1"],
      ["Fails when*", "scores · 0"],
    ] as const) {
      const field = within(sheet).getByLabelText(label);
      const describedBy = field.getAttribute("aria-describedby") ?? "";
      expect(
        describedBy
          .split(" ")
          .map((id) => document.getElementById(id)?.textContent),
        label,
      ).toContain(annotation);
    }

    /* A description is one line, at the height of the name above it. */
    const description = within(sheet).getByLabelText("Description [optional]");
    expect(description.tagName).toBe("INPUT");

    /* The judge answers met or not met. It never returns a fraction. */
    expect(
      within(sheet).queryByText(
        "Describe what the agent must do. The grader returns a score between 0 and 1.",
      ),
    ).toBeNull();
    expect(
      within(sheet).getByText(
        "From 0 to 1. A simulation passes this grader at or above this score.",
      ),
    ).toBeTruthy();

    /*
     * And the order, which is the sheet's argument rather than a layout
     * detail: the framing line before anything is asked for, the evidence
     * sentence above the three boxes it governs, and the boundary drawn
     * before the threshold and the scope that apply it. Presence alone would
     * let a later edit shuffle these and stay green.
     */
    const pinned = [
      [
        "framing line",
        within(sheet).getByText(
          "This grader judges every conversation in its scope. For something " +
            "one test must do, write an expected behavior on that test instead.",
        ),
      ],
      ["Name*", within(sheet).getByLabelText("Name*")],
      [
        "Description [optional]",
        within(sheet).getByLabelText("Description [optional]"),
      ],
      [
        "evidence sentence",
        within(sheet).getByText(
          "The judge reads the transcript, the outcome, the tool calls, and " +
            "the metrics of one conversation.",
        ),
      ],
      [
        "Grading instructions*",
        within(sheet).getByLabelText("Grading instructions*"),
      ],
      ["Passes when*", within(sheet).getByLabelText("Passes when*")],
      ["Fails when*", within(sheet).getByLabelText("Fails when*")],
      ["Pass threshold*", within(sheet).getByLabelText("Pass threshold*")],
      ["Scope", within(sheet).getByText("Scope")],
    ] as const;
    const rendered = [...pinned].sort(([, one], [, next]) => {
      const follows =
        one.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING;
      return follows === 0 ? 1 : -1;
    });
    expect(rendered.map(([step]) => step)).toEqual(
      pinned.map(([step]) => step),
    );

    fireEvent.change(within(sheet).getByLabelText("Name*"), {
      target: { value: "Polite resolution" },
    });
    fireEvent.change(within(sheet).getByLabelText("Grading instructions*"), {
      target: { value: "the agent resolved the request" },
    });
    fireEvent.change(within(sheet).getByLabelText("Passes when*"), {
      target: { value: "the agent confirms the request is done" },
    });
    fireEvent.change(within(sheet).getByLabelText("Fails when*"), {
      target: { value: "the agent leaves the request open" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Create grader" }));

    await waitFor(() => {
      expect(asked.find((one) => one.method === "POST")).toEqual({
        method: "POST",
        path: "/v1/grader-library/custom?projectId=prj_1",
        body: {
          name: "Polite resolution",
          description: null,
          gradingInstructions: "the agent resolved the request",
          passesWhen: "the agent confirms the request is done",
          failsWhen: "the agent leaves the request open",
          scope: { simulations: [{ kind: "all" }], production: null },
          passThreshold: 1,
        },
      });
    });
  });

  it("offers no mechanism and no modality choice, and keeps the pass threshold", async () => {
    apiAnswers(standardAnswers());
    render(<GradersPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Create custom grader" }),
    );

    const sheet = await screen.findByRole("dialog", {
      name: "Create custom grader",
    });
    /* Create is LLM-judge only; predefined code graders arrive through Use. */
    expect(within(sheet).queryByRole("radio", { name: "LLM judge" })).toBeNull();
    expect(within(sheet).queryByRole("radio", { name: "Code" })).toBeNull();
    expect(within(sheet).queryByText("Mechanism")).toBeNull();
    /* A text-only judge is never asked which modalities it can grade. */
    expect(
      within(sheet).queryByRole("group", { name: "Compatible modalities*" }),
    ).toBeNull();
    expect(within(sheet).queryByLabelText("Chat")).toBeNull();
    expect(within(sheet).queryByLabelText("Voice")).toBeNull();
    /* The pass threshold stays exactly as it was, at its default of 1. */
    expect(
      (within(sheet).getByLabelText("Pass threshold*") as HTMLInputElement)
        .value,
    ).toBe("1");
  });

  it("grades every simulation from the start and prices production only when asked", async () => {
    apiAnswers(standardAnswers());
    render(<GradersPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Create custom grader" }),
    );

    const sheet = await screen.findByRole("dialog", {
      name: "Create custom grader",
    });
    /* A grader created here grades something without a second visit. */
    expect(
      (within(sheet).getByLabelText("Grades simulations") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      within(sheet)
        .getByRole("radio", { name: "All simulations" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    const production = within(sheet).getByLabelText(
      "Grades production",
    ) as HTMLInputElement;
    expect(production.checked).toBe(false);
    expect(within(sheet).queryByLabelText("Production sample")).toBeNull();
    expect(
      within(sheet).queryByText("Each sampled transcript costs one judge call."),
    ).toBeNull();

    fireEvent.click(production);
    expect(within(sheet).getByLabelText("Production sample")).toBeTruthy();
    expect(
      within(sheet).getByText("Each sampled transcript costs one judge call."),
    ).toBeTruthy();
  });

  it("resets unsaved custom-grader scope before the sheet reopens", async () => {
    apiAnswers(standardAnswers());
    render(<GradersPage />);
    const create = await screen.findByRole("button", {
      name: "Create custom grader",
    });
    fireEvent.click(create);

    let sheet = await screen.findByRole("dialog", {
      name: "Create custom grader",
    });
    fireEvent.click(within(sheet).getByLabelText("Grades simulations"));
    expect(
      (within(sheet).getByLabelText("Grades simulations") as HTMLInputElement)
        .checked,
    ).toBe(false);
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Create custom grader" }),
      ).toBeNull();
    });

    fireEvent.click(create);
    sheet = await screen.findByRole("dialog", { name: "Create custom grader" });
    await waitFor(() => {
      expect(
        (within(sheet).getByLabelText("Grades simulations") as HTMLInputElement)
          .checked,
      ).toBe(true);
    });
    expect(
      within(sheet)
        .getByRole("radio", { name: "All simulations" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("restores an active grader's saved scope when its sheet reopens", async () => {
    const activeLatencyDefinition = {
      ...LATENCY_DEFINITION,
      activeProjectGraderId: LATENCY.id,
    };
    apiAnswers({
      ...standardAnswers("admin", [EXPECTED, LATENCY], [
        EXPECTED_DEFINITION,
        activeLatencyDefinition,
      ]),
      "GET /v1/grader-library/grl_latency": {
        status: 200,
        body: activeLatencyDefinition,
      },
    });
    render(<GradersPage />);
    await chooseRowMenuItem("Response latency", "Edit");

    let sheet = await screen.findByRole("dialog", { name: "Response latency" });
    fireEvent.click(within(sheet).getByLabelText("Grades simulations"));
    expect(
      (within(sheet).getByLabelText("Grades simulations") as HTMLInputElement)
        .checked,
    ).toBe(false);
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Response latency" }))
        .toBeNull();
    });

    await chooseRowMenuItem("Response latency", "Edit");
    sheet = await screen.findByRole("dialog", { name: "Response latency" });
    await waitFor(() => {
      expect(
        (within(sheet).getByLabelText("Grades simulations") as HTMLInputElement)
          .checked,
      ).toBe(true);
    });
    expect(
      within(sheet)
        .getByRole("radio", { name: "All simulations" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps Expected behaviors scope fixed and lets the project edit only its threshold", async () => {
    const changed = { ...EXPECTED, passThreshold: 0.8 };
    const { asked } = apiAnswers({
      ...standardAnswers(),
      [`GET /v1/grader-library/${EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID}`]: {
        status: 200,
        body: EXPECTED_DEFINITION,
      },
      "PATCH /v1/graders/grd_expected": { status: 200, body: changed },
    });
    render(<GradersPage />);
    await chooseRowMenuItem("Expected behaviors", "Edit");

    const sheet = await screen.findByRole("dialog", { name: "Expected behaviors" });
    /* The caption that answered a question nobody asked is gone. */
    expect(within(sheet).queryByText("Fixed by Egma")).toBeNull();
    expect(within(sheet).getByText("Scope")).toBeTruthy();
    /* The two read-only rows say what the two columns behind the sheet say. */
    expect(within(sheet).getByText("Simulations")).toBeTruthy();
    expect(within(sheet).getByText("All")).toBeTruthy();
    expect(within(sheet).getByText("Production")).toBeTruthy();
    expect(within(sheet).getByText("Off")).toBeTruthy();
    expect(within(sheet).getByText("llm_as_judge")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Remove grader" })).toBeNull();
    fireEvent.change(within(sheet).getByLabelText("Pass threshold*"), {
      target: { value: "0.8" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(asked.find((one) => one.method === "PATCH")).toEqual({
        method: "PATCH",
        path: "/v1/graders/grd_expected?projectId=prj_1",
        body: { settings: {}, passThreshold: 0.8 },
      });
    });
  });

  it("keeps clearing scope separate from removing an optional grader", async () => {
    const activeLatencyDefinition = {
      ...LATENCY_DEFINITION,
      activeProjectGraderId: LATENCY.id,
    };
    const cleared = {
      ...LATENCY,
      scope: { simulations: [], production: null },
    };
    const { asked } = apiAnswers({
      ...standardAnswers("admin", [EXPECTED, LATENCY], [
        EXPECTED_DEFINITION,
        activeLatencyDefinition,
      ]),
      "GET /v1/grader-library/grl_latency": {
        status: 200,
        body: activeLatencyDefinition,
      },
      "PATCH /v1/graders/grd_latency": { status: 200, body: cleared },
      "DELETE /v1/graders/grd_latency": { status: 204, body: null },
    });
    render(<GradersPage />);
    await chooseRowMenuItem("Response latency", "Edit");

    const sheet = await screen.findByRole("dialog", { name: "Response latency" });
    /* Removing left this footer for the row menu, even where removal is allowed. */
    expect(
      within(sheet).queryByRole("button", { name: "Remove grader" }),
    ).toBeNull();
    fireEvent.click(within(sheet).getByLabelText("Grades simulations"));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(asked.find((one) => one.method === "PATCH")?.body).toEqual({
        scope: { simulations: [], production: null },
        settings: { maximum_response_time_ms: 3_000 },
        passThreshold: 1,
      });
    });
    expect(asked.some((one) => one.method === "DELETE")).toBe(false);

    /* Removing is the row's act now, and it still names what would go. */
    await chooseRowMenuItem("Response latency", "Remove grader");
    const confirmation = await screen.findByRole("dialog", {
      name: "Remove Response latency?",
    });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Remove grader" }),
    );
    await waitFor(() => {
      expect(asked.find((one) => one.method === "DELETE")).toEqual({
        method: "DELETE",
        path: "/v1/graders/grd_latency?projectId=prj_1",
        body: undefined,
      });
    });
  });

  it("lets a viewer inspect both tabs but not change project policy", async () => {
    apiAnswers({
      ...standardAnswers("viewer"),
      "GET /v1/grader-library/grl_latency": {
        status: 200,
        body: LATENCY_DEFINITION,
      },
    });
    render(<GradersPage />);

    const create = await screen.findByRole("button", {
      name: "Create custom grader",
    });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Grader library" }));

    const menu = await openRowMenu("Response latency");
    expect(
      (within(menu).getByRole("menuitem", {
        name: "Use in project",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(menu, { key: "Escape" });

    await openRow("Response latency");
    const details = await screen.findByRole("dialog", { name: "Response latency" });
    expect(within(details).getByText("Grades the average response time for a trace.")).toBeTruthy();
    expect(
      (within(details).getByRole("button", {
        name: "Use in project",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("reads a grader's type as the API's own word and its modalities as chips", async () => {
    apiAnswers(standardAnswers("admin", [EXPECTED, LATENCY]));
    render(<GradersPage />);

    expect(await screen.findByText("Expected behaviors")).toBeTruthy();
    const expected = rowOf("Expected behaviors");
    expect(within(expected).getByText("llm_as_judge")).toBeTruthy();
    expect(within(expected).getByText("Chat")).toBeTruthy();
    expect(within(expected).getByText("Voice")).toBeTruthy();
    /* The product words the raw value replaced are nowhere on the row. */
    expect(within(expected).queryByText("LLM judge")).toBeNull();
    expect(within(expected).queryByText("Chat and voice")).toBeNull();
    expect(within(rowOf("Response latency")).getByText("code")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Grader library" }));
    expect(await screen.findByText("Response latency")).toBeTruthy();
    expect(
      within(rowOf("Response latency")).getByText("code"),
    ).toBeTruthy();
  });

  it("says each evidence source in its own column, and says Off quietly", async () => {
    apiAnswers(standardAnswers("admin", [EXPECTED, SELECTED]));
    render(<GradersPage />);

    expect(await screen.findByText("Expected behaviors")).toBeTruthy();
    const expected = rowOf("Expected behaviors");
    expect(within(expected).getByText("All")).toBeTruthy();
    expect(within(expected).getByText("Off").className).toContain("text-faint");
    expect(within(expected).getByText("1.00")).toBeTruthy();

    const selected = rowOf("Selected scope");
    expect(within(selected).getByText("1 test suite, 2 tests")).toBeTruthy();
    expect(within(selected).getByText("25%")).toBeTruthy();
  });

  it("opens a grader from its row and offers Remove only where a grader may go", async () => {
    apiAnswers({
      ...standardAnswers("admin", [EXPECTED, LATENCY]),
      [`GET /v1/grader-library/${EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID}`]: {
        status: 200,
        body: EXPECTED_DEFINITION,
      },
    });
    render(<GradersPage />);

    expect(await screen.findByText("Expected behaviors")).toBeTruthy();
    expect(await rowMenuItems("Expected behaviors")).toEqual(["Edit"]);
    fireEvent.keyDown(
      await screen.findByRole("menu", {
        name: "Open the menu for Expected behaviors",
      }),
      { key: "Escape" },
    );
    expect(await rowMenuItems("Response latency")).toEqual([
      "Edit",
      "Remove grader",
    ]);
    fireEvent.keyDown(
      await screen.findByRole("menu", {
        name: "Open the menu for Response latency",
      }),
      { key: "Escape" },
    );

    await openRow("Expected behaviors");
    expect(
      await screen.findByRole("dialog", { name: "Expected behaviors" }),
    ).toBeTruthy();
  });

  it("opens a grader from anywhere on its row, not only the name", async () => {
    apiAnswers({
      ...standardAnswers("admin", [EXPECTED, LATENCY]),
      [`GET /v1/grader-library/${EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID}`]: {
        status: 200,
        body: EXPECTED_DEFINITION,
      },
    });
    render(<GradersPage />);

    const name = await screen.findByText("Expected behaviors");
    const row = name.closest("tr");
    if (row === null) throw new Error("the grader name is not in a table row");
    fireEvent.click(row);
    expect(
      await screen.findByRole("dialog", { name: "Expected behaviors" }),
    ).toBeTruthy();
  });

  it("offers the library row the active grader, or the way to use it", async () => {
    const activeLatencyDefinition = {
      ...LATENCY_DEFINITION,
      activeProjectGraderId: LATENCY.id,
    };
    apiAnswers({
      ...standardAnswers("admin", [EXPECTED, LATENCY], [
        EXPECTED_DEFINITION,
        activeLatencyDefinition,
      ]),
      "GET /v1/grader-library/grl_latency": {
        status: 200,
        body: activeLatencyDefinition,
      },
      "DELETE /v1/graders/grd_latency": { status: 204, body: null },
    });
    render(<GradersPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Grader library" }));
    expect(await screen.findByText("Response latency")).toBeTruthy();

    /* Egma's own grader is active and cannot be dropped: one item. */
    expect(await rowMenuItems("Expected behaviors")).toEqual([
      "View active grader",
    ]);
    fireEvent.keyDown(
      await screen.findByRole("menu", {
        name: "Open the menu for Expected behaviors",
      }),
      { key: "Escape" },
    );

    expect(await rowMenuItems("Response latency")).toEqual([
      "View active grader",
      "Remove grader",
    ]);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove grader" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Remove Response latency?" }),
    ).toBeTruthy();
  });

  it("opens the library sheet on the review, and on the form from Use in project", async () => {
    apiAnswers({
      ...standardAnswers(),
      "GET /v1/grader-library/grl_latency": {
        status: 200,
        body: LATENCY_DEFINITION,
      },
    });
    render(<GradersPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Grader library" }));

    await openRow("Response latency");
    let sheet = await screen.findByRole("dialog", { name: "Response latency" });
    expect(
      within(sheet).getByText(
        "Review this grader before choosing it for the project.",
      ),
    ).toBeTruthy();
    expect(within(sheet).getByText("Available")).toBeTruthy();
    const close = within(sheet).getAllByRole("button", { name: "Close" }).at(-1);
    if (close === undefined) throw new Error("the sheet has no close button");
    fireEvent.click(close);
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Response latency" }),
      ).toBeNull();
    });

    await chooseRowMenuItem("Response latency", "Use in project");
    sheet = await screen.findByRole("dialog", { name: "Response latency" });
    expect(
      within(sheet).getByText("Choose how this project will use the grader."),
    ).toBeTruthy();
    expect(
      within(sheet).getByLabelText("Maximum response time (p90)"),
    ).toBeTruthy();
  });
});
