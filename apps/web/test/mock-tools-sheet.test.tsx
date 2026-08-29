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
 * The mock-tools panel: the consent, the three honest classes, the warnings,
 * and the reasons the box will not go on.
 *
 * Driven through the real Agents page and the real API seam, so what is
 * asserted is what a person sees and what Egma sends when they act on it.
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

function agentRow(mockToolsEnabled: boolean) {
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
    connections: [{ ...WEB_CALL, mockToolsEnabled }],
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
}): void {
  seen = [];
  let ticked = options.ticked;
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
        return answer({ agents: [agentRow(ticked)], nextPageToken: null });
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
  await screen.findByRole("heading", { name: "What Egma will do" });
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
  it("explains the consent, and shows every tool in its honest class", async () => {
    answerWith({ ticked: false, discovered: discovery() });
    render(<AgentsPage />);
    await openMockTools();

    // The four promises, before anything is ticked.
    expect(
      screen.getByText(/Create a temporary version of this agent in Retell/u),
    ).toBeDefined();
    expect(screen.getByText(/Delete that temporary version/u)).toBeDefined();
    expect(
      screen.getByText(/Never modify the version your agent serves/u),
    ).toBeDefined();
    expect(screen.getByText(/put the binding back exactly as it was/u)).toBeDefined();
    expect(
      screen.getByText(/never dialled for a mocked run/u),
    ).toBeDefined();

    // The three classes, each named rather than folded into a coverage number.
    expect(screen.getByRole("heading", { name: "Egma answers these" })).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Cannot be intercepted" }),
    ).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Not in this version" }),
    ).toBeDefined();
    expect(screen.getByText("get_availability")).toBeDefined();
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




  it("shows the reason the box cannot go on, rather than a control that does nothing", async () => {
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
    expect(
      screen
        .getByRole("button", { name: "Turn on mock tools" })
        .getAttribute("disabled"),
    ).not.toBeNull();
    // And nothing was written.
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
