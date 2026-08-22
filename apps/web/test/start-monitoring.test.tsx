// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import StartMonitoringPage from "../app/projects/[projectId]/monitoring/start/page.tsx";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/**
 * **Start monitoring**, driven the way a person drives it.
 *
 * Three claims live here, and none of them can be read off a source file:
 *
 * 1. **The Retell path commits what was ticked, and nothing else.** The body
 *    the page sends is the whole of what it decided — which egma agent binds
 *    to which platform agent, and which unregistered account agents are being
 *    registered on the spot. A page that sent the already-watching rows back
 *    would ask the server to flip switches nobody touched.
 * 2. **The uniqueness refusal reaches the person, word for word.** One egma
 *    agent watches one platform agent, the database is what enforces it, and
 *    the sentence that comes back names the agent already watching. Paraphrasing
 *    it here would be this page inventing a rule it does not own.
 * 3. **The LiveKit path consults no server state and changes none.** Push is
 *    ungated by design: the OTLP door takes the project key and the stored
 *    evidence is the whole record. A screen that read or wrote monitoring
 *    state would be a second place monitoring looked configured (ADR-0015).
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/prj_2/monitoring/start",
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

const RETELL_KEY = "key_live_monitoring_only_ABCD";

/** One connection, said the way the agents contract says it after ticket 01. */
function connection(over: Record<string, unknown> = {}) {
  return {
    id: "con_1",
    agentId: "agt_1",
    projectId: "prj_2",
    name: "Chat",
    agentPlatform: "retell",
    connectionType: "retell_chat_api",
    accessVariant: "retell_chat_api.api_key",
    modality: "chat",
    productLabel: "Retell chat",
    topology: "hosted-broker",
    environment: null,
    config: { retellAgentId: "agent_voice_1" },
    credentialPresent: true,
    credentialsHint: "ABCD",
    archived: false,
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000000Z",
    updatedAt: "2026-08-01T00:00:00.000000Z",
    ...over,
  };
}

/** One agent as the roster reads it: no description, no revision. */
function agent(over: Record<string, unknown> = {}) {
  return {
    id: "agt_1",
    projectId: "prj_2",
    name: "Front desk",
    agentPlatform: null,
    platformAgentId: null,
    monitoringKeyPresent: false,
    monitoringApiKeyHint: null,
    pullProductionCalls: false,
    archived: false,
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000000Z",
    updatedAt: "2026-08-01T00:00:00.000000Z",
    connections: [],
    ...over,
  };
}

function accountAgent(over: Record<string, unknown> = {}) {
  return {
    id: "agent_voice_1",
    name: "Front desk from Retell",
    registeredAgentId: null,
    registeredAgentName: null,
    pullProductionCalls: false,
    ...over,
  };
}

type Stubbed = { status: number; body: unknown };

type Seen = {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
};

/** Every ask this page made, and whatever egma was standing in for. */
function apiAnswers(answers: Record<string, Stubbed | (() => Stubbed)>): {
  readonly seen: Seen[];
} {
  const seen: Seen[] = [];
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput) => {
      const asked = await observeRequest(input);
      seen.push({ path: asked.path, method: asked.method, body: asked.body });
      const held = answers[asked.path];
      if (held === undefined) {
        throw new Error(`nothing stubbed for ${asked.path}`);
      }
      const answer = typeof held === "function" ? held() : held;
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { seen };
}

/** The ordinary stub: a roster, an account listing, and a commit. */
function stub(options: {
  readonly agents?: readonly ReturnType<typeof agent>[];
  readonly account?: readonly ReturnType<typeof accountAgent>[];
  readonly start?: Stubbed;
}) {
  return apiAnswers({
    "/api/me": { status: 200, body: ME },
    "/v1/agents": {
      status: 200,
      body: { agents: options.agents ?? [agent()], nextPageToken: null },
    },
    "/v1/monitoring/retell/discover": {
      status: 200,
      body: { agents: options.account ?? [accountAgent()] },
    },
    "/v1/monitoring/start":
      options.start ?? {
        status: 200,
        body: {
          watching: [
            {
              agentId: "agt_1",
              agentName: "Front desk",
              platformAgentId: "agent_voice_1",
              created: false,
              pullProductionCalls: true,
            },
          ],
        },
      },
  });
}

/** Paste the key and ask Retell what it can see. */
async function listTheAccount(): Promise<void> {
  fireEvent.change(await screen.findByLabelText("Retell API key"), {
    target: { value: RETELL_KEY },
  });
  fireEvent.click(screen.getByRole("button", { name: "List Retell agents" }));
}

function sent(seen: readonly Seen[], path: string): unknown {
  return seen.find((one) => one.path === path && one.method === "POST")?.body;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Retell path", () => {
  it("asks for the monitoring key even when a connection already holds one", async () => {
    stub({ agents: [agent({ connections: [connection()] })] });
    render(<StartMonitoringPage />);

    // The key is a monitoring-only credential (ADR-0015). The chat connection
    // on this agent holds a Retell key of its own and it is not offered here.
    expect(await screen.findByLabelText("Retell API key")).toBeDefined();
  });

  it("says which account agents Egma knows and which a tick would register", async () => {
    stub({
      account: [
        accountAgent(),
        accountAgent({
          id: "agent_voice_2",
          name: "Billing",
          registeredAgentId: "agt_9",
          registeredAgentName: "Billing desk",
        }),
        accountAgent({
          id: "agent_voice_3",
          name: "Renewals",
          registeredAgentId: "agt_8",
          registeredAgentName: "Renewals desk",
          pullProductionCalls: true,
        }),
      ],
    });
    render(<StartMonitoringPage />);
    await listTheAccount();

    expect(
      await screen.findByText("Not in Egma yet. Ticking it registers it."),
    ).toBeDefined();
    expect(screen.getByText("In Egma as “Billing desk”")).toBeDefined();
    // Already switched on: a fact, not a control. Its switch lives on its agent.
    expect(screen.getByText("Watching")).toBeDefined();
    expect(
      screen.queryByRole("checkbox", { name: "Also watch Renewals" }),
    ).toBeNull();
  });

  it("sends the binding for the picked agent and the ticks beside it", async () => {
    const { seen } = stub({
      agents: [agent({ connections: [connection()] })],
      account: [
        accountAgent(),
        accountAgent({ id: "agent_voice_2", name: "Billing" }),
      ],
    });
    render(<StartMonitoringPage />);

    fireEvent.change(await screen.findByLabelText("Agent"), {
      target: { value: "agt_1" },
    });
    await listTheAccount();

    // The chat connection's retellAgentId prefills the binding, so the row is
    // already chosen before anybody touches it.
    expect(
      await screen.findByRole("button", { name: "This is “Front desk”" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("checkbox", { name: "Also watch Billing" }));
    fireEvent.click(screen.getByRole("button", { name: "Start monitoring" }));

    await screen.findByText("Egma is pulling production calls");
    expect(sent(seen, "/v1/monitoring/start")).toEqual({
      agentPlatform: "retell",
      apiKey: RETELL_KEY,
      watch: [
        { platformAgentId: "agent_voice_1", agentId: "agt_1" },
        { platformAgentId: "agent_voice_2", name: "Billing" },
      ],
    });
  });

  it("registers an unregistered account agent by name when no Egma agent was picked", async () => {
    const { seen } = stub({
      account: [accountAgent()],
      start: {
        status: 200,
        body: {
          watching: [
            {
              agentId: "agt_new",
              agentName: "Front desk from Retell",
              platformAgentId: "agent_voice_1",
              created: true,
              pullProductionCalls: true,
            },
          ],
        },
      },
    });
    render(<StartMonitoringPage />);
    await listTheAccount();

    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Also watch Front desk from Retell",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start monitoring" }));

    await screen.findByText("Egma is pulling production calls");
    expect(sent(seen, "/v1/monitoring/start")).toEqual({
      agentPlatform: "retell",
      apiKey: RETELL_KEY,
      watch: [
        { platformAgentId: "agent_voice_1", name: "Front desk from Retell" },
      ],
    });
    expect(screen.getByText("registered now")).toBeDefined();
  });

  /**
   * The rule is the database's — one switched-on agent per (project, platform,
   * platform agent id) — and the sentence that explains it is the server's.
   */
  it("shows the one-switched-on-agent refusal in the server's own words", async () => {
    const refusal =
      "One Egma agent watches one Retell agent, and something in this " +
      "project already watches agent_voice_1 (watched by “Billing desk”). " +
      "Turn that agent's switch off first, or start monitoring from it instead.";
    stub({
      account: [accountAgent()],
      start: { status: 409, body: { error: "conflict", message: refusal } },
    });
    render(<StartMonitoringPage />);
    await listTheAccount();

    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Also watch Front desk from Retell",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start monitoring" }));

    expect(await screen.findByText(refusal)).toBeDefined();
    expect(screen.queryByText("Egma is pulling production calls")).toBeNull();
  });
});

describe("the LiveKit Agents path", () => {
  it("shows the instructions and consults no monitoring state at all", async () => {
    const { seen } = stub({});
    render(<StartMonitoringPage />);

    fireEvent.change(await screen.findByLabelText("Platform"), {
      target: { value: "livekit_agents" },
    });

    expect(
      await screen.findByText("Install the Egma SDK where your agent runs"),
    ).toBeDefined();
    expect(screen.getByText("pip install egma")).toBeDefined();
    expect(
      screen.getByText("Call monitor_livekit before AgentSession.start"),
    ).toBeDefined();
    expect(screen.getByText(/EGMA_URL/)).toBeDefined();
    expect(screen.getByText(/EGMA_API_KEY/)).toBeDefined();

    // Nothing to switch on, so nothing is asked and nothing is offered.
    expect(seen.filter((one) => one.path.startsWith("/v1/monitoring"))).toEqual(
      [],
    );
    expect(screen.queryByLabelText("Retell API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start monitoring" })).toBeNull();
  });
});

describe("the words every touched screen says", () => {
  it("offers no description field and never says kind", async () => {
    stub({ agents: [agent({ connections: [connection()] })] });
    const { container } = render(<StartMonitoringPage />);

    fireEvent.change(await screen.findByLabelText("Agent"), {
      target: { value: "agt_1" },
    });

    expect(screen.queryByLabelText("Description")).toBeNull();
    const said = within(container).getByRole("main").textContent ?? "";
    expect(said.toLowerCase()).not.toContain("revision");
    expect(said.toLowerCase()).not.toContain(" kind");
  });
});
