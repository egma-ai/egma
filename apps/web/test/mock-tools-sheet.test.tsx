// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentsPage from "../app/projects/[projectId]/agents/page.tsx";
import type { Me } from "../lib/me.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/**
 * The mock-tools panel: one switch per lane, one consent for the web call, the
 * three honest classes, the warnings, and the reasons no switch may go on.
 *
 * Driven through the real Agents page and the real API seam, so what is
 * asserted is what a person sees and what Egma sends when they act on it.
 *
 * The fixture agent's tools span **all three classes** on purpose — a custom
 * webhook tool Egma answers for, a built-in transfer that runs real, and an MCP
 * tool Egma could reach and does not yet — so no class can pass unexercised.
 */

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
  organizations: [{ id: "org_1", name: "Acme", slug: "acme", role: "member" }],
  projects: [{ id: "prj_1", name: "Default", slug: "default" }],
};

const MOMENT = "2026-08-27T10:00:00.000Z";

const WEB_CALL = {
  id: "con_web",
  agentId: "agt_retell",
  projectId: "prj_1",
  name: "Web call",
  agentPlatform: "retell",
  connectionType: "retell_web_call",
  accessVariant: "retell_web_call.api_key",
  modality: "voice",
  productLabel: "Retell web call",
  topology: "hosted-broker",
  environment: null,
  config: { retellAgentId: "agent_b0e2" },
  credentialPresent: true,
  credentialsHint: "WXYZ",
  archived: false,
  archivedAt: null,
  createdAt: MOMENT,
  updatedAt: MOMENT,
  mockToolsEnabled: false,
};

/** The text lane: mocks on the moment it is created, and no consent ever. */
const TEXT_MODE = {
  ...WEB_CALL,
  id: "con_text",
  name: "Text mode",
  connectionType: "retell_text_mode",
  accessVariant: "retell_text_mode.api_key",
  modality: "chat",
  productLabel: "Retell text mode",
  mockToolsEnabled: true,
};

/** The phone lane: the real telephony lane, which can never hold a mock. */
const PHONE = {
  ...WEB_CALL,
  id: "con_phone",
  name: "Phone",
  connectionType: "phone_number",
  accessVariant: "phone_number.public_e164",
  modality: "voice",
  productLabel: "Retell phone",
  config: { phoneNumber: "+12567332874" },
  credentialPresent: false,
  credentialsHint: null,
  mockToolsEnabled: false,
};

function agentRow(
  mockToolsEnabled: boolean,
  connections?: readonly unknown[],
) {
  return {
    id: "agt_retell",
    projectId: "prj_1",
    name: "After hours",
    agentPlatform: "retell",
    retellModality: "voice",
    platformAgentId: "agent_b0e2",
    monitoringKeyPresent: true,
    monitoringApiKeyHint: "WXYZ",
    monitoringConfigured: false,
    pullProductionCalls: false,
    lastReceivedAt: null,
    archived: false,
    archivedAt: null,
    createdAt: MOMENT,
    updatedAt: MOMENT,
    connections: connections ?? [
      { ...TEXT_MODE },
      { ...WEB_CALL, mockToolsEnabled },
      { ...PHONE },
    ],
  };
}

const TOOLS = [
  { name: "get_availability", type: "custom", coverage: "mocked", answered: true },
  { name: "book_appointment", type: "custom", coverage: "mocked", answered: false },
  {
    name: "transfer_to_front_desk",
    type: "transfer_call",
    coverage: "notInterceptable",
    answered: false,
  },
  { name: "inventory", type: "mcp", coverage: "notInThisVersion", answered: false },
];

const WARNINGS = [
  {
    toolName: "transfer_to_front_desk",
    toolType: "transfer_call",
    effect: "transfers the call to a real destination",
  },
];

function discovery(
  over: Partial<{
    mockable: boolean;
    refusal: { reason: string; message: string } | null;
    numbers: { number: string; label: string; verdicts: string[]; pin: boolean }[];
    seeded: string[];
  }> = {},
) {
  return {
    mockable: true,
    refusal: null,
    engine: "conversation-flow",
    servingVersion: 105,
    tools: TOOLS,
    warnings: WARNINGS,
    numbers: [
      {
        number: "+12567332874",
        label: "After hours",
        verdicts: ["environment-tag"],
        pin: false,
      },
    ],
    seeded: [],
    ...over,
  };
}

type Seen = { path: string; method: string; body: unknown };
let seen: Seen[] = [];

function answerWith(options: {
  readonly ticked: boolean;
  readonly discovered: ReturnType<typeof discovery>;
  /** The agent's connections, when this walk needs a different set. */
  readonly connections?: readonly unknown[];
}): void {
  seen = [];
  let ticked = options.ticked;
  let connections = options.connections;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      // Read the way the API receives it: the generated client builds a native
      // Request, so the method and the body are on that and not on `init`.
      const request = await observeRequest(input, init);
      const { method, body } = request;
      seen.push({ path: request.path, method, body });

      const answer = (value: unknown) =>
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      if (request.path === "/api/me") return answer(ME);
      if (request.path === "/v1/agents") {
        return answer({
          agents: [agentRow(ticked, connections)],
          nextPageToken: null,
        });
      }
      // The mint: the consent flow creates the web-call lane when the agent
      // has none, so the feature can never refuse with a step nobody can take.
      if (
        request.path === "/v1/agents/agt_retell/connections" &&
        method === "POST"
      ) {
        connections = [{ ...TEXT_MODE }, { ...WEB_CALL }, { ...PHONE }];
        return answer({ connection: { ...WEB_CALL } });
      }
      if (
        request.path.startsWith("/v1/agents/agt_retell/connections/") &&
        method === "PATCH"
      ) {
        const asked = body as { mockToolsEnabled?: boolean };
        ticked = asked.mockToolsEnabled ?? ticked;
        return answer({ connection: { ...WEB_CALL, mockToolsEnabled: ticked } });
      }
      if (request.path === "/v1/agents/agt_retell/mock-tools:discover") {
        return answer(options.discovered);
      }
      if (request.path === "/v1/agents/agt_retell" && method === "PATCH") {
        const asked = body as { mockToolsEnabled?: boolean };
        ticked = asked.mockToolsEnabled ?? ticked;
        return answer({ agent: agentRow(ticked) });
      }
      throw new Error(`nothing stubbed for ${method} ${request.path}`);
    }),
  );
}

/**
 * Open the mock-tools panel from the agent's details.
 *
 * The details sheet is already open — which panel is open lives in the address
 * and nowhere else, and this suite's address names it — so this is the one
 * control a person presses to get from an agent to its mocked world.
 */
async function openMockTools(): Promise<void> {
  const setUp = await screen.findByRole("button", { name: /mock tools$/iu });
  fireEvent.click(setUp);
  await screen.findByRole("heading", { name: "Ways of running this agent" });
}

/** The switch on one lane, by the slot the surface names it with. */
function laneSwitch(lane: string): HTMLElement {
  const found = document.querySelector(`[data-slot="mock-tools-lane-${lane}"]`);
  if (found === null) throw new Error(`no switch for the ${lane} lane`);
  return found as HTMLElement;
}

beforeEach(() => {
  routed.push.mockReset();
  routed.replace.mockReset();
  routed.pathname = "/projects/prj_1/agents";
  // Which panel is open lives in the address and nowhere else, so this suite
  // opens the agent's details there and presses the one control that leads
  // from an agent to its mocked world.
  routed.search = "sheet=agent&agent=agt_retell";
  routed.params = { projectId: "prj_1" };
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the mock-tools panel", () => {
  it("shows one switch per lane and never claims more than the lanes deliver", async () => {
    answerWith({ ticked: false, discovered: discovery() });
    render(<AgentsPage />);
    await openMockTools();

    // Every lane, each with its own control. The phone lane has none: it is
    // the real telephony lane and can never hold a mock.
    expect(laneSwitch("retell_text_mode")).toBeDefined();
    expect(laneSwitch("retell_web_call")).toBeDefined();
    expect(
      document.querySelector('[data-slot="mock-tools-lane-phone_number"]'),
    ).toBeNull();
    expect(screen.getByText("Never mocked")).toBeDefined();

    // **The over-claim is gone.** A sentence about every simulation against
    // this agent would be false for the phone lane every time.
    expect(document.body.textContent).not.toContain(
      "every simulation against this agent runs in a mocked world",
    );
    // Each lane says what it does, and the phone lane says it reaches real
    // tools.
    expect(
      screen.getAllByText(
        /Runs over this connection are conducted with mocked tools/u,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(/A phone call is the real telephony lane/u),
    ).toBeDefined();
  });

  it("shows the live three-class read, with every class exercised", async () => {
    answerWith({ ticked: false, discovered: discovery() });
    render(<AgentsPage />);
    await openMockTools();

    // The three classes, each named rather than folded into a coverage number,
    // and each with a tool of its own kind in it: a custom webhook tool Egma
    // answers for, a built-in transfer that runs real, and an MCP tool Egma
    // could reach and does not yet.
    expect(screen.getByRole("heading", { name: "Egma answers these" })).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Cannot be intercepted" }),
    ).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Egma does not answer these yet" }),
    ).toBeDefined();
    // Both classes Egma does not answer for say the same plain thing: the tool
    // still runs. An MCP tool the agent really declares lands in the second
    // one, and a person reading it must never take "not yet" for "not at all".
    expect(
      screen.getAllByText(/They still run for real\./u).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("get_availability")).toBeDefined();
    expect(screen.getAllByText("transfer_to_front_desk").length).toBeGreaterThan(0);
    expect(screen.getByText("inventory")).toBeDefined();
    // Which mocked tools already have an answer, and which do not.
    expect(screen.getByText("Answer ready")).toBeDefined();
    expect(screen.getByText("No answer yet")).toBeDefined();

    // And the warning about the tool that really acts.
    expect(
      screen.getByRole("heading", { name: "These still happen for real" }),
    ).toBeDefined();
    expect(
      screen.getByText(/transfers the call to a real destination/u),
    ).toBeDefined();
  });

  it("puts one consent between a person and a web-call mock, and none before a text one", async () => {
    answerWith({ ticked: false, discovered: discovery() });
    render(<AgentsPage />);
    await openMockTools();

    // Nothing is shown until somebody asks to turn a web-call mock on.
    expect(
      screen.queryByRole("heading", { name: "What Egma will do" }),
    ).toBeNull();

    fireEvent.click(laneSwitch("retell_web_call"));
    await screen.findByRole("heading", { name: "What Egma will do" });

    // The four promises, in the spec's own words, and nothing written yet.
    expect(
      screen.getByText(/Create a temporary version of this agent in Retell/u),
    ).toBeDefined();
    expect(screen.getByText(/delete that temporary version/u)).toBeDefined();
    expect(
      screen.getByText(/Never modify the version your agent serves/u),
    ).toBeDefined();
    expect(screen.getByText(/put the binding back exactly as it was/u)).toBeDefined();
    expect(
      screen.getByText(/Never dial your published number for a mocked run/u),
    ).toBeDefined();
    // **No per-number checkbox.** One informed yes is the whole ceremony.
    expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect(seen.some((one) => one.method === "PATCH")).toBe(false);

    // One button, and it is the only thing that turns the web-call switch on.
    fireEvent.click(
      document.querySelector(
        '[data-slot="mock-tools-consent-accept"]',
      ) as HTMLElement,
    );
    await waitFor(() => {
      expect(
        seen.filter(
          (one) =>
            one.method === "PATCH" &&
            one.path === "/v1/agents/agt_retell/connections/con_web",
        ),
      ).toHaveLength(1);
    });
    expect(
      seen.find((one) => one.method === "PATCH")?.body,
    ).toEqual({ mockToolsEnabled: true });
  });

  it("shows no consent at all for the text lane, which writes nothing to Retell", async () => {
    answerWith({ ticked: false, discovered: discovery() });
    render(<AgentsPage />);
    await openMockTools();

    // The text lane arrives on. Turning it off, and on again, never reaches a
    // consent screen: text mode writes nothing to the customer's account.
    fireEvent.click(laneSwitch("retell_text_mode"));
    await waitFor(() => {
      expect(
        seen.some(
          (one) =>
            one.method === "PATCH" &&
            one.path === "/v1/agents/agt_retell/connections/con_text",
        ),
      ).toBe(true);
    });
    expect(
      screen.queryByRole("heading", { name: "What Egma will do" }),
    ).toBeNull();
  });

  it("mints the web-call connection when the agent has none, so the flow cannot refuse", async () => {
    // The refusal that used to stand here told a person to add a connection no
    // flow could create. The consent flow creates it.
    answerWith({
      ticked: false,
      discovered: discovery(),
      connections: [{ ...TEXT_MODE }, { ...PHONE }],
    });
    render(<AgentsPage />);
    await openMockTools();

    fireEvent.click(
      document.querySelector(
        '[data-slot="mock-tools-lane-mint"]',
      ) as HTMLElement,
    );
    await screen.findByRole("heading", { name: "What Egma will do" });
    expect(
      screen.getByText(/add a Retell web-call connection to this agent/u),
    ).toBeDefined();

    fireEvent.click(
      document.querySelector(
        '[data-slot="mock-tools-consent-accept"]',
      ) as HTMLElement,
    );

    // One yes: the lane is created and its switch goes on, in that order.
    await waitFor(() => {
      expect(
        seen.some(
          (one) =>
            one.method === "POST" &&
            one.path === "/v1/agents/agt_retell/connections",
        ),
      ).toBe(true);
    });
    // The discovery read is a POST too, so the mint is found by its own path.
    const minted = seen.find(
      (one) =>
        one.method === "POST" &&
        one.path === "/v1/agents/agt_retell/connections",
    );
    /*
     * **The whole payload, not a subset of it.** This shipped once as a body
     * the API could only refuse — the right lane and no `platformAgentId` —
     * and a `toMatchObject` over three keys said nothing about the two that
     * mattered. So the mint is asserted key for key: the lane, the Retell
     * agent it reaches, and no `config`, because the API writes that from what
     * Retell answered and a second opinion here could disagree with it.
     */
    expect(minted?.body).toEqual({
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      platformAgentId: "agent_b0e2",
    });
    await waitFor(() => {
      expect(seen.some((one) => one.method === "PATCH")).toBe(true);
    });
  });

  it("shows the reason no switch can go on, rather than a control that does nothing", async () => {
    answerWith({
      ticked: false,
      discovered: discovery({
        mockable: false,
        refusal: {
          reason: "custom_llm_engine",
          message:
            "this agent's response engine is a custom LLM, so Retell holds none of its words or tools: they run in your own service.",
        },
      }),
    });
    render(<AgentsPage />);
    await openMockTools();

    expect(
      screen.getByRole("heading", {
        name: "Mock tools cannot be turned on for this agent",
      }),
    ).toBeDefined();
    expect(screen.getByText(/they run in your own service/u)).toBeDefined();
    // No lane's switch may go on while Egma has said it cannot keep the
    // promises for this agent — and nothing is written.
    expect(laneSwitch("retell_web_call").getAttribute("disabled")).not.toBeNull();
    expect(seen.some((one) => one.method === "PATCH")).toBe(false);
  });

  it("reads the tools again on request, and says what it added and what it left alone", async () => {
    answerWith({
      ticked: true,
      discovered: discovery({ seeded: ["book_appointment"] }),
    });
    render(<AgentsPage />);
    await openMockTools();

    fireEvent.click(screen.getByRole("button", { name: "Read the tools again" }));
    expect(
      await screen.findByText(/Added 1 answer: book_appointment/u),
    ).toBeDefined();
    expect(
      screen.getByText(/Answers you had already written were left alone/u),
    ).toBeDefined();
    // The re-read is the one that seeds; the first read never writes.
    const discoveries = seen.filter(
      (one) => one.path === "/v1/agents/agt_retell/mock-tools:discover",
    );
    // The first read carries no body at all, which is how it says it seeds
    // nothing; the re-read asks for it by name.
    expect(discoveries[0]?.body).toBeUndefined();
    expect(discoveries.at(-1)?.body).toEqual({ seed: true });
  });
});
