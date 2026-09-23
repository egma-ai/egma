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

/** A Pipecat connection, on Pipecat Cloud or behind a self-hosted starter. */
function pipecatConnection({
  id,
  agentId,
  modality = "voice",
  config,
}: {
  readonly id: string;
  readonly agentId: string;
  readonly modality?: "voice" | "chat";
  readonly config:
    | { readonly agentName: string }
    | { readonly startUrl: string };
}) {
  const cloud = "agentName" in config;
  return {
    id,
    agentId,
    projectId: "prj_1",
    name: `pipecat_${modality}-${id}`,
    agentPlatform: "pipecat",
    connectionType: "daily_room",
    accessVariant: cloud ? "daily_room.pipecat_cloud" : "daily_room.self_hosted",
    modality,
    productLabel: cloud ? "Pipecat Cloud" : "Pipecat self-hosted",
    topology: "hosted-broker",
    environment: null,
    config,
    credentialPresent: true,
    credentialsHint: cloud ? "WXYZ" : "Authorization",
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
  readonly agentPlatform?: "retell" | "livekit" | "pipecat";
  readonly retellModality?: "voice" | "chat" | null;
  readonly platformAgentId?: string | null;
  readonly monitoringApiKeyHint?: string | null;
  readonly monitoringConfigured?: boolean;
  readonly pullProductionCalls?: boolean;
  readonly lastReceivedAt?: string | null;
  readonly connections?: readonly (
    | ReturnType<typeof connection>
    | ReturnType<typeof pipecatConnection>
  )[];
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
  it("explains every first-agent goal in the empty state", async () => {
    answerWith();

    render(<AgentsPage />);

    expect(
      await screen.findByText(
        "Add an agent to run simulations, monitor production traffic, or do both.",
      ),
    ).toBeDefined();
  });

  it("opens details from the row and its keyboard control with no action column", async () => {
    const voice = connection({
      id: "con_voice",
      agentId: "agt_retell",
      connectionType: "phone_number",
    });
    answerWith(
      agent({
        id: "agt_retell",
        name: "Front desk",
        retellModality: "voice",
        monitoringConfigured: true,
        pullProductionCalls: true,
        connections: [voice],
      }),
    );

    const view = render(<AgentsPage />);
    const table = await screen.findByRole("table", { name: "Agents in this project" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent)
        .filter(Boolean),
    ).toEqual(["Agent", "Platform", "Simulation", "Production monitoring"]);

    const row = within(rowNamed("Front desk"));
    expect(row.getByText("Configured")).toBeDefined();
    expect(row.getByText("Active")).toBeDefined();
    expect(row.getByText("Retell account is connected")).toBeDefined();
    expect(row.queryByRole("link", { name: "View details" })).toBeNull();
    expect(row.queryByRole("button", { name: "Actions for Front desk" })).toBeNull();

    fireEvent.click(row.getByText("Retell account is connected"));
    expect(routed.push).toHaveBeenLastCalledWith(
      "/projects/prj_1/agents?sheet=agent&agent=agt_retell",
    );

    const opener = row.getByRole("button", { name: "Front desk" });
    opener.focus();
    fireEvent.click(opener);
    expect(routed.push).toHaveBeenLastCalledWith(
      "/projects/prj_1/agents?sheet=agent&agent=agt_retell",
    );

    routed.search = "?sheet=agent&agent=agt_retell";
    view.rerender(<AgentsPage />);
    expect(
      await screen.findByRole("heading", { name: "Front desk" }),
    ).toBeDefined();
  });

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

  it("shows one LiveKit code-configured state regardless of trace arrival", async () => {
    const waitingRoom = connection({
      id: "con_waiting",
      agentId: "agt_waiting",
      connectionType: "livekit_room",
    });
    const confirmedRoom = connection({
      id: "con_confirmed",
      agentId: "agt_confirmed",
      connectionType: "livekit_room",
    });
    answerWith(
      agent({
        id: "agt_waiting",
        name: "Waiting worker",
        agentPlatform: "livekit",
        connections: [waitingRoom],
      }),
      agent({
        id: "agt_confirmed",
        name: "Confirmed worker",
        agentPlatform: "livekit",
        lastReceivedAt: MOMENT,
        connections: [confirmedRoom],
      }),
    );

    render(<AgentsPage />);
    await screen.findByRole("table", { name: "Agents in this project" });

    const waiting = within(rowNamed("Waiting worker"));
    expect(waiting.getByText("Configured")).toBeDefined();
    expect(waiting.getByText("Configured via code").className).toContain(
      "text-warning",
    );
    expect(waiting.queryByText("Not confirmed")).toBeNull();
    expect(waiting.queryByText("Waiting for the first production trace")).toBeNull();

    const confirmed = within(rowNamed("Confirmed worker"));
    expect(confirmed.getByText("Configured via code")).toBeDefined();
    expect(confirmed.queryByText("Confirmed")).toBeNull();
    expect(confirmed.queryByText(/Last trace received/)).toBeNull();
    expect(screen.getAllByText("Configured via code")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /monitoring/i })).toBeNull();
  });

  it("opens the Retell details sheet with saved facts and shared setup routes", async () => {
    routed.search = "?sheet=agent&agent=agt_details";
    answerWith(
      agent({
        id: "agt_details",
        name: "After-hours line",
        retellModality: "voice",
        platformAgentId: "agent_voice_1",
        monitoringApiKeyHint: "WXYZ",
        monitoringConfigured: true,
        pullProductionCalls: true,
      }),
    );

    render(<AgentsPage />);
    const dialog = await screen.findByRole("dialog", {
      name: "After-hours line",
    });
    const detail = within(dialog);
    expect(detail.getByRole("heading", { name: "After-hours line" })).toBeDefined();
    expect(
      detail.queryByText("Review saved details and finish the capabilities this agent needs."),
    ).toBeNull();
    expect(detail.queryByText("Agent details · Retell")).toBeNull();
    expect(detail.getByText("Retell agent").parentElement?.textContent).toBe(
      "Retell agentAfter-hours line",
    );
    expect(detail.getByText("Voice")).toBeDefined();
    expect(detail.queryByText("API key")).toBeNull();
    expect(detail.queryByText("Ending WXYZ")).toBeNull();
    expect(detail.getByRole("heading", { name: "Connections" })).toBeDefined();
    expect(detail.getByText("No connections yet")).toBeDefined();
    expect(detail.getByRole("heading", { name: "Capabilities" })).toBeDefined();
    expect(detail.getByRole("link", { name: "Set up simulation" }).getAttribute("href")).toBe(
      "/projects/prj_1/agents?sheet=connect&agent=agt_details&goal=simulation&platform=retell",
    );
    expect(detail.getByRole("button", { name: "Stop monitoring" })).toBeDefined();
    expect(detail.getByRole("button", { name: "Done" })).toBeDefined();

    const actions = detail.getByRole("button", {
      name: "Actions for After-hours line",
    });
    fireEvent.pointerDown(actions, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(actions);
    const menu = await screen.findByRole("menu", {
      name: "Actions for After-hours line",
    });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Rename agent", "Delete agent"]);
  });

  it("shows LiveKit instructions from details but no start or stop action", async () => {
    routed.search = "?sheet=agent&agent=agt_livekit";
    const room = connection({
      id: "con_room",
      agentId: "agt_livekit",
      connectionType: "livekit_room",
    });
    answerWith(
      agent({
        id: "agt_livekit",
        name: "LiveKit worker",
        agentPlatform: "livekit",
        connections: [room],
      }),
    );

    render(<AgentsPage />);
    const detail = within(
      await screen.findByRole("dialog", { name: "LiveKit worker" }),
    );
    expect(detail.queryByText("Agent details · LiveKit")).toBeNull();
    expect(detail.getByText("front-desk")).toBeDefined();
    expect(detail.getByText("wss://acme.livekit.cloud")).toBeDefined();
    expect(detail.getByText("Configured via code")).toBeDefined();
    expect(detail.queryByText("Not confirmed")).toBeNull();
    expect(detail.queryByText("Waiting for the first production trace")).toBeNull();
    expect(detail.queryByText(/Last trace received/)).toBeNull();
    expect(
      detail.getByRole("link", { name: "View setup instructions" }).getAttribute("href"),
    ).toBe(
      "/projects/prj_1/agents?sheet=connect&agent=agt_livekit&goal=monitoring&platform=livekit",
    );
    expect(detail.queryByRole("button", { name: /(?:start|stop) monitoring/i })).toBeNull();
  });

  /** A Pipecat Cloud agent with its voice and chat connections. */
  function pipecatCloudAgent() {
    return agent({
      id: "agt_pipecat",
      name: "lakeside-front-desk",
      agentPlatform: "pipecat",
      connections: [
        pipecatConnection({
          id: "con_voice",
          agentId: "agt_pipecat",
          config: { agentName: "lakeside-front-desk" },
        }),
        pipecatConnection({
          id: "con_chat",
          agentId: "agt_pipecat",
          modality: "chat",
          config: { agentName: "lakeside-front-desk" },
        }),
      ],
    });
  }

  it("lists a Pipecat agent with LiveKit's code-configured monitoring state", async () => {
    answerWith(pipecatCloudAgent());

    render(<AgentsPage />);
    await screen.findByRole("table", { name: "Agents in this project" });
    const row = within(rowNamed("lakeside-front-desk"));
    expect(row.getByText("Pipecat")).toBeDefined();
    expect(row.getByText("Configured")).toBeDefined();
    expect(row.getByText("Configured via code").className).toContain(
      "text-warning",
    );
  });

  it("shows a Pipecat Cloud agent with LiveKit's shape: two facts and code-configured monitoring", async () => {
    routed.search = "?sheet=agent&agent=agt_pipecat";
    answerWith(pipecatCloudAgent());

    render(<AgentsPage />);
    const detail = within(
      await screen.findByRole("dialog", { name: "lakeside-front-desk" }),
    );
    const agentFact = detail.getByText("Pipecat agent").parentElement;
    expect(agentFact?.textContent).toBe("Pipecat agentlakeside-front-desk");
    expect(agentFact?.querySelector("dd")?.className).toContain("font-mono");
    expect(detail.getByText("Start URL").parentElement?.textContent).toBe(
      "Start URLPipecat Cloud",
    );
    expect(detail.getByText("Configured via code")).toBeDefined();
    expect(
      detail.getByRole("link", { name: "View setup instructions" }).getAttribute("href"),
    ).toBe(
      "/projects/prj_1/agents?sheet=connect&agent=agt_pipecat&goal=monitoring&platform=pipecat",
    );
    expect(detail.queryByRole("link", { name: "Set up simulation" })).toBeNull();
    expect(detail.queryByRole("button", { name: /(?:start|stop) monitoring/i })).toBeNull();
  });

  it("names a self-hosted Pipecat agent by its own name and its start URL", async () => {
    routed.search = "?sheet=agent&agent=agt_self";
    answerWith(
      agent({
        id: "agt_self",
        name: "Lakeside bot",
        agentPlatform: "pipecat",
        connections: [
          pipecatConnection({
            id: "con_self",
            agentId: "agt_self",
            config: { startUrl: "https://bots.lakeside.example/start" },
          }),
        ],
      }),
    );

    render(<AgentsPage />);
    const detail = within(
      await screen.findByRole("dialog", { name: "Lakeside bot" }),
    );
    expect(detail.getByText("Pipecat agent").parentElement?.textContent).toBe(
      "Pipecat agentLakeside bot",
    );
    expect(detail.getByText("Start URL").parentElement?.textContent).toBe(
      "Start URLhttps://bots.lakeside.example/start",
    );
  });

  /** One Pipecat agent's details sheet, and its two facts as read. */
  async function pipecatFactsOf(
    connections: readonly ReturnType<typeof pipecatConnection>[],
  ): Promise<{ readonly agent: string; readonly startUrl: string; readonly urlMono: boolean }> {
    routed.search = "?sheet=agent&agent=agt_both";
    answerWith(
      agent({ id: "agt_both", name: "Front desk", agentPlatform: "pipecat", connections }),
    );
    const { unmount } = render(<AgentsPage />);
    const detail = within(await screen.findByRole("dialog", { name: "Front desk" }));
    const agentFact = detail.getByText("Pipecat agent").parentElement;
    const urlFact = detail.getByText("Start URL").parentElement;
    const read = {
      agent: agentFact?.querySelector("dd")?.textContent ?? "",
      startUrl: urlFact?.querySelector("dd")?.textContent ?? "",
      urlMono: urlFact?.querySelector("dd")?.className.includes("font-mono") ?? false,
    };
    unmount();
    cleanup();
    return read;
  }

  /**
   * Only self-hosted connections have a start URL, so only they speak for the
   * fact; Pipecat Cloud stands in when there is none, and the usual empty
   * value when there is no Pipecat connection at all.
   */
  it("reads the Start URL fact from self-hosted connections alone", async () => {
    const cloud = pipecatConnection({
      id: "con_cloud",
      agentId: "agt_both",
      config: { agentName: "front-desk" },
    });
    const dev = pipecatConnection({
      id: "con_dev",
      agentId: "agt_both",
      config: { startUrl: "https://quiet-river.trycloudflare.com/start" },
    });
    const server = pipecatConnection({
      id: "con_server",
      agentId: "agt_both",
      config: { startUrl: "https://bots.lakeside.example/start" },
    });

    // Pipecat Cloud beside one start URL: the URL, and the cloud agent's name.
    expect(await pipecatFactsOf([cloud, dev])).toEqual({
      agent: "front-desk",
      startUrl: "https://quiet-river.trycloudflare.com/start",
      urlMono: true,
    });
    // Two start URLs vary by connection.
    expect(await pipecatFactsOf([cloud, dev, server])).toEqual({
      agent: "front-desk",
      startUrl: "Varies by connection",
      urlMono: false,
    });
    // Voice and chat on one starter share one URL.
    expect(
      await pipecatFactsOf([dev, { ...dev, id: "con_dev_chat", modality: "chat" }]),
    ).toEqual({
      agent: "Front desk",
      startUrl: "https://quiet-river.trycloudflare.com/start",
      urlMono: true,
    });
    // Pipecat Cloud alone.
    expect(await pipecatFactsOf([cloud])).toEqual({
      agent: "front-desk",
      startUrl: "Pipecat Cloud",
      urlMono: false,
    });
    // No Pipecat connection yet.
    expect(await pipecatFactsOf([])).toEqual({
      agent: "Front desk",
      startUrl: "Not saved",
      urlMono: false,
    });
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
