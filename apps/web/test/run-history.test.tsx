// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RunDetailPage from "../app/projects/[projectId]/runs/[runId]/page.tsx";
import RunsPage from "../app/projects/[projectId]/runs/page.tsx";
import type { Me } from "../lib/me.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

const routed = vi.hoisted(() => ({
  pathname: "/projects/prj_1/runs",
  params: { projectId: "prj_1", runId: "run_1" } as Record<string, string>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useParams: () => routed.params,
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

type Stub = { readonly status: number; readonly body: unknown } | "never";
type Sent = {
  readonly path: string;
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
};

let sent: Sent[] = [];

function answers(stubs: Record<string, Stub | readonly Stub[]>): void {
  const turns: Record<string, number> = {};
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = await observeRequest(input, init);
      sent.push({
        path: request.path,
        url: request.url,
        method: request.method,
        body: request.body,
      });
      const held = stubs[request.path];
      if (held === undefined) throw new Error(`nothing stubbed for ${request.path}`);
      const turn = turns[request.path] ?? 0;
      turns[request.path] = turn + 1;
      const answer = Array.isArray(held)
        ? (held[Math.min(turn, held.length - 1)] ?? "never")
        : held;
      if (answer === "never") return new Promise<Response>(() => undefined);
      return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
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

function runHeader(overrides: Record<string, unknown> = {}) {
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
    connectionKind: "retell_chat_api",
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
    createdAt: "2026-08-21T10:00:00.000Z",
    startedAt: "2026-08-21T10:00:01.000Z",
    finishedAt: "2026-08-21T10:01:00.000Z",
    ...overrides,
  };
}

function runDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...runHeader(),
    connectionSnapshot: {
      agentPlatform: "retell",
      connectionKind: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      topology: "hosted-broker",
      environment: "staging",
      config: { retellAgentId: "agent_abc" },
    },
    agent: { id: "agt_1", name: "Front desk", archived: false },
    connection: {
      id: "con_1",
      name: "retell-staging",
      productLabel: "Retell chat",
      archived: false,
    },
    ...overrides,
  };
}

function simulation(overrides: Record<string, unknown> = {}) {
  return {
    id: "sim_1",
    position: 1,
    testId: "tst_1",
    testName: "Books service",
    testVersionId: "tstv_1",
    personaId: "prs_1",
    personaName: "Patient caller",
    personaVersionId: "prsv_1",
    status: "completed",
    gradingState: "complete",
    reason: null,
    modality: "chat",
    hasRecording: false,
    mockToolCoverage: { discovered: [], covered: [], uncovered: [] },
    ...overrides,
  };
}

function shellStubs(): Record<string, Stub> {
  return {
    "/api/me": { status: 200, body: ME },
    "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
  };
}

beforeEach(() => {
  sent = [];
  routed.pathname = "/projects/prj_1/runs";
  routed.params = { projectId: "prj_1", runId: "run_1" };
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, search: "", replace: vi.fn() },
  });
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("run history after suites", () => {
  it("shows the run name and the suite's current name as separate facts", async () => {
    answers({
      ...shellStubs(),
      "/v1/runs": {
        status: 200,
        body: { runs: [runHeader()], nextPageToken: null },
      },
    });
    render(<RunsPage />);

    const table = await screen.findByRole("table", { name: "Runs in this project" });
    expect(within(table).getByRole("link", { name: "Release check" }).getAttribute("href")).toBe(
      "/projects/prj_1/runs/run_1",
    );
    expect(
      within(table).getByRole("link", { name: "Northside Ford" }).getAttribute("href"),
    ).toBe("/projects/prj_1/tests/suites/ste_1");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toContain("Test suite");
  });

  it("keeps historical runs readable after their suite is deleted", async () => {
    answers({
      ...shellStubs(),
      "/v1/runs": {
        status: 200,
        body: {
          runs: [runHeader({ suiteName: "Northside Ford", suiteDeleted: true })],
          nextPageToken: null,
        },
      },
    });
    render(<RunsPage />);

    const table = await screen.findByRole("table", { name: "Runs in this project" });
    expect(within(table).getByText("Northside Ford (deleted)")).toBeTruthy();
    expect(within(table).queryByRole("link", { name: "Northside Ford (deleted)" })).toBeNull();
  });

  it("loads the next bounded page from the runs field", async () => {
    answers({
      ...shellStubs(),
      "/v1/runs": [
        {
          status: 200,
          body: { runs: [runHeader()], nextPageToken: "run_next" },
        },
        {
          status: 200,
          body: {
            runs: [runHeader({ id: "run_2", name: "Second release check" })],
            nextPageToken: null,
          },
        },
      ],
    });
    render(<RunsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("link", { name: "Second release check" })).toBeTruthy();
    expect(
      sent.some(
        (request) =>
          request.path === "/v1/runs" && request.url.includes("pageToken=run_next"),
      ),
    ).toBe(true);
  });
});

describe("one run after suites", () => {
  function detailStubs(
    detail: Record<string, unknown> = runDetail(),
    pages: Stub | readonly Stub[] = {
      status: 200,
      body: { simulations: [simulation()], nextPageToken: null },
    },
  ): Record<string, Stub | readonly Stub[]> {
    return {
      "/api/me": { status: 200, body: ME },
      "/v1/runs/run_1": { status: 200, body: detail },
      "/v1/runs/run_1/simulations": pages,
      "/v1/runs/run_1/cancel": { status: 200, body: detail },
    };
  }

  it("reads simulations from their bounded endpoint and offers no rerun control", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(detailStubs());
    render(<RunDetailPage />);

    expect(await screen.findByRole("heading", { name: "Release check" })).toBeTruthy();
    const suite = screen.getByRole("link", { name: "Northside Ford" });
    expect(suite.getAttribute("href")).toBe("/projects/prj_1/tests/suites/ste_1");
    expect(await screen.findByRole("link", { name: "Books service" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run again|retry/i })).toBeNull();
    expect(
      sent.some(
        (request) =>
          request.method === "GET" && request.path === "/v1/runs/run_1/simulations",
      ),
    ).toBe(true);
  });

  it("uses the suite name as the title when the optional run name is absent", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(detailStubs(runDetail({ name: null })));
    render(<RunDetailPage />);

    expect(await screen.findByRole("heading", { name: "Northside Ford" })).toBeTruthy();
  });

  it("shows a deleted suite as history, not as a live link", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(detailStubs(runDetail({ suiteDeleted: true, name: null })));
    render(<RunDetailPage />);

    const summary = await screen.findByRole("group", { name: "Run summary" });
    expect(within(summary).getByText("Northside Ford (deleted)")).toBeTruthy();
    expect(within(summary).queryByRole("link", { name: /Northside Ford/u })).toBeNull();
  });

  it("loads more simulations with the cursor and keeps the first page", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(
      detailStubs(runDetail(), [
        {
          status: 200,
          body: { simulations: [simulation()], nextPageToken: "sim_next" },
        },
        {
          status: 200,
          body: {
            simulations: [
              simulation({ id: "sim_2", position: 2, testName: "Reschedules service" }),
            ],
            nextPageToken: null,
          },
        },
      ]),
    );
    render(<RunDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("link", { name: "Reschedules service" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Books service" })).toBeTruthy();
    expect(
      sent.some(
        (request) =>
          request.path === "/v1/runs/run_1/simulations" &&
          request.url.includes("pageToken=sim_next"),
      ),
    ).toBe(true);
  });

  it("keeps execution failure separate from grades without capability text", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    answers(
      detailStubs(runDetail(), {
        status: 200,
        body: {
          simulations: [
            simulation({
              status: "failed",
              gradingState: "not_requested",
              reason: "not_answered",
            }),
          ],
          nextPageToken: null,
        },
      }),
    );
    render(<RunDetailPage />);

    expect(await screen.findByText(/execution problem, not a low grade/u)).toBeTruthy();
    expect(screen.queryByText(/capabilit/u)).toBeNull();
  });

  it("still cancels an active run but offers no retry or rerun", async () => {
    routed.pathname = "/projects/prj_1/runs/run_1";
    const active = runDetail({
      status: "running",
      finishedAt: null,
      gradedCount: 0,
      gradableCount: 1,
      simulationCounts: { ...NO_SIMULATIONS, running: 1 },
    });
    answers({
      ...detailStubs(active, {
        status: 200,
        body: {
          simulations: [
            simulation({ status: "running", gradingState: null }),
          ],
          nextPageToken: null,
        },
      }),
      "/v1/runs/run_1/events": "never",
    });
    render(<RunDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel run “Release check”?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));
    await waitFor(() => {
      expect(
        sent.some(
          (request) =>
            request.method === "POST" && request.path === "/v1/runs/run_1/cancel",
        ),
      ).toBe(true);
    });
    expect(screen.queryByRole("button", { name: /run again|retry/i })).toBeNull();
  });
});
