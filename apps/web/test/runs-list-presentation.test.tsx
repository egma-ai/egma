// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
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
    connectionName: "Staging chat key",
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
  it("uses an honest fallback and a local date-time for an older run", async () => {
    answers(
      shellStubs([
        run({
          agentId: "agt_archived",
          connectionName: null,
          createdAt: "2026-07-01T18:00:00.000Z",
        }),
      ]),
    );
    render(<RunsPage />);

    const table = await screen.findByRole("table", { name: "Runs in this project" });
    expect(within(table).getByText("Unavailable agent")).toBeTruthy();
    expect(within(table).getByText("Unavailable connection")).toBeTruthy();
    const instant = within(table).getByText(/2026/).textContent ?? "";
    expect(instant).not.toMatch(/\b(?:UTC|GMT|PDT|PST)\b/u);
  });

  it("does not claim that a pending run has started", async () => {
    answers(shellStubs([run({ status: "pending", startedAt: null })]));
    render(<RunsPage />);

    const table = await screen.findByRole("table", { name: "Runs in this project" });
    expect(within(table).getByText("Not started")).toBeTruthy();
    expect(within(table).queryByText(/^Aug 25, 2026/u)).toBeNull();
  });
});
