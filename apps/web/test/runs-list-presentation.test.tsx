// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RunsPage from "../app/projects/[projectId]/runs/page.tsx";
import type { Me } from "../lib/me.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/prj_1/runs",
  useParams: () => ({ projectId: "prj_1" }),
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

const ME: Me = {
  user: { id: "usr_1", email: "ada@acme.example" },
  organizations: [{ id: "org_1", name: "Acme", slug: "acme", role: "admin" }],
  projects: [{ id: "prj_1", name: "Receptionists", slug: "receptionists" }],
};

type Stub = { readonly status: number; readonly body: unknown };
let requested: string[] = [];

function answers(stubs: Record<string, Stub>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = await observeRequest(input, init);
      requested.push(request.url);
      const answer = stubs[request.path];
      if (answer === undefined) throw new Error(`nothing stubbed for ${request.path}`);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const NO_SIMULATIONS = {
  queued: 0,
  claimed: 0,
  running: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
};

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    projectId: "prj_1",
    status: "completed",
    suiteId: "ste_1",
    suiteName: "Northside Ford",
    suiteDeleted: false,
    name: "Release check",
    agentId: "agt_1",
    connectionId: "con_1",
    agentPlatform: "retell",
    connectionType: "retell_chat_api",
    accessVariant: "retell_chat_api.api_key",
    modality: "chat",
    productLabel: "Retell chat",
    environment: "staging",
    expectedSimulationCount: 1,
    completedCount: 1,
    failedCount: 0,
    canceledCount: 0,
    simulationCounts: { ...NO_SIMULATIONS, completed: 1 },
    finishedCount: 1,
    gradableCount: 1,
    gradedCount: 1,
    resultsUrl: "/projects/prj_1/runs/run_1",
    createdAt: "2026-08-25T18:00:00.000Z",
    startedAt: "2026-08-25T18:00:01.000Z",
    finishedAt: "2026-08-25T18:01:00.000Z",
    ...overrides,
  };
}

function shellStubs(runs: readonly unknown[]): Record<string, Stub> {
  return {
    "/api/me": { status: 200, body: ME },
    "/v1/agents": {
      status: 200,
      body: {
        agents: [
          {
            id: "agt_1",
            name: "Front desk",
            agentPlatform: "retell",
            connections: [],
          },
        ],
        nextPageToken: null,
      },
    },
    "/v1/runs": { status: 200, body: { runs, nextPageToken: null } },
  };
}

beforeEach(() => {
  requested = [];
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-25T19:00:00.000Z"));
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, search: "", replace: vi.fn() },
  });
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("runs list presentation", () => {
  it("keeps one create action and the final empty-state copy", async () => {
    answers(shellStubs([]));
    render(<RunsPage />);

    expect(screen.getByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(await screen.findByText("Create your first simulation run")).toBeTruthy();
    expect(
      screen.getByText("A run simulates a full test suite against a selected agent."),
    ).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Create a run" })).toHaveLength(1);
    const agentFilter = screen.getByRole("combobox", {
      name: "Show only runs against one agent",
    });
    expect(agentFilter.className).toContain("w-[160px]");
    expect(
      screen.queryByLabelText("Show runs started on or after a local date"),
    ).toBeNull();
    expect(
      screen.getByText("Create your first simulation run").closest("section")?.parentElement
        ?.className,
    ).toContain("min-h-[204px]");
    expect(screen.queryByLabelText(/connection/i)).toBeNull();
    expect(screen.queryByLabelText(/run state/i)).toBeNull();

    fireEvent.change(agentFilter, { target: { value: "agt_1" } });
    expect(await screen.findByText("No run here matches that")).toBeTruthy();
    expect(screen.getByText("Clear the filters to see every run in this project.")).toBeTruthy();
    await waitFor(() => {
      expect(requested.filter((url) => url.startsWith("/v1/runs"))).toHaveLength(2);
    });
    expect(requested.some((url) => url.includes("since="))).toBe(false);
  });

  it("opens Create run over the same mounted list without reading the list again", async () => {
    answers({
      ...shellStubs([run()]),
      "/v1/test-suites": {
        status: 200,
        body: { testSuites: [], nextPageToken: null },
      },
    });
    const pushed = vi.spyOn(window.history, "pushState");
    render(<RunsPage />);

    const table = await screen.findByRole("table", { name: "Runs in this project" });
    expect(screen.getByRole("heading", { name: "Runs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Create a run" }));

    expect(await screen.findByRole("dialog", { name: "Create a run" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Runs", hidden: true })).toBeTruthy();
    expect(document.querySelector('table[aria-label="Runs in this project"]')).toBe(table);
    expect(pushed).toHaveBeenCalledWith(
      null,
      "",
      "/projects/prj_1/runs/new",
    );
    expect(requested.filter((url) => url.startsWith("/v1/runs"))).toHaveLength(1);
    expect(requested.filter((url) => url.startsWith("/v1/agents"))).toHaveLength(1);
  });

  it("keeps modified Create run clicks as ordinary deep links", async () => {
    answers(shellStubs([run()]));
    const pushed = vi.spyOn(window.history, "pushState");
    render(<RunsPage />);

    const create = await screen.findByRole("link", { name: "Create a run" });
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    create.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(false);
    expect(create.getAttribute("href")).toBe("/projects/prj_1/runs/new");
    expect(pushed).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Create a run" })).toBeNull();
  });

  it("shows only the five requested facts and resolves the agent identity", async () => {
    answers(shellStubs([run()]));
    render(<RunsPage />);

    const table = await screen.findByRole("table", { name: "Runs in this project" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent ?? "")
      .filter((header) => header !== "");

    expect(headers).toEqual(["Run", "Test suite", "Agent", "Started", "Status"]);
    expect(within(table).queryByText("Execution")).toBeNull();
    expect(within(table).queryByText("Combined score")).toBeNull();
    expect(within(table).getByText("Front desk")).toBeTruthy();
    const started = within(table).getByText("Aug 25, 2026");
    expect(started.getAttribute("datetime")).toBe("2026-08-25T18:00:01.000Z");
    const headerCells = within(table).getAllByRole("columnheader");
    expect(headerCells.slice(0, 5).map((header) => header.style.width)).toEqual([
      "24%",
      "20%",
      "22%",
      "17%",
      "17%",
    ]);
    expect(table.parentElement?.parentElement?.parentElement?.className).toContain(
      "[--row-min-height:56px]",
    );

    const dataRow = within(table).getAllByRole("row")[1] as HTMLElement;
    const runLink = within(table).getByRole("link", { name: "Release check" });
    expect(dataRow.dataset.stretchPrimaryLink).toBe("true");
    expect(dataRow.getAttribute("onclick")).toBeNull();
    expect(runLink.getAttribute("href")).toBe("/projects/prj_1/runs/run_1");
    expect(runLink.getAttribute("tabindex")).toBeNull();
    expect(within(dataRow).getAllByRole("link")).toHaveLength(1);
    expect(within(dataRow).queryByRole("link", { name: "Northside Ford" })).toBeNull();
    expect(runLink.className).toContain("no-underline");
    expect(runLink.className).toContain("pointer-hover:underline");
    const completed = within(table).getByText("Completed");
    expect(completed.closest('[data-slot="badge"]')).toBeNull();
    expect(completed.querySelector('[data-slot="state-mark"]')?.className).toContain(
      "size-2.5",
    );
  });

  it("uses an honest fallback and a local date-time for an older run", async () => {
    answers(
      shellStubs([
        run({
          agentId: "agt_archived",
          createdAt: "2026-07-01T18:00:00.000Z",
        }),
      ]),
    );
    render(<RunsPage />);

    const table = await screen.findByRole("table", { name: "Runs in this project" });
    expect(within(table).getByText("Unavailable agent")).toBeTruthy();
    const instant = within(table).getByText(/2026/).textContent ?? "";
    expect(instant).not.toMatch(/\b(?:UTC|GMT|PDT|PST)\b/u);
  });

  it("does not claim that a pending run has started", async () => {
    answers(shellStubs([run({ status: "pending", startedAt: null })]));
    render(<RunsPage />);

    const table = await screen.findByRole("table", { name: "Runs in this project" });
    expect(within(table).getByText("Not started")).toBeTruthy();
    expect(within(table).queryByText("Aug 25, 2026")).toBeNull();
  });

  it("keeps a row action interactive above the stretched run link", async () => {
    answers(shellStubs([run({ status: "running" })]));
    render(<RunsPage />);

    const table = await screen.findByRole("table", { name: "Runs in this project" });
    const dataRow = within(table).getAllByRole("row")[1] as HTMLElement;
    const menu = within(dataRow).getByRole("button", {
      name: "Actions for Release check",
    });

    expect(dataRow.dataset.stretchPrimaryLink).toBe("true");
    expect(menu).toBeTruthy();
    expect(within(dataRow).getAllByRole("link")).toHaveLength(1);
  });
});
