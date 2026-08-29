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

import ConnectionDetailPage from "../app/projects/[projectId]/agents/[agentId]/connections/[connectionId]/page.tsx";
import NewConnectionPage from "../app/projects/[projectId]/agents/[agentId]/connections/new/page.tsx";
import RegisterAgentPage from "../app/projects/[projectId]/agents/new/page.tsx";
import AgentsPage from "../app/projects/[projectId]/agents/page.tsx";
import type { Me } from "../lib/me.ts";
import {
  observeRequest,
  requestUrl,
  type FetchInput,
} from "./platform-request.ts";

/**
 * The Agents and Connections pages, rendered and driven.
 *
 * They are here in the fast lane rather than in the one real-browser journey
 * because none of what they prove needs a browser: a form drawn from what the
 * server said the connection options are, a control a viewer may not use being
 * genuinely disabled, a stale save keeping the typing it was refused for, and a
 * page that says `unknown` where nothing has been measured. Each drives the real
 * component the way somebody with a keyboard would and reads what the DOM then
 * says; nothing here asserts that a source file contains a string.
 */

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  pathname: "/projects/prj_1/agents",
  search: "",
  params: {
    projectId: "prj_1",
    agentId: "agt_1",
    connectionId: "con_1",
  } as Record<string, string>,
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

function meWith(role: string): Me {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ id: "org_1", name: "Acme", slug: "acme", role }],
    projects: [{ id: "prj_1", name: "Default", slug: "default" }],
  };
}

type Stubbed = { status: number; body: unknown };

type Recorded = {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
};

let sent: Recorded[] = [];

/**
 * Whatever egma is standing in for, answered as the API would answer it, and
 * every write kept so a test can read what the page actually sent.
 *
 * A path may be given a list, answered in order and then repeating its last
 * entry — that is how a save that is refused and then succeeds is written.
 */
function apiAnswers(answers: Record<string, Stubbed | readonly Stubbed[]>): void {
  const asked: Record<string, number> = {};
  sent = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, options?: RequestInit) => {
      const request = await observeRequest(input, options);
      const { address, path } = request;
      const held = answers[path];
      if (held === undefined) throw new Error(`nothing stubbed for ${path}`);

      if (request.method !== "GET") {
        sent.push({
          url: `${path}${address.search}`,
          method: request.method,
          body: (request.body ?? {}) as Record<string, unknown>,
        });
      }

      const turn = asked[path] ?? 0;
      asked[path] = turn + 1;
      const answer = Array.isArray(held)
        ? ((held[Math.min(turn, held.length - 1)] ?? { status: 200, body: {} }) as Stubbed)
        : (held as Stubbed);

      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const AGENT = {
  id: "agt_1",
  projectId: "prj_1",
  name: "Front desk",
  agentPlatform: "retell",
  retellModality: null,
  platformAgentId: null,
  monitoringKeyPresent: false,
  monitoringApiKeyHint: null,
  monitoringConfigured: false,
  pullProductionCalls: false,
  lastReceivedAt: null,
  archived: false,
  archivedAt: null,
  createdAt: "2026-08-15T10:00:00.000Z",
  updatedAt: "2026-08-15T10:00:00.000Z",
};

const CONNECTION = {
  id: "con_1",
  agentId: "agt_1",
  projectId: "prj_1",
  name: "staging",
  agentPlatform: "retell",
  connectionType: "retell_chat_api",
  accessVariant: "retell_chat_api.api_key",
  productLabel: "Retell chat",
  modality: "chat",
  topology: "hosted-broker",
  environment: "staging",
  config: { retellAgentId: "agent_abc" },
  credentialPresent: true,
  credentialsHint: "WXYZ",
  archived: false,
  archivedAt: null,
  createdAt: "2026-08-15T10:00:00.000Z",
  updatedAt: "2026-08-15T10:00:00.000Z",
};

/**
 * A second way into the same agent: another channel. One connection of each
 * kind makes "the facts on a row" a claim a test can falsify.
 */
const MEASURED_CONNECTION = {
  ...CONNECTION,
  id: "con_2",
  // Named apart from its environment on purpose: a fixture where the two read
  // the same would let a cell showing the wrong one pass.
  name: "phone line",
  agentPlatform: "retell",
  connectionType: "phone_number",
  accessVariant: "phone_number.public_e164",
  productLabel: "Phone number",
  modality: "voice",
  environment: "production",
  config: { phoneNumber: "+14155550100" },
  credentialPresent: false,
  credentialsHint: null,
};

/**
 * A third way in, on the other platform. An agent reached on Retell and on
 * LiveKit at the same time is an ordinary state, not a mistake, so a row has to
 * be able to say both.
 */
const LIVEKIT_CONNECTION = {
  ...CONNECTION,
  id: "con_3",
  // A connection created before modality-aware defaults must still be clear.
  name: "livekit_room-1",
  agentPlatform: "livekit",
  connectionType: "livekit_room",
  accessVariant: "livekit_room.project_credentials",
  productLabel: "LiveKit project credentials",
  modality: "voice",
  topology: "egma-dials-out",
  environment: "production",
  config: { url: "wss://egma.livekit.cloud", agentName: "front-desk" },
};

/** An agent as the *list* answers it: the identity, and every way in. */
const LISTED_AGENT = {
  ...AGENT,
  connections: [CONNECTION, MEASURED_CONNECTION],
};

/** And one nobody has given egma a way into at all. */
const UNREACHED_AGENT = {
  ...AGENT,
  id: "agt_2",
  name: "Night line",
  description: null,
  connections: [],
};

const TYPES = {
  items: [
    {
      agentPlatform: "retell",
      agentPlatformLabel: "Retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      accessVariantLabel: "Retell API key",
      modality: "chat",
      productLabel: "Retell chat",
      topology: "hosted-broker",
      simulatorAdapter: true,
      fields: [
        {
          key: "retellAgentId",
          label: "Retell agent ID",
          kind: "text",
          required: true,
          help: "The agent's own identifier in Retell.",
          afterCredentials: false,
        },
      ],
      credentialRule: "required",
      credentialHelp: "Egma seals your key and never shows it again.",
      credentialFields: [
        {
          field: "apiKey",
          label: "Retell API key",
          kind: "secret",
          required: true,
          help: "Copied from your Retell dashboard.",
        },
      ],
    },
    {
      agentPlatform: "retell",
      agentPlatformLabel: "Retell",
      connectionType: "retell_text_mode",
      accessVariant: "retell_text_mode.api_key",
      accessVariantLabel: "Retell API key",
      modality: "chat",
      productLabel: "Retell text mode",
      topology: "hosted-broker",
      simulatorAdapter: true,
      fields: [
        {
          key: "retellAgentId",
          label: "Retell agent ID",
          kind: "text",
          required: true,
          help: "The voice agent's own identifier in Retell.",
          afterCredentials: false,
        },
      ],
      credentialRule: "required",
      credentialHelp: "Egma seals your key and never shows it again.",
      credentialFields: [
        {
          field: "apiKey",
          label: "Retell API key",
          kind: "secret",
          required: true,
          help: "Copied from your Retell dashboard.",
        },
      ],
    },
    {
      agentPlatform: "retell",
      agentPlatformLabel: "Retell",
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      accessVariantLabel: "Public E.164 number",
      modality: "voice",
      productLabel: "Retell phone",
      topology: "egma-dials-in",
      simulatorAdapter: true,
      fields: [
        {
          key: "phoneNumber",
          label: "Phone number",
          kind: "e164",
          required: true,
          help: "A phone number routed to the selected Retell agent.",
          afterCredentials: false,
        },
      ],
      credentialRule: "forbidden",
      credentialHelp: "A phone connection takes no credential.",
      credentialFields: [],
    },
    {
      agentPlatform: "livekit",
      agentPlatformLabel: "LiveKit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      accessVariantLabel: "API key and secret",
      modality: "voice",
      productLabel: "LiveKit project credentials",
      topology: "egma-dials-out",
      simulatorAdapter: true,
      fields: [
        {
          key: "url",
          label: "LiveKit WebSocket URL",
          kind: "url",
          required: true,
          help: "Your LiveKit project or self-hosted server.",
          afterCredentials: false,
        },
        {
          key: "agentName",
          label: "LiveKit agent name",
          kind: "text",
          required: true,
          help: "The exact name registered by the deployed LiveKit worker.",
          afterCredentials: false,
        },
        {
          key: "metadata",
          label: "Room metadata",
          kind: "json",
          required: false,
          help: "JSON handed to the agent.",
          afterCredentials: true,
        },
      ],
      credentialRule: "required",
      credentialHelp: "Used to create the room.",
      credentialFields: [
        {
          field: "apiKey",
          label: "LiveKit API key",
          kind: "secret",
          required: true,
          help: "The key id.",
        },
        {
          field: "apiSecret",
          label: "LiveKit API secret",
          kind: "secret",
          required: true,
          help: "The key secret.",
        },
      ],
    },
    /*
     * Chat and voice on one access variant, which is the shape the server
     * really serves: the two rows differ in one word, and a lookup that reads
     * the variant alone cannot tell them apart.
     */
    {
      agentPlatform: "livekit",
      agentPlatformLabel: "LiveKit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      accessVariantLabel: "API key and secret",
      modality: "chat",
      productLabel: "LiveKit chat",
      topology: "egma-dials-out",
      simulatorAdapter: true,
      fields: [
        {
          key: "url",
          label: "LiveKit WebSocket URL",
          kind: "url",
          required: true,
          help: "Your LiveKit project or self-hosted server.",
          afterCredentials: false,
        },
        {
          key: "agentName",
          label: "LiveKit agent name",
          kind: "text",
          required: true,
          help: "The exact name registered by the deployed LiveKit worker.",
          afterCredentials: false,
        },
        {
          key: "metadata",
          label: "Agent metadata",
          kind: "json",
          required: false,
          help: "JSON handed to the agent.",
          afterCredentials: true,
        },
      ],
      credentialRule: "required",
      credentialHelp: "Used to create the room.",
      credentialFields: [
        {
          field: "apiKey",
          label: "LiveKit API key",
          kind: "secret",
          required: true,
          help: "The key id.",
        },
        {
          field: "apiSecret",
          label: "LiveKit API secret",
          kind: "secret",
          required: true,
          help: "The key secret.",
        },
      ],
    },
    {
      agentPlatform: "livekit",
      agentPlatformLabel: "LiveKit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.customer_token_endpoint",
      accessVariantLabel: "Token endpoint",
      modality: "voice",
      productLabel: "LiveKit token endpoint",
      topology: "egma-dials-out",
      simulatorAdapter: true,
      fields: [
        {
          key: "url",
          label: "LiveKit WebSocket URL",
          kind: "url",
          required: true,
          help: "Your LiveKit project or self-hosted server.",
          afterCredentials: false,
        },
        {
          key: "tokenEndpoint",
          label: "Token endpoint",
          kind: "url",
          required: true,
          help: "The service that creates room tokens.",
          afterCredentials: false,
        },
      ],
      credentialRule: "required",
      credentialHelp: "Auth headers for the endpoint.",
      credentialFields: [
        {
          field: "headers",
          label: "Auth headers",
          kind: "json",
          required: true,
          help: "Header names and secret values sent to the endpoint.",
        },
      ],
    },
    {
      agentPlatform: null,
      agentPlatformLabel: "Any or unknown",
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      accessVariantLabel: "Public E.164 number",
      modality: "voice",
      productLabel: "Phone number",
      topology: "egma-dials-in",
      simulatorAdapter: true,
      fields: [
        {
          key: "phoneNumber",
          label: "Phone number",
          kind: "e164",
          required: true,
          help: "In international form, like +15551234567.",
          afterCredentials: false,
        },
      ],
      credentialRule: "forbidden",
      credentialHelp: "A phone connection takes no credential.",
      credentialFields: [],
    },
  ],
};

beforeEach(() => {
  routed.push.mockReset();
  routed.replace.mockReset();
  routed.pathname = "/projects/prj_1/agents";
  routed.search = "";
  routed.params = {
    projectId: "prj_1",
    agentId: "agt_1",
    connectionId: "con_1",
  };
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The agent editors use the same layout primitive as every other product form.
 *
 * It asks the elements what they are rather than what they are painted with.
 * A class name used to be the fingerprint of a shared component, because a CSS
 * Module hashes one and nothing else can produce it. On the Tailwind base a
 * class list is copyable, so a hand-rolled `<div className="flex gap-3">` would
 * pass a class check — and the migration itself failed one, which is the other
 * half of the same problem. `data-slot` is what `Form` and `FormActions` put on
 * the elements they draw, and a page that stopped using them fails this.
 */
function expectSheetLayout(action: HTMLElement): void {
  const form = action.closest("form");
  expect(form).not.toBeNull();
  expect(form?.dataset.slot).toBe("form");
  // Pinned to the bottom of the panel rather than floating at the end of the
  // fields: `SheetFooter` is what puts the answer and the way out together and
  // the one destructive action at the far end.
  expect(action.closest("[data-slot=sheet-footer]")).not.toBeNull();
}

function expectSharedFormLayout(action: HTMLElement): void {
  const form = action.closest("form");
  expect(form).not.toBeNull();
  expect(form?.dataset.slot).toBe("form");
  expect(action.parentElement?.dataset.slot).toBe("form-actions");
}

/* ------------------------------------------------------------------------ */

describe("finding an agent in a long list", () => {
  it("asks egma for the match rather than filtering the page in hand", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents": {
        status: 200,
        body: { agents: [LISTED_AGENT], nextPageToken: null },
      },
    });
    render(<AgentsPage />);
    await screen.findAllByText("Front desk");

    fireEvent.change(screen.getByLabelText("Search agents by name"), {
      target: { value: "front" },
    });

    await waitFor(() => {
      const asked = vi
        .mocked(globalThis.fetch)
        .mock.calls.map(([input]) => requestUrl(input as FetchInput));
      // A filter applied to what came back would answer differently depending
      // on how far somebody had scrolled.
      expect(asked).toContain("/v1/agents?projectId=prj_1&search=front");
    });
  });

  it("says a search matched nothing without calling the project empty", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents": [
        { status: 200, body: { agents: [LISTED_AGENT], nextPageToken: null } },
        { status: 200, body: { agents: [], nextPageToken: null } },
      ],
    });
    render(<AgentsPage />);
    await screen.findAllByText("Front desk");

    fireEvent.change(screen.getByLabelText("Search agents by name"), {
      target: { value: "zzz" },
    });

    // Two different absences: nothing matched, and there is nothing here. They
    // point somewhere different and must not share a sentence.
    expect(
      await screen.findByText("No agents match “zzz”"),
    ).toBeDefined();
    expect(screen.queryByText("No agents in this project yet")).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The question the list exists to answer: which agents egma can reach, and how.
 */
describe("reading an agent's reach from the list", () => {
  function listOf(...items: readonly unknown[]): void {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": { status: 200, body: { agents: items, nextPageToken: null } },
    });
  }

  function asked(): readonly string[] {
    return vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([input]) => requestUrl(input as FetchInput));
  }

  it("keeps the agent name and table layout stable while details are open", async () => {
    listOf(LISTED_AGENT);
    const view = render(<AgentsPage />);
    const table = await screen.findByRole("table", {
      name: "Agents in this project",
    });
    const name = within(table).getByText("Front desk");
    const row = name.closest("tr");
    expect(row).not.toBeNull();
    if (row === null) throw new Error("The agent row was not rendered.");
    const nameCell = row.cells[0];
    const beforeRowClasses = new Set(row.className.split(/\s+/u));

    fireEvent.click(within(row).getByText("Retell"));
    routed.search = "?sheet=agent&agent=agt_1";
    view.rerender(<AgentsPage />);
    await screen.findByRole("dialog", { name: "Front desk" });

    expect(row.cells[0]).toBe(nameCell);
    expect(nameCell?.textContent).toContain("Front desk");
    const activeMark = nameCell?.querySelector(
      '[data-slot="current-row-mark"]',
    );
    expect(activeMark).not.toBeNull();
    expect(activeMark?.parentElement).toBe(nameCell);
    const addedTableBoxes = row.className
      .split(/\s+/u)
      .filter(
        (className) =>
          !beforeRowClasses.has(className) &&
          (className === "relative" || className.startsWith("before:")),
      );
    expect(addedTableBoxes).toEqual([]);
  });

  it("opens details from the row while the row shows capabilities", async () => {
    listOf(LISTED_AGENT);
    const view = render(<AgentsPage />);
    await screen.findAllByText("Front desk");

    const row = screen.getByText("Front desk").closest("tr");
    expect(row).not.toBeNull();
    const rowView = within(row!);
    expect(rowView.getByText("Retell")).toBeDefined();
    expect(rowView.getByText("Configured")).toBeDefined();
    expect(rowView.getByText("Not configured")).toBeDefined();
    expect(rowView.queryByText("staging")).toBeNull();
    expect(rowView.queryByText("phone line")).toBeNull();
    expect(rowView.queryByRole("link", { name: "View details" })).toBeNull();
    const opener = rowView.getByRole("button", { name: "Front desk" });
    screen.getByLabelText("Search agents by name").focus();
    fireEvent.click(rowView.getByText("Retell"));
    expect(routed.push).toHaveBeenLastCalledWith(
      "/projects/prj_1/agents?sheet=agent&agent=agt_1",
    );

    routed.search = "?sheet=agent&agent=agt_1";
    view.rerender(<AgentsPage />);
    const details = await screen.findByRole("dialog", { name: "Front desk" });
    fireEvent.click(within(details).getByRole("button", { name: "Done" }));
    expect(routed.replace).toHaveBeenLastCalledWith("/projects/prj_1/agents");
    routed.search = "";
    view.rerender(<AgentsPage />);
    await waitFor(() => expect(document.activeElement).toBe(opener));

    // The table still comes from one list read. Opening details does not need
    // a request per row.
    expect(asked().filter((one) => one.startsWith("/v1/agents"))).toHaveLength(1);
    expect(asked().some((one) => one.includes("/v1/agents/"))).toBe(false);
  });

  it("loads a copied agent link when that agent is not on the current page", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": {
        status: 200,
        body: { agents: [UNREACHED_AGENT], nextPageToken: "next-page" },
      },
      "/v1/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [CONNECTION, MEASURED_CONNECTION] },
      },
    });
    routed.search = "?sheet=agent&agent=agt_1";

    render(<AgentsPage />);

    expect(
      await screen.findByRole("dialog", { name: "Front desk" }),
    ).toBeDefined();
    expect(asked()).toContain("/v1/agents/agt_1?projectId=prj_1");
  });

  it("keeps a copied agent link open while it loads and when it is missing", async () => {
    let releaseAgentRead: (() => void) | undefined;
    const agentReadMayFinish = new Promise<void>((resolve) => {
      releaseAgentRead = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, options?: RequestInit) => {
        const request = await observeRequest(input, options);
        if (request.path === "/api/me") {
          return Response.json(meWith("member"));
        }
        if (request.path === "/v1/agents") {
          return Response.json({
            agents: [UNREACHED_AGENT],
            nextPageToken: "next-page",
          });
        }
        if (request.path === "/v1/agents/agt_1") {
          await agentReadMayFinish;
          return Response.json(
            {
              error: "not_found",
              message: "This agent is not available in this project.",
            },
            { status: 404 },
          );
        }
        throw new Error(`nothing stubbed for ${request.path}`);
      }),
    );
    routed.search = "?sheet=agent&agent=agt_1";

    render(<AgentsPage />);

    const loading = within(
      await screen.findByRole("dialog", { name: "Agent details" }),
    );
    expect(loading.getByText("Loading agent details…")).toBeDefined();

    releaseAgentRead?.();
    expect(await loading.findByText("Not available here")).toBeDefined();
    expect(
      loading.getByText("This agent is not available in this project."),
    ).toBeDefined();
  });

  it("shows a copied agent read failure and retries it in the same sheet", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": {
        status: 200,
        body: { agents: [UNREACHED_AGENT], nextPageToken: "next-page" },
      },
      "/v1/agents/agt_1": [
        {
          status: 503,
          body: {
            error: "temporarily_unavailable",
            message: "The API is unavailable. Try again.",
          },
        },
        {
          status: 200,
          body: { agent: AGENT, connections: [CONNECTION, MEASURED_CONNECTION] },
        },
      ],
    });
    routed.search = "?sheet=agent&agent=agt_1";

    render(<AgentsPage />);

    const failed = within(
      await screen.findByRole("dialog", { name: "Agent details" }),
    );
    expect(await failed.findByText("Egma could not load this agent.")).toBeDefined();
    expect(failed.getByText("The API is unavailable. Try again.")).toBeDefined();
    fireEvent.click(failed.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("dialog", { name: "Front desk" }),
    ).toBeDefined();
    expect(
      asked().filter((one) => one === "/v1/agents/agt_1?projectId=prj_1"),
    ).toHaveLength(2);
  });

  /**
   * **An agent can be reached on two platforms at once.** The cell named
   * whichever platform the first connection carried, so one agent on Retell
   * and LiveKit said only one of them — and archiving that connection changed
   * the answer with nothing about the agent having changed.
   */
  it("names every platform an agent's connections are on", async () => {
    listOf({
      ...LISTED_AGENT,
      // The LiveKit way in comes back first, so a cell reading the first
      // connection would say "LiveKit" and stop there.
      connections: [LIVEKIT_CONNECTION, CONNECTION, MEASURED_CONNECTION],
    });
    render(<AgentsPage />);
    await screen.findAllByText("Front desk");

    // One cell, both platforms, in the vocabulary's order rather than the
    // order the connections were made in.
    expect(screen.getByText("Retell · LiveKit")).toBeDefined();
    // And one platform on its own is nowhere on the row, which would read as
    // an agent on one of them.
    expect(screen.queryByText("Retell")).toBeNull();
    expect(screen.queryByText("LiveKit")).toBeNull();
  });

  it("says plainly when simulation is not configured", async () => {
    listOf(UNREACHED_AGENT);
    render(<AgentsPage />);
    await screen.findAllByText("Night line");

    const row = screen.getByText("Night line").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getByText("Retell")).toBeDefined();
    expect(within(row!).getAllByText("Not configured")).toHaveLength(2);
  });

  /**
   * **The row reads left to right: narrow first, then act.** It led with the
   * button until the developer put this page beside a competitor's dashboard,
   * where the action is always the last thing on the strip. The button never
   * changed size — it is the default and always was — but leading a row it
   * shared with a full-width search box made it look like it had.
   */
  it("ends the toolbar with Connect an agent, and holds the search box to the board's width", async () => {
    listOf(LISTED_AGENT);
    render(<AgentsPage />);
    await screen.findAllByText("Front desk");

    const connect = await screen.findByRole("link", { name: "Connect an agent" });
    /*
     * **Query state on the address this list is already at, never a
     * navigation** (founder ruling, 2026-08-24). `/agents/new` still opens the
     * same panel for a copied link, but pressing the button here does not go
     * there and does not reload the page under the panel.
     */
    expect(connect.getAttribute("href")).toBe(
      "/projects/prj_1/agents?sheet=connect",
    );

    // Ends it: the search box is drawn before the action rather than after it.
    const search = screen.getByLabelText("Search agents by name");
    expect(search.compareDocumentPosition(connect) & 4).toBe(4);

    // And it is the one width every list in the product uses (`71Q-0`), read
    // from the theme rather than chosen here — not whatever is left of the row.
    expect(search.className).toContain("w-(--search-width)");
  });

  it("puts one Connect an agent in the middle of a project with nothing in it", async () => {
    listOf();
    render(<AgentsPage />);

    expect(await screen.findByText("No agents in this project yet")).toBeDefined();
    // One, not two: the empty state is the whole screen, so the toolbar's copy
    // of this control would leave somebody choosing between identical buttons.
    expect(screen.getAllByRole("link", { name: "Connect an agent" })).toHaveLength(1);
    // And nothing to search, so nothing offering to.
    expect(screen.queryByLabelText("Search agents by name")).toBeNull();
  });

  /**
   * Renaming sends the name and nothing else.
   *
   * **There is no revision to send.** An agent is deliberately unversioned —
   * its real content lives at the provider, where Egma cannot freeze it — so
   * two people editing one agent is last-writer-wins (ADR-0015), and a
   * revision in this body would be a promise the contract does not keep.
   */
  it("renames an agent with the name alone", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": [
        { status: 200, body: { agents: [LISTED_AGENT], nextPageToken: null } },
        { status: 200, body: { agents: [LISTED_AGENT], nextPageToken: null } },
      ],
      "/v1/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: LISTED_AGENT.connections },
      },
    });
    routed.search = "?sheet=agent&agent=agt_1";
    render(<AgentsPage />);
    await screen.findByRole("dialog", { name: "Front desk" });

    const trigger = screen.getByRole("button", { name: "Actions for Front desk" });
    trigger.focus();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Rename agent" }),
    );

    const name = (await screen.findByLabelText("Name*")) as HTMLInputElement;
    expect(name.value).toBe("Front desk");
    // Nothing to save until it moved, so the sheet cannot write a no-op.
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(name, { target: { value: "Night line" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.method).toBe("PATCH");
    expect(sent[0]?.url).toBe("/v1/agents/agt_1?projectId=prj_1");
    expect(sent[0]?.body).toEqual({ name: "Night line" });
  });

  /**
   * The row's one action is opening the agent. Management stays in that
   * agent's sheet, away from the list's four fact columns.
   */
  it("offers exactly Rename agent and Delete agent in the details sheet", async () => {
    listOf(LISTED_AGENT);
    routed.search = "?sheet=agent&agent=agt_1";
    render(<AgentsPage />);
    await screen.findByRole("dialog", { name: "Front desk" });

    const trigger = screen.getByRole("button", { name: "Actions for Front desk" });
    trigger.focus();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", { name: "Actions for Front desk" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Rename agent", "Delete agent"]);
  });

  it("lists every saved connection in the agent details sheet", async () => {
    listOf({
      ...LISTED_AGENT,
      connections: [CONNECTION, MEASURED_CONNECTION, LIVEKIT_CONNECTION],
    });
    routed.search = "?sheet=agent&agent=agt_1";
    render(<AgentsPage />);
    const panel = within(await screen.findByRole("dialog", { name: "Front desk" }));
    expect(panel.getByRole("heading", { name: "Connections" })).toBeDefined();
    expect(
      panel
        .getAllByRole("link", { name: "View" })
        .map((one) => one.getAttribute("href")),
    ).toEqual([
      "/projects/prj_1/agents?sheet=connection&agent=agt_1&connection=con_1",
      "/projects/prj_1/agents?sheet=connection&agent=agt_1&connection=con_2",
      "/projects/prj_1/agents?sheet=connection&agent=agt_1&connection=con_3",
    ]);
    const connections = panel
      .getByRole("heading", { name: "Connections" })
      .closest("section");
    expect(connections).not.toBeNull();
    const rows = within(connections!).getAllByRole("listitem");
    expect(within(rows[0]!).getByText("staging")).toBeDefined();
    expect(within(rows[0]!).getByText("Chat")).toBeDefined();
    expect(within(rows[1]!).getByText("phone line")).toBeDefined();
    expect(within(rows[1]!).getByText("Voice")).toBeDefined();
    expect(within(rows[2]!).getByText("livekit_room-1")).toBeDefined();
    expect(within(rows[2]!).getByText("Voice")).toBeDefined();
  });

  it("does not present one LiveKit connection's access as an agent fact", async () => {
    const chat = {
      ...LIVEKIT_CONNECTION,
      id: "con_4",
      name: "livekit_room-2",
      productLabel: "LiveKit chat",
      modality: "chat",
      config: { url: "wss://chat.livekit.cloud", agentName: "chat-worker" },
    };
    listOf({
      ...LISTED_AGENT,
      agentPlatform: "livekit",
      connections: [chat, LIVEKIT_CONNECTION],
    });
    routed.search = "?sheet=agent&agent=agt_1";
    render(<AgentsPage />);

    const panel = within(
      await screen.findByRole("dialog", { name: "Front desk" }),
    );
    const facts = panel.getByText("LiveKit agent").closest("section");
    expect(facts).not.toBeNull();
    expect(within(facts!).queryByText("Access")).toBeNull();
    expect(
      within(facts!).getAllByText("Varies by connection"),
    ).toHaveLength(2);
  });

  it("tells a viewer why the control is not theirs, where a keyboard can reach it", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/v1/agents": {
        status: 200,
        body: { agents: [LISTED_AGENT], nextPageToken: null },
      },
    });
    render(<AgentsPage />);

    const refused = await screen.findByRole("button", { name: "Connect an agent" });
    expect((refused as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: "Connect an agent" })).toBeNull();

    // **A disabled control cannot take focus, so a tooltip on one is a reason
    // only a pointer can reach.** The sentence is on the page and the control
    // names it, which is what makes disabling rather than hiding worth doing.
    const said = refused.getAttribute("aria-describedby");
    expect(said).not.toBeNull();
    expect(document.getElementById(String(said))?.textContent).toBe(
      "Your viewer role cannot connect agents. Ask an organization admin to change your role.",
    );
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The artifact's goal-first setup flow, driven through the real sheet.
 *
 * The goal comes before the provider. Provider capability then decides what
 * Egma can complete in the UI and what it must explain for the customer to do.
 */
describe("goal-first agent setup", () => {
  const retellDiscovery = {
    agents: [
      {
        platformAgentId: "agent_voice_1",
        name: "Appointment line",
        modality: "voice",
        connectionCandidates: [
          {
            agentPlatform: "retell",
            connectionType: "retell_text_mode",
            accessVariant: "retell_text_mode.api_key",
            modality: "chat",
            productLabel: "Retell text mode",
            config: { retellAgentId: "agent_voice_1" },
          },
          {
            agentPlatform: "retell",
            connectionType: "phone_number",
            accessVariant: "phone_number.public_e164",
            modality: "voice",
            productLabel: "Retell phone",
            config: { phoneNumber: "+14155550100" },
          },
          {
            agentPlatform: "retell",
            connectionType: "phone_number",
            accessVariant: "phone_number.public_e164",
            modality: "voice",
            productLabel: "Retell phone",
            config: { phoneNumber: "+14155550199" },
          },
        ],
      },
    ],
  };

  const liveKitAgent = {
    ...AGENT,
    id: "agt_livekit",
    name: "LiveKit front desk",
    agentPlatform: "livekit",
  };

  const liveKitConnection = {
    ...LIVEKIT_CONNECTION,
    id: "con_livekit",
    agentId: "agt_livekit",
  };

  function sheetAnswers(
    extra: Record<string, Stubbed | readonly Stubbed[]> = {},
  ): void {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/connection-options": { status: 200, body: TYPES },
      "/v1/agents": {
        status: 200,
        body: { agents: [], nextPageToken: null },
      },
      ...extra,
    });
  }

  async function choose(
    goal: "Run simulations" | "Monitor production" | "Set up both",
    platform: "Retell" | "LiveKit",
  ): Promise<void> {
    fireEvent.click(
      await screen.findByRole("radio", { name: new RegExp(`^${goal}`) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", {
        name: "Choose your agent platform",
      }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: platform }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  }

  async function findRetellAgents(): Promise<void> {
    fireEvent.change(await screen.findByLabelText("Retell API key*"), {
      target: { value: "retell-secret-A1B2C3D4WXYZ" },
    });
    expect(
      screen.queryByRole("radio", { name: /^Appointment line/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Find agents" }));
    expect(
      await screen.findByRole("heading", { name: "Choose a Retell agent" }),
    ).toBeDefined();
  }

  async function pickRetellAgent(name: string): Promise<void> {
    fireEvent.click(
      await screen.findByRole("radio", { name: new RegExp(`^${name}`) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  }

  /** The LiveKit lane's first screen, which comes before any credential box. */
  async function chooseLiveKitModality(name: "Chat" | "Voice"): Promise<void> {
    expect(
      await screen.findByRole("heading", {
        name: "How do you want to test this agent?",
      }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  }

  async function fillLiveKitSimulation(): Promise<void> {
    expect(
      await screen.findByRole("heading", {
        name: "Connect LiveKit Voice for simulations",
      }),
    ).toBeDefined();
    const connectionType = screen.getByRole("combobox", {
      name: "Connection type*",
    }) as HTMLSelectElement;
    expect(connectionType.value).toBe("livekit_room.project_credentials");
    expect(connectionType.getAttribute("aria-required")).toBe("true");
    expect(
      Array.from(connectionType.options).map((option) => option.text),
    ).toEqual(["Project credentials", "Token endpoint"]);
    expect(
      screen.getByPlaceholderText("your-livekit-agent-name"),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Enter the exact agent name shown in your LiveKit Cloud dashboard.",
      ),
    ).toBeDefined();
    expect(
      screen.getByPlaceholderText("wss://your-project.livekit.cloud"),
    ).toBeDefined();
    fireEvent.change(await screen.findByLabelText("LiveKit agent name*"), {
      target: { value: "front-desk" },
    });
    fireEvent.change(screen.getByLabelText("WebSocket URL*"), {
      target: { value: "wss://rooms.example.test" },
    });
    fireEvent.change(screen.getByLabelText("API key*"), {
      target: { value: "livekit-key" },
    });
    fireEvent.change(screen.getByLabelText("API secret*"), {
      target: { value: "livekit-secret" },
    });
  }

  it("asks for the goal first, then offers Retell before LiveKit", async () => {
    sheetAnswers();
    render(<RegisterAgentPage />);

    expect(
      await screen.findByText("What do you want Egma to do?"),
    ).toBeDefined();
    expect(screen.queryByText("Setup · Goal")).toBeNull();
    expect(
      screen.getAllByRole("radio").map((choice) => choice.textContent),
    ).toEqual([
      "Run simulationsTest how the agent responds before production.",
      "Monitor productionMonitor an agent in production",
      "Set up bothConfigure an agent for both testing and monitoring",
    ]);
    expect(
      screen.queryByRole("heading", { name: "Choose your agent platform" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Retell API key*")).toBeNull();

    const submit = screen.getByRole("button", { name: "Continue" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(
      screen.getByRole("radio", { name: /^Run simulations/ }),
    );
    expect(
      screen.queryByRole("heading", { name: "Choose your agent platform" }),
    ).toBeNull();
    fireEvent.click(submit);

    expect(
      await screen.findByRole("heading", {
        name: "Choose your agent platform",
      }),
    ).toBeDefined();
    expect(screen.queryByText("Setup · Platform")).toBeNull();
    expect(screen.getAllByRole("radio").map((one) => one.textContent)).toEqual([
      "Retell",
      "LiveKit",
    ]);
    for (const provider of screen.getAllByRole("radio")) {
      expect(provider.className).toContain("min-h-(--control-lg)");
      expect(provider.className).not.toContain("min-h-[92px]");
    }
    expect(screen.queryByLabelText("Retell API key*")).toBeNull();
    expect(screen.queryByLabelText("WebSocket URL*")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Retell" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Retell API key*")).toBeDefined();
    expect(screen.queryByText("Retell · Connection")).toBeNull();
    expect(screen.queryByText("Your key stays private.")).toBeNull();
    expect(screen.queryByText(/Egma stores it securely/)).toBeNull();
    expect(screen.queryByLabelText("WebSocket URL*")).toBeNull();
  });

  it("shows a Retell provider refusal and retries discovery without clearing the key", async () => {
    const apiKey = "retell-provider-key-A1B2C3D4";
    const providerMessage =
      "Retell could not list phone numbers while its service was unavailable.";
    const returnedAgentId = "agent_returned_after_retry";
    const returnedAgentName = "Provider-returned appointment desk";
    sheetAnswers({
      "/v1/agents:discover": [
        {
          status: 503,
          body: {
            error: "provider_unavailable",
            message: providerMessage,
          },
        },
        {
          status: 200,
          body: {
            agents: [
              {
                platformAgentId: returnedAgentId,
                name: returnedAgentName,
                modality: "voice",
                connectionCandidates: [
                  {
                    agentPlatform: "retell",
                    connectionType: "phone_number",
                    accessVariant: "phone_number.public_e164",
                    modality: "voice",
                    productLabel: "Retell phone",
                    config: { phoneNumber: "+14155550987" },
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    render(<RegisterAgentPage />);
    await choose("Run simulations", "Retell");

    const key = await screen.findByLabelText("Retell API key*");
    fireEvent.change(key, { target: { value: apiKey } });
    fireEvent.click(screen.getByRole("button", { name: "Find agents" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(providerMessage);
    expect((key as HTMLInputElement).value).toBe(apiKey);

    fireEvent.click(
      await screen.findByRole("button", { name: "Find agents" }),
    );
    expect(
      await screen.findByRole("radio", {
        name: new RegExp(`^${returnedAgentName}`),
      }),
    ).toBeDefined();

    const attempts = sent.filter((call) =>
      call.url.startsWith("/v1/agents:discover"),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.map((call) => call.url)).toEqual([
      "/v1/agents:discover?projectId=prj_1",
      "/v1/agents:discover?projectId=prj_1",
    ]);
    expect(attempts.map((call) => call.body)).toEqual([
      {
        agentPlatform: "retell",
        credentials: { apiKey },
      },
      {
        agentPlatform: "retell",
        credentials: { apiKey },
      },
    ]);
  });

  it("protects a credential draft from Close, Escape, and Cancel", async () => {
    sheetAnswers();
    render(<RegisterAgentPage />);
    await choose("Run simulations", "Retell");
    fireEvent.change(await screen.findByLabelText("Retell API key*"), {
      target: { value: "retell-secret-A1B2C3D4WXYZ" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    let warning = await screen.findByRole("dialog", {
      name: "Leave without saving?",
    });
    fireEvent.click(within(warning).getByRole("button", { name: "Keep editing" }));
    expect(await screen.findByLabelText("Retell API key*")).toBeDefined();

    fireEvent.keyDown(
      screen.getByRole("dialog", { name: "Set up an agent" }),
      { key: "Escape" },
    );
    warning = await screen.findByRole("dialog", {
      name: "Leave without saving?",
    });
    fireEvent.click(within(warning).getByRole("button", { name: "Keep editing" }));

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    warning = await screen.findByRole("dialog", {
      name: "Leave without saving?",
    });
    fireEvent.click(
      within(warning).getByRole("button", { name: "Discard changes" }),
    );

    expect(routed.replace).toHaveBeenCalledWith("/projects/prj_1/agents");
  });

  it("moves radio focus with the goal selection", async () => {
    sheetAnswers();
    render(<RegisterAgentPage />);

    const simulation = await screen.findByRole("radio", {
      name: /^Run simulations/,
    });
    simulation.focus();
    fireEvent.keyDown(simulation, { key: "ArrowRight" });

    const monitoring = screen.getByRole("radio", { name: /^Monitor production/ });
    await waitFor(() => expect(document.activeElement).toBe(monitoring));
    expect(monitoring.getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(monitoring, { key: "End" });
    const both = screen.getByRole("radio", { name: /^Set up both/ });
    await waitFor(() => expect(document.activeElement).toBe(both));
    expect(both.getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(both, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(simulation));
    expect(simulation.getAttribute("aria-checked")).toBe("true");
  });

  it("opens with Monitoring selected when another page states that goal", async () => {
    routed.search = "?sheet=connect&goal=monitoring";
    sheetAnswers();
    render(<AgentsPage />);

    const monitoring = await screen.findByRole("radio", {
      name: /^Monitor production/,
    });
    expect(monitoring.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByText(
        "Production monitoring is selected because you started from Traces. You can still change the goal.",
      ),
    ).toBeDefined();
    expect(
      screen.queryByRole("heading", { name: "Choose your agent platform" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", {
        name: "Choose your agent platform",
      }),
    ).toBeDefined();
  });

  it("honors the provider lane carried by a capability link", async () => {
    routed.search =
      "?sheet=connect&agent=agt_1&goal=monitoring&platform=livekit";
    sheetAnswers({
      "/v1/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
    });
    render(<AgentsPage />);

    expect(
      await screen.findByRole("heading", {
        name: "Add monitoring to your LiveKit agent",
      }),
    ).toBeDefined();
    expect(screen.queryByText("LiveKit · Monitoring")).toBeNull();
    expect(screen.queryByLabelText("Retell API key*")).toBeNull();
  });

  it("waits for an existing agent's saved setup and retries a failed read", async () => {
    routed.search =
      "?sheet=connect&agent=agt_1&goal=monitoring&platform=retell";
    sheetAnswers({
      "/v1/agents/agt_1": [
        {
          status: 503,
          body: {
            error: "provider_unavailable",
            message: "Egma could not read this agent. Try again.",
          },
        },
        {
          status: 200,
          body: {
            agent: {
              ...AGENT,
              monitoringKeyPresent: true,
              monitoringApiKeyHint: "WXYZ",
            },
            connections: [],
          },
        },
      ],
    });
    render(<AgentsPage />);

    expect(
      await screen.findByRole("heading", {
        name: "Egma could not load this agent's saved setup.",
      }),
    ).toBeDefined();
    expect(screen.queryByLabelText("Retell API key*")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText(/already holds its Retell key \(ending WXYZ\)/),
    ).toBeDefined();
    expect(screen.queryByLabelText("Retell API key*")).toBeNull();
  });

  it("resumes Retell monitoring repeatedly without adding a connection", async () => {
    routed.search =
      "?sheet=connect&agent=agt_1&goal=monitoring&platform=retell";
    sheetAnswers({
      "/v1/agents/agt_1": {
        status: 200,
        body: {
          agent: {
            ...AGENT,
            platformAgentId: "agent_voice_1",
            monitoringKeyPresent: true,
            monitoringApiKeyHint: "WXYZ",
            monitoringConfigured: true,
            pullProductionCalls: false,
          },
          connections: [MEASURED_CONNECTION],
        },
      },
      "/v1/agents:discover": { status: 200, body: retellDiscovery },
      "/v1/monitoring/start": {
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
    render(<AgentsPage />);

    expect(
      await screen.findByText(/already holds its Retell key \(ending WXYZ\)/),
    ).toBeDefined();
    expect(screen.queryByLabelText("Retell API key*")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Find agents" }));
    expect(
      await screen.findByRole("heading", { name: "Choose a Retell agent" }),
    ).toBeDefined();
    await pickRetellAgent("Appointment line");

    expect(await screen.findByLabelText("Phone number*")).toBeDefined();
    const start = screen.getByRole("button", { name: "Start monitoring" });
    for (let turn = 1; turn <= 2; turn += 1) {
      fireEvent.click(start);
      await waitFor(() => {
        expect(
          sent.filter((call) =>
            call.url.startsWith("/v1/monitoring/start"),
          ),
        ).toHaveLength(turn);
      });
    }

    const discovery = sent.find((call) =>
      call.url.startsWith("/v1/agents:discover"),
    );
    expect(discovery?.body).toEqual({
      agentPlatform: "retell",
      agentId: "agt_1",
    });
    for (const resumed of sent.filter((call) =>
      call.url.startsWith("/v1/monitoring/start"),
    )) {
      expect(resumed.body).toEqual({
        agentPlatform: "retell",
        watch: [
          { agentId: "agt_1", platformAgentId: "agent_voice_1" },
        ],
      });
    }
    expect(
      sent.some((call) =>
        call.url.startsWith("/v1/agents/agt_1/connections"),
      ),
    ).toBe(false);
  });

  it("lists every voice agent, keeps an unrouted one visible, and hides chat-native agents", async () => {
    // Egma registers Retell **voice** agents, so a chat-native agent is never
    // in the picker: no lane reaches one.
    const voiceAgents = Array.from({ length: 12 }, (_, index) => ({
      platformAgentId: `agent_voice_${index + 1}`,
      name: `Voice agent ${index + 1}`,
      modality: "voice" as const,
      connectionCandidates: [
        {
          agentPlatform: "retell" as const,
          connectionType: "phone_number" as const,
          accessVariant: "phone_number.public_e164" as const,
          modality: "voice" as const,
          productLabel: "Retell phone",
          config: { phoneNumber: `+1415555010${index}` },
        },
      ],
    }));
    sheetAnswers({
      "/v1/agents:discover": {
        status: 200,
        body: {
          agents: [
            ...voiceAgents,
            {
              platformAgentId: "agent_chat_1",
              name: "Chat agent 1",
              modality: "chat",
              connectionCandidates: [],
            },
            {
              platformAgentId: "agent_voice_unrouted",
              name: "Voice without a number",
              modality: "voice",
              connectionCandidates: [],
            },
          ],
        },
      },
    });
    render(<RegisterAgentPage />);

    await choose("Run simulations", "Retell");
    await findRetellAgents();

    expect(screen.getAllByRole("radio")).toHaveLength(13);
    expect(
      screen.getByRole("radio", { name: /^Voice agent 12/ }),
    ).toBeDefined();
    expect(screen.queryByRole("radio", { name: /^Chat agent 1/ })).toBeNull();
    const unrouted = screen.getByRole("radio", {
      name: /Voice without a number.*no phone numbers available/,
    }) as HTMLButtonElement;
    expect(unrouted.disabled).toBe(true);
  });

  it("asks one question, and a Text-only pick mints text mode and asks for no number", async () => {
    sheetAnswers({
      "/v1/agents:discover": { status: 200, body: retellDiscovery },
      "/v1/agents": [
        { status: 200, body: { agents: [], nextPageToken: null } },
        {
          status: 201,
          body: {
            result: "created",
            agent: {
              ...AGENT,
              name: "Appointment line",
              platformAgentId: "agent_voice_1",
            },
            connection: { ...CONNECTION, connectionType: "retell_text_mode" },
          },
        },
        { status: 200, body: { agents: [LISTED_AGENT], nextPageToken: null } },
      ],
    });
    render(<RegisterAgentPage />);
    await choose("Run simulations", "Retell");

    expect(screen.queryByLabelText("LiveKit agent name*")).toBeNull();
    await findRetellAgents();
    await pickRetellAgent("Appointment line");

    // The one question leads, before any plumbing.
    expect(
      await screen.findByRole("heading", {
        name: "How should Egma test this agent?",
      }),
    ).toBeDefined();
    expect(screen.queryByLabelText("Phone number*")).toBeNull();

    // Three lanes, each with its own help line.
    expect(screen.getByText("Text")).toBeDefined();
    expect(screen.getByText("Web call")).toBeDefined();
    expect(screen.getByText("Phone call")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Text"));
    const connect = screen.getByRole("button", { name: "Set up simulation" });
    expect(connect.closest("[data-slot=sheet-footer]")).not.toBeNull();
    fireEvent.click(connect);

    await waitFor(() => {
      expect(
        sent.some((call) => call.url === "/v1/agents?projectId=prj_1"),
      ).toBe(true);
    });
    const registration = sent.find(
      (call) => call.url === "/v1/agents?projectId=prj_1",
    );
    // Text mints text mode against the voice agent it conducts in text — and
    // the phone-number chooser never appeared, because Phone was not picked.
    expect(registration?.body).toEqual({
      name: "Appointment line",
      agentPlatform: "retell",
      connection: {
        agentPlatform: "retell",
        connectionType: "retell_text_mode",
        accessVariant: "retell_text_mode.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_voice_1" },
        platformAgentId: "agent_voice_1",
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
  });

  /** A voice agent as discovery now describes one, text mode door and all. */
  const voiceWithTextMode = {
    agents: [
      {
        platformAgentId: "agent_voice_1",
        name: "Front desk",
        modality: "voice",
        connectionCandidates: [
          {
            agentPlatform: "retell",
            connectionType: "retell_text_mode",
            accessVariant: "retell_text_mode.api_key",
            modality: "chat",
            productLabel: "Retell text mode",
            config: { retellAgentId: "agent_voice_1" },
          },
          {
            agentPlatform: "retell",
            connectionType: "retell_web_call",
            accessVariant: "retell_web_call.api_key",
            modality: "voice",
            productLabel: "Retell web call",
            config: { retellAgentId: "agent_voice_1" },
          },
          {
            agentPlatform: "retell",
            connectionType: "phone_number",
            accessVariant: "phone_number.public_e164",
            modality: "voice",
            productLabel: "Retell phone",
            config: { phoneNumber: "+14155550100" },
          },
        ],
      },
    ],
  };

  it("leads a Simulation voice agent with the one question, and Text mints text mode", async () => {
    sheetAnswers({
      "/v1/agents:discover": { status: 200, body: voiceWithTextMode },
      "/v1/agents": [
        { status: 200, body: { agents: [], nextPageToken: null } },
        {
          status: 201,
          body: {
            result: "created",
            agent: { ...AGENT, name: "Front desk", platformAgentId: "agent_voice_1" },
            connection: { ...CONNECTION, connectionType: "retell_text_mode" },
          },
        },
        { status: 200, body: { agents: [LISTED_AGENT], nextPageToken: null } },
      ],
    });
    render(<RegisterAgentPage />);
    await choose("Run simulations", "Retell");
    await findRetellAgents();
    await pickRetellAgent("Front desk");

    // The one question leads, before any plumbing. A phone picker is not on
    // screen yet, and it never will be for a pick that leaves Phone out.
    expect(
      await screen.findByRole("heading", {
        name: "How should Egma test this agent?",
      }),
    ).toBeDefined();
    expect(screen.queryByLabelText("Phone number*")).toBeNull();

    fireEvent.click(screen.getByLabelText("Text"));
    fireEvent.click(screen.getByRole("button", { name: "Set up simulation" }));

    await waitFor(() => {
      expect(
        sent.some((call) => call.url === "/v1/agents?projectId=prj_1"),
      ).toBe(true);
    });
    const registration = sent.find(
      (call) => call.url === "/v1/agents?projectId=prj_1",
    );
    // Choosing text mints text mode with the same key, against the voice
    // agent it conducts in text.
    expect(registration?.body).toEqual({
      name: "Front desk",
      agentPlatform: "retell",
      connection: {
        agentPlatform: "retell",
        connectionType: "retell_text_mode",
        accessVariant: "retell_text_mode.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_voice_1" },
        platformAgentId: "agent_voice_1",
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
  });

  it("takes a Simulation voice agent to the phone picker only when Phone call is picked", async () => {
    sheetAnswers({
      "/v1/agents:discover": { status: 200, body: voiceWithTextMode },
      "/v1/agents": [
        { status: 200, body: { agents: [], nextPageToken: null } },
        {
          status: 201,
          body: {
            result: "created",
            agent: { ...AGENT, name: "Front desk", platformAgentId: "agent_voice_1" },
            connection: MEASURED_CONNECTION,
          },
        },
        { status: 200, body: { agents: [LISTED_AGENT], nextPageToken: null } },
      ],
    });
    render(<RegisterAgentPage />);
    await choose("Run simulations", "Retell");
    await findRetellAgents();
    await pickRetellAgent("Front desk");

    expect(
      await screen.findByRole("heading", {
        name: "How should Egma test this agent?",
      }),
    ).toBeDefined();
    fireEvent.click(screen.getByLabelText("Phone call"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // The phone chooser, which only the phone lane leads into.
    const numbers = (await screen.findByLabelText(
      "Phone number*",
    )) as HTMLSelectElement;
    // Discovery offers this voice agent a web-call candidate too, but it
    // carries no number, so it stays out of the phone chooser rather than
    // sitting in it as a blank option and, by sorting first, becoming the
    // step's default. It is picked by its own tick in the one question.
    expect([...numbers.options].map((one) => one.value)).toEqual([
      "phone:+14155550100",
    ]);
    expect(numbers.value).toBe("phone:+14155550100");
  });

  it("uses one Retell key for Both and stores the selected voice route", async () => {
    sheetAnswers({
      "/v1/agents:discover": { status: 200, body: retellDiscovery },
      "/v1/agents": [
        { status: 200, body: { agents: [], nextPageToken: null } },
        {
          status: 201,
          body: {
            result: "created",
            agent: {
              ...AGENT,
              name: "Appointment line",
              platformAgentId: "agent_voice_1",
              monitoringKeyPresent: true,
              monitoringApiKeyHint: "WXYZ",
              pullProductionCalls: true,
            },
            connection: MEASURED_CONNECTION,
          },
        },
        { status: 200, body: { agents: [LISTED_AGENT], nextPageToken: null } },
      ],
    });
    render(<RegisterAgentPage />);
    await choose("Set up both", "Retell");
    await findRetellAgents();
    expect(screen.getByRole("radio", { name: /^Appointment line/ })).toBeDefined();
    await pickRetellAgent("Appointment line");

    const numbers = screen.getByLabelText(
      "Phone number*",
    ) as HTMLSelectElement;
    expect([...numbers.options].map((one) => one.textContent)).toEqual([
      "+14155550100",
      "+14155550199",
    ]);
    fireEvent.change(numbers, { target: { value: "phone:+14155550199" } });
    expect(screen.queryByLabelText("Retell API key*")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Set up both",
      }),
    );

    await waitFor(() => {
      expect(
        sent.some((call) => call.url === "/v1/agents?projectId=prj_1"),
      ).toBe(true);
    });
    const registration = sent.find(
      (call) => call.url === "/v1/agents?projectId=prj_1",
    );
    expect(registration?.body).toMatchObject({
      name: "Appointment line",
      agentPlatform: "retell",
      connection: {
        connectionType: "phone_number",
        modality: "voice",
        config: { phoneNumber: "+14155550199" },
        platformAgentId: "agent_voice_1",
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
        pullProductionCalls: true,
      },
    });
    expect(
      sent.filter((call) => call.url.startsWith("/v1/agents:discover")),
    ).toHaveLength(1);
    expect(
      sent.some((call) => call.url.startsWith("/v1/monitoring/start")),
    ).toBe(false);
  });

  it("never sees the test question when Monitoring is the goal", async () => {
    // A monitoring-goal user skips the question, as before: production pull
    // needs the voice connection and nothing else, so asking "text, web call
    // or phone?" would be a question whose answer it cannot use.
    sheetAnswers({
      "/v1/agents:discover": { status: 200, body: retellDiscovery },
    });
    render(<RegisterAgentPage />);
    await choose("Monitor production", "Retell");
    await findRetellAgents();
    await pickRetellAgent("Appointment line");

    expect(await screen.findByLabelText("Phone number*")).toBeDefined();
    expect(
      screen.queryByRole("heading", {
        name: "How should Egma test this agent?",
      }),
    ).toBeNull();
  });

  it("stores the selected Retell route and starts pulling when Monitoring is the goal", async () => {
    sheetAnswers({
      "/v1/agents:discover": { status: 200, body: retellDiscovery },
      "/v1/agents": [
        { status: 200, body: { agents: [], nextPageToken: null } },
        {
          status: 201,
          body: {
            result: "created",
            agent: {
              ...AGENT,
              name: "Appointment line",
              platformAgentId: "agent_voice_1",
              monitoringKeyPresent: true,
              monitoringApiKeyHint: "WXYZ",
              pullProductionCalls: true,
            },
            connection: MEASURED_CONNECTION,
          },
        },
        { status: 200, body: { agents: [LISTED_AGENT], nextPageToken: null } },
      ],
    });
    render(<RegisterAgentPage />);
    await choose("Monitor production", "Retell");
    await findRetellAgents();
    await pickRetellAgent("Appointment line");
    expect(await screen.findByLabelText("Phone number*")).toBeDefined();

    const start = screen.getByRole("button", { name: "Start monitoring" });
    await waitFor(() => {
      expect((start as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(start);

    await waitFor(() => {
      expect(
        sent.some((call) => call.url === "/v1/agents?projectId=prj_1"),
      ).toBe(true);
    });
    const registration = sent.find(
      (call) => call.url === "/v1/agents?projectId=prj_1",
    );
    expect(registration?.body).toEqual({
      name: "Appointment line",
      agentPlatform: "retell",
      connection: {
        agentPlatform: "retell",
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
        modality: "voice",
        config: { phoneNumber: "+14155550100" },
        platformAgentId: "agent_voice_1",
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
        pullProductionCalls: true,
      },
    });
    expect(
      sent.some((call) => call.url.startsWith("/v1/monitoring/start")),
    ).toBe(false);
  });

  it("creates only the LiveKit room connection for Simulation", async () => {
    sheetAnswers({
      "/v1/agents": [
        { status: 200, body: { agents: [], nextPageToken: null } },
        {
          status: 201,
          body: {
            result: "created",
            agent: liveKitAgent,
            connection: liveKitConnection,
          },
        },
        {
          status: 200,
          body: {
            agents: [
              { ...liveKitAgent, connections: [liveKitConnection] },
            ],
            nextPageToken: null,
          },
        },
      ],
    });
    render(<RegisterAgentPage />);
    await choose("Run simulations", "LiveKit");
    await chooseLiveKitModality("Voice");
    await fillLiveKitSimulation();

    expect(
      screen.queryByRole("heading", {
        name: "Add monitoring to your LiveKit agent",
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Save connection" }),
    );

    await waitFor(() => {
      expect(
        sent.some((call) => call.url === "/v1/agents?projectId=prj_1"),
      ).toBe(true);
    });
    expect(routed.replace).toHaveBeenCalledWith("/projects/prj_1/agents");

    const registration = sent.find(
      (call) => call.url === "/v1/agents?projectId=prj_1",
    );
    expect(registration?.body).toEqual({
      name: "front-desk",
      agentPlatform: "livekit",
      connection: {
        agentPlatform: "livekit",
        connectionType: "livekit_room",
        accessVariant: "livekit_room.project_credentials",
        modality: "voice",
        config: {
          url: "wss://rooms.example.test",
          agentName: "front-desk",
        },
        credentials: {
          apiKey: "livekit-key",
          apiSecret: "livekit-secret",
        },
      },
    });
  });

  /**
   * The choice a person understands comes before the plumbing it settles.
   *
   * Chat and voice are two different things to test, and which one this is
   * decides what the credential screen may even offer — so a credential box on
   * screen before the question has been answered would be asking for the
   * wrong values half the time.
   */
  it("asks how the agent is tested before any LiveKit credential box", async () => {
    sheetAnswers();
    render(<RegisterAgentPage />);
    await choose("Run simulations", "LiveKit");

    expect(
      await screen.findByRole("heading", {
        name: "How do you want to test this agent?",
      }),
    ).toBeDefined();
    expect(
      screen.getAllByRole("radio").map((choice) => choice.textContent),
    ).toEqual([
      expect.stringContaining("Voice"),
      expect.stringContaining("Chat"),
    ]);
    expect(screen.queryByLabelText("LiveKit agent name*")).toBeNull();
    expect(screen.queryByLabelText("WebSocket URL*")).toBeNull();
    expect(screen.queryByLabelText("API key*")).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Connection type*" }),
    ).toBeNull();
    expect(sent).toEqual([]);
  });

  it("saves a LiveKit chat connection and offers no way in but project credentials", async () => {
    sheetAnswers({
      "/v1/agents": [
        { status: 200, body: { agents: [], nextPageToken: null } },
        {
          status: 201,
          body: {
            result: "created",
            agent: liveKitAgent,
            connection: {
              ...liveKitConnection,
              modality: "chat",
              productLabel: "LiveKit chat",
            },
          },
        },
        {
          status: 200,
          body: {
            agents: [{ ...liveKitAgent, connections: [liveKitConnection] }],
            nextPageToken: null,
          },
        },
      ],
    });
    render(<RegisterAgentPage />);
    await choose("Run simulations", "LiveKit");
    await chooseLiveKitModality("Chat");

    expect(
      await screen.findByRole("heading", {
        name: "Connect LiveKit Chat for simulations",
      }),
    ).toBeDefined();
    // Egma has to dispatch the worker to tell it the simulation is typed, so
    // there is one way in and nothing that pretends otherwise.
    expect(
      screen.queryByRole("combobox", { name: "Connection type*" }),
    ).toBeNull();
    expect(screen.queryByText("Token endpoint")).toBeNull();
    expect(screen.queryByLabelText("Token endpoint*")).toBeNull();

    fireEvent.change(screen.getByLabelText("LiveKit agent name*"), {
      target: { value: "front-desk" },
    });
    fireEvent.change(screen.getByLabelText("WebSocket URL*"), {
      target: { value: "wss://rooms.example.test" },
    });
    fireEvent.change(screen.getByLabelText("API key*"), {
      target: { value: "livekit-key" },
    });
    fireEvent.change(screen.getByLabelText("API secret*"), {
      target: { value: "livekit-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => {
      expect(
        sent.some((call) => call.url === "/v1/agents?projectId=prj_1"),
      ).toBe(true);
    });
    const registration = sent.find(
      (call) => call.url === "/v1/agents?projectId=prj_1",
    );
    expect(registration?.body).toEqual({
      name: "front-desk",
      agentPlatform: "livekit",
      connection: {
        agentPlatform: "livekit",
        connectionType: "livekit_room",
        accessVariant: "livekit_room.project_credentials",
        modality: "chat",
        config: {
          url: "wss://rooms.example.test",
          agentName: "front-desk",
        },
        credentials: {
          apiKey: "livekit-key",
          apiSecret: "livekit-secret",
        },
      },
    });

    // The setup Egma cannot perform, handed over after the connection exists.
    expect(
      await screen.findByRole("heading", {
        name: "Add the chat setup to your LiveKit agent",
      }),
    ).toBeDefined();
    expect(
      screen.getAllByRole("button", { name: "Copy" }),
    ).toHaveLength(2);
    const shown = document.body.textContent ?? "";
    expect(shown).toContain(
      'chat = ctx.job.room.name.startswith("egma-sim-chat-")',
    );
    expect(shown).toContain("TextOutputOptions(sync_transcription=False)");
    expect(shown).not.toMatch(/chat (is )?(ready|configured|on)\b/i);
    expect(shown).not.toContain("Verified");
  });

  /**
   * The second modality on an agent Egma already holds.
   *
   * One vendor agent is one Egma agent, so the chat run and the voice run of
   * the same test suite can be read side by side. A second registration here
   * would split that history in half.
   */
  it("adds chat to an agent that already exists instead of minting a twin", async () => {
    routed.search =
      "?sheet=connect&agent=agt_livekit&goal=simulation&platform=livekit";
    sheetAnswers({
      "/v1/agents/agt_livekit": {
        status: 200,
        body: { agent: liveKitAgent, connections: [liveKitConnection] },
      },
      "/v1/agents/agt_livekit/connections": {
        status: 201,
        body: {
          connection: {
            ...liveKitConnection,
            id: "con_livekit_chat",
            modality: "chat",
            productLabel: "LiveKit chat",
          },
        },
      },
    });
    render(<AgentsPage />);

    await chooseLiveKitModality("Chat");
    fireEvent.change(await screen.findByLabelText("LiveKit agent name*"), {
      target: { value: "front-desk" },
    });
    fireEvent.change(screen.getByLabelText("WebSocket URL*"), {
      target: { value: "wss://rooms.example.test" },
    });
    fireEvent.change(screen.getByLabelText("API key*"), {
      target: { value: "livekit-key" },
    });
    fireEvent.change(screen.getByLabelText("API secret*"), {
      target: { value: "livekit-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => {
      expect(
        sent.some((call) =>
          call.url.startsWith("/v1/agents/agt_livekit/connections"),
        ),
      ).toBe(true);
    });
    expect(
      sent.some((call) => call.url === "/v1/agents?projectId=prj_1"),
    ).toBe(false);
    const added = sent.find((call) =>
      call.url.startsWith("/v1/agents/agt_livekit/connections"),
    );
    expect(added?.body).toEqual({
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "chat",
      config: {
        url: "wss://rooms.example.test",
        agentName: "front-desk",
      },
      credentials: {
        apiKey: "livekit-key",
        apiSecret: "livekit-secret",
      },
    });
  });

  it("stores a LiveKit token endpoint without asking for the project secret", async () => {
    sheetAnswers({
      "/v1/agents": [
        { status: 200, body: { agents: [], nextPageToken: null } },
        {
          status: 201,
          body: {
            result: "created",
            agent: liveKitAgent,
            connection: {
              ...liveKitConnection,
              accessVariant: "livekit_room.customer_token_endpoint",
              productLabel: "LiveKit token endpoint",
              config: {
                url: "wss://rooms.example.test",
                tokenEndpoint: "https://tokens.example.test/livekit",
              },
            },
          },
        },
        {
          status: 200,
          body: {
            agents: [
              { ...liveKitAgent, connections: [liveKitConnection] },
            ],
            nextPageToken: null,
          },
        },
      ],
    });
    render(<RegisterAgentPage />);
    await choose("Run simulations", "LiveKit");
    await chooseLiveKitModality("Voice");

    fireEvent.change(
      await screen.findByRole("combobox", { name: "Connection type*" }),
      { target: { value: "livekit_room.customer_token_endpoint" } },
    );
    expect(
      await screen.findByRole("heading", {
        name: "Connect LiveKit Voice for simulations",
      }),
    ).toBeDefined();
    expect(screen.getByLabelText("LiveKit agent name*")).toBeDefined();
    expect(
      screen.getByText(
        "This names the agent in Egma. Your token endpoint decides which deployed worker joins the room.",
      ),
    ).toBeDefined();
    expect(screen.queryByLabelText("API secret*")).toBeNull();
    expect(
      screen.getByPlaceholderText("wss://your-project.livekit.cloud"),
    ).toBeDefined();
    expect(
      screen.getByPlaceholderText("https://api.example.com/livekit/token"),
    ).toBeDefined();
    expect(
      screen.getByPlaceholderText('{"Authorization":"Bearer your-token"}'),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Enter a non-empty JSON object that maps each header name to a non-empty string value.",
      ),
    ).toBeDefined();

    fireEvent.change(screen.getByLabelText("WebSocket URL*"), {
      target: { value: "wss://rooms.example.test" },
    });
    fireEvent.change(screen.getByLabelText("LiveKit agent name*"), {
      target: { value: "appointment-scheduling-langsmith" },
    });
    fireEvent.change(screen.getByLabelText("Token endpoint*"), {
      target: { value: "https://tokens.example.test/livekit" },
    });
    fireEvent.change(screen.getByLabelText("Auth headers*"), {
      target: { value: '{"Authorization":"Bearer token"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => {
      expect(
        sent.some((call) => call.url === "/v1/agents?projectId=prj_1"),
      ).toBe(true);
    });
    const registration = sent.find(
      (call) => call.url === "/v1/agents?projectId=prj_1",
    );
    expect(registration?.body).toEqual({
      name: "appointment-scheduling-langsmith",
      agentPlatform: "livekit",
      connection: {
        agentPlatform: "livekit",
        connectionType: "livekit_room",
        accessVariant: "livekit_room.customer_token_endpoint",
        modality: "voice",
        config: {
          url: "wss://rooms.example.test",
          tokenEndpoint: "https://tokens.example.test/livekit",
        },
        credentials: {
          headers: '{"Authorization":"Bearer token"}',
        },
      },
    });
  });

  it("shows only LiveKit Monitoring instructions and performs no write", async () => {
    sheetAnswers();
    render(<RegisterAgentPage />);
    await choose("Monitor production", "LiveKit");

    expect(
      await screen.findByRole("heading", {
        name: "Add monitoring to your LiveKit agent",
      }),
    ).toBeDefined();
    const copy = document.body.textContent ?? "";
    expect(copy).toContain("monitor_livekit(ctx)");
    expect(copy).toContain("await session.start(...)");
    expect(copy).not.toContain("ctx.connect()");
    expect(copy).toContain("EGMA_URL=<your-public-egma-url>");
    expect(copy).not.toContain("localhost");
    expect(copy).toContain("EGMA_API_KEY=<your-project-api-key>");
    expect(
      screen.getByRole("link", { name: "API keys" }).getAttribute("href"),
    ).toBe("/projects/prj_1/settings/keys");
    expect(screen.queryByLabelText("Agent*")).toBeNull();
    expect(screen.queryByLabelText("LiveKit agent name*")).toBeNull();
    expect(screen.queryByLabelText("WebSocket URL*")).toBeNull();
    expect(
      screen.queryByText(/Enter the exact LiveKit agent name/),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Return to agents" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Save agent" })).toBeNull();
    expect(sent).toEqual([]);
  });

  it("sets up LiveKit Simulation first for Both, then shows Monitoring instructions", async () => {
    sheetAnswers({
      "/v1/agents": [
        { status: 200, body: { agents: [], nextPageToken: null } },
        {
          status: 201,
          body: {
            result: "created",
            agent: liveKitAgent,
            connection: liveKitConnection,
          },
        },
      ],
    });
    render(<RegisterAgentPage />);
    await choose("Set up both", "LiveKit");
    await chooseLiveKitModality("Voice");
    await fillLiveKitSimulation();

    expect(
      screen.queryByRole("heading", {
        name: "Add monitoring to your LiveKit agent",
      }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Continue to monitoring" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Add monitoring to your LiveKit agent",
      }),
    ).toBeDefined();
    expect(screen.queryByText("Not verified yet")).toBeNull();
    expect(screen.queryByText(/Production traces received/)).toBeNull();
    expect(
      sent.some((call) => call.url.startsWith("/v1/monitoring/")),
    ).toBe(false);
  });

  it("draws no setup form until it knows the person's role", async () => {
    sheetAnswers();
    render(<RegisterAgentPage />);

    expect(
      screen.getByRole("heading", { name: "Set up an agent" }),
    ).toBeDefined();
    expect(
      screen.queryByText("What do you want Egma to do?"),
    ).toBeNull();
    expect(screen.queryByLabelText("Retell API key*")).toBeNull();

    expect(
      await screen.findByText("What do you want Egma to do?"),
    ).toBeDefined();
  });

  it("explains that a viewer cannot use the setup flow", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/v1/connection-options": { status: 200, body: TYPES },
      "/v1/agents": {
        status: 200,
        body: { agents: [], nextPageToken: null },
      },
    });
    render(<RegisterAgentPage />);

    expect(
      await screen.findByText(
        "Your viewer role cannot connect agents. Ask an organization admin to change your role, then try again.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue" }),
    ).toBeNull();
  });

  it("offers a retry when Egma cannot load the connection catalog", async () => {
    sheetAnswers({
      "/v1/connection-options": [
        {
          status: 500,
          body: { error: "unreadable_answer", message: "Egma could not answer." },
        },
        { status: 200, body: TYPES },
      ],
    });
    render(<RegisterAgentPage />);
    await choose("Run simulations", "LiveKit");

    expect(
      await screen.findByText("Egma could not describe the connection options."),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    // The modality choices are the catalog's, so this screen waits for it too.
    await chooseLiveKitModality("Voice");
    expect(
      await screen.findByRole("heading", {
        name: "Connect LiveKit Voice for simulations",
      }),
    ).toBeDefined();
    expect(screen.getByLabelText("LiveKit agent name*")).toBeDefined();
  });
});

/* ------------------------------------------------------------------------ */

describe("one connection's page", () => {
  /** Open the ⋮ in the sheet's head, which is where managing lives now. */
  async function openConnectionMenu(): Promise<void> {
    const trigger = await screen.findByRole("button", {
      name: /^Actions for /,
    });
    trigger.focus();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(trigger);
    await screen.findByRole("menu", { name: /^Actions for / });
  }

  function answersWith(
    connection: Record<string, unknown>,
    role = "member",
    extra: Record<string, Stubbed | readonly Stubbed[]> = {},
  ): void {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/v1/connection-options": { status: 200, body: TYPES },
      // The list behind the panel: this address draws the agents screen with
      // one connection open over it.
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/v1/agents/agt_1/connections/con_1": { status: 200, body: { connection } },
      ...extra,
    });
  }

  it("names itself the word while it loads and the connection once it has one", async () => {
    answersWith(CONNECTION);
    render(<ConnectionDetailPage />);

    // A panel with no answer yet says what it is, not what it is of: the
    // connection's name is in the read that has not come back.
    expect(screen.getByRole("heading", { name: "Connection" })).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "staging" }),
    ).toBeTruthy();
    /*
     * **And nothing under the title** (`ITZ-0`). The subtitle used to say
     * "Retell chat · Chat", which is what the Access row says two lines below
     * it; the first thing a panel says should be the record rather than its
     * category.
     */
    expect(screen.queryByText("Retell chat · Chat")).toBeNull();
  });

  it("keeps provider secrets out of the panel and names what Archive stops", async () => {
    answersWith(CONNECTION);
    render(<ConnectionDetailPage />);

    /* Access says what the catalog calls this way in, in the catalog's words. */
    expect(await screen.findByText("Retell API key")).toBeDefined();
    expect(screen.queryByLabelText("Retell API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Rotate credential" })).toBeNull();
    expect(screen.queryByText("Capabilities")).toBeNull();
    /*
     * **Three rows left with the 2026-08-24 boards.** Platform, because Access
     * already says which product this is; Updated-at, because nobody reads a
     * connection to find out when it was touched; and Env, because the product
     * stopped speaking that word — the stored column stays where it is.
     */
    expect(screen.queryByText("Platform")).toBeNull();
    expect(screen.queryByText("Env")).toBeNull();
    expect(screen.queryByText(/^Updated/)).toBeNull();
    const modality = screen.getByText("Modality").parentElement;
    expect(modality).not.toBeNull();
    expect(within(modality!).getByText("Chat")).toBeDefined();
    /* The credential is a hint of its last characters, never the secret. */
    expect(screen.getByText("…WXYZ")).toBeDefined();

    /*
     * **The destructive action says Delete, and it lives in the header ⋮**
     * (founder ruling, 2026-08-24). The write underneath still archives, which
     * is why the sentence says stored transcripts stay stored: the word
     * matches what the person meant, and the sentence says what actually
     * happens.
     */
    await openConnectionMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete connection" }));
    expect(
      await screen.findByText(
        "Egma stops using “staging” to reach this agent, and every run waiting on it stops. Transcripts already stored stay stored.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/archive/i)).toBeNull();
  });

  it("keeps credential copy out of ordinary edits that take no credential", async () => {
    for (const connection of [
      {
        ...CONNECTION,
        agentPlatform: "retell",
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
        productLabel: "Phone number",
        modality: "voice",
        config: { phoneNumber: "+14155550100" },
      },
      {
        ...CONNECTION,
        agentPlatform: "livekit",
        connectionType: "livekit_room",
        accessVariant: "livekit_room.customer_token_endpoint",
        productLabel: "LiveKit token endpoint",
        modality: "voice",
        config: {
          url: "wss://example.livekit.cloud",
          tokenEndpoint: "https://example.test/livekit-token",
        },
      },
    ]) {
      answersWith(connection);
      const view = render(<ConnectionDetailPage />);

      await openConnectionMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit connection" }));
      expect(screen.queryByText("A phone connection takes no credential.")).toBeNull();
      expect(screen.queryByText("Optional auth headers for the endpoint.")).toBeNull();

      view.unmount();
      cleanup();
    }
  });

  it("uses catalog field labels and keeps forward-compatible fields visible", async () => {
    answersWith({
      ...CONNECTION,
      config: {
        ...CONNECTION.config,
        undocumentedKey: "kept visible",
      },
    });
    render(<ConnectionDetailPage />);

    // The fields are labelled rows in the panel now, so there is no block
    // heading over them and nothing to look for one under.
    expect(await screen.findByText("Retell agent ID")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Where it points" })).toBeNull();

    // Known keys use the product language from the connection catalog. A key
    // from a newer server is still visible by its raw name, so the panel loses
    // no configuration while clients and servers roll forward separately.
    expect(screen.getByText("agent_abc")).toBeDefined();
    expect(screen.getByText("undocumentedKey")).toBeDefined();
    expect(screen.getByText("kept visible")).toBeDefined();
  });

  it("saves only the editable display name and target fields", async () => {
    answersWith(CONNECTION);
    render(<ConnectionDetailPage />);

    await openConnectionMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit connection" }));
    fireEvent.change(screen.getByLabelText("Connection name*"), {
      target: { value: "Primary Retell connection" },
    });
    fireEvent.change(screen.getByLabelText("Retell agent ID*"), {
      target: { value: "agent_moved" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      name: "Primary Retell connection",
      config: { retellAgentId: "agent_moved" },
    });
  });

  it("keeps LiveKit editing on a named agent", async () => {
    const named = {
      ...CONNECTION,
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      productLabel: "LiveKit project credentials",
      modality: "voice",
      config: {
        url: "wss://example.livekit.cloud",
        agentName: "front-desk",
      },
    };
    answersWith(named);
    render(<ConnectionDetailPage />);

    await openConnectionMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit connection" }));
    // The name is the whole of the LiveKit decision here: every dispatch is
    // explicit, so there is no method left to choose between.
    expect(screen.queryByLabelText("Dispatch method*")).toBeNull();
    expect(
      (screen.getByLabelText("LiveKit agent name*") as HTMLInputElement).value,
    ).toBe("front-desk");
    fireEvent.change(screen.getByLabelText("LiveKit agent name*"), {
      target: { value: "customer-support" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      name: "staging",
      config: {
        url: "wss://example.livekit.cloud",
        agentName: "customer-support",
      },
    });
  });

  /**
   * A LiveKit connection saved before the name was demanded.
   *
   * Egma will not conduct on that row: every Egma dispatch is explicit, and
   * a connection with no name has no worker to dispatch. So the editor asks
   * for one and refuses to save until it has it, rather than writing the row
   * back the way it was.
   */
  it("requires a name from a LiveKit connection that was saved without one", async () => {
    const unnamed = {
      ...CONNECTION,
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      productLabel: "LiveKit project credentials",
      modality: "voice",
      config: { url: "wss://example.livekit.cloud" },
    };
    answersWith(unnamed);
    render(<ConnectionDetailPage />);

    await openConnectionMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit connection" }));
    expect(screen.queryByLabelText("Dispatch method*")).toBeNull();
    expect(
      (screen.getByLabelText("LiveKit agent name*") as HTMLInputElement).value,
    ).toBe("");

    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe("Enter the exact LiveKit agent name.");
    expect(
      screen.getByText("Enter the exact LiveKit agent name."),
    ).toBeDefined();
    expect(screen.queryByText(/automatic dispatch/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("LiveKit agent name*"), {
      target: { value: "customer-support" },
    });
    const enabledSave = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(enabledSave.disabled).toBe(false);
    fireEvent.click(enabledSave);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      name: "staging",
      config: {
        url: "wss://example.livekit.cloud",
        agentName: "customer-support",
      },
    });
  });

  it("says so when it could not describe the type, and offers a retry", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/connection-options": [
        {
          status: 500,
          body: { error: "unreadable_answer", message: "Egma could not answer." },
        },
        { status: 200, body: TYPES },
      ],
      "/v1/agents/agt_1/connections/con_1": {
        status: 200,
        body: { connection: CONNECTION },
      },
    });
    render(<ConnectionDetailPage />);

    expect(
      await screen.findByText("Egma could not describe this connection."),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.queryByText("Egma could not describe this connection.")).toBeNull(),
    );
    await openConnectionMenu();
    expect(
      screen
        .getByRole("menuitem", { name: "Edit connection" })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  it("does not open an editor when the type catalog is unavailable", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/connection-options": {
        status: 500,
        body: { error: "unreadable_answer", message: "Egma could not answer." },
      },
      "/v1/agents/agt_1/connections/con_1": {
        status: 200,
        body: { connection: CONNECTION },
      },
    });
    render(<ConnectionDetailPage />);

    await openConnectionMenu();
    const edit = screen.getByRole("menuitem", { name: "Edit connection" });
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    /*
     * A disabled menu item takes no focus and answers no hover, so the reason
     * is a line of the panel rather than a tooltip only a pointer could reach.
     */
    expect(
      screen.getAllByText(/Egma could not describe this connection's fields\./)
        .length,
    ).toBeGreaterThan(0);

    fireEvent.click(edit);
    // No editor opened: the panel is still the read view, whose Name is a line
    // of text rather than a labelled box.
    expect(screen.queryByLabelText("Name*")).toBeNull();
  });

  it("sends an expired session to sign-in rather than showing a broken page", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { replace, assign: vi.fn(), href: "" });
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/connection-options": { status: 401, body: {} },
      "/v1/agents/agt_1/connections/con_1": {
        status: 200,
        body: { connection: CONNECTION },
      },
    });
    render(<ConnectionDetailPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
  });

});
