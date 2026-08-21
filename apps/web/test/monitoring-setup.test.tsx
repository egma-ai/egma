// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MonitoringSetupPage from "../app/projects/[projectId]/monitoring/setup/page.tsx";
import { observeRequest, type FetchInput } from "./platform-request.ts";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/prj_2/monitoring/setup",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: "prj_2" }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: unknown;
  }) => <a href={href} {...rest}>{children as never}</a>,
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const ME = {
  user: { id: "usr_1", email: "ada@acme.example" },
  organizations: [{ id: "org_1", name: "Acme", slug: "acme", role: "admin" }],
  projects: [{ id: "prj_2", name: "Outbound", slug: "outbound" }],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Monitoring setup", () => {
  it("shows an unexpected Retell response instead of calling the agent active", async () => {
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput) => {
        const { address: at } = await observeRequest(input);
        if (at.pathname === "/api/me") return json(200, ME);
        if (at.pathname === "/v1/monitoring") {
          return json(200, {
            monitoringSources: [
              {
                id: "mns_1",
                projectId: "prj_2",
                agentPlatform: "retell",
                strategy: "retell_api_polling",
                credentialsHint: "cdef",
                health: {
                  state: "healthy",
                  blockedUntil: null,
                  consecutiveFailures: 0,
                  lastErrorAt: null,
                  lastRecoveredAt: null,
                  lastReceivedAt: null,
                },
                agents: [
                  {
                    id: "rma_1",
                    platformAgentId: "agent_1",
                    platformAgentName: "Front desk",
                    state: "active",
                    scanKind: null,
                    lastSuccessAt: null,
                    lastConversationAt: null,
                    lastErrorKind: "provider_contract",
                    lastErrorAt: "2026-08-20T00:00:00.000Z",
                    consecutiveFailures: 1,
                    failures: [],
                  },
                ],
              },
            ],
          });
        }
        throw new Error(`nothing stubbed for GET ${at.pathname}`);
      }),
    );

    render(<MonitoringSetupPage />);
    expect(
      await screen.findByText(
        "1 agent received an unexpected Retell response. Egma will retry.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Unexpected Retell response")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("retries one durable Retell import failure and refreshes its status", async () => {
    const asked: { method: string; path: string }[] = [];
    let reads = 0;
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const request = await observeRequest(input, init);
        const { address: at, method } = request;
        asked.push({ method, path: at.pathname });
        if (at.pathname === "/api/me") return json(200, ME);
        if (at.pathname === "/v1/monitoring" && method === "GET") {
          reads += 1;
          return json(200, {
            monitoringSources: [
              {
                id: "mns_1",
                projectId: "prj_2",
                agentPlatform: "retell",
                strategy: "retell_api_polling",
                credentialsHint: "cdef",
                health: {
                  state: "healthy",
                  blockedUntil: null,
                  consecutiveFailures: 0,
                  lastErrorAt: null,
                  lastRecoveredAt: null,
                  lastReceivedAt: null,
                },
                agents: [
                  {
                    id: "rma_1",
                    platformAgentId: "agent_1",
                    platformAgentName: "Front desk",
                    state: reads === 1 ? "degraded" : "active",
                    scanKind: null,
                    lastSuccessAt: null,
                    lastConversationAt: null,
                    lastErrorKind: reads === 1 ? "provider_call_not_found" : null,
                    lastErrorAt: null,
                    consecutiveFailures: 0,
                    failures:
                      reads === 1
                        ? [
                            {
                              id: "rif_1",
                              providerCallId: "call_1",
                              errorKind: "provider_call_not_found",
                              attempts: 1,
                              status: "open",
                              lastAttemptAt: "2026-08-20T00:00:00.000Z",
                              createdAt: "2026-08-20T00:00:00.000Z",
                            },
                          ]
                        : [],
                  },
                ],
              },
            ],
          });
        }
        if (
          at.pathname === "/v1/monitoring/retell/failures/rif_1/replay" &&
          method === "POST"
        ) {
          return json(200, {
            failure: { id: "rif_1", status: "resolved" },
            trace: { id: "trace_1", write: "written" },
          });
        }
        throw new Error(`nothing stubbed for ${method} ${at.pathname}`);
      }),
    );

    render(<MonitoringSetupPage />);
    expect(await screen.findByText("1 agent needs attention.")).toBeTruthy();
    expect(screen.getByText("Front desk")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(document.querySelector('[data-state-mark="error"]')).toBeTruthy();
    const retry = await screen.findByRole("button", { name: "Retry import" });
    fireEvent.click(retry);

    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByRole("button", { name: "Retry import" })).toBeNull();
    expect(await screen.findByText("Active")).toBeTruthy();
    expect(document.querySelector('[data-state-mark="complete"]')).toBeTruthy();
    expect(asked).toContainEqual({
      method: "POST",
      path: "/v1/monitoring/retell/failures/rif_1/replay",
    });
  });

  it("asks before it removes a setup", async () => {
    let deletes = 0;
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const request = await observeRequest(input, init);
        const { address: at, method } = request;
        if (at.pathname === "/api/me") return json(200, ME);
        if (at.pathname === "/v1/monitoring" && method === "GET") {
          return json(200, {
            monitoringSources:
              deletes === 0
                ? [
                    {
                      id: "mns_1",
                      projectId: "prj_2",
                      agentPlatform: "retell",
                      strategy: "retell_api_polling",
                      credentialsHint: "cdef",
                      health: {
                        state: "healthy",
                        blockedUntil: null,
                        consecutiveFailures: 0,
                        lastErrorAt: null,
                        lastRecoveredAt: null,
                        lastReceivedAt: null,
                      },
                      agents: [],
                    },
                  ]
                : [],
          });
        }
        if (at.pathname === "/v1/monitoring/retell" && method === "DELETE") {
          deletes += 1;
          return new Response(null, { status: 204 });
        }
        throw new Error(`nothing stubbed for ${method} ${at.pathname}`);
      }),
    );

    render(<MonitoringSetupPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove setup" }),
    );

    expect(deletes).toBe(0);
    const dialog = screen.getByRole("dialog", {
      name: "Remove Retell Monitoring setup?",
    });
    expect(
      within(dialog).getByText(/stop polling every selected Retell agent/u),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/production conversations stay/u),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/traces stay/u)).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove setup" }),
    );

    await waitFor(() => expect(deletes).toBe(1));
  });

  it("protects an unfinished Retell form before switching platforms", async () => {
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput) => {
        const { address: at } = await observeRequest(input);
        if (at.pathname === "/api/me") return json(200, ME);
        if (at.pathname === "/v1/monitoring") {
          return json(200, { monitoringSources: [] });
        }
        throw new Error(`nothing stubbed for GET ${at.pathname}`);
      }),
    );

    render(<MonitoringSetupPage />);
    const platform = await screen.findByLabelText("Agent platform");
    fireEvent.change(platform, { target: { value: "retell" } });
    fireEvent.change(screen.getByLabelText("Retell API key"), {
      target: { value: "secret-key" },
    });
    fireEvent.change(platform, { target: { value: "livekit_agents" } });

    const dialog = screen.getByRole("dialog", {
      name: "Discard Retell setup changes?",
    });
    expect(
      (screen.getByLabelText("Retell API key") as HTMLInputElement).value,
    ).toBe("secret-key");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.change(platform, { target: { value: "livekit_agents" } });
    fireEvent.click(
      within(
        screen.getByRole("dialog", {
          name: "Discard Retell setup changes?",
        }),
      ).getByRole("button", { name: "Discard changes" }),
    );

    expect(
      await screen.findByRole("heading", { name: "LiveKit Agents" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Retell API key")).toBeNull();
  });
});
