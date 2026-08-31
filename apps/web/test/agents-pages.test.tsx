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
 * Connecting now hands the full job to the coding agent in the repository.
 *
 * The web surface makes no provider choice and performs no setup write. It
 * offers the three public outcomes as complete prompts and stays useful when
 * an old link carries one goal or platform in its query.
 */
describe("coding-agent setup handoff", () => {
  const handoff =
    `Use ${window.location.origin} as the Egma platform URL. ` +
    "Start by running `egma` if available or `npx --yes @egma/cli` otherwise. " +
    "Follow the coding-agent handoff. Use existing credentials. " +
    "Ask the developer only for browser authorization, a missing credential, " +
    "a choice that cannot be safely inferred, an unsafe conflict, or approval " +
    "before a real phone run that may cost money.";
  const prompts = {
    simulation:
      "Set up Egma simulation testing for this repository's voice agent end to end. " +
      handoff,
    monitoring:
      "Set up Egma production monitoring for this repository's voice agent end to end. " +
      handoff,
    both:
      "Set up Egma simulation testing and production monitoring for this repository's voice agent end to end. " +
      handoff,
  } as const;

  function handoffAnswers(role = "member"): void {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/v1/agents": {
        status: 200,
        body: { agents: [], nextPageToken: null },
      },
    });
  }

  function requestedPaths(): readonly string[] {
    return vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([input]) => requestUrl(input as FetchInput));
  }

  it("keeps all three prompts visible when an old link carries one goal and platform", async () => {
    routed.search =
      "?sheet=connect&agent=agt_not_on_page&goal=monitoring&platform=livekit";
    handoffAnswers();
    render(<AgentsPage />);

    const sheet = within(
      await screen.findByRole("dialog", { name: "Connect an agent" }),
    );

    expect(
      sheet
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Simulation", "Monitoring", "Both"]);
    expect(sheet.getByText(prompts.simulation)).toBeDefined();
    expect(sheet.getByText(prompts.monitoring)).toBeDefined();
    expect(sheet.getByText(prompts.both)).toBeDefined();
    expect(
      sheet.getAllByRole("button", { name: /^Copy .* prompt$/ }).map(
        (button) => button.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Copy simulation prompt",
      "Copy monitoring prompt",
      "Copy both prompt",
    ]);

    expect(sheet.queryByRole("radio")).toBeNull();
    expect(sheet.queryByRole("combobox")).toBeNull();
    expect(sheet.queryByRole("textbox")).toBeNull();
    expect(sheet.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(sheet.queryByText("Retell")).toBeNull();
    expect(sheet.queryByText("LiveKit")).toBeNull();
    expect(sheet.queryByText(/API key/u)).toBeNull();
    expect(sheet.queryByText(/Press Enter/u)).toBeNull();

    await waitFor(() =>
      expect(requestedPaths()).toContain("/v1/agents?projectId=prj_1"),
    );
    expect(
      requestedPaths().some(
        (path) =>
          path.includes("connection-options") ||
          path.includes(":discover") ||
          path.includes("/monitoring/") ||
          path.includes("/v1/agents/agt_not_on_page"),
      ),
    ).toBe(false);
    expect(sent).toEqual([]);
  });

  it("copies the exact prompt for each outcome and announces success", async () => {
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    handoffAnswers();
    render(<RegisterAgentPage />);

    const sheet = within(
      await screen.findByRole("dialog", { name: "Connect an agent" }),
    );
    const cases = [
      ["simulation", prompts.simulation],
      ["monitoring", prompts.monitoring],
      ["both", prompts.both],
    ] as const;

    for (const [outcome, prompt] of cases) {
      fireEvent.click(
        sheet.getByRole("button", { name: `Copy ${outcome} prompt` }),
      );
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(prompt));
      expect(
        sheet.getByRole("button", {
          name: `${outcome.charAt(0).toUpperCase() + outcome.slice(1)} prompt copied`,
        }),
      ).toBeDefined();
      expect(
        sheet.getByText(
          `${outcome.charAt(0).toUpperCase() + outcome.slice(1)} prompt copied.`,
        ),
      ).toBeDefined();
    }

    expect(writeText.mock.calls.map(([value]) => value)).toEqual([
      prompts.simulation,
      prompts.monitoring,
      prompts.both,
    ]);
    expect(sent).toEqual([]);
  });

  it("keeps the prompt visible and announces a clipboard failure", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("Clipboard permission was denied.");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    handoffAnswers();
    render(<RegisterAgentPage />);

    const sheet = within(
      await screen.findByRole("dialog", { name: "Connect an agent" }),
    );
    fireEvent.click(
      sheet.getByRole("button", { name: "Copy monitoring prompt" }),
    );

    expect((await sheet.findByRole("alert")).textContent).toBe(
      "Could not copy the monitoring prompt. Select the text and copy it manually.",
    );
    expect(
      sheet.getByRole("button", {
        name: "Try to copy monitoring prompt again",
      }),
    ).toBeDefined();
    expect(sheet.getByText(prompts.monitoring)).toBeDefined();
    expect(sent).toEqual([]);
  });

  it("refuses a viewer who opens the setup URL directly", async () => {
    routed.pathname = "/projects/prj_1/agents/new";
    handoffAnswers("viewer");
    render(<RegisterAgentPage />);

    const sheet = within(
      await screen.findByRole("dialog", { name: "Connect an agent" }),
    );
    expect(
      sheet.getByText(
        "Your viewer role cannot connect agents. Ask an organization admin to change your role, then try again.",
      ),
    ).toBeDefined();
    expect(
      sheet.queryByRole("button", { name: /^Copy .* prompt$/ }),
    ).toBeNull();
    expect(sent).toEqual([]);
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
