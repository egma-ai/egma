import { newId } from "@egma/ids";
import { enablePullProductionCalls, getSimulation } from "@egma/db";
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
 * refusal code, a stale-write conflict, a credential that never comes back, and
 * an Archive that settles work already queued. Every one of those is the same
 * whoever asked, and a real Chrome would prove nothing extra while costing a
 * minute.
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

type AgentBody = {
  readonly id: string;
  readonly name: string;
  readonly retellModality: "voice" | "chat" | null;
  readonly description: string | null;
  readonly revision: string;
  readonly archived: boolean;
};

type ConnectionBody = {
  readonly id: string;
  readonly name: string;
  readonly agentPlatform: string | null;
  readonly connectionType: string;
  readonly accessVariant: string;
  readonly productLabel: string;
  readonly revision: string;
  readonly archived: boolean;
  readonly credentialPresent: boolean;
  readonly credentialsHint: string | null;
  readonly config: Record<string, string>;
};

const RETELL_KEY = "retell-secret-A1B2C3D4WXYZ";

async function anAgent(who: Customer, name: string): Promise<AgentBody> {
  const created = await browser("POST", "/v1/agents", who, { agentPlatform: "retell", name });
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
      connectionType: "retell_chat_api",
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
  it("is a name and a platform binding, never the provider's configuration", async () => {
    api = await createApi("agents_browser_identity");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const edited = await browser("PATCH", `/v1/agents/${agent.id}`, ada, {
      name: "Front desk, renamed",
    });
    expect(edited.status).toBe(200);
    expect(held<AgentBody>(edited, "agent").name).toBe("Front desk, renamed");

    // No prompt, no model, no tools: those live at the provider, and a read
    // carrying a copy would be a copy going stale. No description either — it
    // was dropped pre-launch (ADR-0015).
    const read = await browser("GET", `/v1/agents/${agent.id}`, ada);
    const shape = held<Record<string, unknown>>(read, "agent");
    for (const provider of ["prompt", "model", "tools", "voice", "pulled"]) {
      expect(Object.keys(shape)).not.toContain(provider);
    }
    expect(Object.keys(shape)).not.toContain("description");
    expect(Object.keys(shape)).not.toContain("revision");

    // What it does carry: where the agent lives, whether egma pulls its
    // production calls, and when one last arrived. The platform was declared
    // at registration; pulling is off and nothing has arrived — which is a fact and
    // not a condition, so no word beside it says how the agent is doing.
    expect(shape).toMatchObject({
      agentPlatform: "retell",
      platformAgentId: null,
      retellModality: null,
      monitoringKeyPresent: false,
      pullProductionCalls: false,
      monitoringConfigured: false,
      lastReceivedAt: null,
    });
    expect(Object.keys(shape)).toContain("lastReceivedAt");

    // And an edit that tried to set the provider's own configuration is
    // refused by name rather than having the key quietly dropped.
    const tried = await browser("PATCH", `/v1/agents/${agent.id}`, ada, {
      prompt: "You are a helpful agent",
    });
    expect(tried.status).toBe(400);
    expect(String(tried.body.message)).toContain("prompt");
  });

  it("keeps Retell Chat after its active connection is archived", async () => {
    api = await createApi("agents_browser_retell_modality_history");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const agent = await anAgent(ada, "Front desk");
    const chat = await aConnection(ada, agent.id);

    const active = await browser("GET", `/v1/agents/${agent.id}`, ada);
    expect(held<AgentBody>(active, "agent").retellModality).toBe("chat");

    const archived = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections/${chat.id}/archive`,
      ada,
      {},
    );
    expect(archived.status).toBe(200);

    const after = await browser("GET", `/v1/agents/${agent.id}`, ada);
    expect(held<AgentBody>(after, "agent").retellModality).toBe("chat");
    expect(held<readonly ConnectionBody[]>(after, "connections")).toEqual([]);

    const listed = await browser("GET", "/v1/agents", ada);
    const [row] = held<
      readonly (AgentBody & { readonly connections: readonly ConnectionBody[] })[]
    >(listed, "agents");
    expect(row?.retellModality).toBe("chat");
    expect(row?.connections).toEqual([]);
  });

  it("takes the last write, because there is no revision to be stale against", async () => {
    // The column was dropped pre-launch (ADR-0015). Two editors on one agent
    // is a silent overwrite now — the exact failure the revision existed to
    // stop, accepted with eyes open — and a browser that still sent one is
    // refused by name rather than having it quietly ignored.
    api = await createApi("agents_browser_last_writer_wins");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const agent = await anAgent(ada, "Front desk");

    const first = await browser("PATCH", `/v1/agents/${agent.id}`, ada, {
      name: "Edited first",
    });
    expect(first.status).toBe(200);

    const second = await browser("PATCH", `/v1/agents/${agent.id}`, ada, {
      name: "Edited second",
    });
    expect(second.status).toBe(200);

    const read = await browser("GET", `/v1/agents/${agent.id}`, ada);
    expect(held<AgentBody>(read, "agent").name).toBe("Edited second");

    const stale = await browser("PATCH", `/v1/agents/${agent.id}`, ada, {
      name: "Edited third",
      expectedRevision: "rev_00000000000000000000000001",
    });
    expect(stale.status).toBe(400);
    expect(String(stale.body.message)).toContain("expectedRevision");

    // A connection lost the same column and answers the same way. It used to
    // list the key as one it accepts and then drop it, so a browser holding on
    // to optimistic locking was told its edit was safe when nothing checked.
    const wiring = await aConnection(ada, agent.id, { name: "staging" });
    const staleWiring = await browser(
      "PATCH",
      `/v1/agents/${agent.id}/connections/${wiring.id}`,
      ada,
      { name: "renamed", expectedRevision: "rev_00000000000000000000000001" },
    );
    expect(staleWiring.status).toBe(400);
    expect(String(staleWiring.body.message)).toContain("expectedRevision");
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
 * Archive and Restore are identity writes, and nothing guards them any more.
 *
 * The revision column was dropped from `agent` and `connection` pre-launch
 * (ADR-0015), so the race this block used to prove — one tab archiving while
 * another, holding a page from before a rename, restores — now resolves
 * silently in favour of whoever wrote last. That is the accepted consequence,
 * written down here so that a reader meets it rather than assuming a guard
 * that is gone.
 */
describe("what an Archive or a Restore is written against", () => {
  it("is nothing: a stale tab's Archive simply lands", async () => {
    api = await createApi("agents_browser_archive_last_writer_wins");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");

    // Two tabs on the same agent. The first renames it; the second is still
    // holding the page from before, and is told nothing about that.
    const renamed = await browser("PATCH", `/v1/agents/${agent.id}`, ada, {
      name: "Front desk, renamed",
    });
    expect(renamed.status).toBe(200);

    const archived = await browser(
      "POST",
      `/v1/agents/${agent.id}/archive`,
      ada,
      {},
    );
    expect(archived.status).toBe(200);
    expect(held<AgentBody>(archived, "agent").archived).toBe(true);
    // The rename survives the Archive: last-writer-wins is per write, not a
    // rollback of what somebody else already landed.
    expect(held<AgentBody>(archived, "agent").name).toBe("Front desk, renamed");

    const back = await browser(
      "POST",
      `/v1/agents/${agent.id}/restore`,
      ada,
      {},
    );
    expect(back.status).toBe(200);
    expect(held<AgentBody>(back, "agent").archived).toBe(false);
  });

  it("is nothing for a connection either", async () => {
    api = await createApi("agents_browser_connection_last_writer_wins");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id, { name: "staging" });
    const at = `/v1/agents/${agent.id}/connections/${wiring.id}`;

    const renamed = await browser("PATCH", at, ada, {
      name: "staging, renamed",
    });
    expect(renamed.status).toBe(200);

    const archived = await browser("POST", `${at}/archive`, ada, {});
    expect(archived.status).toBe(200);
    expect(held<ConnectionBody>(archived, "connection").archived).toBe(true);

    // A Retell chat connection's credential does not come back with it, so a
    // Restore still has to bring one. That rule is the access variant's, not
    // the revision's, and it is untouched by this pass.
    const back = await browser("POST", `${at}/restore`, ada, {
      credential: {
        choice: "replace",
        credentials: { apiKey: "retell-secret-NEW1NEW2ABCD" },
      },
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
        readonly connectionType: string;
        readonly accessVariant: string;
        readonly modality: string;
        readonly productLabel: string;
        readonly simulatorAdapter: boolean;
        readonly credentialRule: string;
        readonly fields: readonly { readonly key: string; readonly kind: string }[];
        readonly credentialFields: readonly { readonly field: string }[];
      }[]
    >(catalog, "items");

    const livekit = items.filter(
      (one) =>
        one.agentPlatform === "livekit" &&
        one.connectionType === "livekit_room",
    );
    // Access variant and modality together, because one variant now carries
    // two rows: the pair is what a form offers, and either half alone would
    // stop describing the product the moment chat landed.
    expect(
      livekit.map((one) => `${one.accessVariant}/${one.modality}`),
    ).toEqual([
      "livekit_room.project_credentials/voice",
      "livekit_room.project_credentials/chat",
      "livekit_room.customer_token_endpoint/voice",
    ]);
    expect(livekit.map((one) => one.productLabel)).toEqual([
      "LiveKit project credentials",
      "LiveKit chat",
      "LiveKit token endpoint",
    ]);

    // The three credential rules the product's Restore is written against,
    // each named on the shape that has it.
    // The chat-native door is dormant, so a form is never offered it; the
    // text door is the Retell shape a person picks.
    expect(
      items.some((one) => one.connectionType === "retell_chat_api"),
    ).toBe(false);
    expect(
      items.find((one) => one.connectionType === "retell_text_mode")
        ?.credentialRule,
    ).toBe("required");
    expect(
      items.find(
        (one) =>
          one.agentPlatform === null &&
          one.connectionType === "phone_number",
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

describe("which platform a connection is stored under", () => {
  it("refuses a phone payload that contradicts its bound agent, and says both", async () => {
    api = await createApi("agents_browser_platform_contradiction");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const agent = await anAgent(ada, "Front desk");

    // Bind the agent to Retell the way the product does: turn its pull switch
    // on with a Retell key.
    await enablePullProductionCalls(
      {
        userId: ada.userId,
        organizationId: ada.organizationId,
        projectId: ada.projectId,
        role: "admin",
        via: "session",
      },
      {
        agentId: agent.id,
        agentPlatform: "retell",
        platformAgentId: "agent_voice_1",
        apiKey: "key_live_retell_monitoring_secret_QRST",
      },
    );

    // `phone_number` reaches any platform, so this connection would be stored
    // as Retell's whatever the payload claims.
    const refused = await browser(
      "POST",
      `/v1/agents/${agent.id}/connections`,
      ada,
      {
        name: "hotline",
        agentPlatform: "livekit",
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
        modality: "voice",
        config: { phoneNumber: "+15551234567" },
      },
    );

    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe("unprocessable");
    expect(String(refused.body.message)).toContain("livekit");
    expect(String(refused.body.message)).toContain("retell");

    // Nothing was written, so the agent is exactly as it was.
    const read = await browser("GET", `/v1/agents/${agent.id}`, ada);
    expect(read.body.connections).toEqual([]);
  });

  // The two admitted paths — a payload that agrees with its agent, and one on
  // an unbound agent — are proven where they belong: at the access layer in
  // `connections.test.ts`, and through the door in `agents.test.ts`, which
  // already carries the Retell confirmation a phone connection needs.
});

describe("a connection's shape", () => {
  it("is stored at create and cannot be edited into the other one", async () => {
    api = await createApi("agents_browser_variant_immutable");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const agent = await anAgent(ada, "Front desk");
    const wiring = await aConnection(ada, agent.id, {
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "voice",
      config: { url: "wss://acme.livekit.cloud", agentName: "front-desk" },
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
      connectionType: "phone_number",
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
      agentPlatform: "livekit",
      connectionType: "livekit_room",
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
    // the graders, personas and tests follow — and nothing in the group
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
      [
        "POST",
        "/v1/agents",
        { name: "Theirs", agentPlatform: "retell" },
      ],
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
    expect(archived.body.canceledRunCount).toBe(1);

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
 * builds one: Egma's Predefined persona, a test that names it, and a run over
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

  const suite = await browser("POST", "/v1/test-suites", who, {
    name: "Front desk regression",
  });
  expect(suite.status, JSON.stringify(suite.body)).toBe(201);
  const suiteId = String(suite.body.id);

  const written = await browser("POST", "/v1/tests", who, {
    suiteId,
    name: "Books an appointment",
    scenario: "The caller wants an appointment next week.",
    expectedBehaviors: ["The agent offers a time"],
    personas: ["Everyday caller"],
  });
  expect(written.status, JSON.stringify(written.body)).toBe(201);

  const started = await browser("POST", "/v1/runs", who, {
    suiteId,
    agentId: agent.id,
    connectionId: wiring.id,
    idempotencyKey: newId("run"),
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const page = await browser(
    "GET",
    `/v1/runs/${String(started.body.id)}/simulations?pageSize=1`,
    who,
  );
  expect(page.status, JSON.stringify(page.body)).toBe(200);
  const simulations = page.body.simulations as readonly { id: string }[];

  return {
    agentId: agent.id,
    connectionId: wiring.id,
    connectionRevision: wiring.revision,
    runId: String(started.body.id),
    simulationId: simulations[0]?.id ?? "",
  };
}
