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
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useParams: () => ({ projectId: routed.projectId }),
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
  settings: { maximum_average_response_time_ms: 3_000 },
  passThreshold: 1,
  ...DATES,
};

const EXPECTED_DEFINITION: GraderLibraryEntry = {
  id: EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID,
  name: "expected_behaviors",
  description: "Grades a completed simulation against its expected behaviors.",
  owner: "egma",
  type: "llm_as_judge",
  scopeEditable: false,
  currentDefinitionVersion: 1,
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
  modalities: ["chat", "voice"],
  gradingInstructions: null,
  requiredEvidence: ["turn_response_latency"],
  settingDefinitions: [
    {
      key: "maximum_average_response_time_ms",
      label: "Maximum average response time",
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

async function openRowMenu(name: string, item: string): Promise<void> {
  fireEvent.click(
    await screen.findByRole("button", { name: `Open the menu for ${name}` }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
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

  it("separates active project policy from the grader library without repeated headings", async () => {
    const { asked } = apiAnswers(standardAnswers());
    render(<GradersPage />);

    expect(await screen.findByText("Expected behaviors")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Active graders" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Grader library" })).toBeTruthy();
    expect(screen.getAllByText("Active graders")).toHaveLength(1);
    expect(screen.queryByText(/what active means/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /add predefined grader/i })).toBeNull();
    expect(screen.getByText("All simulations · Production off")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Grader library" }));
    expect(await screen.findByText("Response latency")).toBeTruthy();
    expect(screen.getAllByText("Grader library")).toHaveLength(1);
    expect(screen.getByText("Available")).toBeTruthy();
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
    await openRowMenu("expected_behaviors", "View and edit");
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

    await openRowMenu("Expected behaviors", "View and edit");
    await closeAfterMotion("Expected behaviors");

    fireEvent.click(screen.getByRole("tab", { name: "Grader library" }));
    await openRowMenu("Response latency", "View details");
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
    await openRowMenu("Response latency", "View details");

    const details = await screen.findByRole("dialog", { name: "Response latency" });
    expect(within(details).getByText("turn response latency")).toBeTruthy();
    expect(within(details).queryByLabelText("Maximum average response time")).toBeNull();
    fireEvent.click(within(details).getByRole("button", { name: "Use in project" }));

    const maximum = within(details).getByLabelText("Maximum average response time");
    expect((maximum as HTMLInputElement).value).toBe("3");
    fireEvent.change(maximum, { target: { value: "2.5" } });
    fireEvent.click(within(details).getByRole("button", { name: "Use in project" }));

    await waitFor(() => {
      expect(asked.find((one) => one.method === "POST")).toEqual({
        method: "POST",
        path: "/v1/grader-library/grl_latency/use?projectId=prj_1",
        body: {
          scope: { simulations: [], production: null },
          settings: { maximum_average_response_time_ms: 2_500 },
          passThreshold: 1,
        },
      });
    });
  });

  it("creates only an LLM judge with Grading instructions and no mechanism picker", async () => {
    const customDefinition: GraderLibraryEntry = {
      ...LATENCY_DEFINITION,
      id: "grl_custom",
      name: "Polite resolution",
      description: null,
      owner: "organization",
      type: "llm_as_judge",
      gradingInstructions: "The agent stays polite and resolves the request.",
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
      scope: { simulations: [], production: null },
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
    expect(within(sheet).getByLabelText("Grading instructions")).toBeTruthy();
    for (const absent of ["Type", "Model", "Output type", "Code"]) {
      expect(within(sheet).queryByLabelText(absent)).toBeNull();
    }
    fireEvent.change(within(sheet).getByLabelText("Name"), {
      target: { value: "Polite resolution" },
    });
    fireEvent.change(within(sheet).getByLabelText("Grading instructions"), {
      target: {
        value: "The agent stays polite and resolves the request.",
      },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Create grader" }));

    await waitFor(() => {
      expect(asked.find((one) => one.method === "POST")).toEqual({
        method: "POST",
        path: "/v1/grader-library/custom?projectId=prj_1",
        body: {
          name: "Polite resolution",
          description: null,
          gradingInstructions:
            "The agent stays polite and resolves the request.",
          modalities: ["chat", "voice"],
          scope: { simulations: [], production: null },
          passThreshold: 1,
        },
      });
    });
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
    fireEvent.click(within(sheet).getByLabelText("All simulations"));
    expect(
      (within(sheet).getByLabelText("Grades simulations") as HTMLInputElement)
        .checked,
    ).toBe(true);
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
      ).toBe(false);
    });
    expect(within(sheet).queryByLabelText("All simulations")).toBeNull();
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
    await openRowMenu("Response latency", "View and edit");

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

    await openRowMenu("Response latency", "View and edit");
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
    await openRowMenu("Expected behaviors", "View and edit");

    const sheet = await screen.findByRole("dialog", { name: "Expected behaviors" });
    expect(within(sheet).getByText("Fixed by Egma")).toBeTruthy();
    expect(within(sheet).getByText("Grades all simulations")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Remove grader" })).toBeNull();
    fireEvent.change(within(sheet).getByLabelText("Pass threshold"), {
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
    await openRowMenu("Response latency", "View and edit");

    let sheet = await screen.findByRole("dialog", { name: "Response latency" });
    fireEvent.click(within(sheet).getByLabelText("Grades simulations"));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(asked.find((one) => one.method === "PATCH")?.body).toEqual({
        scope: { simulations: [], production: null },
        settings: { maximum_average_response_time_ms: 3_000 },
        passThreshold: 1,
      });
    });
    expect(asked.some((one) => one.method === "DELETE")).toBe(false);

    await openRowMenu("Response latency", "View and edit");
    sheet = await screen.findByRole("dialog", { name: "Response latency" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Remove grader" }));
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
    await openRowMenu("Response latency", "View details");
    const details = await screen.findByRole("dialog", { name: "Response latency" });
    expect(within(details).getByText("Grades the average response time for a trace.")).toBeTruthy();
    expect(
      (within(details).getByRole("button", {
        name: "Use in project",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
