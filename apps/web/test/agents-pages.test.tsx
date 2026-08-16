// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentDetailPage from "../app/projects/[projectId]/agents/[agentId]/page.tsx";
import ConnectionDetailPage from "../app/projects/[projectId]/agents/[agentId]/connections/[connectionId]/page.tsx";
import NewConnectionPage from "../app/projects/[projectId]/agents/[agentId]/connections/new/page.tsx";
import RegisterAgentPage from "../app/projects/[projectId]/agents/new/page.tsx";
import AgentsPage from "../app/projects/[projectId]/agents/page.tsx";
import type { Me } from "../lib/me.ts";

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
  params: {
    projectId: "prj_1",
    agentId: "agt_1",
    connectionId: "con_1",
  } as Record<string, string>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: routed.push, replace: routed.replace, back: vi.fn() }),
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

const TYPES = {
  items: [
    {
      type: "retell",
      label: "Retell",
      modalities: ["chat", "voice"],
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

const CAPABILITIES = {
  items: [
    { key: "dtmf", label: "DTMF entry", description: "The caller can press digits." },
    { key: "barge_in", label: "Barge-in", description: "The caller can interrupt." },
    { key: "raw_audio", label: "Raw audio", description: "The audio is available." },
  ],
};

beforeEach(() => {
  routed.push.mockReset();
  routed.replace.mockReset();
  routed.pathname = "/projects/prj_1/agents";
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

/** The agent editors use the same layout primitive as every other product form. */
function expectSharedFormLayout(action: HTMLElement): void {
  const form = action.closest("form");
  expect(form).not.toBeNull();
  expect(form?.className).toContain("form");
  expect(action.parentElement?.className).toContain("formActions");
}

/* ------------------------------------------------------------------------ */

describe("finding an agent in a long list", () => {
  it("asks egma for the match rather than filtering the page in hand", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/agents": { status: 200, body: { items: [AGENT], next_cursor: null } },
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

  it("asks for the archived half when the filter is moved to it", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/agents": { status: 200, body: { items: [AGENT], next_cursor: null } },
    });
    render(<AgentsPage />);
    await screen.findAllByText("Front desk");

    fireEvent.click(screen.getByRole("radio", { name: "Archived" }));

    await waitFor(() => {
      const asked = vi
        .mocked(globalThis.fetch)
        .mock.calls.map(([url]) => String(url));
      expect(asked).toContain("/api/agents?archived=true&project=prj_1");
    });
  });

  it("says a search matched nothing without calling the project empty", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/agents": [
        { status: 200, body: { items: [AGENT], next_cursor: null } },
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
      await screen.findByText("No active agents match “zzz”"),
    ).toBeDefined();
    expect(screen.queryByText("No agents in this project yet")).toBeNull();
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

describe("one agent's page", () => {
  function answersWith(
    agent: Record<string, unknown>,
    connections: readonly unknown[],
    role = "member",
  ): void {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/api/agents/agt_1": { status: 200, body: { agent, connections } },
    });
  }

  it("offers a member the controls, and a viewer the same ones disabled", async () => {
    answersWith(AGENT, [CONNECTION], "viewer");
    render(<AgentDetailPage />);

    const edit = await screen.findByRole("button", { name: "Edit" });
    // Present and genuinely disabled: a viewer sees what egma can do here and
    // is told plainly that this part is not theirs. The server refuses their
    // write either way, which is where the boundary actually is.
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Archive" }) as HTMLButtonElement)
      .disabled).toBe(true);
    expect(
      screen.getByText(
        "Your viewer role cannot change agents. Ask an organization admin to change your role.",
      ),
    ).toBeDefined();
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

  it("says what archiving will stop before it happens", async () => {
    answersWith(AGENT, [CONNECTION]);
    render(<AgentDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("archives every active connection");
    expect(dialog.textContent).toContain("Queued simulations");
  });

  it("opens an archived agent, and offers Restore instead of Archive", async () => {
    answersWith({ ...AGENT, archived: true, archived_at: "2026-08-15T11:00:00.000Z" }, []);
    render(<AgentDetailPage />);

    expect(await screen.findByText("This agent is archived")).toBeDefined();
    expect(screen.getByRole("button", { name: "Restore" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    // Editing an archived agent is not offered: it is out of new work, and the
    // move is to restore it first.
    expect(
      (screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("says a connection has been measured, or that nobody has looked", async () => {
    answersWith(AGENT, [
      CONNECTION,
      {
        ...CONNECTION,
        id: "con_2",
        name: "production",
        capabilities: {
          state: "known",
          measured: ["dtmf"],
          supported: ["dtmf"],
          checked_at: "2026-08-15T09:00:00.000Z",
          source: "retell adapter",
          standing: {
            dtmf: "supported",
            barge_in: "not_measured",
            raw_audio: "not_measured",
          },
        },
      },
    ]);
    render(<AgentDetailPage />);

    // Unknown is never drawn as "none": a target nobody has measured and one
    // measured and found bare lead somewhere different.
    expect(await screen.findAllByText("Unknown")).not.toHaveLength(0);
    expect(screen.getAllByText("1 supported")).not.toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */

describe("adding a connection", () => {
  it("draws the fields the server said the shape holds, and nothing it invented", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/connection-types": { status: 200, body: TYPES },
      "/api/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    // Retell's own key, and its credential field, both described by the server.
    expect(await screen.findByLabelText("Retell agent ID")).toBeDefined();
    expect(screen.getByLabelText("Retell API key")).toBeDefined();
    expect(
      screen.getByText("The agent's own identifier in Retell."),
    ).toBeDefined();
    // Nothing belonging to the other type is on this form.
    expect(screen.queryByLabelText("Phone number")).toBeNull();
  });

  it("redraws the form when the type changes, and drops what belonged to the old one", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/connection-types": { status: 200, body: TYPES },
      "/api/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    fireEvent.change(await screen.findByLabelText("Type"), {
      target: { value: "phone" },
    });

    expect(await screen.findByLabelText("Phone number")).toBeDefined();
    expect(screen.queryByLabelText("Retell agent ID")).toBeNull();
    // A phone connection takes no credential, so there is no box for one and
    // the form says why rather than leaving a gap.
    expect(screen.queryByLabelText("Retell API key")).toBeNull();
    expect(
      screen.getByText("A phone connection takes no credential."),
    ).toBeDefined();
  });

  it("sends only what was filled in, so an optional key left empty stays absent", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/connection-types": { status: 200, body: TYPES },
      "/api/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    fireEvent.change(await screen.findByLabelText("Retell agent ID"), {
      target: { value: "agent_abc" },
    });
    fireEvent.change(screen.getByLabelText("Retell API key"), {
      target: { value: "retell-secret-A1B2C3D4WXYZ" },
    });
    const add = screen.getByRole("button", { name: "Add connection" });
    expectSharedFormLayout(add);
    fireEvent.click(add);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      type: "retell",
      modality: "chat",
      config: { retellAgentId: "agent_abc" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    });
    // The name and the environment were left empty, so they are absent rather
    // than sent blank — absent means "egma names it" and blank means "no name".
    expect(Object.keys(sent[0]?.body ?? {})).not.toContain("name");
    expect(Object.keys(sent[0]?.body ?? {})).not.toContain("environment");
  });

  it("draws the credential as a field a shoulder cannot read", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/connection-types": { status: 200, body: TYPES },
      "/api/agents/agt_1/connections": {
        status: 201,
        body: { connection: CONNECTION },
      },
    });
    render(<NewConnectionPage />);

    const field = (await screen.findByLabelText("Retell API key")) as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("new-password");
  });

  it("says so and offers a retry when egma could not describe the types", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
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
    expect(await screen.findByLabelText("Retell agent ID")).toBeDefined();
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
      "/api/capabilities": { status: 200, body: CAPABILITIES },
      "/api/agents/agt_1/connections/con_1": { status: 200, body: { connection } },
      ...extra,
    });
  }

  it("shows that a credential is stored and never anything that could be one", async () => {
    answersWith(CONNECTION);
    render(<ConnectionDetailPage />);

    expect(await screen.findByText("Present")).toBeDefined();
    expect(screen.getByText("WXYZ")).toBeDefined();
    // Nowhere on this page is there a control that could show a stored secret.
    expect(screen.queryByLabelText("Retell API key")).toBeNull();
  });

  it("replaces a credential whole, and asks for every field of the new one", async () => {
    answersWith(CONNECTION);
    render(<ConnectionDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Rotate credential" }));
    fireEvent.change(screen.getByLabelText("Retell API key"), {
      target: { value: "retell-secret-Z9Y8X7W6MNOP" },
    });
    const replace = screen.getByRole("button", { name: "Replace credential" });
    expectSharedFormLayout(replace);
    fireEvent.click(replace);

    await waitFor(() => expect(sent).toHaveLength(1));
    // No merge and no "leave this as it was": both would mean reading the
    // stored secret back out.
    expect(sent[0]?.body).toEqual({
      credentials: { apiKey: "retell-secret-Z9Y8X7W6MNOP" },
      expected_revision: "rev_con_one",
    });
  });

  it("says unknown capabilities are unknown, not unsupported", async () => {
    answersWith(CONNECTION);
    render(<ConnectionDetailPage />);

    expect(
      await screen.findByText("Nobody has measured this target"),
    ).toBeDefined();
    // And Refresh is inert for a type egma ships no adapter for, saying why
    // rather than failing when it is pressed.
    const refresh = screen.getByRole("button", { name: "Refresh capabilities" });
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
    expect(refresh.getAttribute("title")).toContain("no capability adapter");
  });

  it("names what was measured, and when, and by what", async () => {
    answersWith({
      ...CONNECTION,
      capabilities: {
        state: "known",
        measured: ["dtmf"],
        supported: ["dtmf"],
        checked_at: "2026-08-15T09:00:00.000Z",
        source: "retell adapter",
        standing: {
          dtmf: "supported",
          barge_in: "not_measured",
          raw_audio: "not_measured",
        },
      },
    });
    render(<ConnectionDetailPage />);

    // The catalog's label rather than the raw key, so a person reads what the
    // capability is rather than what it is called in the schema.
    expect(await screen.findByText("DTMF entry")).toBeDefined();
    expect(screen.getAllByText("2026-08-15").length).toBeGreaterThan(0);
    expect(screen.getByText("retell adapter")).toBeDefined();
  });

  it("draws a capability nobody measured apart from one the target lacks", async () => {
    answersWith({
      ...CONNECTION,
      capabilities: {
        state: "known",
        measured: ["raw_audio", "dtmf"],
        supported: ["raw_audio"],
        checked_at: "2026-08-15T09:00:00.000Z",
        source: "retell adapter",
        standing: {
          raw_audio: "supported",
          dtmf: "unsupported",
          barge_in: "not_measured",
        },
      },
    });
    render(<ConnectionDetailPage />);

    // Three groups, and the third is the one a single list could not draw: the
    // page must never put a capability nobody checked beside one that was
    // checked and found missing.
    await screen.findByText("Not measured");

    const groupOf = (name: string) =>
      screen.getByText(name).parentElement?.textContent ?? "";

    expect(groupOf("Supported")).toContain("Raw audio");
    expect(groupOf("Not supported")).toContain("DTMF entry");
    expect(groupOf("Not measured")).toContain("Barge-in");

    // And it says why the third group exists, in the target's favour.
    expect(
      screen.getByText(/does not know either way/),
    ).toBeDefined();
  });

  it("warns that changing where a connection points forgets its measurements", async () => {
    answersWith({
      ...CONNECTION,
      capabilities: {
        state: "known",
        measured: ["dtmf"],
        supported: ["dtmf"],
        checked_at: "2026-08-15T09:00:00.000Z",
        source: "retell adapter",
        standing: {
          dtmf: "supported",
          barge_in: "not_measured",
          raw_audio: "not_measured",
        },
      },
    });
    render(<ConnectionDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expectSharedFormLayout(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByLabelText("Retell agent ID"), {
      target: { value: "agent_moved" },
    });

    expect(
      await screen.findByText(
        /Changing where this connection points makes its capabilities unknown/,
      ),
    ).toBeDefined();
  });

  it("asks a Restore for a new credential when the shape requires one", async () => {
    answersWith({ ...CONNECTION, archived: true, credential_present: false }, "member", {
      "/api/agents/agt_1/connections/con_1/restore": {
        status: 200,
        body: { connection: { ...CONNECTION, credentials_hint: "ABCD" } },
      },
    });
    render(<ConnectionDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    fireEvent.change(screen.getByLabelText("Retell API key"), {
      target: { value: "retell-secret-NEW1NEW2ABCD" },
    });
    const restore = screen.getByRole("button", { name: "Restore connection" });
    expectSharedFormLayout(restore);
    fireEvent.click(restore);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.url).toBe(
      "/api/agents/agt_1/connections/con_1/restore?project=prj_1",
    );
    // Replace, explicitly. Nothing about this path could reuse what was sealed.
    expect(sent[0]?.body.credential).toEqual({
      choice: "replace",
      credentials: { apiKey: "retell-secret-NEW1NEW2ABCD" },
    });
  });

  it("asks a Restore for nothing at all when the shape takes no credential", async () => {
    routed.params = { ...routed.params, connectionId: "con_2" };
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/connection-types": { status: 200, body: TYPES },
      "/api/capabilities": { status: 200, body: CAPABILITIES },
      "/api/agents/agt_1/connections/con_2/restore": {
        status: 200,
        body: { connection: { ...CONNECTION, id: "con_2" } },
      },
      "/api/agents/agt_1/connections/con_2": {
        status: 200,
        body: {
          connection: {
            ...CONNECTION,
            id: "con_2",
            name: "hotline",
            type: "phone",
            variant_id: "phone.number",
            modality: "voice",
            config: { phoneNumber: "+15551234567" },
            credential_present: false,
            credentials_hint: null,
            archived: true,
          },
        },
      },
    });
    render(<ConnectionDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    expect(screen.queryByLabelText("Retell API key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore connection" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(Object.keys(sent[0]?.body ?? {})).not.toContain("credential");
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
      "/api/capabilities": { status: 200, body: CAPABILITIES },
      "/api/agents/agt_1/connections/con_1": {
        status: 200,
        body: { connection: CONNECTION },
      },
    });
    render(<ConnectionDetailPage />);

    expect(
      await screen.findByText("Egma could not describe this connection's type."),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("never leaves a control that opens nothing when the type is unknown", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/connection-types": {
        status: 500,
        body: { error: "unreadable_answer", message: "Egma could not answer." },
      },
      "/api/capabilities": { status: 200, body: CAPABILITIES },
      "/api/agents/agt_1/connections/con_1": {
        status: 200,
        body: { connection: { ...CONNECTION, archived: true } },
      },
    });
    render(<ConnectionDetailPage />);

    // Edit and Restore are drawn from the shape, so without it they cannot be
    // opened. Enabled-but-inert is the state this must never be in: a control
    // that answers a click with nothing tells somebody the product is broken
    // and gives them nothing to do about it.
    const edit = (await screen.findByRole("button", {
      name: "Edit",
    })) as HTMLButtonElement;
    const restore = screen.getByRole("button", {
      name: "Restore",
    }) as HTMLButtonElement;

    expect(edit.disabled).toBe(true);
    expect(restore.disabled).toBe(true);
    for (const control of [edit, restore]) {
      expect(control.getAttribute("title")).toContain("could not describe");
    }

    fireEvent.click(edit);
    fireEvent.click(restore);
    expect(screen.queryByRole("dialog")).toBeNull();

    // Rotate says why as well, rather than being greyed out in silence.
    expect(
      screen
        .getByRole("button", { name: "Rotate credential" })
        .getAttribute("title"),
    ).toContain("could not describe");
  });

  it("sends an expired session to sign-in rather than showing a broken page", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { replace, assign: vi.fn(), href: "" });
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/connection-types": { status: 401, body: {} },
      "/api/capabilities": { status: 200, body: CAPABILITIES },
      "/api/agents/agt_1/connections/con_1": {
        status: 200,
        body: { connection: CONNECTION },
      },
    });
    render(<ConnectionDetailPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
  });

  it("shows egma's refusal when a Restore is turned away", async () => {
    answersWith(
      { ...CONNECTION, archived: true },
      "member",
      {
        "/api/agents/agt_1/connections/con_1/restore": {
          status: 409,
          body: {
            error: "parent_agent_archived",
            message:
              "Connection con_1 cannot be restored while agent agt_1 is archived. Restore the agent first, then restore this connection.",
          },
        },
      },
    );
    render(<ConnectionDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    fireEvent.change(screen.getByLabelText("Retell API key"), {
      target: { value: "retell-secret-NEW1NEW2ABCD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Restore connection" }));

    // Never silent: the refusal's own sentence names the next move, and the
    // dialog stays open with what was typed still in it.
    expect(
      await screen.findByText(
        "Connection con_1 cannot be restored while agent agt_1 is archived. Restore the agent first, then restore this connection.",
      ),
    ).toBeDefined();
    expect(
      (screen.getByLabelText("Retell API key") as HTMLInputElement).value,
    ).toBe("retell-secret-NEW1NEW2ABCD");
  });
});
