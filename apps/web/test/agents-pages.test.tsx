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

import AgentDetailPage from "../app/projects/[projectId]/agents/[agentId]/page.tsx";
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
  agentPlatform: null,
  platformAgentId: null,
  monitoringKeyPresent: false,
  monitoringApiKeyHint: null,
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
 * A second way into the same agent: another platform and another channel. One
 * connection of each kind makes "the facts on a row" a claim a test can falsify.
 */
const MEASURED_CONNECTION = {
  ...CONNECTION,
  id: "con_2",
  // Named apart from its environment on purpose: a fixture where the two read
  // the same would let a cell showing the wrong one pass.
  name: "phone line",
  agentPlatform: null,
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
  name: "livekit room",
  agentPlatform: "livekit_agents",
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
      agentPlatform: "livekit_agents",
      agentPlatformLabel: "LiveKit Agents",
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
          required: false,
          help: "The LiveKit worker dispatch name. Leave it empty for automatic dispatch.",
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
    {
      agentPlatform: "livekit_agents",
      agentPlatformLabel: "LiveKit Agents",
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

  it("names each connection as a link, with the platform and the day beside it", async () => {
    listOf(LISTED_AGENT);
    render(<AgentsPage />);
    await screen.findAllByText("Front desk");

    /*
     * **The row names the ways in and lets somebody open one.** It used to
     * print four facts per connection on stacked lines, which made a row with
     * three connections three times the height of its neighbour and gave
     * nobody anything to press. The four facts are still egma's; they are what
     * the panel behind each of these links opens onto.
     */
    const staging = screen.getByRole("link", { name: "staging" });
    expect(staging.getAttribute("href")).toBe(
      "/projects/prj_1/agents?sheet=connection&agent=agt_1&connection=con_1",
    );
    expect(
      screen.getByRole("link", { name: "phone line" }).getAttribute("href"),
    ).toBe(
      "/projects/prj_1/agents?sheet=connection&agent=agt_1&connection=con_2",
    );

    // The platform, read from the connections rather than from the agent: the
    // agent's own column is null until Start monitoring binds it, and this
    // agent has a live Retell connection.
    expect(screen.getByText("Retell")).toBeDefined();
    /*
     * And when it joined egma, as the boards write a date in a list column:
     * the absolute short date, not the ISO day this printed before ticket 09
     * gave every list one formatter (`asListInstant`).
     */
    expect(screen.getByText("Aug 15, 2026")).toBeDefined();

    expect(screen.queryByText("Not checked")).toBeNull();
    expect(screen.queryByText("Checked")).toBeNull();

    // And all of it out of the one read that painted the list. A page that
    // fetched per row would still look right here, which is why the requests
    // are what is asserted rather than the pixels.
    expect(asked().filter((one) => one.startsWith("/v1/agents"))).toHaveLength(1);
    expect(asked().some((one) => one.includes("/v1/agents/"))).toBe(false);
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
      // connection would say "LiveKit Agents" and stop there.
      connections: [LIVEKIT_CONNECTION, CONNECTION, MEASURED_CONNECTION],
    });
    render(<AgentsPage />);
    await screen.findAllByText("Front desk");

    // One cell, both platforms, in the vocabulary's order rather than the
    // order the connections were made in.
    expect(screen.getByText("Retell · LiveKit Agents")).toBeDefined();
    // And one platform on its own is nowhere on the row, which would read as
    // an agent on one of them.
    expect(screen.queryByText("Retell")).toBeNull();
    expect(screen.queryByText("LiveKit Agents")).toBeNull();
  });

  it("says plainly when egma has no way into an agent", async () => {
    listOf(UNREACHED_AGENT);
    render(<AgentsPage />);
    await screen.findAllByText("Night line");

    // In words, on the row. An agent egma cannot reach is found out here
    // rather than when a run refuses to start.
    expect(screen.getByText("No connections yet")).toBeDefined();
    // And nothing claims a platform for an agent nothing has named one for.
    expect(screen.getByText("—")).toBeDefined();
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
    // The address is kept: the panel it opens is drawn over this list either
    // way, and this is the path the CLI and the documentation already print.
    expect(connect.getAttribute("href")).toBe("/projects/prj_1/agents/new");

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
 * **One panel does both halves now.** Registering an agent and giving it a way
 * in used to be two pages, and an agent that never reached the second one sat
 * in the list with nothing behind it. The boards put the agent and its first
 * connection in one side sheet with one submit, so what these hold is that the
 * single write carries both.
 */
describe("registering an agent", () => {
  function sheetAnswers(
    onRegister: Stubbed,
    ...afterwards: readonly Stubbed[]
  ): void {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/connection-options": { status: 200, body: TYPES },
      // One path, two operations: the list read that paints the screen behind
      // the panel, then the registration, then whatever the screen reads next.
      "/v1/agents": [
        { status: 200, body: { agents: [], nextPageToken: null } },
        onRegister,
        ...afterwards,
      ],
    });
  }

  /** The one platform that needs no account discovery, so a test can finish. */
  async function chooseAPhoneNumber(number: string): Promise<void> {
    fireEvent.change(await screen.findByLabelText("Platform"), {
      target: { value: "unknown" },
    });
    fireEvent.change(await screen.findByLabelText("Phone number"), {
      target: { value: number },
    });
  }

  it("sends the name and the first way in, and nothing about the provider", async () => {
    sheetAnswers(
      { status: 201, body: { result: "created", agent: AGENT } },
      { status: 200, body: { agents: [LISTED_AGENT], nextPageToken: null } },
    );
    render(<RegisterAgentPage />);

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Front desk" },
    });
    // No description field: the column was dropped pre-launch (ADR-0015), and
    // a form that still collected one would be collecting what egma refuses.
    expect(screen.queryByLabelText("Description")).toBeNull();
    await chooseAPhoneNumber("+14155550100");

    const connect = screen.getByRole("button", { name: "Connect agent" });
    expectSheetLayout(connect);
    fireEvent.click(connect);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.method).toBe("POST");
    /*
     * **The project is in the address, which is the one spelling every write
     * in the product uses** — and what this assertion is really holding is
     * that the page names it *at all*.
     *
     * It named it in the query once before and that was right about the page
     * and wrong about the door: `POST /v1/agents` read a body key only, so
     * the query was not refused, it was **ignored**. The door found no project,
     * fell back to the session's own — the organization's **first** — wrote the
     * agent there, and answered 201, sending the browser to a detail page for
     * an agent that is not in the project the address names. Only a real
     * browser standing in a second project could see that, and one did. The
     * door now reads the address as well as the body, so the fault is closed
     * where it was rather than in this caller alone, and this file no longer
     * has to know which half a door happens to read.
     */
    expect(sent[0]?.url).toBe("/v1/agents?projectId=prj_1");
    /*
     * **The platform rides on the connection, and that is the contract's
     * doing.** `registerAgent` has no `agentPlatform` and refuses unknown keys,
     * so an agent's platform is not something this form can write; the
     * connection's is.
     */
    expect(sent[0]?.body).toEqual({
      name: "Front desk",
      connection: {
        agentPlatform: null,
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
        modality: "voice",
        config: { phoneNumber: "+14155550100" },
      },
    });
    // No prompt, no model, no tools: this form does not have them, so it cannot
    // send them.
    for (const provider of ["prompt", "model", "tools"]) {
      expect(Object.keys(sent[0]?.body ?? {})).not.toContain(provider);
    }
    // And the panel closes onto the agent it just made — the record with this
    // agent's identity, its production-calls switch and its connections on it,
    // rather than the list of everything with one new row somewhere in it.
    await waitFor(() =>
      expect(routed.replace).toHaveBeenCalledWith("/projects/prj_1/agents/agt_1"),
    );
  });

  it("refuses an empty name here rather than making somebody wait for egma", async () => {
    sheetAnswers({ status: 201, body: { result: "created", agent: AGENT } });
    render(<RegisterAgentPage />);

    await chooseAPhoneNumber("+14155550100");
    fireEvent.click(screen.getByRole("button", { name: "Connect agent" }));

    expect(
      await screen.findByText(
        "An agent needs a name, so that a list can tell it apart.",
      ),
    ).toBeDefined();
    expect(sent).toHaveLength(0);
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps everything that was typed when egma refuses the save", async () => {
    sheetAnswers({
      status: 409,
      body: {
        error: "name_taken",
        message: 'an agent named "Front desk" already exists in this project',
      },
    });
    render(<RegisterAgentPage />);

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Front desk" },
    });
    await chooseAPhoneNumber("+14155550100");
    fireEvent.click(screen.getByRole("button", { name: "Connect agent" }));

    // Egma's own sentence, unchanged — and the typing still on screen, so the
    // fix is an edit rather than typing it all again.
    expect(
      await screen.findByText(
        'an agent named "Front desk" already exists in this project',
      ),
    ).toBeDefined();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Front desk",
    );
    expect((screen.getByLabelText("Phone number") as HTMLInputElement).value).toBe(
      "+14155550100",
    );
  });

  it("tells a viewer the panel is not theirs instead of pretending it worked", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/v1/connection-options": { status: 200, body: TYPES },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
    });
    render(<RegisterAgentPage />);

    expect(
      await screen.findByText(
        "Your viewer role cannot connect agents. Ask an organization admin to change your role, then try again.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Connect agent" })).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */

describe("onboarding an agent", () => {
  /**
   * **The one address where a two-stage bar is true.** The panel is a single
   * submit everywhere else, so a progress bar over it would be claiming a
   * stage that never happened. Registering an agent forwards here, and here an
   * earlier stage genuinely is behind the reader.
   */
  it("finishes after the connection step and never attaches tests", async () => {
    routed.search = "?onboarding=connection";
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/v1/connection-options": { status: 200, body: TYPES },
      "/v1/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    const progress = await screen.findByRole("navigation", { name: "Agent setup" });
    const bar = within(progress).getByRole("progressbar", { name: "Agent setup progress" });
    expect(bar.getAttribute("aria-valuemax")).toBe("2");
    expect(bar.getAttribute("aria-valuetext")).toBe("1 of 2 stages finished");
    expect(within(progress).queryByText("Tests")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Finish without a connection" }),
    ).toBeDefined();

    fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "unknown" } });
    fireEvent.change(await screen.findByLabelText("Phone number"), {
      target: { value: "+14155550100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect agent" }));

    // The agent it just set up, not the list: this is the end of a flow that
    // began on that agent.
    await waitFor(() => {
      expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/agents/agt_1");
    });
    expect(sent.some((call) => call.url.startsWith("/v1/tests"))).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */

describe("one agent's page", () => {
  function answersWith(
    agent: Record<string, unknown>,
    connections: readonly unknown[],
    role = "member",
  ): void {
    // Deliberately no runs and no tests: this page reads neither any more, so
    // an answer standing by for one would quietly make a re-introduction work.
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/v1/agents/agt_1": { status: 200, body: { agent, connections } },
    });
  }

  /**
   * The page is the agent's identity and its connections, and nothing else.
   *
   * Runs and tests were here, each behind a section of its own, and each was a
   * second rendering of a fact another area owns. What proves they have gone is
   * not that the headings are absent — a tab nobody opened would satisfy that —
   * but that the page no longer *asks* for them.
   */
  it("holds identity and connections, and reads neither runs nor tests", async () => {
    answersWith(AGENT, [CONNECTION, MEASURED_CONNECTION], "viewer");
    render(<AgentDetailPage />);

    // Connections are the page, reached without opening anything.
    expect(await screen.findByRole("heading", { name: "Connections" })).toBeDefined();
    expect(screen.getByRole("link", { name: "staging" })).toBeDefined();
    expect(screen.getByRole("link", { name: "phone line" })).toBeDefined();

    // Capability status is not part of the connection surface.
    expect(screen.queryByText("Not checked")).toBeNull();
    expect(screen.queryByText("Checked")).toBeNull();
    // The environment label, which is this connection's own and not its name:
    // the phone line is named apart from the environment it points at.
    expect(screen.getByText("production")).toBeDefined();
    // And the same product labels and modalities as the row shows.
    expect(screen.getByText("Phone number")).toBeDefined();
    expect(screen.getByText("Retell chat")).toBeDefined();
    expect(screen.getByText("Voice")).toBeDefined();
    expect(screen.getByText("Chat")).toBeDefined();

    // What left.
    expect(screen.queryByRole("navigation", { name: "Agent sections" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Recent runs" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Attached tests" })).toBeNull();
    const asked = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([url]) => String(url));
    expect(asked.some((one) => one.startsWith("/v1/runs"))).toBe(false);
    expect(asked.some((one) => one.startsWith("/v1/tests"))).toBe(false);

    // Identity is still the page's own, and still edited from here. Present and
    // genuinely disabled: a viewer sees what egma can do here and is told
    // plainly that this part is not theirs. The server refuses their write
    // either way, which is where the boundary actually is.
    const edit = screen.getByRole("button", { name: "Edit" });
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        "Your viewer role cannot change agents. Ask an organization admin to change your role.",
      ),
    ).toBeDefined();

    // Starting work is an action rather than a second copy of a record, so it
    // stays.
    expect(screen.getByRole("link", { name: "Create a run" })).toBeDefined();
  });

  it("says egma cannot reach an agent that has no connection", async () => {
    answersWith(AGENT, [], "member");
    render(<AgentDetailPage />);

    expect(await screen.findByText("No connections")).toBeDefined();
    expect(
      screen.getByText(
        "Egma cannot reach this agent yet. Add a connection to give it a way in.",
      ),
    ).toBeDefined();
    expect(screen.getByRole("link", { name: "Add connection" })).toBeDefined();
  });

  it("claims nothing about a role while the session read is still in flight", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents/agt_1": { status: 200, body: { agent: AGENT, connections: [] } },
    });
    render(<AgentDetailPage />);

    // Before the session answers there is no control at all, because a disabled
    // one would have to say why and every sentence it could say would be a
    // claim about somebody egma has not identified yet.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Edit" })).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("saves the name with no revision, because edits are last-writer-wins", async () => {
    // The revision column was dropped pre-launch (ADR-0015), so there is
    // nothing for the save to be written against and no conflict to show. Two
    // browsers editing one agent is a silent overwrite now — accepted with
    // eyes open, and the exact failure the column existed to stop.
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents/agt_1": [
        { status: 200, body: { agent: AGENT, connections: [] } },
        { status: 200, body: { agent: AGENT, connections: [] } },
      ],
    });
    render(<AgentDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    // There is no description to edit either; the name is the whole of what
    // egma owns about an agent's identity.
    expect(screen.queryByLabelText("Description")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed front desk" },
    });
    const save = screen.getByRole("button", { name: "Save" });
    expectSharedFormLayout(save);
    fireEvent.click(save);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.method).toBe("PATCH");
    expect(sent[0]?.body).toEqual({ name: "Renamed front desk" });
    expect(sent[0]?.body).not.toHaveProperty("expectedRevision");
  });

});

/* ------------------------------------------------------------------------ */

/**
 * **The pull switch, on the agent that owns it.**
 *
 * There is no monitoring setup object anywhere in the product any more, so
 * what is worth holding here is which direction each half of the switch goes:
 * turning it *off* is a door this page opens by itself, and turning it *on*
 * needs the platform key — sealed randomly and never read back — so it is the
 * start-monitoring flow's job and this page only points at it.
 */
describe("an agent's production calls", () => {
  const PULLING = {
    ...AGENT,
    agentPlatform: "retell",
    platformAgentId: "agent_voice_1",
    monitoringKeyPresent: true,
    monitoringApiKeyHint: "QRST",
    pullProductionCalls: true,
  };

  it("points at the start-monitoring flow while the switch is off", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents/agt_1": { status: 200, body: { agent: AGENT, connections: [] } },
    });
    render(<AgentDetailPage />);

    await screen.findByRole("heading", { name: "Production calls" });
    expect(screen.getByText("Off")).toBeDefined();
    // Nothing binds it yet, and the page says so rather than showing a blank.
    expect(screen.getAllByText("Not bound")).toHaveLength(2);
    // The link carries the agent it came from, so the flow opens about this
    // agent instead of the account roster — which is what stops an unbound
    // agent being started a second time under a new roster entry.
    expect(
      screen.getByRole("link", { name: "Start monitoring" }).getAttribute("href"),
    ).toBe("/projects/prj_1/monitoring/start?agent=agt_1");
    expect(screen.queryByRole("button", { name: "Stop pulling" })).toBeNull();
  });

  /**
   * Push is observed, never declared: the agent's own process sends its spans
   * to the OTLP door with the project key, and there is no server-side off for
   * it. A switch here could never be turned on, and would read as a fault.
   */
  it("offers no switch at all for an agent that pushes its own spans", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents/agt_1": {
        status: 200,
        body: {
          agent: { ...AGENT, agentPlatform: "livekit_agents" },
          connections: [],
        },
      },
    });
    render(<AgentDetailPage />);

    await screen.findByRole("heading", { name: "Production calls" });
    expect(screen.getByText("LiveKit Agents")).toBeDefined();
    expect(screen.queryByText("Off")).toBeNull();
    expect(screen.queryByText("Pull production calls")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop pulling" })).toBeNull();
    // And a LiveKit agent carries itself too, so the flow shows its own SDK
    // steps rather than opening on the Retell key form.
    expect(
      screen.getByRole("link", { name: "Read the setup steps" }).getAttribute("href"),
    ).toBe("/projects/prj_1/monitoring/start?agent=agt_1");
  });

  it("shows the binding and the key hint, and never the key", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents/agt_1": { status: 200, body: { agent: PULLING, connections: [] } },
    });
    render(<AgentDetailPage />);

    await screen.findByRole("heading", { name: "Production calls" });
    expect(screen.getByText("On")).toBeDefined();
    expect(screen.getByText("Retell")).toBeDefined();
    expect(screen.getByText("agent_voice_1")).toBeDefined();
    expect(screen.getByText("…QRST")).toBeDefined();
  });

  /**
   * **Whether it pulls, and when it last received.** Those are the two facts an
   * agent states about monitoring, and the second one had nowhere to be read
   * until now. It is a bare fact: no condition word stands beside it, because
   * a quiet agent is a quiet agent and not a fault.
   */
  it("says when a production call last arrived", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents/agt_1": {
        status: 200,
        body: {
          agent: { ...PULLING, lastReceivedAt: "2026-08-15T09:30:00.000Z" },
          connections: [],
        },
      },
    });
    render(<AgentDetailPage />);

    await screen.findByRole("heading", { name: "Production calls" });
    expect(screen.getByText("Last received")).toBeDefined();
    expect(
      screen
        .getByText("Last received")
        .closest("div")
        ?.querySelector("time")
        ?.getAttribute("datetime"),
    ).toBe("2026-08-15T09:30:00.000Z");
    // And no health word anywhere near it.
    expect(screen.queryByText(/degraded/i)).toBeNull();
  });

  it("says nothing has arrived yet rather than leaving the fact blank", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents/agt_1": { status: 200, body: { agent: PULLING, connections: [] } },
    });
    render(<AgentDetailPage />);

    await screen.findByRole("heading", { name: "Production calls" });
    expect(screen.getByText("Nothing yet")).toBeDefined();
  });

  it("stops pulling through the agent's own door, after naming the agent", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents/agt_1": { status: 200, body: { agent: PULLING, connections: [] } },
      "/v1/monitoring/agents/agt_1/stop": {
        status: 200,
        body: {
          monitoring: {
            agentId: "agt_1",
            pullProductionCalls: false,
            agentPlatform: "retell",
            platformAgentId: "agent_voice_1",
            monitoringApiKeyHint: "QRST",
            lastReceivedAt: null,
          },
        },
      },
    });
    render(<AgentDetailPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Stop pulling" }),
    );

    // The dialog names the agent, says what survives — the transcripts, the
    // binding and the key — and says the one thing that does not: starting
    // again is a new observation, never a backfill of the quiet period.
    expect(
      await screen.findByText(/Egma stops asking Retell for “Front desk”/),
    ).toBeDefined();
    expect(screen.getByText(/stays stored/)).toBeDefined();
    expect(
      screen.getByText(
        /does not go back for the calls that happen while the switch is off/,
      ),
    ).toBeDefined();

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Stop pulling",
      }),
    );

    await waitFor(() =>
      expect(
        sent.some(
          (one) => one.url === "/v1/monitoring/agents/agt_1/stop?projectId=prj_1",
        ),
      ).toBe(true),
    );
  });
});

describe("adding a connection", () => {
  it("opens on the agent it was asked for, over the list it came from", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/v1/connection-options": { status: 200, body: TYPES },
    });
    render(<NewConnectionPage />);

    // The panel names what it is for, and the picker is already on the agent
    // the address named rather than on "Create a new agent".
    expect(
      await screen.findByRole("heading", { name: "Connect an agent" }),
    ).toBeTruthy();
    const picker = (await screen.findByLabelText("Agent")) as HTMLSelectElement;
    expect(picker.value).toBe("agt_1");
    expect(picker.selectedOptions[0]?.textContent).toBe("Front desk");
    // Making a new agent is still one of its options, on every way in.
    expect(within(picker).getByText("Create a new agent")).toBeTruthy();
    expect(
      screen.getByText("The label shown for this connection in Egma."),
    ).toBeTruthy();
  });

  it("confirms a Retell phone route before it stores the provider-blind connection", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/v1/connection-options": { status: 200, body: TYPES },
      "/v1/agents:discover": {
        status: 200,
        body: {
          agents: [
            {
              platformAgentId: "agent_voice_1",
              name: "Appointment line",
              connectionCandidates: [
                {
                  agentPlatform: "retell",
                  connectionType: "retell_chat_api",
                  accessVariant: "retell_chat_api.api_key",
                  modality: "chat",
                  productLabel: "Retell chat",
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
        },
      },
      "/v1/agents/agt_1/connections": {
        status: 201,
        body: {
          connection: {
            ...CONNECTION,
            agentPlatform: "retell",
            connectionType: "phone_number",
            accessVariant: "phone_number.public_e164",
            productLabel: "Retell phone",
            modality: "voice",
            config: { phoneNumber: "+14155550100" },
          },
        },
      },
    });
    render(<NewConnectionPage />);

    /*
     * **Modality is the control on Retell, and it chooses the connection.**
     * Retell has a chat option and a voice option and nothing else, so the
     * board's segmented control is the access choice rather than a second one
     * beside it. An Access select here would have offered the same two shapes
     * a second way.
     */
    fireEvent.click(await screen.findByRole("radio", { name: "Voice" }));
    expect(screen.queryByLabelText("Access")).toBeNull();
    const field = (await screen.findByLabelText(
      "Retell API key",
    )) as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("off");
    fireEvent.change(field, {
      target: { value: "retell-secret-A1B2C3D4WXYZ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load Retell agents" }));

    expect(
      (await screen.findByLabelText("Retell agent") as HTMLSelectElement)
        .value,
    ).toBe("agent_voice_1");
    expect(
      (screen.getByLabelText("Connection") as HTMLSelectElement)
        .selectedOptions[0]?.textContent,
    ).toBe("Retell phone · +14155550100");
    expect(field.value).toBe("retell-secret-A1B2C3D4WXYZ");

    const add = screen.getByRole("button", { name: "Connect agent" });
    expectSheetLayout(add);
    fireEvent.click(add);

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toMatchObject({
      url: "/v1/agents:discover?projectId=prj_1",
      body: {
        agentPlatform: "retell",
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    expect(sent[1]?.body).toEqual({
      agentPlatform: "retell",
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
      config: { phoneNumber: "+14155550100" },
      agentPlatformSelection: {
        platformAgentId: "agent_voice_1",
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    expect(sent[1]?.body).not.toHaveProperty("credentials");
    expect(sent[1]?.url).toBe(
      "/v1/agents/agt_1/connections?projectId=prj_1",
    );
    await waitFor(() => expect(field.value).toBe(""));
    // The panel closes onto the list, where the new connection is now a link
    // on its agent's row.
    expect(routed.replace).toHaveBeenCalledWith("/projects/prj_1/agents");
  });

  it("uses either honest LiveKit access method and defaults its channel to voice", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/v1/connection-options": { status: 200, body: TYPES },
      "/v1/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    fireEvent.change(await screen.findByLabelText("Platform"), {
      target: { value: "livekit_agents" },
    });
    fireEvent.change(screen.getByLabelText("Access"), {
      target: { value: "livekit_room.customer_token_endpoint" },
    });
    expect(screen.queryByText(/shape/i)).toBeNull();
    expect(screen.queryByText(/credential/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("LiveKit WebSocket URL"), {
      target: { value: "wss://rooms.example.test" },
    });
    fireEvent.change(screen.getByLabelText("Token endpoint"), {
      target: { value: "https://tokens.example.test/livekit" },
    });
    fireEvent.change(screen.getByLabelText("Auth headers"), {
      target: { value: '{"Authorization":"Bearer endpoint-secret"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect agent" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      agentPlatform: "livekit_agents",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.customer_token_endpoint",
      modality: "voice",
      config: {
        url: "wss://rooms.example.test",
        tokenEndpoint: "https://tokens.example.test/livekit",
      },
      credentials: {
        headers: '{"Authorization":"Bearer endpoint-secret"}',
      },
    });

    cleanup();
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/v1/connection-options": { status: 200, body: TYPES },
      "/v1/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    fireEvent.change(await screen.findByLabelText("Platform"), {
      target: { value: "livekit_agents" },
    });
    expect((screen.getByLabelText("Dispatch method") as HTMLSelectElement).value)
      .toBe("named");
    expect(
      (screen.getByRole("button", { name: "Connect agent" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("LiveKit WebSocket URL"), {
      target: { value: "wss://rooms.example.test" },
    });
    fireEvent.change(screen.getByLabelText("LiveKit agent name"), {
      target: { value: "front-desk" },
    });
    expect(
      screen.getByText(
        "Enter the exact agent name registered by the deployed LiveKit worker. A different name prevents the agent from joining the room.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("LiveKit agent name (optional)")).toBeNull();
    const metadata = screen.getByLabelText("Room metadata (optional)");
    fireEvent.change(metadata, {
      target: { value: '{"tenant":"acme"}' },
    });
    fireEvent.change(screen.getByLabelText("LiveKit API key"), {
      target: { value: "livekit-key" },
    });
    const apiSecret = screen.getByLabelText("LiveKit API secret");
    fireEvent.change(apiSecret, {
      target: { value: "livekit-secret" },
    });
    expect(
      apiSecret.compareDocumentPosition(metadata) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Connect agent" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      agentPlatform: "livekit_agents",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "voice",
      config: {
        url: "wss://rooms.example.test",
        agentName: "front-desk",
        metadata: '{"tenant":"acme"}',
      },
      credentials: {
        apiKey: "livekit-key",
        apiSecret: "livekit-secret",
      },
    });
  });

  it("makes automatic LiveKit dispatch an explicit choice that stores no agent name", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/v1/connection-options": { status: 200, body: TYPES },
      "/v1/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    fireEvent.change(await screen.findByLabelText("Platform"), {
      target: { value: "livekit_agents" },
    });
    fireEvent.change(screen.getByLabelText("LiveKit agent name"), {
      target: { value: "must-not-be-sent" },
    });
    fireEvent.change(screen.getByLabelText("Dispatch method"), {
      target: { value: "automatic" },
    });
    expect(screen.queryByLabelText("LiveKit agent name")).toBeNull();
    expect(
      screen.getByText(
        "LiveKit sends the room to any available agent that accepts automatic dispatch. Egma stores no agent name.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("LiveKit WebSocket URL"), {
      target: { value: "wss://rooms.example.test" },
    });
    fireEvent.change(screen.getByLabelText("LiveKit API key"), {
      target: { value: "livekit-key" },
    });
    fireEvent.change(screen.getByLabelText("LiveKit API secret"), {
      target: { value: "livekit-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect agent" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      agentPlatform: "livekit_agents",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "voice",
      config: { url: "wss://rooms.example.test" },
      credentials: {
        apiKey: "livekit-key",
        apiSecret: "livekit-secret",
      },
    });
  });

  it("says so and offers a retry when egma could not describe the types", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": { status: 200, body: { agents: [], nextPageToken: null } },
      "/v1/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/v1/connection-options": [
        {
          status: 500,
          body: { error: "unreadable_answer", message: "Egma could not answer." },
        },
        { status: 200, body: TYPES },
      ],
      "/v1/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    // A catalog that did not arrive is a form that cannot be drawn. Showing an
    // empty type list would read as egma supporting nothing.
    expect(
      await screen.findByText("Egma could not describe the connection options."),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Retell API key")).toBeDefined();
  });
});

/* ------------------------------------------------------------------------ */

describe("one connection's page", () => {
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
    // And under the title, the two words the row and this panel share.
    expect(screen.getByText("Retell chat · Chat")).toBeTruthy();
  });

  it("keeps provider secrets out of the panel and names what Archive stops", async () => {
    answersWith(CONNECTION);
    render(<ConnectionDetailPage />);

    expect(await screen.findByText("Retell")).toBeDefined();
    expect(screen.queryByLabelText("Retell API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Rotate credential" })).toBeNull();
    expect(screen.queryByText("Capabilities")).toBeNull();

    /*
     * **The destructive action says Archive, because that is the write.** The
     * contract has no delete for a connection — `archiveConnection` is the
     * whole of it — so a control labelled Delete would be telling somebody
     * their data is gone when the API kept it. And `DESIGN.md` asks a
     * destructive dialog to name the thing it is about to act on.
     */
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(
      await screen.findByText(
        "Egma stops using “staging” to reach this agent, and every run waiting on it stops. Transcripts already stored stay stored.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/delete/i)).toBeNull();
  });

  it("keeps credential copy out of ordinary edits that take no credential", async () => {
    for (const connection of [
      {
        ...CONNECTION,
        agentPlatform: null,
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
        productLabel: "Phone number",
        modality: "voice",
        config: { phoneNumber: "+14155550100" },
      },
      {
        ...CONNECTION,
        agentPlatform: "livekit_agents",
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

      fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Primary Retell connection" },
    });
    fireEvent.change(screen.getByLabelText("Retell agent ID"), {
      target: { value: "agent_moved" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      name: "Primary Retell connection",
      config: { retellAgentId: "agent_moved" },
    });
  });

  it("edits named and automatic LiveKit dispatch as two explicit modes", async () => {
    const named = {
      ...CONNECTION,
      agentPlatform: "livekit_agents",
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

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Dispatch method") as HTMLSelectElement).value)
      .toBe("named");
    expect((screen.getByLabelText("LiveKit agent name") as HTMLInputElement).value)
      .toBe("front-desk");
    fireEvent.change(screen.getByLabelText("Dispatch method"), {
      target: { value: "automatic" },
    });
    expect(screen.queryByLabelText("LiveKit agent name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      name: "staging",
      config: { url: "wss://example.livekit.cloud" },
    });

    cleanup();
    const automatic = {
      ...named,
      config: { url: "wss://example.livekit.cloud" },
    };
    answersWith(automatic);
    render(<ConnectionDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Dispatch method") as HTMLSelectElement).value)
      .toBe("automatic");
    expect(screen.queryByLabelText("LiveKit agent name")).toBeNull();
    fireEvent.change(screen.getByLabelText("Dispatch method"), {
      target: { value: "named" },
    });
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toContain("exact LiveKit agent name");
    fireEvent.change(screen.getByLabelText("Dispatch method"), {
      target: { value: "automatic" },
    });
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Dispatch method"), {
      target: { value: "named" },
    });
    fireEvent.change(screen.getByLabelText("LiveKit agent name"), {
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
      expect(
        (screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
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

    const edit = (await screen.findByRole("button", {
      name: "Edit",
    })) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.getAttribute("title")).toContain("could not describe");

    fireEvent.click(edit);
    // No editor opened: the panel is still the read view, whose Name is a line
    // of text rather than a labelled box.
    expect(screen.queryByLabelText("Name")).toBeNull();
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
