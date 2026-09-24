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
import { currentDraftState } from "../ui/settings-read.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

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

type Stubbed = { readonly status: number; readonly body: unknown; readonly waitFor?: Promise<void> };

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
      await answer.waitFor;
      return json(answer.status, answer.body);
    }),
  );
  return { asked };
}

const DATES = {
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:00:00.000Z",
};

const MODEL_SETTINGS = [
  { key: "llm_provider", label: "LLM provider", valueType: "string", defaultValue: "openai", unit: null, minimum: null, maximum: null },
  { key: "llm_model", label: "LLM model", valueType: "string", defaultValue: "gpt-5.6-terra", unit: null, minimum: null, maximum: null },
] as const;

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
  settings: { llm_provider: "openai", llm_model: "gpt-5.6-terra" },
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
  settingDefinitions: [...MODEL_SETTINGS],
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
    "GET /v1/grader-form": { status: 200, body: { settingDefinitions: MODEL_SETTINGS, modelCatalog: [
      { provider: "openai", model: "gpt-4o-mini", label: "OpenAI" },
      { provider: "openai", model: "gpt-5.6-terra", label: "OpenAI" },
    ] } },
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
    expect(within(details).queryByLabelText("Maximum acceptable response latency")).toBeNull();
    fireEvent.click(within(details).getByRole("button", { name: "Use in project" }));

    const maximum = within(details).getByLabelText("Maximum acceptable response latency*");
    expect(maximum.getAttribute("aria-required")).toBe("true");
    expect((maximum as HTMLInputElement).value).toBe("3");
    fireEvent.change(maximum, { target: { value: "2.5" } });
    fireEvent.click(within(details).getByRole("button", { name: "Use in project" }));

    await waitFor(() => {
      expect(asked.find((one) => one.method === "POST")).toEqual({
        method: "POST",
        path: "/v1/grader-library/grl_latency/use?projectId=prj_1",
        body: {
          scope: { simulations: [{ kind: "all" }], production: null },
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
      owner: "project",
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
      owner: "project",
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
        "Create a grader for this project.",
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
        "The judge reads the transcript, tool calls, and metrics of one conversation.",
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
    expect(
      within(sheet).getByText("A value between 0 and 1."),
    ).toBeTruthy();
    const thresholdHelp = within(sheet).getByRole("button", {
      name: "What does pass threshold mean?",
    });
    const thresholdHeading = thresholdHelp.closest("p");
    if (thresholdHeading === null) {
      throw new Error("The threshold help must sit in the section heading.");
    }
    expect(thresholdHeading.textContent).toContain("Pass threshold");

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
    const description = within(sheet).getByLabelText("Description");
    expect(description.tagName).toBe("INPUT");

    /* The judge answers met or not met. It never returns a fraction. */
    expect(
      within(sheet).queryByText(
        "Describe what the agent must do. The grader returns a score between 0 and 1.",
      ),
    ).toBeNull();
    expect(
      within(sheet).queryByText(
        "From 0 to 1. A simulation passes this grader at or above this score.",
      ),
    ).toBeNull();

    /*
     * And the order, which is the sheet's argument rather than a layout
     * detail: the framing line before anything is asked for, the evidence
     * sentence above the three boxes it governs, and the boundary drawn
     * before the scope, settings, and threshold that apply it. Presence alone would
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
        "Description",
        within(sheet).getByLabelText("Description"),
      ],
      [
        "evidence sentence",
        within(sheet).getByText(
          "The judge reads the transcript, tool calls, and metrics of one conversation.",
        ),
      ],
      [
        "Grading instructions*",
        within(sheet).getByLabelText("Grading instructions*"),
      ],
      ["Passes when*", within(sheet).getByLabelText("Passes when*")],
      ["Fails when*", within(sheet).getByLabelText("Fails when*")],
      ["Scope", within(sheet).getByText("Scope")],
      ["Settings", within(sheet).getByText("Settings")],
      ["Pass threshold", thresholdHeading],
      ["Pass threshold*", within(sheet).getByLabelText("Pass threshold*")],
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
          settings: { llm_provider: "openai", llm_model: "gpt-5.6-terra" },
          scope: { simulations: [{ kind: "all" }], production: null },
          passThreshold: 1,
        },
      });
    });
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
});

const REVIEW_CORE: GraderLibraryEntry = {
  ...EXPECTED_DEFINITION,
  id: "grl_review",
  name: "Reviewed core",
  owner: "project",
  scopeEditable: true,
  gradingInstructions: "The version one instruction.",
  activeProjectGraderId: null,
};

describe("grader review regressions", () => {
  it("protects core drafts on Back and close, blocks closing during save, and keeps a stale save's original base", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { asked } = apiAnswers({
      ...standardAnswers("admin", [EXPECTED], [REVIEW_CORE]),
      "GET /v1/grader-library/grl_review": { status: 200, body: REVIEW_CORE },
      "PATCH /v1/grader-library/grl_review": {
        status: 409, body: { error: "conflict", message: "This core changed. Read the current version before editing." }, waitFor: pending,
      },
    });
    render(<GradersPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Grader library" }));
    await openRow("Reviewed core");
    const sheet = await screen.findByRole("dialog", { name: "Reviewed core" });
    fireEvent.click(await within(sheet).findByRole("button", { name: "Edit core" }));
    fireEvent.change(within(sheet).getByLabelText("Name*"), { target: { value: "My unsaved name" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    let question = await screen.findByRole("dialog", { name: "Leave without saving?" });
    fireEvent.click(within(question).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave without saving?" })).toBeNull());
    expect((within(sheet).getByLabelText("Name*") as HTMLInputElement).value).toBe("My unsaved name");
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    question = await screen.findByRole("dialog", { name: "Leave without saving?" });
    fireEvent.click(within(question).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave without saving?" })).toBeNull());
    fireEvent.click(within(sheet).getByRole("button", { name: "Save core" }));
    await waitFor(() => expect(currentDraftState()).toBe("saving"));
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Reviewed core" })).toBe(sheet);
    expect(screen.queryByRole("dialog", { name: "Leave without saving?" })).toBeNull();
    await act(async () => { release(); });
    await within(sheet).findByText("This core changed. Read the current version before editing.");
    expect(asked.find((one) => one.method === "PATCH")?.body).toMatchObject({
      baseDefinitionVersion: 1, gradingInstructions: REVIEW_CORE.gradingInstructions, name: "My unsaved name",
    });
    expect((within(sheet).getByLabelText("Name*") as HTMLInputElement).value).toBe("My unsaved name");
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    question = await screen.findByRole("dialog", { name: "Leave without saving?" });
    fireEvent.click(within(question).getByRole("button", { name: "Discard changes" }));
    await within(sheet).findByRole("button", { name: "Edit core" });
    expect(within(sheet).queryByLabelText("Name*")).toBeNull();
  });
});
