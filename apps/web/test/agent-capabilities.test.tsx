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

import AgentsPage from "../app/projects/[projectId]/agents/page.tsx";
import type { Me } from "../lib/me.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/** Paper boards 25 and 32, through the real Agents page and API seam. */

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  pathname: "/projects/prj_1/agents",
  search: "",
  params: { projectId: "prj_1" },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: routed.push, replace: routed.replace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(routed.search),
  useParams: () => routed.params,
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
  organizations: [
    { id: "org_1", name: "Acme", slug: "acme", role: "member" },
  ],
  projects: [{ id: "prj_1", name: "Default", slug: "default" }],
};

const MOMENT = "2026-08-27T10:00:00.000Z";

function connection({
  id,
  agentId,
  connectionType,
}: {
  readonly id: string;
  readonly agentId: string;
  readonly connectionType: "retell_text_mode" | "phone_number" | "livekit_room";
}) {
  const livekit = connectionType === "livekit_room";
  const chat = connectionType === "retell_text_mode";
  return {
    id,
    agentId,
    projectId: "prj_1",
    name: `${connectionType} connection`,
    agentPlatform: livekit ? "livekit" : "retell",
    connectionType,
    accessVariant: livekit
      ? "livekit_room.project_credentials"
      : chat
        ? "retell_text_mode.api_key"
        : "phone_number.public_e164",
    modality: chat ? "chat" : "voice",
    productLabel: livekit
      ? "LiveKit project credentials"
      : chat
        ? "Retell text mode"
        : "Phone number",
    topology: livekit ? "agent-dials-out" : chat ? "hosted-broker" : "egma-dials-in",
    environment: null,
    config: livekit
      ? { url: "wss://acme.livekit.cloud", agentName: "front-desk" }
      : {},
    credentialPresent: livekit || chat,
    credentialsHint: livekit || chat ? "WXYZ" : null,
    archived: false,
    archivedAt: null,
    createdAt: MOMENT,
    updatedAt: MOMENT,
  };
}

function agent({
  id,
  name,
  agentPlatform = "retell",
  retellModality = null,
  platformAgentId = null,
  monitoringApiKeyHint = null,
  monitoringConfigured = false,
  pullProductionCalls = false,
  lastReceivedAt = null,
  connections = [],
}: {
  readonly id: string;
  readonly name: string;
  readonly agentPlatform?: "retell" | "livekit";
  readonly retellModality?: "voice" | "chat" | null;
  readonly platformAgentId?: string | null;
  readonly monitoringApiKeyHint?: string | null;
  readonly monitoringConfigured?: boolean;
  readonly pullProductionCalls?: boolean;
  readonly lastReceivedAt?: string | null;
  readonly connections?: readonly ReturnType<typeof connection>[];
}) {
  return {
    id,
    projectId: "prj_1",
    name,
    agentPlatform,
    retellModality,
    platformAgentId,
    monitoringKeyPresent: monitoringApiKeyHint !== null,
    monitoringApiKeyHint,
    monitoringConfigured,
    pullProductionCalls,
    lastReceivedAt,
    archived: false,
    archivedAt: null,
    createdAt: MOMENT,
    updatedAt: MOMENT,
    connections,
  };
}

function answerWith(...agents: readonly ReturnType<typeof agent>[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, options?: RequestInit) => {
      const request = await observeRequest(input, options);
      const body =
        request.path === "/api/me"
          ? ME
          : request.path === "/v1/agents"
            ? { agents, nextPageToken: null }
            : (() => {
                throw new Error(`nothing stubbed for ${request.path}`);
              })();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function rowNamed(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  expect(row).not.toBeNull();
  return row!;
}

beforeEach(() => {
  routed.push.mockReset();
  routed.replace.mockReset();
  routed.pathname = "/projects/prj_1/agents";
  routed.search = "";
  routed.params = { projectId: "prj_1" };
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Paper agent capability states", () => {
  it("uses the three Retell monitoring states and explains a chat limitation", async () => {
    answerWith(
      agent({ id: "agt_new", name: "Fresh agent" }),
      agent({
        id: "agt_stopped",
        name: "Stopped pull",
        retellModality: "voice",
        monitoringConfigured: true,
      }),
      agent({
        id: "agt_chat",
        name: "Chat agent",
        retellModality: "chat",
        connections: [
          connection({
            id: "con_chat",
            agentId: "agt_chat",
            connectionType: "retell_text_mode",
          }),
        ],
      }),
    );

    render(<AgentsPage />);
    await screen.findByRole("table", { name: "Agents in this project" });

    expect(within(rowNamed("Fresh agent")).getAllByText("Not configured")).toHaveLength(2);
    expect(within(rowNamed("Stopped pull")).getByText("Stopped")).toBeDefined();
    expect(
      within(rowNamed("Stopped pull")).getByText("Production monitoring is stopped"),
    ).toBeDefined();
    expect(within(rowNamed("Chat agent")).getByText("Configured")).toBeDefined();
    expect(
      within(rowNamed("Chat agent")).getByText(
        "Production monitoring needs a Retell voice agent",
      ),
    ).toBeDefined();
  });

  it("stops Retell monitoring from details and changes the durable state", async () => {
    routed.search = "?sheet=agent&agent=agt_active";
    const active = agent({
      id: "agt_active",
      name: "Active pull",
      retellModality: "voice",
      monitoringConfigured: true,
      pullProductionCalls: true,
    });
    const stopped = { ...active, pullProductionCalls: false };
    let reads = 0;
    const requests: Array<{ readonly path: string; readonly method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, options?: RequestInit) => {
        const request = await observeRequest(input, options);
        requests.push({ path: request.url, method: request.method });
        const body =
          request.path === "/api/me"
            ? ME
            : request.path === "/v1/agents"
              ? { agents: [reads++ === 0 ? active : stopped], nextPageToken: null }
              : request.path === "/v1/monitoring/agents/agt_active/stop"
                ? { monitoring: { agentId: "agt_active", pullProductionCalls: false } }
                : (() => {
                    throw new Error(`nothing stubbed for ${request.path}`);
                  })();
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    render(<AgentsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop monitoring" }));

    await waitFor(() =>
      expect(requests).toContainEqual({
        path: "/v1/monitoring/agents/agt_active/stop?projectId=prj_1",
        method: "POST",
      }),
    );
    await waitFor(
      () =>
        expect(
          requests.filter(
            (request) =>
              request.path === "/v1/agents?projectId=prj_1" &&
              request.method === "GET",
          ),
        ).toHaveLength(2),
      { timeout: 5_000 },
    );
    expect(
      await screen.findByRole(
        "link",
        { name: "Resume monitoring" },
        { timeout: 5_000 },
      ),
    ).toBeDefined();
  });
});
