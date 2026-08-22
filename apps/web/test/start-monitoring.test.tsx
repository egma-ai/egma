// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
  /** The account listing. A list of lists answers each read in turn. */
  readonly account?:
    | readonly ReturnType<typeof accountAgent>[]
    | readonly (readonly ReturnType<typeof accountAgent>[])[];
  readonly start?: Stubbed;
}) {
  const listings: readonly (readonly ReturnType<typeof accountAgent>[])[] =
    options.account === undefined
      ? [[accountAgent()]]
      : Array.isArray(options.account[0])
        ? (options.account as readonly (readonly ReturnType<typeof accountAgent>[])[])
        : [options.account as readonly ReturnType<typeof accountAgent>[]];
  let read = 0;

  return apiAnswers({
    "/api/me": { status: 200, body: ME },
    "/v1/agents": {
      status: 200,
      body: { agents: options.agents ?? [agent()], nextPageToken: null },
    },
    "/v1/monitoring/retell/discover": () => {
      const answering = listings[Math.min(read, listings.length - 1)] ?? [];
      read += 1;
      return { status: 200, body: { agents: answering } };
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
          refused: [],
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
    const bound = await screen.findByRole("radio", {
      name: "“Front desk” is Front desk from Retell",
    });
    expect(bound.getAttribute("aria-checked")).toBe("true");

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

  /**
   * **A picked agent that is not bound to a Retell row would be duplicated.**
   *
   * Sending the ticks without an agent id lets the server resolve them by
   * platform id alone, and a second agent named after the Retell agent
   * appears beside the one already picked. The page refuses to send anything
   * until the question is answered.
   */
  it("will not commit a picked agent that names no Retell agent", async () => {
    const { seen } = stub({
      // No chat connection, so nothing prefills, and the agent holds no
      // platform binding of its own yet.
      agents: [agent({ connections: [] })],
      account: [accountAgent()],
    });
    render(<StartMonitoringPage />);

    fireEvent.change(await screen.findByLabelText("Agent"), {
      target: { value: "agt_1" },
    });
    await listTheAccount();

    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Also watch Front desk from Retell",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start monitoring" }));

    expect(
      await screen.findByText(/Choose which Retell agent “Front desk” is/),
    ).toBeDefined();
    expect(sent(seen, "/v1/monitoring/start")).toBeUndefined();

    // Answer it, and the same press commits the binding rather than a copy.
    fireEvent.click(
      screen.getByRole("radio", {
        name: "“Front desk” is Front desk from Retell",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start monitoring" }));

    await screen.findByText("Egma is pulling production calls");
    expect(sent(seen, "/v1/monitoring/start")).toEqual({
      agentPlatform: "retell",
      apiKey: RETELL_KEY,
      watch: [{ platformAgentId: "agent_voice_1", agentId: "agt_1" }],
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
          refused: [],
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
   * **A partial commit is two facts, and both are shown.**
   *
   * Showing only the refusal would leave a switch on that nothing on screen
   * mentions — which is exactly what makes somebody press the button again.
   */
  it("shows what started beside what did not, in the server's own words", async () => {
    const contested =
      "agent_voice_2 is already watched by “Billing desk”. One Egma agent " +
      "watches one Retell agent, so turn that agent's switch off first, or " +
      "start monitoring from it instead.";
    const { seen } = stub({
      account: [
        [
          accountAgent(),
          accountAgent({ id: "agent_voice_2", name: "Billing" }),
        ],
        // What the account reads as after the commit: the started one is
        // watched, and the contested one is unchanged.
        [
          accountAgent({
            registeredAgentId: "agt_1",
            registeredAgentName: "Front desk from Retell",
            pullProductionCalls: true,
          }),
          accountAgent({ id: "agent_voice_2", name: "Billing" }),
        ],
      ],
      start: {
        status: 200,
        body: {
          watching: [
            {
              agentId: "agt_1",
              agentName: "Front desk from Retell",
              platformAgentId: "agent_voice_1",
              created: true,
              pullProductionCalls: true,
            },
          ],
          refused: [
            {
              platformAgentId: "agent_voice_2",
              reason: "contested",
              message: contested,
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
    fireEvent.click(screen.getByRole("checkbox", { name: "Also watch Billing" }));
    fireEvent.click(screen.getByRole("button", { name: "Start monitoring" }));

    // Both halves of the answer, each naming what it is about.
    expect(
      await screen.findByRole("heading", {
        name: "Egma is pulling production calls",
      }),
    ).toBeDefined();
    expect(screen.getByRole("heading", { name: "Not started" })).toBeDefined();
    expect(screen.getByText(contested)).toBeDefined();

    // The account is read again, so the started one is a fact rather than a
    // tick, and pressing again cannot start it a second time.
    await screen.findByText("Watching");
    expect(
      screen.queryByRole("checkbox", {
        name: "Also watch Front desk from Retell",
      }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start monitoring" }));
    await screen.findByRole("heading", { name: "Not started" });
    const commits = seen.filter(
      (one) => one.path === "/v1/monitoring/start" && one.method === "POST",
    );
    expect(
      commits.map((one) => (one.body as { watch: unknown[] }).watch),
    ).toEqual([
      [
        { platformAgentId: "agent_voice_1", name: "Front desk from Retell" },
        { platformAgentId: "agent_voice_2", name: "Billing" },
      ],
      // The second press sends only what is still unstarted.
      [{ platformAgentId: "agent_voice_2", name: "Billing" }],
    ]);
  });

  it("relays a whole-request refusal without claiming anything started", async () => {
    const refusal = "Enter a Retell API key.";
    stub({
      account: [accountAgent()],
      start: { status: 422, body: { error: "unprocessable", message: refusal } },
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

/**
 * **A listing belongs to the key that produced it.**
 *
 * Editing the key while discovery is in flight is ordinary — a paste that
 * missed a character, a second key from the password manager. What must not
 * happen is the first account's agents landing in a form that is now about the
 * second account, because the commit that follows would send one account's
 * platform agent ids with the other account's key.
 */
/**
 * **A binding belongs to the account that holds it.**
 *
 * The stored binding and a chat connection's prefill were both decided against
 * some earlier Retell account. Pointed at a key for a different account, that
 * id means nothing there — committing it would seal the new account's key onto
 * an identity the new account does not have, and Egma would poll forever for
 * an agent that is not there.
 */
describe("a prefilled binding the account does not hold", () => {
  it("binds while the listing holds it, and stops binding when it does not", async () => {
    const { seen } = stub({
      agents: [agent({ connections: [connection()] })],
      account: [
        // The first account holds the prefilled id.
        [accountAgent()],
        // The second does not, and offers a different agent entirely.
        [accountAgent({ id: "agent_elsewhere_1", name: "Elsewhere" })],
      ],
    });
    render(<StartMonitoringPage />);

    fireEvent.change(await screen.findByLabelText("Agent"), {
      target: { value: "agt_1" },
    });
    await listTheAccount();

    // The connection's retellAgentId is on this account, so it is bound.
    const bound = await screen.findByRole("radio", {
      name: "“Front desk” is Front desk from Retell",
    });
    expect(bound.getAttribute("aria-checked")).toBe("true");

    // A key for another account. The prefilled id is not on it.
    fireEvent.change(screen.getByLabelText("Retell API key"), {
      target: { value: "key_live_another_account" },
    });
    fireEvent.click(screen.getByRole("button", { name: "List Retell agents" }));
    await screen.findByText("Elsewhere");

    expect(
      screen.getByText(/this Retell account does not have it/),
    ).toBeDefined();
    expect(
      screen
        .getByRole("radio", { name: "“Front desk” is Elsewhere" })
        .getAttribute("aria-checked"),
    ).toBe("false");

    // Nothing is committed until somebody chooses.
    fireEvent.click(screen.getByRole("button", { name: "Start monitoring" }));
    expect(
      await screen.findByText(/Choose which Retell agent “Front desk” is/),
    ).toBeDefined();
    expect(sent(seen, "/v1/monitoring/start")).toBeUndefined();

    // Choosing sends this account's own id, never the one it did not hold.
    fireEvent.click(
      screen.getByRole("radio", { name: "“Front desk” is Elsewhere" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start monitoring" }));

    await screen.findByText("Egma is pulling production calls");
    expect(sent(seen, "/v1/monitoring/start")).toEqual({
      agentPlatform: "retell",
      apiKey: "key_live_another_account",
      watch: [{ platformAgentId: "agent_elsewhere_1", agentId: "agt_1" }],
    });
  });
});

describe("a key edited while discovery is in flight", () => {
  it("ignores the answer the old key asked for", async () => {
    const seen: Seen[] = [];
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput) => {
        const asked = await observeRequest(input);
        seen.push({ path: asked.path, method: asked.method, body: asked.body });

        if (asked.path === "/api/me") {
          return new Response(JSON.stringify(ME), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (asked.path === "/v1/agents") {
          return new Response(
            JSON.stringify({ agents: [agent()], nextPageToken: null }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (asked.path === "/v1/monitoring/retell/discover") {
          const usedKey = (asked.body as { apiKey: string }).apiKey;
          // The first read is held open until the key has been edited.
          if (usedKey === RETELL_KEY) await held;
          return new Response(
            JSON.stringify({
              agents: [
                accountAgent({
                  id: usedKey === RETELL_KEY ? "stale_agent" : "fresh_agent",
                  name: usedKey === RETELL_KEY ? "Stale" : "Fresh",
                }),
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ watching: [], refused: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    render(<StartMonitoringPage />);
    const key = await screen.findByLabelText("Retell API key");
    fireEvent.change(key, { target: { value: RETELL_KEY } });
    fireEvent.click(screen.getByRole("button", { name: "List Retell agents" }));

    // The key changes before the first answer arrives.
    fireEvent.change(key, { target: { value: "key_live_a_different_one" } });
    // Let the stale answer land *and* let React render whatever it did, so
    // the assertions below are about the settled screen rather than about a
    // state update that has not been flushed yet.
    await act(async () => {
      release?.();
      await held;
    });

    // The stale account never reaches the form, and nothing is left ticked.
    expect(screen.queryByText("Stale")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start monitoring" })).toBeNull();

    // The new key's own read is the one that fills it.
    fireEvent.click(screen.getByRole("button", { name: "List Retell agents" }));
    expect(await screen.findByText("Fresh")).toBeDefined();
    expect(screen.queryByText("Stale")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Also watch Fresh" }));
    fireEvent.click(screen.getByRole("button", { name: "Start monitoring" }));

    await vi.waitFor(() =>
      expect(
        seen.some((one) => one.path === "/v1/monitoring/start"),
      ).toBe(true),
    );
    // One key, one account: the commit carries the key its listing was read
    // with and the ids that listing named.
    expect(sent(seen, "/v1/monitoring/start")).toEqual({
      agentPlatform: "retell",
      apiKey: "key_live_a_different_one",
      watch: [{ platformAgentId: "fresh_agent", name: "Fresh" }],
    });
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
