// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import StartMonitoringAlias from "../app/projects/[projectId]/monitoring/start/page.tsx";
import MonitoringTranscriptsPage from "../app/projects/[projectId]/monitoring/transcripts/page.tsx";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/**
 * **Monitor an agent**, driven the way a person drives it — the picker sheet
 * that replaced the Start-monitoring page.
 *
 * This file is that page's test, reworked to its successor. Four claims live
 * here, and none of them can be read off a source file:
 *
 * 1. **The picker opens by query state on the Transcripts address.** No
 *    navigation, no reload; a copied link reopens it, and the retired
 *    Start-monitoring address renders the same screen with it already open.
 * 2. **The list is agents not yet monitored, and the rule differs by
 *    platform.** A Retell agent leaves the list when its pull switch is on. A
 *    LiveKit agent never leaves it, because there is no LiveKit monitored-state
 *    to read and inventing one would contradict the stores-nothing ruling.
 * 3. **A Retell agent asks once for key and id, and commits exactly that.**
 *    The body names this egma agent and the platform's id for it — one entry,
 *    the existing operation, unchanged. An agent that already holds a sealed
 *    key is not asked for one again.
 * 4. **The LiveKit half reads no server state and writes none.** It is
 *    instructions. A sheet that called an operation there would be a second
 *    place monitoring looked configured (ADR-0015).
 */

/** The router this screen closes the sheet with, watchable from the cases. */
const routed = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/prj_2/monitoring/transcripts",
  useRouter: () => ({ push: vi.fn(), replace: routed.replace, back: vi.fn() }),
  useParams: () => ({ projectId: "prj_2" }),
  useSearchParams: () => new URLSearchParams(globalThis.location.search),
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

/** One agent as the roster reads it. */
function agent(over: Record<string, unknown> = {}) {
  return {
    id: "agt_1",
    projectId: "prj_2",
    name: "Front desk",
    agentPlatform: "retell",
    platformAgentId: null,
    monitoringKeyPresent: false,
    monitoringApiKeyHint: null,
    pullProductionCalls: false,
    lastReceivedAt: null,
    archived: false,
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000000Z",
    updatedAt: "2026-08-01T00:00:00.000000Z",
    connections: [],
    ...over,
  };
}

type Stubbed = { status: number; body: unknown };

type Seen = {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
};

/** Every ask this screen made, and whatever egma was standing in for. */
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

/**
 * The screen's own reads, plus the one write the picker can make.
 *
 * `/v1/traces`, `/v1/graders` and `/v1/keys` are the Transcripts screen's, and
 * they answer empty: the sheet opens over whatever the list is, and a busy list
 * would only put rows in the way of what these cases are about.
 */
function stub(options: {
  readonly agents?: readonly ReturnType<typeof agent>[];
  readonly start?: Stubbed;
}) {
  return apiAnswers({
    "/api/me": { status: 200, body: ME },
    "/v1/traces": { status: 200, body: { traces: [], nextPageToken: null } },
    "/v1/graders": { status: 200, body: { graders: [], nextPageToken: null } },
    "/v1/keys": { status: 200, body: { keys: [] } },
    "/v1/agents": {
      status: 200,
      body: { agents: options.agents ?? [agent()], nextPageToken: null },
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

/** Put the browser on an address, the way a copied link does. */
function at(address: string): void {
  globalThis.history.replaceState({}, "", address);
}

const TRANSCRIPTS = "/projects/prj_2/monitoring/transcripts";

/** The address the action points at: this page, with the picker asked for. */
function withThePicker(query = ""): void {
  at(`${TRANSCRIPTS}?sheet=monitor${query}`);
}

function sent(seen: readonly Seen[], path: string): unknown {
  return seen.find((one) => one.path === path && one.method === "POST")?.body;
}

/** Fill the Retell half in, the way somebody with a keyboard does. */
function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  routed.replace.mockClear();
  at(TRANSCRIPTS);
});

describe("how the picker opens", () => {
  /**
   * **The address is what says the sheet is open.** Held in component state
   * instead, it would disagree with the address the first time somebody pressed
   * Back — which is exactly the reload the blanket rule exists to prevent.
   */
  it("stays shut on the plain Transcripts address", async () => {
    stub({});
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { level: 1, name: "Transcripts" });
    expect(screen.queryByRole("dialog", { name: "Monitor an agent" })).toBeNull();
    // And the roster is not even read, because nothing is asking about it.
    expect(screen.queryByLabelText("Agent")).toBeNull();
  });

  it("opens on a copied link that carries the query", async () => {
    withThePicker();
    stub({});
    render(<MonitoringTranscriptsPage />);

    expect(
      await screen.findByRole("dialog", { name: "Monitor an agent" }),
    ).toBeDefined();
  });

  /**
   * The retired Start-monitoring page's address renders the same screen with
   * the picker open, rather than redirecting to it: one load, and the link
   * somebody saved still lands where it meant to.
   */
  it("opens on the retired Start-monitoring address, in one load", async () => {
    at("/projects/prj_2/monitoring/start");
    stub({});
    render(<StartMonitoringAlias />);

    expect(
      await screen.findByRole("dialog", { name: "Monitor an agent" }),
    ).toBeDefined();
    // Rendered rather than redirected: the address is still the one that was
    // asked for, and the Transcripts screen is what is underneath it.
    expect(globalThis.location.pathname).toBe("/projects/prj_2/monitoring/start");
    expect(routed.replace).not.toHaveBeenCalled();
    expect(document.querySelector("main")?.textContent ?? "").toContain(
      "Transcripts",
    );
  });

  /** And `?agent=` still means the same thing it meant to the old page. */
  it("carries the agent an old link named through to the picker", async () => {
    at("/projects/prj_2/monitoring/start?agent=agt_2");
    stub({
      agents: [agent(), agent({ id: "agt_2", name: "Billing" })],
    });
    render(<StartMonitoringAlias />);

    const picked = (await screen.findByLabelText("Agent")) as HTMLSelectElement;
    expect(picked.value).toBe("agt_2");
  });

  /**
   * An id from an older page, another project, or an agent already monitored
   * names nothing this list holds. A control naming an agent it cannot show
   * would be worse than the first row.
   */
  it("falls through to the first agent when the link names one it cannot show", async () => {
    withThePicker("&agent=agt_gone");
    stub({});
    render(<MonitoringTranscriptsPage />);

    const picked = (await screen.findByLabelText("Agent")) as HTMLSelectElement;
    expect(picked.value).toBe("agt_1");
  });
});

describe("which agents the picker lists", () => {
  /**
   * **Retell-precise.** The pull switch is a stored fact, so an agent already
   * pulling is not offered again — starting it twice is not a thing a person
   * can want, and the switch is the only truthful way to know.
   */
  it("leaves out a Retell agent that is already pulling", async () => {
    withThePicker();
    stub({
      agents: [
        agent({ pullProductionCalls: true }),
        agent({ id: "agt_2", name: "Billing" }),
      ],
    });
    render(<MonitoringTranscriptsPage />);

    const picked = await screen.findByLabelText("Agent");
    const options = [...picked.querySelectorAll("option")].map(
      (one) => one.textContent,
    );
    expect(options).toEqual(["Billing · Retell"]);
  });

  /**
   * **LiveKit-approximate, on purpose.** Push stores nothing, so there is no
   * agent-level LiveKit monitored-state to read — and writing one to remember
   * that somebody once read the instructions would contradict the
   * stores-nothing ruling. Re-opening idempotent instructions is harmless.
   */
  it("keeps a LiveKit agent listed whatever its pull switch says", async () => {
    withThePicker();
    stub({
      agents: [
        agent({
          id: "agt_lk",
          name: "Livekit agent",
          agentPlatform: "livekit",
          pullProductionCalls: true,
        }),
      ],
    });
    render(<MonitoringTranscriptsPage />);

    const picked = await screen.findByLabelText("Agent");
    expect(
      [...picked.querySelectorAll("option")].map((one) => one.textContent),
    ).toEqual(["Livekit agent · LiveKit"]);
  });

  it("says so plainly when every agent here is already monitored", async () => {
    withThePicker();
    stub({ agents: [agent({ pullProductionCalls: true })] });
    render(<MonitoringTranscriptsPage />);

    expect(
      await screen.findByRole("heading", {
        name: "Every agent here is already monitored",
      }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Start pulling" })).toBeNull();
  });
});

describe("the Retell half", () => {
  it("commits the picked agent and the id typed for it, and nothing else", async () => {
    withThePicker();
    const { seen } = stub({});
    render(<MonitoringTranscriptsPage />);

    await screen.findByLabelText("Agent");
    type("Retell API key*", RETELL_KEY);
    type("Retell agent ID*", "agent_voice_1");
    fireEvent.click(screen.getByRole("button", { name: "Start pulling" }));

    await waitFor(() =>
      // The project rides in the query, which is where the operation takes it.
      expect(sent(seen, "/v1/monitoring/start")).toEqual({
        agentPlatform: "retell",
        apiKey: RETELL_KEY,
        // One entry, naming both halves of the binding: the egma agent this
        // sheet is about, and the platform's own id for it. Without the agent
        // id the server would resolve by platform id alone and a second agent
        // for the same Retell agent could appear beside the one picked.
        watch: [{ platformAgentId: "agent_voice_1", agentId: "agt_1" }],
      }),
    );

    /*
     * And the sheet leaves the way it arrived: the query goes out of the
     * address, replaced rather than pushed, so Back still means the page before
     * this one rather than the sheet again.
     */
    await waitFor(() => expect(routed.replace).toHaveBeenCalledWith(TRANSCRIPTS));
  });

  /**
   * **The key is asked for once per agent, ever.** An agent that already holds
   * a sealed one is told so rather than asked again — the paste is the thing a
   * person remembers doing, and asking twice is how a secret ends up managed in
   * two places.
   */
  it("does not ask again for a key the agent already holds", async () => {
    withThePicker();
    stub({
      agents: [agent({ monitoringKeyPresent: true, monitoringApiKeyHint: "ABCD" })],
    });
    render(<MonitoringTranscriptsPage />);

    await screen.findByLabelText("Agent");
    expect(screen.queryByLabelText("Retell API key*")).toBeNull();
    expect(
      screen.getByText("Egma already holds this agent's Retell key (…ABCD)."),
    ).toBeDefined();
    // The binding is still asked for: it is not a secret, and it is what the
    // pull is actually about.
    expect(screen.getByLabelText("Retell agent ID*")).toBeDefined();
  });

  /** The stored binding prefills, so the ordinary case is one click. */
  it("prefills the id this agent is already bound to", async () => {
    withThePicker();
    stub({ agents: [agent({ platformAgentId: "agent_voice_9" })] });
    render(<MonitoringTranscriptsPage />);

    const bound = (await screen.findByLabelText(
      "Retell agent ID*",
    )) as HTMLInputElement;
    expect(bound.value).toBe("agent_voice_9");
  });

  /**
   * **A per-entry refusal is the server's own sentence, relayed word for
   * word.** The rule it explains is the database's — one egma agent watches one
   * platform agent — and paraphrasing it here would be this sheet inventing a
   * rule it does not own.
   */
  it("relays a refused entry in place, in egma's own words", async () => {
    withThePicker();
    const said =
      "“Billing desk” already pulls agent_voice_1. Stop it there first.";
    stub({
      start: {
        status: 200,
        body: {
          watching: [],
          refused: [
            {
              platformAgentId: "agent_voice_1",
              reason: "contested",
              message: said,
            },
          ],
        },
      },
    });
    render(<MonitoringTranscriptsPage />);

    await screen.findByLabelText("Agent");
    type("Retell API key*", RETELL_KEY);
    type("Retell agent ID*", "agent_voice_1");
    fireEvent.click(screen.getByRole("button", { name: "Start pulling" }));

    expect(await screen.findByText(said)).toBeDefined();
    // Nothing started, so the sheet stays open on what was typed.
    expect(
      (screen.getByLabelText("Retell agent ID*") as HTMLInputElement).value,
    ).toBe("agent_voice_1");
  });

  /** Nothing is sent until the sheet has what the operation needs. */
  it("refuses in place rather than sending an empty binding", async () => {
    withThePicker();
    const { seen } = stub({});
    render(<MonitoringTranscriptsPage />);

    await screen.findByLabelText("Agent");
    type("Retell API key*", RETELL_KEY);
    fireEvent.click(screen.getByRole("button", { name: "Start pulling" }));

    expect(
      await screen.findByText("Enter Retell's own id for this agent."),
    ).toBeDefined();
    expect(sent(seen, "/v1/monitoring/start")).toBeUndefined();
  });
});

describe("the LiveKit half", () => {
  /**
   * Push is ungated by design: the door authenticates with the project key,
   * tenancy comes from the key, and the stored evidence is the whole record of
   * an agent pushing. So this half is three sentences and a way out.
   */
  it("shows the three steps, and offers nothing to start", async () => {
    withThePicker();
    const { seen } = stub({
      agents: [
        agent({ id: "agt_lk", name: "Livekit agent", agentPlatform: "livekit" }),
      ],
    });
    render(<MonitoringTranscriptsPage />);

    await screen.findByLabelText("Agent");
    for (const step of [
      "Install the Egma SDK.",
      "Call monitor_livekit(ctx) before AgentSession.start.",
      "Set EGMA_URL and EGMA_API_KEY in the agent's environment.",
    ]) {
      expect(screen.getByText(step), step).toBeDefined();
    }
    expect(screen.queryByRole("button", { name: "Start pulling" })).toBeNull();
    expect(screen.queryByLabelText("Retell API key*")).toBeNull();
    // Two ways out and no way in: the ✕ in the head, and the footer's own.
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);

    // And it stores nothing: the roster read is the only ask it made.
    expect(seen.filter((one) => one.method === "POST")).toEqual([]);
  });
});
