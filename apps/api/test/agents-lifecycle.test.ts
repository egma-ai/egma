import { newId } from "@egma/ids";
import {
  getSimulation,
  registerCapabilityDiscovery,
  type CapabilityDiscovery,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  contextFor,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * What a browser can do with an agent and with the ways egma reaches it, over
 * real HTTP.
 *
 * These are the promises the Agents pages are built on, and they are proved
 * here rather than in a browser because none of them is about a browser: a
 * refusal code, a stale-write conflict, a credential that never comes back, a
 * capability record that says `unknown` rather than pretending, and an Archive
 * that settles work already queued. Every one of those is the same whoever
 * asked, and a real Chrome would prove nothing extra while costing a minute.
 *
 * Refusal codes are asserted exactly. The code is the contract a client
 * branches on; the sentences are asserted where the product's own refusal table
 * names them word for word, because a client shows those unchanged.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

type Answer = {
  readonly status: number;
  readonly body: Record<string, unknown>;
};

/** A browser request: a session cookie, and a project named in the query. */
async function browser(
  method: "GET" | "POST" | "PATCH",
  url: string,
  who: Customer,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  const separator = url.includes("?") ? "&" : "?";
  const response = await api.app.inject({
    method,
    url: `${url}${separator}projectId=${who.projectId}`,
    headers: { cookie: who.cookie },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

function held<T>(answer: Answer, key: string): T {
  return answer.body[key] as T;
}

/** The capability record of the connection an answer carries. */
function held0(answer: Answer): ConnectionBody["capabilities"] {
  return held<ConnectionBody>(answer, "connection").capabilities;
}

type AgentBody = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly revision: string;
  readonly archived: boolean;
};

type ConnectionBody = {
  readonly id: string;
  readonly name: string;
  readonly agentPlatform: string | null;
  readonly connectionKind: string;
  readonly accessVariant: string;
  readonly productLabel: string;
  readonly revision: string;
  readonly archived: boolean;
  readonly credentialPresent: boolean;
  readonly credentialsHint: string | null;
  readonly config: Record<string, string>;
  readonly capabilities: {
    readonly state: string;
    readonly measured: readonly string[] | null;
    readonly supported: readonly string[] | null;
    readonly checkedAt: string | null;
    readonly source: string | null;
    readonly standing: Readonly<Record<string, string>>;
  };
};

const RETELL_KEY = "retell-secret-A1B2C3D4WXYZ";

/** A voice connection that needs no carrier configuration in this test API. */
const LIVEKIT_VOICE = {
  agentPlatform: "livekit_agents",
  connectionKind: "livekit_room",
  accessVariant: "livekit_room.project_credentials",
  modality: "voice",
  config: { url: "wss://acme.livekit.cloud" },
  credentials: {
    apiKey: "livekit-key-A1B2C3D4WXYZ",
    apiSecret: "livekit-secret-E5F6G7H8QRST",
  },
} as const;

async function anAgent(who: Customer, name: string): Promise<AgentBody> {
  const created = await browser("POST", "/v1/agents", who, { name });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return held<AgentBody>(created, "agent");
}

async function aConnection(
  who: Customer,
  agentId: string,
  overrides: Record<string, unknown> = {},
): Promise<ConnectionBody> {
  const added = await browser(
    "POST",
    `/v1/agents/${agentId}/connections`,
    who,
    {
      agentPlatform: "retell",
      connectionKind: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: RETELL_KEY },
      ...overrides,
    },
  );
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  return held<ConnectionBody>(added, "connection");
}

describe("the agent list a browser reads", () => {
  it("finds an agent by part of its name, across pages rather than within one", async () => {
    api = await createApi("agents_browser_search");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    for (const name of ["Front desk", "Front office", "Billing line"]) {
      await anAgent(ada, name);
    }

    const found = await browser("GET", "/v1/agents?search=front", ada);
    expect(found.status).toBe(200);
    expect(
      (held<readonly AgentBody[]>(found, "agents")).map((one) => one.name).sort(),
    ).toEqual(["Front desk", "Front office"]);

    // The search reaches the whole project rather than the page in hand: asking
    // for one row at a time still finds the second match on the next page.
    const first = await browser("GET", "/v1/agents?search=front&pageSize=1", ada);
    expect(held<readonly AgentBody[]>(first, "agents")).toHaveLength(1);
    const cursor = first.body.nextPageToken as string;
    expect(cursor).toBeTypeOf("string");
    const second = await browser(
      "GET",
      `/v1/agents?search=front&pageSize=1&pageToken=${cursor}`,
      ada,
    );
    expect(held<readonly AgentBody[]>(second, "agents")).toHaveLength(1);
    expect(second.body.nextPageToken).toBeNull();
  });

  it("keeps the archived half behind its own filter, and keeps it readable", async () => {
    api = await createApi("agents_browser_archived_filter");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const active = await anAgent(ada, "Standing");
    const retired = await anAgent(ada, "Retiring");
    const archived = await browser(
      "POST",
      `/v1/agents/${retired.id}/archive`,
      ada,
      { expectedRevision: retired.revision },
    );
    expect(archived.status).toBe(200);

    const listed = await browser("GET", "/v1/agents", ada);
    expect(held<readonly AgentBody[]>(listed, "agents").map((one) => one.id)).toEqual([
      active.id,
    ]);

    const filed = await browser("GET", "/v1/agents?archived=true", ada);
    expect(held<readonly AgentBody[]>(filed, "agents").map((one) => one.id)).toEqual([
      retired.id,
    ]);

    // Archived is not gone: the detail page of an archived agent has to open,
    // because its runs are still evidence and Restore is reached from it.
    const opened = await browser("GET", `/v1/agents/${retired.id}`, ada);
    expect(opened.status).toBe(200);
    expect(held<AgentBody>(opened, "agent").archived).toBe(true);
  });

  it("refuses a limit no page may hold, rather than quietly capping it", async () => {
    api = await createApi("agents_browser_limit");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const asked = await browser("GET", "/v1/agents?pageSize=5000", ada);
    expect(asked.status).toBe(400);
    expect(asked.body.error).toBe("invalid_request");
  });
});

describe("the Egma-owned half of an agent", () => {
  it("is a name and a description, and never the provider's configuration", async () => {
    api = await createApi("agents_browser_identity");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const edited = await browser("PATCH", `/v1/agents/${agent.id}`, ada, {
      name: "Front desk",
      description: "Answers the main line",
      expectedRevision: agent.revision,
    });
    expect(edited.status).toBe(200);
    expect(held<AgentBody>(edited, "agent").description).toBe(
      "Answers the main line",
    );

    // No prompt, no model, no tools: those live at the provider, and a read
    // carrying a copy would be a copy going stale.
    const read = await browser("GET", `/v1/agents/${agent.id}`, ada);
    const shape = held<Record<string, unknown>>(read, "agent");
    for (const provider of ["prompt", "model", "tools", "voice", "pulled"]) {
      expect(Object.keys(shape)).not.toContain(provider);
    }

    // And an edit that tried to set one is refused by name rather than having
    // the key quietly dropped.
    const tried = await browser("PATCH", `/v1/agents/${agent.id}`, ada, {
      prompt: "You are a helpful agent",
      expectedRevision: held<AgentBody>(edited, "agent").revision,
    });
    expect(tried.status).toBe(400);
    expect(String(tried.body.message)).toContain("prompt");
  });

  it("refuses an edit written against a revision the agent has moved past", async () => {
    api = await createApi("agents_browser_stale_edit");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");

    // Two editors open the same agent. The first saves.
    const first = await browser("PATCH", `/v1/agents/${agent.id}`, ada, {
      description: "Edited first",
      expectedRevision: agent.revision,
    });
    expect(first.status).toBe(200);

    // The second saves against what it read, and is told rather than winning.
    const second = await browser("PATCH", `/v1/agents/${agent.id}`, ada, {
      description: "Edited second",
      expectedRevision: agent.revision,
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("identity_conflict");
    expect(second.body.message).toBe(
      `agent ${agent.id} changed after you opened it. Read it again, keep or ` +
        `reapply your edits, and send the update with expectedRevision set ` +
        `to its new revision.`,
    );

    // And the first editor's work is exactly where they left it.
    const read = await browser("GET", `/v1/agents/${agent.id}`, ada);
    expect(held<AgentBody>(read, "agent").description).toBe("Edited first");
  });

  it("makes a browser say which revision it was written against", async () => {
    api = await createApi("agents_browser_revision_required");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const agent = await anAgent(ada, "Front desk");

    const blind = await browser("PATCH", `/v1/agents/${agent.id}`, ada, {
      description: "No revision named",
    });
    expect(blind.status).toBe(422);
    expect(blind.body.error).toBe("unprocessable");
  });
});

describe("archiving an agent", () => {
  it("takes its active connections with it, and leaves them archived on Restore", async () => {
    api = await createApi("agents_browser_archive_cascade");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id, { name: "staging" });

    const archived = await browser(
      "POST",
      `/v1/agents/${agent.id}/archive`,
      ada,
      { expectedRevision: agent.revision },
    );
    expect(archived.status).toBe(200);
    expect(archived.body.archivedConnections).toEqual([wiring.id]);

    const restored = await browser(
      "POST",
      `/v1/agents/${agent.id}/restore`,
      ada,
      { expectedRevision: held<AgentBody>(archived, "agent").revision },
    );
    expect(restored.status).toBe(200);
    expect(held<AgentBody>(restored, "agent").archived).toBe(false);

    // The whole reason the connections do not come back with the agent: each
    // one carries a credential, and reactivating them in a batch would put an
    // old provider key into use without anybody choosing to.
    const active = await browser("GET", `/v1/agents/${agent.id}`, ada);
    expect(held<readonly ConnectionBody[]>(active, "connections")).toEqual([]);
    const filed = await browser(
      "GET",
      `/v1/agents/${agent.id}?archived=true`,
      ada,
    );
    expect(
      held<readonly ConnectionBody[]>(filed, "connections").map((one) => one.id),
    ).toEqual([wiring.id]);
  });

  it("refuses to restore over a name another active agent has taken since", async () => {
    api = await createApi("agents_browser_restore_name");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const first = await anAgent(ada, "Front desk");
    const archived = await browser(
      "POST",
      `/v1/agents/${first.id}/archive`,
      ada,
      { expectedRevision: first.revision },
    );
    const revision = held<AgentBody>(archived, "agent").revision;

    // The name was released by the Archive and somebody took it.
    await anAgent(ada, "Front desk");

    const refused = await browser(
      "POST",
      `/v1/agents/${first.id}/restore`,
      ada,
      { expectedRevision: revision },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("name_taken");

    // The recovery the refusal names: a replacement name in the Restore.
    const renamed = await browser(
      "POST",
      `/v1/agents/${first.id}/restore`,
      ada,
      { expectedRevision: revision, name: "Front desk (original)" },
    );
    expect(renamed.status).toBe(200);
    expect(held<AgentBody>(renamed, "agent").name).toBe("Front desk (original)");
  });
});

/**
 * The sentence a caller reads when the thing it opened has moved since.
 *
 * Written out here in full rather than imported from the product, because the
 * wording is the contract: a coding agent reads it off a terminal and a browser
 * shows it unchanged. Sharing the product's own composer would make this file
 * agree with whatever the product says today, which is not the same as proving
 * it says what was promised.
 */
function movedOn(resource: "agent" | "connection", id: string): string {
  return (
    `${resource} ${id} changed after you opened it. Read it again, keep or ` +
    `reapply your edits, and send the update with expectedRevision set to ` +
    `its new revision.`
  );
}

/**
 * Archive and Restore are identity writes, and they are guarded exactly as an
 * edit is.
 *
 * **Every other Archive and Restore in this file sends the revision it read a
 * line earlier**, so a handler that took `expectedRevision` and dropped it
 * would leave all of them green. What that would let through is the race the
 * guard exists for: one tab archives an agent while another, holding a page
 * from before a rename, restores it — and neither person is ever told that
 * they were looking at different things.
 *
 * These are the twins of "refuses an edit written against a revision the agent
 * has moved past", and they are written so Agents read the way Personas
 * already do.
 */
describe("the revision an Archive or a Restore is written against", () => {
  it("guards Archive and Restore on the same terms, for an agent", async () => {
    api = await createApi("agents_browser_archive_stale_revision");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");

    // Two tabs on the same agent. The first renames it, which moves the
    // revision the second is still holding.
    const renamed = await browser("PATCH", `/v1/agents/${agent.id}`, ada, {
      name: "Front desk, renamed",
      expectedRevision: agent.revision,
    });
    expect(renamed.status).toBe(200);
    const current = held<AgentBody>(renamed, "agent").revision;

    const stale = await browser("POST", `/v1/agents/${agent.id}/archive`, ada, {
      expectedRevision: agent.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("identity_conflict");
    expect(stale.body.message).toBe(movedOn("agent", agent.id));

    // Refused means nothing written: the agent is still in new work.
    const standing = await browser("GET", `/v1/agents/${agent.id}`, ada);
    expect(held<AgentBody>(standing, "agent").archived).toBe(false);

    const archived = await browser(
      "POST",
      `/v1/agents/${agent.id}/archive`,
      ada,
      { expectedRevision: current },
    );
    expect(archived.status).toBe(200);
    const afterArchive = held<AgentBody>(archived, "agent").revision;

    // The revision the Archive replaced is exactly what a page opened before it
    // is holding, and Restore refuses it for the same reason.
    const staleRestore = await browser(
      "POST",
      `/v1/agents/${agent.id}/restore`,
      ada,
      { expectedRevision: current },
    );
    expect(staleRestore.status).toBe(409);
    expect(staleRestore.body.error).toBe("identity_conflict");
    expect(staleRestore.body.message).toBe(movedOn("agent", agent.id));

    const filed = await browser("GET", `/v1/agents/${agent.id}`, ada);
    expect(held<AgentBody>(filed, "agent").archived).toBe(true);

    const back = await browser("POST", `/v1/agents/${agent.id}/restore`, ada, {
      expectedRevision: afterArchive,
    });
    expect(back.status).toBe(200);
    expect(held<AgentBody>(back, "agent").archived).toBe(false);
  });

  it("guards Archive and Restore on the same terms, for a connection", async () => {
    api = await createApi("agents_browser_connection_stale_revision");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id, { name: "staging" });
    const at = `/v1/agents/${agent.id}/connections/${wiring.id}`;

    const renamed = await browser("PATCH", at, ada, {
      name: "staging, renamed",
      expectedRevision: wiring.revision,
    });
    expect(renamed.status).toBe(200);
    const current = held<ConnectionBody>(renamed, "connection").revision;

    const stale = await browser("POST", `${at}/archive`, ada, {
      expectedRevision: wiring.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("identity_conflict");
    expect(stale.body.message).toBe(movedOn("connection", wiring.id));

    // Nothing written, so the target is still reachable — which matters more
    // here than on the agent: an Archive that landed would have settled the
    // work going over it.
    const standing = await browser("GET", at, ada);
    expect(held<ConnectionBody>(standing, "connection").archived).toBe(false);

    const archived = await browser("POST", `${at}/archive`, ada, {
      expectedRevision: current,
    });
    expect(archived.status).toBe(200);
    const afterArchive = held<ConnectionBody>(archived, "connection").revision;

    // The Restore carries the credential `retell` requires, so the revision is
    // the only thing left that can refuse it.
    const credential = {
      choice: "replace",
      credentials: { apiKey: "retell-secret-NEW1NEW2ABCD" },
    };
    const staleRestore = await browser("POST", `${at}/restore`, ada, {
      expectedRevision: current,
      credential,
    });
    expect(staleRestore.status).toBe(409);
    expect(staleRestore.body.error).toBe("identity_conflict");
    expect(staleRestore.body.message).toBe(movedOn("connection", wiring.id));

    const filed = await browser("GET", at, ada);
    expect(held<ConnectionBody>(filed, "connection").archived).toBe(true);

    const back = await browser("POST", `${at}/restore`, ada, {
      expectedRevision: afterArchive,
      credential,
    });
    expect(back.status).toBe(200);
    expect(held<ConnectionBody>(back, "connection").archived).toBe(false);
  });
});

describe("a connection's stored credential", () => {
  it("never comes back, and a read says only that one is there", async () => {
    api = await createApi("agents_browser_credential_secrecy");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id);

    const read = await browser(
      "GET",
      `/v1/agents/${agent.id}/connections/${wiring.id}`,
      ada,
    );
    const shape = held<ConnectionBody>(read, "connection");
    expect(shape.credentialPresent).toBe(true);
    expect(shape.credentialsHint).toBe("WXYZ");
    expect(JSON.stringify(read.body)).not.toContain(RETELL_KEY);

    // Rotation replaces the whole credential and is visible only as a new hint.
    const rotated = await browser(
      "PATCH",
      `/v1/agents/${agent.id}/connections/${wiring.id}`,
      ada,
      {
        credentials: { apiKey: "retell-secret-Z9Y8X7W6MNOP" },
        expectedRevision: shape.revision,
      },
    );
    expect(rotated.status).toBe(200);
    expect(held<ConnectionBody>(rotated, "connection").credentialsHint).toBe(
      "MNOP",
    );
    expect(JSON.stringify(rotated.body)).not.toContain("MNOPQ");
    expect(JSON.stringify(rotated.body)).not.toContain(RETELL_KEY);
  });

  it("is described to a form without any of it crossing", async () => {
    api = await createApi("agents_browser_connection_options");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const catalog = await browser("GET", "/v1/connection-options", ada);
    expect(catalog.status).toBe(200);

    const items = held<
      readonly {
        readonly agentPlatform: string | null;
        readonly connectionKind: string;
        readonly accessVariant: string;
        readonly simulatorAdapter: boolean;
        readonly capabilityDiscovery: boolean;
        readonly credentialRule: string;
        readonly fields: readonly { readonly key: string; readonly kind: string }[];
        readonly credentialFields: readonly { readonly field: string }[];
      }[]
    >(catalog, "items");

    const livekit = items.filter(
      (one) =>
        one.agentPlatform === "livekit_agents" &&
        one.connectionKind === "livekit_room",
    );
    expect(livekit.map((one) => one.accessVariant)).toEqual([
      "livekit_room.project_credentials",
      "livekit_room.customer_token_endpoint",
    ]);

    // The three credential rules the product's Restore is written against,
    // each named on the shape that has it.
    expect(
      items.find((one) => one.connectionKind === "retell_chat_api")
        ?.credentialRule,
    ).toBe("required");
    expect(
      items.find(
        (one) =>
          one.agentPlatform === null &&
          one.connectionKind === "phone_number",
      )?.credentialRule,
    ).toBe("forbidden");
    expect(
      livekit.find(
        (one) =>
          one.accessVariant === "livekit_room.customer_token_endpoint",
      )?.credentialRule,
    ).toBe("required");

    // Nothing that could be a validator, an internal refusal or a secret. The
    // answer is JSON over the wire, so a function could not survive the trip —
    // this is about what the shape claims to hold.
    const written = JSON.stringify(catalog.body);
    expect(written).not.toContain("function");
    expect(written).not.toContain("not_admitted");
    expect(written).not.toContain(RETELL_KEY);
  });
});

describe("a connection's shape", () => {
  it("is stored at create and cannot be edited into the other one", async () => {
    api = await createApi("agents_browser_variant_immutable");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id, {
      agentPlatform: "livekit_agents",
      connectionKind: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "voice",
      config: { url: "wss://acme.livekit.cloud" },
      credentials: {
        apiKey: "livekit-key-A1B2C3D4WXYZ",
        apiSecret: "livekit-secret-E5F6G7H8QRST",
      },
    });
    expect(wiring.accessVariant).toBe("livekit_room.project_credentials");

    const moved = await browser(
      "PATCH",
      `/v1/agents/${agent.id}/connections/${wiring.id}`,
      ada,
      {
        config: {
          url: "wss://acme.livekit.cloud",
          tokenEndpoint: "https://acme.example/egma/livekit-token",
        },
        credentials: { headers: '{"Authorization":"Bearer token-value"}' },
        expectedRevision: wiring.revision,
      },
    );
    expect(moved.status).toBe(400);
    expect(String(moved.body.message)).toContain(
      'config has no key "tokenEndpoint"',
    );

    const read = await browser(
      "GET",
      `/v1/agents/${agent.id}/connections/${wiring.id}`,
      ada,
    );
    expect(held<ConnectionBody>(read, "connection").accessVariant).toBe(
      "livekit_room.project_credentials",
    );
  });
});

describe("restoring a connection", () => {
  it("follows the stored shape's credential rule, and never reuses the archived one", async () => {
    api = await createApi("agents_browser_restore_credential");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id);

    const archived = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${wiring.id}/archive`,
      ada,
      { expectedRevision: wiring.revision },
    );
    expect(archived.status).toBe(200);
    const revision = held<ConnectionBody>(archived, "connection").revision;

    // `retell` requires a credential, so a Restore that brings none is refused
    // in the product's own words rather than quietly reusing what was sealed.
    const bare = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${wiring.id}/restore`,
      ada,
      { expectedRevision: revision },
    );
    expect(bare.status).toBe(422);
    expect(bare.body.error).toBe("credential_required");
    expect(bare.body.message).toBe(
      `Connection ${wiring.id} uses retell_chat_api, which requires a new credential ` +
        `after Archive. Enter a new credential and restore it again.`,
    );

    const back = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${wiring.id}/restore`,
      ada,
      {
        expectedRevision: revision,
        credential: {
          choice: "replace",
          credentials: { apiKey: "retell-secret-NEW1NEW2ABCD" },
        },
      },
    );
    expect(back.status).toBe(200);
    const restored = held<ConnectionBody>(back, "connection");
    expect(restored.archived).toBe(false);
    // The hint is the new credential's, which is the visible proof that the
    // archived one was replaced rather than reused.
    expect(restored.credentialsHint).toBe("ABCD");
  });

  it("refuses a credential on a forbidden shape and demands one on a required shape", async () => {
    api = await createApi("agents_browser_restore_rules");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");

    const phone = await aConnection(ada, agent.id, {
      name: "hotline",
      agentPlatform: null,
      connectionKind: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
      config: { phoneNumber: "+15551234567" },
      credentials: undefined,
    });
    const archivedPhone = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${phone.id}/archive`,
      ada,
      { expectedRevision: phone.revision },
    );
    const phoneRevision = held<ConnectionBody>(archivedPhone, "connection").revision;

    const withCredential = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${phone.id}/restore`,
      ada,
      {
        expectedRevision: phoneRevision,
        credential: { choice: "replace", credentials: { apiKey: "nope-nope-nope" } },
      },
    );
    expect(withCredential.status).toBe(422);
    expect(withCredential.body.error).toBe("credential_forbidden");

    const plain = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${phone.id}/restore`,
      ada,
      { expectedRevision: phoneRevision },
    );
    expect(plain.status).toBe(200);

    // A public token endpoint always needs a fresh auth credential on Restore.
    const endpoint = await aConnection(ada, agent.id, {
      name: "endpoint",
      agentPlatform: "livekit_agents",
      connectionKind: "livekit_room",
      accessVariant: "livekit_room.customer_token_endpoint",
      modality: "voice",
      config: {
        url: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://acme.example/egma/livekit-token",
      },
      credentials: { headers: '{"Authorization":"Bearer token-value"}' },
    });
    const archivedEndpoint = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${endpoint.id}/archive`,
      ada,
      { expectedRevision: endpoint.revision },
    );
    const endpointRevision = held<ConnectionBody>(
      archivedEndpoint,
      "connection",
    ).revision;

    const undecided = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${endpoint.id}/restore`,
      ada,
      { expectedRevision: endpointRevision },
    );
    expect(undecided.status).toBe(422);
    expect(undecided.body.error).toBe("credential_required");

    const cleared = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${endpoint.id}/restore`,
      ada,
      { expectedRevision: endpointRevision, credential: { choice: "clear" } },
    );
    expect(cleared.status).toBe(422);
    expect(cleared.body.error).toBe("credential_required");

    const replaced = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${endpoint.id}/restore`,
      ada,
      {
        expectedRevision: endpointRevision,
        credential: {
          choice: "replace",
          credentials: {
            headers: '{"Authorization":"Bearer replacement-value"}',
          },
        },
      },
    );
    expect(replaced.status).toBe(200);
    const back = held<ConnectionBody>(replaced, "connection");
    expect(back.credentialPresent).toBe(true);
    expect(back.credentialsHint).toBe("Authorization");
  });

  it("refuses while the parent agent is archived", async () => {
    api = await createApi("agents_browser_restore_parent");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id);
    const archived = await browser(
      "POST",
      `/v1/agents/${agent.id}/archive`,
      ada,
      { expectedRevision: agent.revision },
    );
    expect(archived.status).toBe(200);

    const filed = await browser(
      "GET",
      `/v1/agents/${agent.id}?archived=true`,
      ada,
    );
    const revision = held<readonly ConnectionBody[]>(filed, "connections")[0]
      ?.revision;

    const refused = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${wiring.id}/restore`,
      ada,
      {
        expectedRevision: revision,
        credential: {
          choice: "replace",
          credentials: { apiKey: "retell-secret-NEW1NEW2ABCD" },
        },
      },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("parent_agent_archived");
    expect(refused.body.message).toBe(
      `Connection ${wiring.id} cannot be restored while agent ${agent.id} is ` +
        `archived. Restore the agent first, then restore this connection.`,
    );
  });
});

describe("a connection Restore that collides on its name", () => {
  it("names the colliding name, and takes a replacement", async () => {
    api = await createApi("agents_browser_connection_restore_name");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const first = await aConnection(ada, agent.id, { name: "staging" });

    const archived = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${first.id}/archive`,
      ada,
      { expectedRevision: first.revision },
    );
    const revision = held<ConnectionBody>(archived, "connection").revision;

    // Archiving released the name, and something took it.
    await aConnection(ada, agent.id, { name: "staging" });

    const credential = {
      choice: "replace",
      credentials: { apiKey: "retell-secret-NEW1NEW2ABCD" },
    };

    const refused = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${first.id}/restore`,
      ada,
      { expectedRevision: revision, credential },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("name_taken");
    // The name it collided on is the one the row still carries, and the
    // sentence has to say which name to avoid rather than filling its own slot
    // with a phrase.
    expect(refused.body.message).toBe(
      "The name staging is already used by an active connection. Choose a " +
        "different name in Restore and try again.",
    );

    const renamed = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${first.id}/restore`,
      ada,
      { expectedRevision: revision, name: "staging (original)", credential },
    );
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const back = held<ConnectionBody>(renamed, "connection");
    expect(back.name).toBe("staging (original)");
    expect(back.archived).toBe(false);
    expect(back.credentialsHint).toBe("ABCD");
  });

  it("names the colliding name for an agent Restore too", async () => {
    api = await createApi("agents_browser_agent_restore_name_named");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const first = await anAgent(ada, "Front desk");
    const archived = await browser(
      "POST",
      `/v1/agents/${first.id}/archive`,
      ada,
      { expectedRevision: first.revision },
    );
    await anAgent(ada, "Front desk");

    const refused = await browser(
      "POST",
      `/v1/agents/${first.id}/restore`,
      ada,
      { expectedRevision: held<AgentBody>(archived, "agent").revision },
    );
    expect(refused.body.message).toBe(
      "The name Front desk is already used by an active agent. Choose a " +
        "different name in Restore and try again.",
    );
  });
});

describe("a key minted for the whole organization", () => {
  it("is answered rather than faulted, on every write in this group", async () => {
    api = await createApi("agents_org_wide_key");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id);

    // `ada.secret` is minted for the whole customer and names no project. The
    // organization holds one project, so the API resolves it — the same rule
    // the graders, personas and mock tools follow — and nothing in the group
    // reaches the data layer's project guard as a fault.
    const withKey = async (
      method: "POST" | "PATCH",
      url: string,
      payload: Record<string, unknown>,
    ) => {
      const response = await api.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${ada.secret}` },
        payload,
      });
      return {
        status: response.statusCode,
        body: response.json() as Record<string, unknown>,
      };
    };

    const archivedConnection = await withKey(
      "POST",
      `/v1/agents/${agent.id}/connections/${wiring.id}/archive`,
      {},
    );
    expect(archivedConnection.status).toBe(200);

    const archived = await withKey("POST", `/v1/agents/${agent.id}/archive`, {});
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);

    const restored = await withKey("POST", `/v1/agents/${agent.id}/restore`, {});
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);

    // Archive and Restore answer the same key the same way, which they did not
    // before: one returned 200 and the other a bare 500 from a plain throw.
    for (const answer of [archivedConnection, archived, restored]) {
      expect(answer.status).toBeLessThan(500);
    }
  });
});

describe("a connection's capability record", () => {
  it("starts unknown, which is not the same as unsupported", async () => {
    api = await createApi("agents_browser_capabilities_unknown");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id);

    expect(wiring.capabilities.state).toBe("unknown");
    // Never an empty list: nobody has looked, and a reader who saw `[]` would
    // read it as a target measured and found bare.
    expect(wiring.capabilities.supported).toBeNull();
    expect(wiring.capabilities.checkedAt).toBeNull();
  });

  it("answers what egma's own transport settles: audio on voice, none on chat", async () => {
    api = await createApi("agents_browser_capabilities_transport");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const spoken = await aConnection(ada, agent.id, {
      name: "by-voice",
      ...LIVEKIT_VOICE,
    });
    const typed = await aConnection(ada, agent.id, {
      name: "by-chat",
      modality: "chat",
    });

    const measure = async (connectionId: string) => {
      const done = await browser(
        "POST",
        `/v1/agents/${agent.id}/connections/${connectionId}/capabilities/refresh`,
        ada,
      );
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      return held<ConnectionBody>(done, "connection").capabilities;
    };

    // A voice simulation holds PCM both ways, so there is audio for an audio
    // grader to read. This is a fact about egma's own transport rather than
    // about the provider's name, which is why an adapter is allowed to state
    // it at all.
    const voice = await measure(spoken.id);
    expect(voice.state).toBe("known");
    expect(voice.supported).toEqual(["raw_audio"]);

    // A chat simulation is text end to end. Not "not yet" — none.
    const chat = await measure(typed.id);
    expect(chat.state).toBe("known");
    expect(chat.supported).toEqual([]);

    // And DTMF is absent from both, which under this record means measured and
    // unsupported: nothing in the simulator can press a digit over any
    // transport. Saying so is worth more than leaving it unknown, because a
    // test that needs a phone menu is then skipped with a reason somebody can
    // act on rather than because nobody has looked.
    // Measured either way, so its absence is a fact rather than a gap.
    expect(voice.standing.dtmf).toBe("unsupported");
    expect(chat.standing.dtmf).toBe("unsupported");
    expect(chat.standing.raw_audio).toBe("unsupported");
  });

  it("answers each capability one of three ways, never two", async () => {
    api = await createApi("agents_browser_capability_standing");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const spoken = await aConnection(ada, agent.id, {
      name: "by-voice",
      ...LIVEKIT_VOICE,
    });

    // Before anything looks, every key is unmeasured — including the two the
    // adapter can speak to.
    for (const key of ["raw_audio", "dtmf", "barge_in"]) {
      expect(spoken.capabilities.standing[key], key).toBe("not_measured");
    }

    const done = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${spoken.id}/capabilities/refresh`,
      ada,
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const held = held0(done);

    // The three answers, one per capability, after one refresh.
    expect(held.standing).toEqual({
      // Measured and found: a voice simulation holds PCM both ways.
      raw_audio: "supported",
      // Measured and absent: nothing in the simulator can send a digit.
      dtmf: "unsupported",
      // Not measured: barge-in is a question about the customer's agent, and
      // no shipped adapter asks it. This is the answer that used to be lost.
      barge_in: "not_measured",
    });

    expect(held.measured).toEqual(["raw_audio", "dtmf"]);
    expect(held.supported).toEqual(["raw_audio"]);
  });

  it("never reads a capability nobody measured as one the target lacks", async () => {
    api = await createApi("agents_browser_capability_not_measured");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id, LIVEKIT_VOICE);

    /**
     * The property, taken past the shipped adapter: whatever an adapter
     * reports, a key it did not measure is never `unsupported`.
     *
     * This is the confusion the ticket exists to prevent. Run eligibility is
     * built on this record, and a test needing barge-in must be skipped with
     * `required_capability_unknown` — go and measure it — rather than
     * `required_capability_unsupported`, which says the target cannot and sends
     * somebody to rewrite a test that was fine.
     */
    const before = registerCapabilityDiscovery("livekit_room", async () => ({
      measured: ["raw_audio"],
      supported: ["raw_audio"],
    }));

    try {
      const done = await browser(
        "POST",
        `/v1/agents/${agent.id}/connections/${wiring.id}/capabilities/refresh`,
        ada,
      );
      expect(done.status).toBe(200);
      const capabilities = held0(done);

      expect(capabilities.state).toBe("known");
      expect(capabilities.standing.raw_audio).toBe("supported");
      // Both absent from `supported`, and neither is a claim about the target.
      expect(capabilities.standing.dtmf).toBe("not_measured");
      expect(capabilities.standing.barge_in).toBe("not_measured");
      expect(Object.values(capabilities.standing)).not.toContain("unsupported");
    } finally {
      registerCapabilityDiscovery("livekit_room", before);
    }
  });

  it("is refused a Refresh for a type egma ships no adapter for", async () => {
    api = await createApi("agents_browser_capabilities_no_adapter");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id);

    // Every shipped type carries the transport adapter, so this is the state a
    // type added ahead of its adapter would be in — taken by removing the one
    // that is there.
    const before = registerCapabilityDiscovery("retell_chat_api", undefined);
    try {
      const asked = await browser(
        "POST",
        `/v1/agents/${agent.id}/connections/${wiring.id}/capabilities/refresh`,
        ada,
      );
      expect(asked.status).toBe(422);
      expect(asked.body.error).toBe("no_capability_adapter");
      // The refusal says the state is unchanged, so nobody reads it as having
      // cleared a measurement.
      expect(String(asked.body.message)).toContain("stays unknown");
    } finally {
      registerCapabilityDiscovery("retell_chat_api", before);
    }
  });

  it("records what an adapter measured, and forgets it when the target moves", async () => {
    api = await createApi("agents_browser_capabilities_known");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id);

    const found: CapabilityDiscovery = async () => ({
      measured: ["dtmf", "raw_audio"],
      supported: ["dtmf", "raw_audio"],
    });
    const before = registerCapabilityDiscovery("retell_chat_api", found);

    try {
      const measured = await browser(
        "POST",
        `/v1/agents/${agent.id}/connections/${wiring.id}/capabilities/refresh`,
        ada,
      );
      expect(measured.status).toBe(200);
      const known = held<ConnectionBody>(measured, "connection").capabilities;
      expect(known.state).toBe("known");
      expect(known.supported).toEqual(["dtmf", "raw_audio"]);
      expect(known.checkedAt).toBeTypeOf("string");
      expect(known.source).toBe("retell_chat_api adapter");

      // Changing where the connection points changes which target this is, so
      // a measurement of the old one stops being evidence about it.
      const edited = await browser(
        "PATCH",
        `/v1/agents/${agent.id}/connections/${wiring.id}`,
        ada,
        {
          config: { retellAgentId: "agent_in_retell_2" },
          expectedRevision: held<ConnectionBody>(measured, "connection").revision,
        },
      );
      expect(edited.status).toBe(200);
      expect(held<ConnectionBody>(edited, "connection").capabilities.state).toBe(
        "unknown",
      );
    } finally {
      registerCapabilityDiscovery("retell_chat_api", before);
    }
  });

  it("leaves the record alone when the adapter could not establish anything", async () => {
    api = await createApi("agents_browser_capabilities_failed");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id);

    const before = registerCapabilityDiscovery("retell_chat_api", async () => {
      throw new Error("the provider did not answer");
    });

    try {
      const asked = await browser(
        "POST",
        `/v1/agents/${agent.id}/connections/${wiring.id}/capabilities/refresh`,
        ada,
      );
      expect(asked.status).toBe(502);
      expect(asked.body.error).toBe("capability_check_failed");
      expect(asked.body.message).toBe(
        `Egma could not check capabilities for connection ${wiring.id}. Its ` +
          `capability state remains unknown; check the connection settings ` +
          `and try Refresh capabilities again.`,
      );

      const read = await browser(
        "GET",
        `/v1/agents/${agent.id}/connections/${wiring.id}`,
        ada,
      );
      expect(held<ConnectionBody>(read, "connection").capabilities.state).toBe(
        "unknown",
      );
    } finally {
      registerCapabilityDiscovery("retell_chat_api", before);
    }
  });
});

describe("the capability catalog", () => {
  it("is one server-owned list, and a key outside it is refused", async () => {
    api = await createApi("agents_browser_capability_catalog");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const catalog = await browser("GET", "/v1/capabilities", ada);
    expect(catalog.status).toBe(200);
    const keys = held<readonly { readonly key: string }[]>(
      catalog,
      "items",
    ).map((one) => one.key);
    expect(keys).toContain("dtmf");

    // An adapter answering a key the catalog has not got is a bug in the
    // adapter, and the measurement is refused rather than stored — a
    // capability nobody could ever require would be a fact nothing reads.
    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id);
    const before = registerCapabilityDiscovery("retell_chat_api", async () => ({
      measured: ["telepathy"],
      supported: ["telepathy"],
    }));
    try {
      const asked = await browser(
        "POST",
        `/v1/agents/${agent.id}/connections/${wiring.id}/capabilities/refresh`,
        ada,
      );
      expect(asked.status).toBe(500);
      const read = await browser(
        "GET",
        `/v1/agents/${agent.id}/connections/${wiring.id}`,
        ada,
      );
      expect(held<ConnectionBody>(read, "connection").capabilities.state).toBe(
        "unknown",
      );
    } finally {
      registerCapabilityDiscovery("retell_chat_api", before);
    }
  });
});

describe("what a viewer may do here", () => {
  it("reads everything and is refused every write, with no browser involved", async () => {
    api = await createApi("agents_browser_viewer");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const vic = await colleagueOf(api.app, ada, "vic@acme.example", "viewer");
    const viewer: Customer = { ...ada, cookie: vic.cookie };

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id);

    // Reads are theirs, all of them.
    expect((await browser("GET", "/v1/agents", viewer)).status).toBe(200);
    expect(
      (await browser("GET", `/v1/agents/${agent.id}`, viewer)).status,
    ).toBe(200);
    expect((await browser("GET", "/v1/connection-options", viewer)).status).toBe(
      200,
    );

    /**
     * And every write is refused by the server, whether or not a browser was
     * involved. Hiding a control is a courtesy; this is the boundary.
     */
    const refusal = {
      error: "not_permitted",
      message:
        "Your viewer role cannot create or change agents and connections. " +
        "Ask an organization admin to change your role, then try again.",
    };

    const writes: readonly [string, string, Record<string, unknown>][] = [
      ["POST", "/v1/agents", { name: "Theirs" }],
      [
        "PATCH",
        `/v1/agents/${agent.id}`,
        { name: "Renamed", expectedRevision: agent.revision },
      ],
      [
        "POST",
        `/v1/agents/${agent.id}/archive`,
        { expectedRevision: agent.revision },
      ],
      [
        "POST",
        `/v1/agents/${agent.id}/restore`,
        { expectedRevision: agent.revision },
      ],
      [
        "PATCH",
        `/v1/agents/${agent.id}/connections/${wiring.id}`,
        { name: "renamed", expectedRevision: wiring.revision },
      ],
      [
        "POST",
        `/v1/agents/${agent.id}/connections/${wiring.id}/archive`,
        { expectedRevision: wiring.revision },
      ],
      [
        "POST",
        `/v1/agents/${agent.id}/connections/${wiring.id}/capabilities/refresh`,
        {},
      ],
    ];

    for (const [method, url, payload] of writes) {
      const answer = await browser(
        method as "POST" | "PATCH",
        url,
        viewer,
        payload,
      );
      expect(answer.status, `${method} ${url}`).toBe(403);
      expect(answer.body, `${method} ${url}`).toEqual(refusal);
    }

    // Nothing moved.
    const read = await browser("GET", `/v1/agents/${agent.id}`, viewer);
    expect(held<AgentBody>(read, "agent").name).toBe("Front desk");
    expect(held<AgentBody>(read, "agent").archived).toBe(false);
  });
});

describe("another organization's agent", () => {
  it("is an absence for every verb, never a denial that confirms it exists", async () => {
    api = await createApi("agents_browser_isolation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const gus = await signUp(api.app, "gus@globex.example", "Globex");

    const agent = await anAgent(ada, "Acme Only");
    const wiring = await aConnection(ada, agent.id);

    for (const [method, url, payload] of [
      ["GET", `/v1/agents/${agent.id}`, undefined],
      [
        "PATCH",
        `/v1/agents/${agent.id}`,
        { name: "Taken", expectedRevision: agent.revision },
      ],
      [
        "POST",
        `/v1/agents/${agent.id}/archive`,
        { expectedRevision: agent.revision },
      ],
      [
        "GET",
        `/v1/agents/${agent.id}/connections/${wiring.id}`,
        undefined,
      ],
    ] as const) {
      const answer = await browser(
        method,
        url,
        gus,
        payload as Record<string, unknown> | undefined,
      );
      expect(answer.status, `${method} ${url}`).toBe(404);
      expect(answer.body.error, `${method} ${url}`).toBe("not_found");
    }

    // And Acme's agent is exactly as it was.
    const read = await browser("GET", `/v1/agents/${agent.id}`, ada);
    expect(held<AgentBody>(read, "agent").name).toBe("Acme Only");
  });
});

describe("archiving a connection that work is queued over", () => {
  it("cancels the queued simulation and the run, without erasing evidence", async () => {
    api = await createApi("agents_browser_archive_cancels");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const { agentId, connectionId, connectionRevision, runId, simulationId } =
      await aQueuedRunFor(ada);

    const archived = await browser(
      "POST",
      `/v1/agents/${agentId}/connections/${connectionId}/archive`,
      ada,
      { expectedRevision: connectionRevision },
    );
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(archived.body.canceledRuns).toEqual([runId]);

    // The queued conversation ended here — never dispatched, never claimable —
    // and the run says canceled rather than quietly completing.
    const simulation = await getSimulation(
      contextFor(ada, "member"),
      simulationId,
    );
    expect(simulation?.status).toBe("canceled");

    const run = await browser("GET", `/v1/runs/${runId}`, ada);
    expect(run.body.status).toBe("canceled");
  });
});

/**
 * A run with one conversation waiting to be claimed, built the way the product
 * builds one: a project's default persona, a test that names it, and a run over
 * one connection.
 */
async function aQueuedRunFor(who: Customer): Promise<{
  readonly agentId: string;
  readonly connectionId: string;
  readonly connectionRevision: string;
  readonly runId: string;
  readonly simulationId: string;
}> {
  const agent = await anAgent(who, "Front desk");
  const wiring = await aConnection(who, agent.id);

  const written = await browser("POST", "/v1/tests", who, {
    name: "Books an appointment",
    scenario: "The caller wants an appointment next week.",
    expectedBehaviors: ["The agent offers a time"],
  });
  expect(written.status, JSON.stringify(written.body)).toBe(201);
  const versionId = String(written.body.versionId);

  const started = await browser("POST", "/v1/runs", who, {
    connectionId: wiring.id,
    testVersionIds: [versionId],
    idempotencyKey: newId("run"),
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const simulations = started.body.simulations as readonly { id: string }[];

  return {
    agentId: agent.id,
    connectionId: wiring.id,
    connectionRevision: wiring.revision,
    runId: String(started.body.id),
    simulationId: simulations[0]?.id ?? "",
  };
}
