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
import AgentOnboardingPage from "../app/projects/[projectId]/agents/[agentId]/onboarding/page.tsx";
import RegisterAgentPage from "../app/projects/[projectId]/agents/new/page.tsx";
import AgentsPage from "../app/projects/[projectId]/agents/page.tsx";
import type { Me } from "../lib/me.ts";
import type { ListedTest } from "../lib/tests.ts";

/**
 * The Agents and Connections pages, rendered and driven.
 *
 * They are here in the fast lane rather than in the one real-browser journey
 * because none of what they prove needs a browser: a form drawn from what the
 * server said the connection types are, a control a viewer may not use being
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
    vi.fn(async (input: string, options?: RequestInit) => {
      const address = new URL(input, "http://egma.test");
      const path = address.pathname;
      const held = answers[path];
      if (held === undefined) throw new Error(`nothing stubbed for ${path}`);

      if (options?.method !== undefined && options.method !== "GET") {
        sent.push({
          url: `${path}${address.search}`,
          method: options.method,
          body: JSON.parse(String(options.body ?? "{}")) as Record<string, unknown>,
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
  project_id: "prj_1",
  name: "Front desk",
  description: "Answers the main line.",
  revision: "rev_one",
  archived: false,
  archived_at: null,
  created_at: "2026-08-15T10:00:00.000Z",
  updated_at: "2026-08-15T10:00:00.000Z",
};

const CONNECTION = {
  id: "con_1",
  agent_id: "agt_1",
  project_id: "prj_1",
  name: "staging",
  type: "retell",
  type_label: "Retell",
  variant_id: "retell.api_key",
  modality: "chat",
  topology: "hosted-broker",
  environment: "staging",
  config: { retellAgentId: "agent_abc" },
  credential_present: true,
  credentials_hint: "WXYZ",
  capabilities: {
    state: "unknown" as const,
    measured: null,
    supported: null,
    checked_at: null,
    source: null,
    standing: {
      dtmf: "not_measured" as const,
      barge_in: "not_measured" as const,
      raw_audio: "not_measured" as const,
    },
  },
  revision: "rev_con_one",
  archived: false,
  archived_at: null,
  created_at: "2026-08-15T10:00:00.000Z",
  updated_at: "2026-08-15T10:00:00.000Z",
};

/**
 * A second way into the same agent: another platform, another channel, and a
 * capability record somebody has actually measured. One connection of each kind
 * is what makes "the facts on a row" a claim a test can falsify.
 */
const MEASURED_CONNECTION = {
  ...CONNECTION,
  id: "con_2",
  // Named apart from its environment on purpose: a fixture where the two read
  // the same would let a cell showing the wrong one pass.
  name: "phone line",
  type: "phone",
  type_label: "Phone number",
  variant_id: "phone.number",
  modality: "voice",
  environment: "production",
  config: { phoneNumber: "+14155550100" },
  credential_present: false,
  credentials_hint: null,
  capabilities: {
    state: "known" as const,
    measured: ["dtmf"],
    supported: ["dtmf"],
    checked_at: "2026-08-18T09:00:00.000Z",
    source: "retell",
    standing: {
      dtmf: "supported" as const,
      barge_in: "unsupported" as const,
      raw_audio: "not_measured" as const,
    },
  },
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

function onboardingTest(
  overrides: Partial<ListedTest> = {},
): ListedTest {
  return {
    id: "tst_1",
    project_id: "prj_1",
    name: "Books an appointment",
    description: "The caller asks for a booking.",
    version: 2,
    version_id: "tstv_2",
    scenario: "Ask for an appointment.",
    expected_behaviors: ["The agent offers a time."],
    personas: [],
    required_capabilities: [],
    override_count: 0,
    agents: [{ id: "agt_9", name: "Existing agent", archived_at: null }],
    revision: "rev_test_1",
    applicability_revision: "rev_app_1",
    archived_at: null,
    archive_reason: null,
    created_at: "2026-08-15T10:00:00.000Z",
    updated_at: "2026-08-15T10:00:00.000Z",
    ...overrides,
  };
}

const TYPES = {
  items: [
    {
      type: "retell",
      label: "Retell",
      modalities: ["chat"],
      topology: "hosted-broker",
      simulator_adapter: true,
      capability_discovery: false,
      variants: [
        {
          id: "retell.api_key",
          label: "Retell agent",
          chosen_by: null,
          fields: [
            {
              key: "retellAgentId",
              label: "Retell agent ID",
              kind: "text",
              required: true,
              help: "The agent's own identifier in Retell.",
            },
          ],
          credential_rule: "required",
          credential_help: "Egma seals your key and never shows it again.",
          credential_fields: [
            {
              field: "apiKey",
              label: "Retell API key",
              kind: "secret",
              required: true,
              help: "Copied from your Retell dashboard.",
            },
          ],
        },
      ],
    },
    {
      type: "livekit",
      label: "LiveKit",
      modalities: ["voice"],
      topology: "egma-dials-out",
      simulator_adapter: true,
      capability_discovery: false,
      variants: [
        {
          id: "livekit.key_pair",
          label: "API key and secret",
          chosen_by: null,
          fields: [
            {
              key: "url",
              label: "LiveKit WebSocket URL",
              kind: "url",
              required: true,
              help: "Your LiveKit project or self-hosted server.",
              after_credentials: false,
            },
            {
              key: "agentName",
              label: "LiveKit agent name",
              kind: "text",
              required: false,
              help: "The LiveKit worker dispatch name. Leave it empty for automatic dispatch.",
              after_credentials: false,
            },
            {
              key: "metadata",
              label: "Room metadata",
              kind: "json",
              required: false,
              help: "JSON handed to the agent.",
              after_credentials: true,
            },
          ],
          credential_rule: "required",
          credential_help: "Used to create the room.",
          credential_fields: [
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
          id: "livekit.token_endpoint",
          label: "Token endpoint",
          chosen_by: "tokenEndpoint",
          fields: [
            {
              key: "url",
              label: "LiveKit WebSocket URL",
              kind: "url",
              required: true,
              help: "Your LiveKit project or self-hosted server.",
              after_credentials: false,
            },
            {
              key: "tokenEndpoint",
              label: "Token endpoint",
              kind: "url",
              required: true,
              help: "The service that creates room tokens.",
              after_credentials: false,
            },
          ],
          credential_rule: "optional",
          credential_help: "Optional auth headers for the endpoint.",
          credential_fields: [
            {
              field: "headers",
              label: "Auth headers",
              kind: "json",
              required: false,
              help: "Header names and secret values sent to the endpoint.",
            },
          ],
        },
      ],
    },
    {
      type: "phone",
      label: "Phone number",
      modalities: ["voice"],
      topology: "egma-dials-in",
      simulator_adapter: true,
      capability_discovery: false,
      variants: [
        {
          id: "phone.number",
          label: "Public phone number",
          chosen_by: null,
          fields: [
            {
              key: "phoneNumber",
              label: "Phone number",
              kind: "e164",
              required: true,
              help: "In international form, like +15551234567.",
            },
          ],
          credential_rule: "forbidden",
          credential_help: "A phone connection takes no credential.",
          credential_fields: [],
        },
      ],
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
      "/api/agents": {
        status: 200,
        body: { items: [LISTED_AGENT], next_cursor: null },
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
        .mock.calls.map(([url]) => String(url));
      // A filter applied to what came back would answer differently depending
      // on how far somebody had scrolled.
      expect(asked).toContain("/api/agents?search=front&project=prj_1");
    });
  });

  it("says a search matched nothing without calling the project empty", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/agents": [
        { status: 200, body: { items: [LISTED_AGENT], next_cursor: null } },
        { status: 200, body: { items: [], next_cursor: null } },
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
      "/api/agents": { status: 200, body: { items, next_cursor: null } },
    });
  }

  function asked(): readonly string[] {
    return vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url));
  }

  it("shows each connection's platform, channel, environment and capability state", async () => {
    listOf(LISTED_AGENT);
    render(<AgentsPage />);
    await screen.findAllByText("Front desk");

    // The staging one, which nobody has measured. "Not checked" and "measured
    // and found wanting" are different sentences and must not share one.
    expect(screen.getByText("staging")).toBeDefined();
    // The registry's word for the platform, not the token a client branches
    // on: the connection page says "Retell", and a row that said "retell"
    // would be a second vocabulary for one fact.
    expect(screen.getByText("Retell · Chat")).toBeDefined();
    expect(screen.getByText("Not checked")).toBeDefined();

    // The production one, which somebody has.
    expect(screen.getByText("production")).toBeDefined();
    expect(screen.getByText("Phone number · Voice")).toBeDefined();
    expect(screen.getByText("Checked")).toBeDefined();

    // With its time, kept exactly rather than only as an age that drifts.
    const when = document.querySelector("time");
    expect(when?.getAttribute("datetime")).toBe("2026-08-18T09:00:00.000Z");

    // And all of it out of the one read that painted the list. A page that
    // fetched per row would still look right here, which is why the requests
    // are what is asserted rather than the pixels.
    expect(asked().filter((one) => one.startsWith("/api/agents"))).toHaveLength(1);
    expect(asked().some((one) => one.includes("/api/agents/"))).toBe(false);
  });

  it("says plainly when egma has no way into an agent", async () => {
    listOf(UNREACHED_AGENT);
    render(<AgentsPage />);
    await screen.findAllByText("Night line");

    // In words, on the row. An agent egma cannot reach is found out here
    // rather than when a run refuses to start.
    expect(screen.getByText("No connections")).toBeDefined();
  });

  /**
   * **The row reads left to right: narrow first, then act.** It led with the
   * button until the developer put this page beside a competitor's dashboard,
   * where the action is always the last thing on the strip. The button never
   * changed size — it is the default and always was — but leading a row it
   * shared with a full-width search box made it look like it had.
   */
  it("ends the toolbar with Connect agent, and holds the search box to a width", async () => {
    listOf(LISTED_AGENT);
    render(<AgentsPage />);
    await screen.findAllByText("Front desk");

    const connect = await screen.findByRole("link", { name: "Connect agent" });
    expect(connect.getAttribute("href")).toBe("/projects/prj_1/agents/new");

    // Ends it: the search box is drawn before the action rather than after it.
    const search = screen.getByLabelText("Search agents by name");
    expect(search.compareDocumentPosition(connect) & 4).toBe(4);

    // And the box stops somewhere. It used to take the whole remaining row.
    expect(search.className).toContain("max-w-");
  });

  it("puts one Connect agent in the middle of a project with nothing in it", async () => {
    listOf();
    render(<AgentsPage />);

    expect(await screen.findByText("No agents in this project yet")).toBeDefined();
    // One, not two: the empty state is the whole screen, so the toolbar's copy
    // of this control would leave somebody choosing between identical buttons.
    expect(screen.getAllByRole("link", { name: "Connect agent" })).toHaveLength(1);
    // And nothing to search, so nothing offering to.
    expect(screen.queryByLabelText("Search agents by name")).toBeNull();
  });

  it("tells a viewer why the control is not theirs, where a keyboard can reach it", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/api/agents": {
        status: 200,
        body: { items: [LISTED_AGENT], next_cursor: null },
      },
    });
    render(<AgentsPage />);

    const refused = await screen.findByRole("button", { name: "Connect agent" });
    expect((refused as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: "Connect agent" })).toBeNull();

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

describe("registering an agent", () => {
  it("sends the name and description, and nothing about the provider", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents": { status: 201, body: { agent: AGENT } },
    });
    render(<RegisterAgentPage />);

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Front desk" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Answers the main line." },
    });
    const register = screen.getByRole("button", { name: "Register agent" });
    expectSharedFormLayout(register);
    fireEvent.click(register);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.method).toBe("POST");
    /*
     * **The project is in the address, which is the one spelling every write
     * in the product uses** — and what this assertion is really holding is
     * that the page names it *at all*.
     *
     * It named it in the query once before and that was right about the page
     * and wrong about the door: `POST /api/agents` read a body key only, so
     * the query was not refused, it was **ignored**. The door found no project,
     * fell back to the session's own — the organization's **first** — wrote the
     * agent there, and answered 201, sending the browser to a detail page for
     * an agent that is not in the project the address names. Only a real
     * browser standing in a second project could see that, and one did. The
     * door now reads the address as well as the body, so the fault is closed
     * where it was rather than in this caller alone, and this file no longer
     * has to know which half a door happens to read.
     */
    expect(sent[0]?.url).toBe("/api/agents?project=prj_1");
    expect(sent[0]?.body).toEqual({
      name: "Front desk",
      description: "Answers the main line.",
    });
    // No prompt, no model, no tools: this form does not have them, so it cannot
    // send them.
    for (const provider of ["prompt", "model", "tools"]) {
      expect(Object.keys(sent[0]?.body ?? {})).not.toContain(provider);
    }
    await waitFor(() =>
      expect(routed.push).toHaveBeenCalledWith(
        "/projects/prj_1/agents/agt_1/connections/new?onboarding=connection",
      ),
    );
  });

  it("refuses an empty name here rather than making somebody wait for egma", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents": { status: 201, body: { agent: AGENT } },
    });
    render(<RegisterAgentPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Register agent" }));

    expect(
      await screen.findByText(
        "An agent needs a name, so that a list can tell it apart.",
      ),
    ).toBeDefined();
    expect(sent).toHaveLength(0);
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps everything that was typed when egma refuses the save", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents": {
        status: 409,
        body: {
          error: "name_taken",
          message: 'an agent named "Front desk" already exists in this project',
        },
      },
    });
    render(<RegisterAgentPage />);

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Front desk" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Answers the main line." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register agent" }));

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
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("Answers the main line.");
  });

  it("tells a viewer the page is not theirs instead of pretending it worked", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/api/agents": { status: 201, body: { agent: AGENT } },
    });
    render(<RegisterAgentPage />);

    expect(
      await screen.findByText(
        "Your viewer role cannot register agents. Ask an organization admin to change your role, then try again.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Register agent" })).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */

describe("onboarding an agent", () => {
  it("reuses the connection form, then carries the new agent into test setup", async () => {
    routed.search = "?onboarding=connection";
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/api/connection-types": { status: 200, body: TYPES },
      "/api/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    const progress = await screen.findByRole("navigation", {
      name: "Agent setup",
    });
    expect(within(progress).getByText("Connection").getAttribute("aria-current"))
      .toBe("step");
    expect(screen.queryByText(/Step 2 of 3/u)).toBeNull();

    /*
     * The bar counts stages *finished*, so the second stage reads one of three
     * rather than two. A bar that filled a stage ahead of the work would be
     * claiming the page in front of somebody was already done.
     */
    const bar = within(progress).getByRole("progressbar", {
      name: "Agent setup progress",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("3");
    expect(bar.getAttribute("aria-valuetext")).toBe("1 of 3 stages finished");

    /*
     * What the eye is given, against what the screen reader is given.
     *
     * This is the assertion that guards the fix in `components/ui/progress.tsx`.
     * The registry's indicator computes `100 - value` and ignores `max`, so this
     * bar announced "1 of 3 stages finished" and was drawn 99% empty. The two
     * must be the same fact: one stage of three is a third filled, which is
     * two thirds still to travel.
     */
    const fill = bar.querySelector("[data-slot='progress-indicator']");
    expect(fill?.getAttribute("style")).toContain("translateX(-66.6");
    expect(fill?.getAttribute("style")).not.toContain("-99%");
    expect(
      screen.getByRole("link", { name: "Skip connection for now" })
        .getAttribute("href"),
    ).toBe("/projects/prj_1/agents/agt_1/onboarding");
    expect(
      screen.getByText(/Without a connection, Egma cannot run a simulation/u),
    ).toBeDefined();

    fireEvent.change(screen.getByLabelText("Platform"), {
      target: { value: "phone" },
    });
    fireEvent.change(await screen.findByLabelText("Phone number"), {
      target: { value: "+14155550100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));

    await waitFor(() =>
      expect(routed.push).toHaveBeenCalledWith(
        "/projects/prj_1/agents/agt_1/onboarding",
      ),
    );
  });

  /**
   * An agent with no connection, and the bar that has to tell the truth about
   * it without guessing how it got that way.
   *
   * Being behind the current stage is not the same as being finished. Somebody
   * reaches the tests page with two stages behind them and one of them not
   * done, and an agent with no connection cannot run a simulation at all — so a
   * bar reading "2 of 3 stages finished" would call the setup nearly complete
   * when the part that makes it work is missing.
   *
   * **The word is asserted as a state rather than an intention**, and that is
   * the point of this test rather than an incidental detail. This page reads
   * the active connections, so an empty list is both "Skip connection for now"
   * and "connected once, archived it later". A word like "Skipped" is right for
   * one of those people and wrong for the other, and nothing on this page can
   * tell which one is reading it.
   *
   * Both halves are checked, because `DESIGN.md` will not let a state rest on a
   * mark and a colour: the count, and the words beside the stage.
   */
  it("says an agent with no connection needs one, without calling it a skip", async () => {
    routed.pathname = "/projects/prj_1/agents/agt_1/onboarding";
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/api/tests": [
        { status: 200, body: { items: [onboardingTest()], next_cursor: null } },
      ],
    });
    render(<AgentOnboardingPage />);

    const progress = await screen.findByRole("navigation", {
      name: "Agent setup",
    });
    const bar = within(progress).getByRole("progressbar", {
      name: "Agent setup progress",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuetext")).toBe(
      "1 of 3 stages finished, Connection not finished",
    );

    const connection = within(progress).getByText("Connection");
    expect(connection.getAttribute("data-unfinished")).toBe("true");
    expect(connection.getAttribute("data-complete")).toBeNull();
    expect(within(progress).getByText("Needs a connection")).toBeTruthy();
    /*
     * The word this must never go back to. Both people who see this screen have
     * the same empty list, and only one of them pressed Skip.
     */
    expect(within(progress).queryByText(/skipped/iu)).toBeNull();
  });

  /** The same page with a connection in place, so the count moves. */
  it("counts a connection that is in place, and says nothing beside it", async () => {
    routed.pathname = "/projects/prj_1/agents/agt_1/onboarding";
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [CONNECTION] },
      },
      "/api/tests": [
        { status: 200, body: { items: [onboardingTest()], next_cursor: null } },
      ],
    });
    render(<AgentOnboardingPage />);

    const progress = await screen.findByRole("navigation", {
      name: "Agent setup",
    });
    const bar = within(progress).getByRole("progressbar", {
      name: "Agent setup progress",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuetext")).toBe("2 of 3 stages finished");

    const connection = within(progress).getByText("Connection");
    expect(connection.getAttribute("data-complete")).toBe("true");
    expect(connection.getAttribute("data-unfinished")).toBeNull();
    expect(within(progress).queryByText("Needs a connection")).toBeNull();
  });

  it("attaches selected existing tests through each test's applicability revision", async () => {
    routed.pathname = "/projects/prj_1/agents/agt_1/onboarding";
    const test = onboardingTest();
    const second = onboardingTest({
      id: "tst_2",
      name: "Handles a cancellation",
      applicability_revision: "rev_app_2",
    });
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [CONNECTION] },
      },
      "/api/tests": [
        { status: 200, body: { items: [test], next_cursor: "cursor_2" } },
        { status: 200, body: { items: [second], next_cursor: null } },
      ],
      "/api/tests/tst_1/agents": {
        status: 200,
        body: {
          ...test,
          agents: [...test.agents, { id: "agt_1", name: "Front desk" }],
          applicability_revision: "rev_app_2",
        },
      },
      "/api/tests/tst_2/agents": {
        status: 200,
        body: {
          ...second,
          agents: [...second.agents, { id: "agt_1", name: "Front desk" }],
          applicability_revision: "rev_app_3",
        },
      },
    });
    render(<AgentOnboardingPage />);

    const choice = await screen.findByRole("checkbox", {
      name: /Books an appointment/u,
    });
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const secondChoice = await screen.findByRole("checkbox", {
      name: /Handles a cancellation/u,
    });
    expect((choice as HTMLInputElement).checked).toBe(true);
    fireEvent.click(secondChoice);
    expect(screen.getByRole("button", { name: "Attach 2 tests and finish" }))
      .toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Attach 2 tests and finish" }),
    );

    await waitFor(() => {
      expect(sent.find((call) => call.url.startsWith("/api/tests/tst_1/agents")))
        .toBeDefined();
    });
    const call = sent.find((item) => item.url.startsWith("/api/tests/tst_1/agents"));
    expect(call?.body).toEqual({
      agents: ["agt_9", "agt_1"],
      expected_applicability_revision: "rev_app_1",
    });
    const secondCall = sent.find((item) =>
      item.url.startsWith("/api/tests/tst_2/agents"),
    );
    expect(secondCall?.body).toEqual({
      agents: ["agt_9", "agt_1"],
      expected_applicability_revision: "rev_app_2",
    });
    await waitFor(() =>
      expect(routed.push).toHaveBeenCalledWith(
        "/projects/prj_1/agents/agt_1",
      ),
    );
  });

  it("keeps a selected test pinned while the server searches another page", async () => {
    routed.pathname = "/projects/prj_1/agents/agt_1/onboarding";
    const test = onboardingTest();
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/api/tests": [
        { status: 200, body: { items: [test], next_cursor: null } },
        { status: 200, body: { items: [], next_cursor: null } },
      ],
    });
    render(<AgentOnboardingPage />);

    const choice = await screen.findByRole("checkbox", {
      name: /Books an appointment/u,
    });
    fireEvent.click(choice);
    fireEvent.change(screen.getByLabelText("Search tests by name"), {
      target: { value: "weekend" },
    });

    await waitFor(() => {
      const asked = vi
        .mocked(globalThis.fetch)
        .mock.calls.map(([url]) => String(url));
      expect(asked).toContain("/api/tests?name=weekend&project=prj_1");
    });
    expect(
      (screen.getByRole("checkbox", {
        name: /Books an appointment/u,
      }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Attach 1 test and finish" }))
      .toBeDefined();
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
      "/api/agents/agt_1": { status: 200, body: { agent, connections } },
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

    // Wearing the same facts the list row wears, said the same way.
    expect(screen.getAllByText("Not checked").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Checked").length).toBeGreaterThan(0);
    // The environment label, which is this connection's own and not its name:
    // the phone line is named apart from the environment it points at.
    expect(screen.getByText("production")).toBeDefined();
    // And the same words for the platform and the channel as the row shows.
    expect(screen.getByText("Phone number")).toBeDefined();
    expect(screen.getByText("Retell")).toBeDefined();
    expect(screen.getByText("Voice")).toBeDefined();
    expect(screen.getByText("Chat")).toBeDefined();

    // What left.
    expect(screen.queryByRole("navigation", { name: "Agent sections" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Recent runs" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Attached tests" })).toBeNull();
    const asked = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([url]) => String(url));
    expect(asked.some((one) => one.startsWith("/api/runs"))).toBe(false);
    expect(asked.some((one) => one.startsWith("/api/tests"))).toBe(false);

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
      "/api/agents/agt_1": { status: 200, body: { agent: AGENT, connections: [] } },
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

  it("sends the revision it was opened on, and keeps the edit when it is stale", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents/agt_1": [
        { status: 200, body: { agent: AGENT, connections: [] } },
        {
          status: 409,
          body: {
            error: "identity_conflict",
            message:
              "agent agt_1 changed after you opened it. Read it again, keep or reapply your edits, and send the update with expected_revision set to its new revision.",
          },
        },
      ],
    });
    render(<AgentDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Rewritten while somebody else was editing" },
    });
    const save = screen.getByRole("button", { name: "Save" });
    expectSharedFormLayout(save);
    fireEvent.click(save);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.method).toBe("PATCH");
    expect(sent[0]?.body.expected_revision).toBe("rev_one");

    // The conflict is shown in egma's own words and the work stays on screen:
    // reading again is one click, retyping is not.
    expect(
      await screen.findByText(
        "agent agt_1 changed after you opened it. Read it again, keep or reapply your edits, and send the update with expected_revision set to its new revision.",
      ),
    ).toBeDefined();
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("Rewritten while somebody else was editing");
  });

});

/* ------------------------------------------------------------------------ */

describe("adding a connection", () => {
  it("keeps the connection hierarchy present while the parent agent loads", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/api/connection-types": { status: 200, body: TYPES },
    });
    render(<NewConnectionPage />);

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Agents" })).toBeTruthy();
    expect(within(breadcrumb).getByRole("link", { name: "Agent" })).toBeTruthy();
    expect(within(breadcrumb).getByText("New connection")).toBeTruthy();
    expect(
      await within(breadcrumb).findByRole("link", { name: "Front desk" }),
    ).toBeTruthy();
    expect(
      screen.getByText("The label shown for this connection in Egma."),
    ).toBeTruthy();
  });

  it("confirms a Retell phone route before it stores the provider-blind connection", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/api/connection-types": { status: 200, body: TYPES },
      "/api/providers/retell/voice-agents": {
        status: 200,
        body: {
          agents: [
            {
              id: "agent_voice_1",
              name: "Appointment line",
              numbers: [
                { number: "+14155550100", label: "Main number" },
              ],
            },
          ],
        },
      },
      "/api/agents/agt_1/connections/retell-phone": {
        status: 201,
        body: {
          connection: {
            ...CONNECTION,
            type: "phone",
            modality: "voice",
            config: { phoneNumber: "+14155550100" },
          },
        },
      },
    });
    render(<NewConnectionPage />);

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
      (await screen.findByLabelText("Retell voice agent") as HTMLSelectElement)
        .value,
    ).toBe("agent_voice_1");
    expect((screen.getByLabelText("Phone number") as HTMLSelectElement).value)
      .toBe("+14155550100");
    expect(field.value).toBe("retell-secret-A1B2C3D4WXYZ");

    const add = screen.getByRole("button", { name: "Add connection" });
    expectSharedFormLayout(add);
    fireEvent.click(add);

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toMatchObject({
      url: "/api/providers/retell/voice-agents?project=prj_1",
      body: { api_key: "retell-secret-A1B2C3D4WXYZ" },
    });
    expect(sent[1]?.body).toEqual({
      api_key: "retell-secret-A1B2C3D4WXYZ",
      retell_agent_id: "agent_voice_1",
      phone_number: "+14155550100",
    });
    expect(sent[1]?.url).toBe(
      "/api/agents/agt_1/connections/retell-phone?project=prj_1",
    );
    await waitFor(() => expect(field.value).toBe(""));
    expect(routed.push).toHaveBeenCalledWith(
      "/projects/prj_1/agents/agt_1/connections/con_1",
    );
  });

  it("uses either honest LiveKit access method and defaults its channel to voice", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/api/connection-types": { status: 200, body: TYPES },
      "/api/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    fireEvent.change(await screen.findByLabelText("Platform"), {
      target: { value: "livekit" },
    });
    fireEvent.change(screen.getByLabelText("Access"), {
      target: { value: "livekit.token_endpoint" },
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
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      type: "livekit",
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
      "/api/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/api/connection-types": { status: 200, body: TYPES },
      "/api/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    fireEvent.change(await screen.findByLabelText("Platform"), {
      target: { value: "livekit" },
    });
    expect((screen.getByLabelText("Dispatch method") as HTMLSelectElement).value)
      .toBe("named");
    expect(
      (screen.getByRole("button", { name: "Add connection" }) as HTMLButtonElement)
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
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      type: "livekit",
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
      "/api/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/api/connection-types": { status: 200, body: TYPES },
      "/api/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    fireEvent.change(await screen.findByLabelText("Platform"), {
      target: { value: "livekit" },
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
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      type: "livekit",
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
      "/api/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/api/connection-types": [
        {
          status: 500,
          body: { error: "unreadable_answer", message: "Egma could not answer." },
        },
        { status: 200, body: TYPES },
      ],
      "/api/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    // A catalog that did not arrive is a form that cannot be drawn. Showing an
    // empty type list would read as egma supporting nothing.
    expect(
      await screen.findByText("Egma could not describe the connection types."),
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
      "/api/connection-types": { status: 200, body: TYPES },
      "/api/agents/agt_1": {
        status: 200,
        body: { agent: AGENT, connections: [] },
      },
      "/api/agents/agt_1/connections/con_1": { status: 200, body: { connection } },
      ...extra,
    });
  }

  it("keeps the connection hierarchy present while its reads load", () => {
    answersWith(CONNECTION);
    render(<ConnectionDetailPage />);

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Agents" })).toBeTruthy();
    expect(within(breadcrumb).getByRole("link", { name: "Agent" })).toBeTruthy();
    expect(within(breadcrumb).getByText("Connection")).toBeTruthy();
  });

  it("keeps provider secrets and lifecycle controls out of the page", async () => {
    answersWith(CONNECTION);
    render(<ConnectionDetailPage />);

    expect(await screen.findByText("Retell")).toBeDefined();
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Front desk" }))
      .toBeTruthy();
    expect(screen.queryByLabelText("Retell API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Rotate credential" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByText("Capabilities")).toBeNull();
  });

  it("keeps credential copy out of ordinary edits that take no credential", async () => {
    for (const connection of [
      {
        ...CONNECTION,
        type: "phone",
        variant_id: "phone.number",
        modality: "voice",
        config: { phoneNumber: "+14155550100" },
      },
      {
        ...CONNECTION,
        type: "livekit",
        variant_id: "livekit.token_endpoint",
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

    const targetTitle = await screen.findByRole("heading", {
      name: "Where it points",
    });
    const target = targetTitle.closest("section");
    if (target === null) throw new Error("Where it points should be a section");

    // Known keys use the product language from the connection catalog. A key
    // from a newer server is still visible by its raw name, so the page loses
    // no configuration while clients and servers roll forward separately.
    expect(within(target).getByText("Retell agent ID")).toBeDefined();
    expect(within(target).queryByText("retellAgentId")).toBeNull();
    expect(within(target).getByText("undocumentedKey")).toBeDefined();
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
      expected_revision: "rev_con_one",
    });
  });

  it("edits named and automatic LiveKit dispatch as two explicit modes", async () => {
    const named = {
      ...CONNECTION,
      type: "livekit",
      variant_id: "livekit.key_pair",
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
      expected_revision: "rev_con_one",
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
      expected_revision: "rev_con_one",
    });
  });

  it("says so when it could not describe the type, and offers a retry", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/connection-types": [
        {
          status: 500,
          body: { error: "unreadable_answer", message: "Egma could not answer." },
        },
        { status: 200, body: TYPES },
      ],
      "/api/agents/agt_1/connections/con_1": {
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
      "/api/connection-types": {
        status: 500,
        body: { error: "unreadable_answer", message: "Egma could not answer." },
      },
      "/api/agents/agt_1/connections/con_1": {
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
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends an expired session to sign-in rather than showing a broken page", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { replace, assign: vi.fn(), href: "" });
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/connection-types": { status: 401, body: {} },
      "/api/agents/agt_1/connections/con_1": {
        status: 200,
        body: { connection: CONNECTION },
      },
    });
    render(<ConnectionDetailPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
  });

});
