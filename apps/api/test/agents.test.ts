import {
  createAgent,
  createProject,
  type AuthContext,
  type Role,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  contextFor,
  mintKey,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * What a developer's `connect` can count on.
 *
 * Registering an agent is the first write anybody makes against Egma, and it
 * happens from a terminal, often through a coding agent, often twice because
 * the first attempt's answer was lost. So the promises tested here are the
 * ones that make that safe: the agent and the first way of reaching it are
 * written together or not at all; registering the same vendor agent again
 * answers what is already there rather than minting a second identity; the
 * provider key is sealed on arrival and never comes back; and every refusal
 * carries a stable code and a sentence a coding agent can act on without a
 * person reading the screen.
 *
 * Every refusal sentence in this file is asserted word for word. A client
 * relays them to the terminal unchanged, so the wording is the contract.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

function withKey(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

/** The registration a developer's connect sends. */
function registration(
  overrides: {
    readonly name?: string;
    readonly modality?: string;
    readonly retellAgentId?: string;
    readonly apiKey?: string;
    readonly connectionName?: string;
  } = {},
): Record<string, unknown> {
  return {
    name: overrides.name ?? "Front desk",
    connection: {
      ...(overrides.connectionName === undefined
        ? {}
        : { name: overrides.connectionName }),
      type: "retell",
      modality: overrides.modality ?? "chat",
      config: { retellAgentId: overrides.retellAgentId ?? "agent_in_retell_1" },
      credentials: { apiKey: overrides.apiKey ?? "retell-secret-A1B2C3D4WXYZ" },
    },
  };
}

type Answer = {
  readonly status: number;
  readonly body: Record<string, unknown>;
};

async function post(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<Answer> {
  const response = await api.app.inject({
    method: "POST",
    url,
    headers,
    payload,
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

async function get(
  url: string,
  headers: Record<string, string>,
): Promise<Answer> {
  const response = await api.app.inject({ method: "GET", url, headers });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

function agentOf(answer: Answer): Record<string, unknown> {
  return answer.body.agent as Record<string, unknown>;
}

function connectionOf(answer: Answer): Record<string, unknown> {
  return answer.body.connection as Record<string, unknown>;
}

async function agentRowCount(): Promise<number> {
  const { rows } = await api.database.sql<{ count: string }>(
    "select count(*) as count from agent",
  );
  return Number(rows[0]?.count ?? "-1");
}

/** An otherwise valid retell connection, spoiled one field at a time. */
function connectionPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "retell",
    modality: "voice",
    config: { retellAgentId: "agent_in_retell_2" },
    credentials: { apiKey: "retell-secret-B2C3D4E5WXYZ" },
    ...overrides,
  };
}

describe("registering an agent", () => {
  it("writes the agent and the first way of reaching it in one request", async () => {
    api = await createApi("agents_register");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const registered = await post(
      "/api/agents",
      withKey(ada.secret),
      registration(),
    );

    expect(registered.status).toBe(201);
    expect(registered.body.result).toBe("created");
    expect(agentOf(registered)).toMatchObject({
      name: "Front desk",
      project_id: ada.projectId,
      description: null,
    });
    expect(connectionOf(registered)).toMatchObject({
      agent_id: agentOf(registered).id,
      name: "retell-1",
      type: "retell",
      modality: "chat",
      // Derived from the type, never caller-supplied.
      topology: "hosted-broker",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials_hint: "WXYZ",
    });

    const { rows } = await api.database.sql<{
      agents: string;
      connections: string;
    }>(
      `select
         (select count(*) from agent) as agents,
         (select count(*) from connection) as connections`,
    );
    expect(rows[0]).toEqual({ agents: "1", connections: "1" });
  });

  it("leaves no agent behind when the connection payload is refused", async () => {
    api = await createApi("agents_all_or_nothing");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await post("/api/agents", withKey(ada.secret), {
      name: "Front desk",
      connection: {
        type: "retell",
        modality: "chat",
        // One letter wrong, which is the whole point: a typo dies at the door.
        config: { retellAgentld: "agent_in_retell_1" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        'a retell connection\'s config has no key "retellAgentld"; it holds retellAgentId',
    });
    expect(await agentRowCount()).toBe(0);
  });

  it("claims an identity on its own when no connection is named", async () => {
    api = await createApi("agents_identity_only");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const claimed = await post("/api/agents", withKey(ada.secret), {
      name: "Not wired yet",
      description: "credentials are still with the platform team",
    });

    expect(claimed.status).toBe(201);
    expect(claimed.body.result).toBe("created");
    expect(claimed.body).not.toHaveProperty("connection");
    expect(agentOf(claimed).description).toBe(
      "credentials are still with the platform team",
    );
  });

  it("refuses a registration with no name, in the factory's own words", async () => {
    api = await createApi("agents_needs_a_name");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await post("/api/agents", withKey(ada.secret), {
      name: "   ",
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message: "an agent needs a name",
    });
  });
});

describe("a connection payload its type will not take", () => {
  /**
   * The connection registry owns these four rules and writes their sentences,
   * and the route relays them without touching a word. They are asserted here
   * rather than only at the seam below because the sentence a developer's
   * terminal prints is the one that came over the wire.
   */
  it("names an unknown connection type, and what Egma does know", async () => {
    api = await createApi("agents_unknown_type");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await post("/api/agents", withKey(ada.secret), {
      name: "Front desk",
      connection: connectionPayload({ type: "vapi" }),
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        '"vapi" is not a connection type Egma knows; expected one of retell, phone, livekit',
    });
    expect(await agentRowCount()).toBe(0);
  });

  it("names a modality the type does not speak", async () => {
    api = await createApi("agents_wrong_modality");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await post("/api/agents", withKey(ada.secret), {
      name: "Reception line",
      connection: {
        type: "phone",
        modality: "chat",
        config: { phoneNumber: "+15551234567" },
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        "a phone connection speaks voice, and this one was asked for chat",
    });
  });

  it("names the credentials shape when none arrived", async () => {
    api = await createApi("agents_no_credentials");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await post("/api/agents", withKey(ada.secret), {
      name: "Front desk",
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_1" },
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message: "a retell connection needs credentials shaped { apiKey }",
    });
  });

  it("names the floor under a credential that arrived too short", async () => {
    api = await createApi("agents_short_credential");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await post("/api/agents", withKey(ada.secret), {
      name: "Front desk",
      connection: connectionPayload({ credentials: { apiKey: "short" } }),
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        "a retell connection's credentials need apiKey to be at least 8 characters",
    });
  });

  it("refuses a connection sent with a blank name, in the factory's own words", async () => {
    api = await createApi("agents_connection_needs_a_name");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await post("/api/agents", withKey(ada.secret), {
      name: "Front desk",
      connection: connectionPayload({ name: "   " }),
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message: "a connection needs a name",
    });
    expect(await agentRowCount()).toBe(0);
  });
});

/**
 * The livekit type through the door a developer actually knocks on.
 *
 * A LiveKit connection is the first one where Egma opens the room and the
 * customer's agent joins it, which is what makes an agent running on a laptop
 * reachable at all. Two things are asserted here rather than only at the seam:
 * the sentences, because the one a terminal prints is the one that came over
 * the wire; and the secret, because this is the door it arrives through.
 */
describe("a livekit connection", () => {
  /** The credential halves, each tailed so a hint can only come from the key. */
  const API_KEY = "APIsentinelkey0WXYZ";
  const API_SECRET = "SENTINEL-livekit-secret-3f9c2a7e";

  function livekitPayload(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      type: "livekit",
      modality: "voice",
      config: { url: "wss://acme.livekit.cloud" },
      credentials: { apiKey: API_KEY, apiSecret: API_SECRET },
      ...overrides,
    };
  }

  it("is registered with a url alone, and dials out", async () => {
    api = await createApi("agents_livekit_bare");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const registered = await post("/api/agents", withKey(ada.secret), {
      name: "Quickstart agent",
      connection: livekitPayload(),
    });

    expect(registered.status).toBe(201);
    expect(connectionOf(registered)).toMatchObject({
      name: "livekit-1",
      type: "livekit",
      modality: "voice",
      // Derived from the type, never caller-supplied.
      topology: "agent-dials-out",
      config: { url: "wss://acme.livekit.cloud" },
      // The last four of the key. The secret has no hint and no line at all.
      credentials_hint: "WXYZ",
    });
    expect(connectionOf(registered)).not.toHaveProperty("credentials");
  });

  it("is registered with an agent name and metadata too, and reads both back", async () => {
    api = await createApi("agents_livekit_dispatched");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const registered = await post("/api/agents", withKey(ada.secret), {
      name: "Dispatched agent",
      connection: livekitPayload({
        config: {
          url: "wss://acme.livekit.cloud",
          agentName: "front-desk",
          metadata: '{"tenant":"acme"}',
        },
      }),
    });

    expect(registered.status).toBe(201);

    const one = await get(
      `/api/agents/${String(agentOf(registered).id)}`,
      withKey(ada.secret),
    );
    const [reached] = one.body.connections as Record<string, unknown>[];
    expect(reached).toMatchObject({
      config: {
        url: "wss://acme.livekit.cloud",
        agentName: "front-desk",
        metadata: '{"tenant":"acme"}',
      },
      credentials_hint: "WXYZ",
    });
    expect(reached).not.toHaveProperty("credentials");
  });

  /**
   * The second shape through the same door: a connection that names where to
   * ask for a token instead of carrying the key pair that would mint one.
   *
   * What a read shows is the whole point of the shape. The endpoint is
   * configuration and comes back; the headers that authenticate Egma to it are
   * a credential and do not, hinted by their names — which is what a person
   * needs to recognise the connection, and is not a secret, where the last
   * four characters of a bearer token would be four real characters of one.
   */
  it("is registered with a token endpoint instead of a key pair", async () => {
    api = await createApi("agents_livekit_endpoint");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const registered = await post("/api/agents", withKey(ada.secret), {
      name: "Production agent",
      connection: {
        type: "livekit",
        modality: "voice",
        config: {
          url: "wss://acme.livekit.cloud",
          tokenEndpoint: "https://acme.example/egma/livekit-token",
        },
        credentials: { headers: '{"Authorization":"Bearer not-a-real-token"}' },
      },
    });

    expect(registered.status).toBe(201);
    expect(connectionOf(registered)).toMatchObject({
      type: "livekit",
      modality: "voice",
      topology: "agent-dials-out",
      config: {
        url: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://acme.example/egma/livekit-token",
      },
      credentials_hint: "Authorization",
    });
    expect(connectionOf(registered)).not.toHaveProperty("credentials");
  });

  /**
   * An endpoint on a private network can be reachable only from Egma and open
   * to it. The hardening recipe says not to leave it that way and says what an
   * open one means, but the door cannot see whose network the endpoint is on,
   * so it does not turn that advice into a rule it would be lying about.
   */
  it("is registered with no credentials at all, when the endpoint is open", async () => {
    api = await createApi("agents_livekit_open_endpoint");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const registered = await post("/api/agents", withKey(ada.secret), {
      name: "Private-network agent",
      connection: {
        type: "livekit",
        modality: "voice",
        config: {
          url: "ws://livekit.internal:7880",
          tokenEndpoint: "http://tokens.internal/egma",
        },
      },
    });

    expect(registered.status).toBe(201);
    expect(connectionOf(registered)).toMatchObject({
      config: {
        url: "ws://livekit.internal:7880",
        tokenEndpoint: "http://tokens.internal/egma",
      },
      credentials_hint: null,
    });
  });

  /**
   * Every way a livekit payload can be wrong, and the sentence each one gets.
   * Word for word: a client relays these to a terminal a coding agent reads,
   * and the fix it picks comes out of the wording.
   */
  const REFUSED: readonly {
    readonly named: string;
    /** Short and stable, because it names the test's own database. */
    readonly slug: string;
    readonly payload: Record<string, unknown>;
    readonly message: string;
  }[] = [
    {
      named: "a modality a livekit connection does not speak",
      slug: "wrong_modality",
      payload: { modality: "chat" },
      message:
        "a livekit connection speaks voice, and this one was asked for chat",
    },
    {
      named: "a word that is not a modality at all",
      slug: "not_a_modality",
      payload: { modality: "telepathy" },
      message: '"telepathy" is not a modality; a livekit connection speaks voice',
    },
    {
      named: "no url",
      slug: "no_url",
      payload: { config: {} },
      message: "a livekit connection's config needs url",
    },
    {
      named: "a url in a scheme the SDKs do not take",
      slug: "bad_url",
      payload: { config: { url: "sip:acme.livekit.cloud" } },
      message:
        "the config's url must be a ws, wss, http or https URL, which looks " +
        "like wss://example.livekit.cloud",
    },
    {
      named: "an agent name that is there but blank",
      slug: "blank_agent_name",
      payload: {
        config: { url: "wss://acme.livekit.cloud", agentName: "   " },
      },
      message: "the config's agentName must be a non-empty string",
    },
    {
      named: "metadata that is not a JSON object",
      slug: "bad_metadata",
      payload: {
        config: { url: "wss://acme.livekit.cloud", metadata: "tenant=acme" },
      },
      message:
        "the config's metadata must be a JSON object written in a string, " +
        'which looks like {"tenant":"acme"}',
    },
    {
      named: "a config key a livekit connection has no place for",
      slug: "unknown_config_key",
      payload: {
        config: { url: "wss://acme.livekit.cloud", roomName: "lobby" },
      },
      message:
        'a livekit connection\'s config has no key "roomName"; it holds url, ' +
        "agentName (optional), metadata (optional)",
    },
    {
      // Neither of the two shapes: no key pair, and no endpoint to ask for a
      // token either. The sentence names both doors, because either is a
      // whole answer and a caller who read about one may have missed the
      // other.
      named: "no credentials at all",
      slug: "no_credentials",
      payload: { credentials: undefined },
      message:
        "a livekit connection mints its own tokens, so it needs the " +
        "project's apiKey and apiSecret. Send the pair, or name a " +
        "tokenEndpoint in the config and Egma will ask that endpoint for a " +
        "token instead — which is the shape where the project's secret " +
        "never leaves the customer.",
    },
    {
      named: "a key pair sent alongside a token endpoint",
      slug: "pair_and_endpoint",
      payload: {
        config: {
          url: "wss://acme.livekit.cloud",
          tokenEndpoint: "https://acme.example/egma/livekit-token",
        },
      },
      message:
        "a livekit connection whose config names a tokenEndpoint asks that " +
        "endpoint for every token, so it holds no key pair of its own: its " +
        "credentials are the endpoint's auth headers, shaped { headers }. " +
        "Send those, or drop the tokenEndpoint and Egma will mint its own " +
        "tokens from an apiKey and apiSecret.",
    },
    {
      named: "endpoint headers on a connection that names no endpoint",
      slug: "headers_no_endpoint",
      payload: {
        credentials: { headers: '{"Authorization":"Bearer not-real"}' },
      },
      message:
        "a livekit connection mints its own tokens, so it needs the " +
        "project's apiKey and apiSecret. Send the pair, or name a " +
        "tokenEndpoint in the config and Egma will ask that endpoint for a " +
        "token instead — which is the shape where the project's secret " +
        "never leaves the customer.",
    },
    {
      // The two URL keys pasted the wrong way round: Egma POSTs to this one.
      named: "a token endpoint in a scheme Egma cannot post to",
      slug: "bad_token_endpoint",
      payload: {
        config: {
          url: "wss://acme.livekit.cloud",
          tokenEndpoint: "wss://acme.livekit.cloud",
        },
        credentials: { headers: '{"Authorization":"Bearer not-real"}' },
      },
      message:
        "the config's tokenEndpoint must be an http or https URL, which " +
        "looks like https://example.com/egma/livekit-token",
    },
    {
      // Dispatching is a power a key pair buys, and this shape has none.
      named: "an agent to dispatch on a connection that cannot dispatch",
      slug: "agent_name_with_endpoint",
      payload: {
        config: {
          url: "wss://acme.livekit.cloud",
          tokenEndpoint: "https://acme.example/egma/livekit-token",
          agentName: "front-desk",
        },
        credentials: { headers: '{"Authorization":"Bearer not-real"}' },
      },
      message:
        'a token-endpoint livekit connection\'s config has no key "agentName"; ' +
        "it holds url, tokenEndpoint",
    },
    {
      named: "headers that are not a JSON object of name to value",
      slug: "bad_headers",
      payload: {
        config: {
          url: "wss://acme.livekit.cloud",
          tokenEndpoint: "https://acme.example/egma/livekit-token",
        },
        credentials: { headers: "Authorization: Bearer not-real" },
      },
      message:
        "a token-endpoint livekit connection's credentials need headers to " +
        "be a JSON object of header name to header value, written in a " +
        'string, which looks like {"Authorization":"Bearer …"}',
    },
    {
      named: "only half the credential",
      slug: "half_credential",
      payload: { credentials: { apiKey: API_KEY } },
      message:
        "a livekit connection's credentials need apiSecret to be a non-empty string",
    },
    {
      named: "a credential half too short for its hint to stay a hint",
      slug: "short_credential",
      payload: { credentials: { apiKey: API_KEY, apiSecret: "abcd" } },
      message:
        "a livekit connection's credentials need apiSecret to be at least 8 characters",
    },
    {
      // Even the right answer: the type decides it, so there is nowhere in a
      // request to put one.
      named: "a topology of its own choosing",
      slug: "supplied_topology",
      payload: { topology: "agent-dials-out" },
      message:
        'a connection has no key "topology"; it holds name, type, modality, ' +
        "environment, config, credentials",
    },
    {
      named: "a credential key that does not belong",
      slug: "unknown_credential_key",
      payload: {
        credentials: {
          apiKey: API_KEY,
          apiSecret: API_SECRET,
          apiToken: "sentinel-token-not-a-field",
        },
      },
      message:
        'a livekit connection\'s credentials have no key "apiToken"; they are ' +
        "shaped { apiKey, apiSecret }",
    },
  ];

  it.each(REFUSED)("is refused for $named, naming it", async (refusal) => {
    api = await createApi(`agents_lk_${refusal.slug}`);
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await post("/api/agents", withKey(ada.secret), {
      name: "Quickstart agent",
      connection: livekitPayload(refusal.payload),
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message: refusal.message,
    });
    expect(await agentRowCount()).toBe(0);
  });

  /**
   * The secret half, followed everywhere it could surface.
   *
   * `apiSecret` is the one field on a livekit connection that Egma can never
   * hand back and can never write down in the clear: it signs the tokens that
   * open rooms on the customer's own LiveKit project. So this drives a
   * registration that works and several that are refused, all carrying the
   * same sentinel, and then looks for that sentinel in every place a value can
   * end up — the answers, the log, the read models and the row itself.
   *
   * The refused ones matter more than the one that worked. A refusal is where
   * a value gets quoted back to explain what was wrong with it, and it is
   * where an error carrying a payload gets written to a log.
   */
  it("never appears in an answer, a log line, a read or a row", async () => {
    const lines: string[] = [];
    api = await createApi("agents_livekit_secret", {
      logTo: {
        write(line) {
          lines.push(line);
        },
      },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const answers = [
      // The one that works, so the sealing path is walked too.
      await post("/api/agents", withKey(ada.secret), {
        name: "Quickstart agent",
        connection: livekitPayload(),
      }),
      // And the refusals, each with the secret sitting in the body.
      ...(await Promise.all(
        REFUSED.map((refusal) =>
          post("/api/agents", withKey(ada.secret), {
            name: `Refused ${refusal.named}`,
            connection: livekitPayload(refusal.payload),
          }),
        ),
      )),
    ];

    const registered = answers[0];
    if (registered === undefined) throw new Error("nothing was registered");
    const agentId = String(agentOf(registered).id);
    answers.push(await get(`/api/agents/${agentId}`, withKey(ada.secret)));
    answers.push(await get("/api/agents", withKey(ada.secret)));

    for (const answer of answers) {
      expect(JSON.stringify(answer.body)).not.toContain(API_SECRET);
    }

    // The log, which is the output nobody reads until something has gone
    // wrong — and by then the secret would be sitting in a shipped file.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(API_SECRET);

    // And the row underneath, where only the sealed envelope belongs.
    const { rows } = await api.database.sql<{
      credentials: string;
      credentials_hint: string;
      config: Record<string, string>;
    }>("select credentials, credentials_hint, config from connection");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.credentials).not.toContain(API_SECRET);
    expect(rows[0]?.credentials).toMatch(/^v1\./);
    expect(rows[0]?.credentials_hint).toBe("WXYZ");
    expect(JSON.stringify(rows[0]?.config)).not.toContain(API_SECRET);
  });

  /**
   * The same walk for the other shape's secret.
   *
   * An `Authorization: Bearer …` header is a reusable credential: whoever
   * holds it can ask the customer's endpoint for a token into any room it will
   * mint one for. So it lives where credentials live and is followed the same
   * way — through a registration that works, a read, a list, and every refusal
   * carrying it — and what a read shows of it is the header's *name*, which is
   * not a secret, rather than a tail of its value, which is.
   */
  it("keeps an endpoint's auth header out of every answer, log, read and row", async () => {
    const HEADER_SECRET = "SENTINEL-endpoint-bearer-4c81ea";
    const headers = `{"Authorization":"Bearer ${HEADER_SECRET}"}`;
    const endpointPayload = (
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      type: "livekit",
      modality: "voice",
      config: {
        url: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://acme.example/egma/livekit-token",
      },
      credentials: { headers },
      ...overrides,
    });

    const lines: string[] = [];
    api = await createApi("agents_livekit_header", {
      logTo: {
        write(line) {
          lines.push(line);
        },
      },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const answers = [
      await post("/api/agents", withKey(ada.secret), {
        name: "Production agent",
        connection: endpointPayload(),
      }),
      // And the refusals, each with the header sitting in the body: a refusal
      // is where a value gets quoted back to explain what was wrong with it.
      await post("/api/agents", withKey(ada.secret), {
        name: "Refused for a stray credential key",
        connection: endpointPayload({
          credentials: { headers, apiKey: "APIsomethingelse" },
        }),
      }),
      await post("/api/agents", withKey(ada.secret), {
        name: "Refused for a modality it does not speak",
        connection: endpointPayload({ modality: "chat" }),
      }),
      await post("/api/agents", withKey(ada.secret), {
        name: "Refused for headers with no endpoint",
        connection: endpointPayload({
          config: { url: "wss://acme.livekit.cloud" },
        }),
      }),
    ];

    const registered = answers[0];
    if (registered === undefined) throw new Error("nothing was registered");
    expect(registered.status).toBe(201);
    const agentId = String(agentOf(registered).id);
    answers.push(await get(`/api/agents/${agentId}`, withKey(ada.secret)));
    answers.push(await get("/api/agents", withKey(ada.secret)));

    for (const answer of answers) {
      expect(JSON.stringify(answer.body)).not.toContain(HEADER_SECRET);
    }

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(HEADER_SECRET);

    const { rows } = await api.database.sql<{
      credentials: string;
      credentials_hint: string;
      config: Record<string, string>;
    }>("select credentials, credentials_hint, config from connection");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.credentials).not.toContain(HEADER_SECRET);
    expect(rows[0]?.credentials).toMatch(/^v1\./);
    // The name, and nothing of the value it authenticates with.
    expect(rows[0]?.credentials_hint).toBe("Authorization");
    expect(JSON.stringify(rows[0]?.config)).not.toContain(HEADER_SECRET);
  });
});

describe("registering the same vendor agent again", () => {
  it("answers what is already there, with the credential rotated whole", async () => {
    api = await createApi("agents_reused");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const first = await post(
      "/api/agents",
      withKey(ada.secret),
      registration({ apiKey: "retell-secret-first-0000AAAA" }),
    );
    expect(first.body.result).toBe("created");

    const again = await post(
      "/api/agents",
      withKey(ada.secret),
      registration({ apiKey: "retell-secret-second-1111ZZZZ" }),
    );

    expect(again.status).toBe(200);
    expect(again.body.result).toBe("reused");
    expect(agentOf(again).id).toBe(agentOf(first).id);
    expect(connectionOf(again).id).toBe(connectionOf(first).id);

    // The hint is the whole of what a read can see, so it is the whole of what
    // can show that the newly supplied key is the one now stored.
    expect(connectionOf(first).credentials_hint).toBe("AAAA");
    expect(connectionOf(again).credentials_hint).toBe("ZZZZ");

    // And underneath, the envelope was replaced rather than merged into: the
    // old key is not in the row, and neither is the new one in plain text.
    const sealed = await api.database.sql<{ credentials: string }>(
      "select credentials from connection",
    );
    expect(sealed.rows).toHaveLength(1);
    const envelope = sealed.rows[0]?.credentials ?? "";
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(envelope).not.toContain("0000AAAA");
    expect(envelope).not.toContain("1111ZZZZ");

    const { rows } = await api.database.sql<{
      agents: string;
      connections: string;
    }>(
      `select
         (select count(*) from agent) as agents,
         (select count(*) from connection) as connections`,
    );
    expect(rows[0]).toEqual({ agents: "1", connections: "1" });
  });

  it("adds a second way of reaching the same agent when the modality changed", async () => {
    api = await createApi("agents_connection_added");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const chat = await post(
      "/api/agents",
      withKey(ada.secret),
      registration(),
    );
    const voice = await post(
      "/api/agents",
      withKey(ada.secret),
      registration({ modality: "voice" }),
    );

    expect(voice.status).toBe(201);
    expect(voice.body.result).toBe("connection_added");
    expect(agentOf(voice).id).toBe(agentOf(chat).id);
    expect(connectionOf(voice).id).not.toBe(connectionOf(chat).id);
    expect(connectionOf(voice)).toMatchObject({
      name: "retell-2",
      modality: "voice",
    });

    const one = await get(
      `/api/agents/${String(agentOf(chat).id)}`,
      withKey(ada.secret),
    );
    expect(
      (one.body.connections as { name: string }[]).map((held) => held.name),
    ).toEqual(["retell-1", "retell-2"]);
    expect(await agentRowCount()).toBe(1);
  });

  /**
   * A retry storm, which is what an uncertain network failure actually looks
   * like: several identical registrations in flight at once, none of them
   * knowing whether any of the others landed.
   *
   * Six rather than two on purpose. Two requests through the whole HTTP path
   * tend to stay one query apart and never meet inside the write; six overlap,
   * and without the transaction settling them they collide on the agent name.
   * The refusals this file asserts elsewhere are exactly what a client would
   * see then — which is why this has to be a real race rather than two calls
   * in a row.
   */
  it("resolves racing registrations to one agent, not several", async () => {
    api = await createApi("agents_race");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    // One request first, so nothing below is measuring a cold path rather
    // than a race.
    expect((await get("/api/agents", withKey(ada.secret))).status).toBe(200);

    const racing = await Promise.all(
      Array.from({ length: 6 }, () =>
        post(
          "/api/agents",
          withKey(ada.secret),
          registration({ name: "Racing" }),
        ),
      ),
    );

    // Exactly one of them created; every other one found it and said so.
    const results = racing.map((one) => one.body.result);
    expect(results.filter((one) => one === "created")).toHaveLength(1);
    expect(results.filter((one) => one === "reused")).toHaveLength(5);
    expect(racing.map((one) => one.status).sort()).toEqual([
      200, 200, 200, 200, 200, 201,
    ]);

    expect(new Set(racing.map((one) => agentOf(one).id)).size).toBe(1);
    expect(new Set(racing.map((one) => connectionOf(one).id)).size).toBe(1);
    expect(await agentRowCount()).toBe(1);
  });
});

describe("the vendor payload Egma no longer keeps", () => {
  /**
   * Nothing ever read it back, and a stored copy of what lives at the provider
   * rots from the moment it is written. Dropping it silently would leave a
   * client believing Egma held something it does not, so a body carrying it is
   * refused by name.
   */
  it("is refused as an unknown key, loudly rather than ignored", async () => {
    api = await createApi("agents_pulled_dropped");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await post("/api/agents", withKey(ada.secret), {
      ...registration(),
      pulled: {
        vendor: "retell",
        documents: [{ of: "prompt", body: "you are a receptionist" }],
        prompt: "you are a receptionist",
        voice: null,
        tools: [],
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        "Egma no longer keeps what was pulled from the provider, so a " +
        'registration has no "pulled" key. Drop it and send name, ' +
        "description, project, connection; the agent's content stays at the " +
        "provider, where Egma reads it fresh rather than out of a copy that " +
        "would go stale.",
    });
    expect(await agentRowCount()).toBe(0);
  });

  /** The same refusal on the other object, naming that object and its keys. */
  it("is refused on a connection body too, naming that object's own keys", async () => {
    api = await createApi("agents_pulled_on_connection");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const registered = await post(
      "/api/agents",
      withKey(ada.secret),
      registration(),
    );

    const refused = await post(
      `/api/agents/${String(agentOf(registered).id)}/connections`,
      withKey(ada.secret),
      connectionPayload({ pulled: { vendor: "retell" } }),
    );

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        "Egma no longer keeps what was pulled from the provider, so a " +
        'connection has no "pulled" key. Drop it and send name, type, ' +
        "modality, environment, config, credentials; the agent's content " +
        "stays at the provider, where Egma reads it fresh rather than out of " +
        "a copy that would go stale.",
    });
  });

  it("refuses any other key a registration has no place for", async () => {
    api = await createApi("agents_unknown_key");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await post("/api/agents", withKey(ada.secret), {
      name: "Front desk",
      organization: "org_somebody_elses",
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        'a registration has no key "organization"; it holds name, description, project, connection',
    });
  });

  it("refuses a supplied topology, which the type decides", async () => {
    api = await createApi("agents_topology_derived");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await post("/api/agents", withKey(ada.secret), {
      name: "Front desk",
      connection: connectionPayload({ topology: "egma-dials-in" }),
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        'a connection has no key "topology"; it holds name, type, modality, environment, config, credentials',
    });
  });
});

describe("a connection's name", () => {
  it("defaults to the smallest free numbered name for its type", async () => {
    api = await createApi("agents_default_names");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const registered = await post(
      "/api/agents",
      withKey(ada.secret),
      registration(),
    );
    const agentId = String(agentOf(registered).id);

    const second = await post(
      `/api/agents/${agentId}/connections`,
      withKey(ada.secret),
      connectionPayload(),
    );

    expect(second.status).toBe(201);
    expect(connectionOf(registered).name).toBe("retell-1");
    expect(connectionOf(second).name).toBe("retell-2");
  });

  it("is refused when a living connection on the agent already holds it", async () => {
    api = await createApi("agents_connection_name_taken");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const registered = await post(
      "/api/agents",
      withKey(ada.secret),
      registration(),
    );

    const clash = await post(
      `/api/agents/${String(agentOf(registered).id)}/connections`,
      withKey(ada.secret),
      connectionPayload({ name: "retell-1" }),
    );

    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({
      error: "name_taken",
      message: 'a connection named "retell-1" already exists on this agent',
    });
  });
});

describe("an agent's name", () => {
  it("is refused when a living agent in the project already holds it", async () => {
    api = await createApi("agents_name_taken");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    await post("/api/agents", withKey(ada.secret), registration());

    // A different vendor agent, so the reuse rule does not answer this one —
    // the name is the whole of what refuses it.
    const clash = await post(
      "/api/agents",
      withKey(ada.secret),
      registration({ retellAgentId: "agent_in_retell_9" }),
    );

    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({
      error: "name_taken",
      message: 'an agent named "Front desk" already exists in this project',
    });
  });
});

describe("a sealed credential", () => {
  /**
   * The stored value is ciphertext and the read shape has no line for it at
   * all, so there is no serializer anybody could forget to strip it in. Every
   * shape a client can reach is checked, because "absent from every read" is
   * the promise and one leaky endpoint would be the whole of the failure.
   */
  it("is absent from every read shape, and only its last four characters come back", async () => {
    api = await createApi("agents_sealed");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const secret = "retell-secret-A1B2C3D4WXYZ";

    const registered = await post(
      "/api/agents",
      withKey(ada.secret),
      registration({ apiKey: secret }),
    );
    const agentId = String(agentOf(registered).id);

    const attached = await post(
      `/api/agents/${agentId}/connections`,
      withKey(ada.secret),
      connectionPayload({ credentials: { apiKey: secret } }),
    );

    const one = await get(`/api/agents/${agentId}`, withKey(ada.secret));
    const listed = await get("/api/agents", withKey(ada.secret));

    for (const shape of [registered, attached, one, listed]) {
      const written = JSON.stringify(shape.body);
      expect(written).not.toContain(secret);
      expect(written).not.toContain("A1B2C3D4");
    }

    for (const held of one.body.connections as Record<string, unknown>[]) {
      expect(
        Object.keys(held).filter((named) => /credential/.test(named)),
      ).toEqual(["credentials_hint"]);
      expect(held.credentials_hint).toBe("WXYZ");
    }

    // And what actually landed is a versioned envelope, not the key.
    const { rows } = await api.database.sql<{ credentials: string }>(
      "select credentials from connection",
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.credentials.startsWith("v1.")).toBe(true);
      expect(row.credentials).not.toContain(secret);
    }
  });
});

describe("reading agents", () => {
  /**
   * One envelope, and a cursor rather than a page number. A page is a page —
   * there is no size to ask for — so the setup writes past one through the
   * factory and the reading is done over HTTP, which is the part under test.
   */
  it("answers one envelope with a working cursor", async () => {
    api = await createApi("agents_list_cursor");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const acting = contextFor(ada, "admin");

    for (let n = 0; n < 51; n += 1) {
      await createAgent(acting, { name: `Agent ${String(n).padStart(2, "0")}` });
    }

    const page = await get("/api/agents", withKey(ada.secret));
    expect(page.status).toBe(200);
    const first = page.body.items as { name: string }[];
    expect(first).toHaveLength(50);
    // Newest first, because the agent somebody is looking for is usually the
    // one they just registered.
    expect(first[0]?.name).toBe("Agent 50");
    expect(page.body.next_cursor).toBeTypeOf("string");

    const rest = await get(
      `/api/agents?cursor=${String(page.body.next_cursor)}`,
      withKey(ada.secret),
    );
    expect(
      (rest.body.items as { name: string }[]).map((one) => one.name),
    ).toEqual(["Agent 00"]);
    expect(rest.body.next_cursor).toBeNull();
  });

  it("refuses a cursor that is not an agent id", async () => {
    api = await createApi("agents_list_cursor_refused");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await get(
      "/api/agents?cursor=not-an-id",
      withKey(ada.secret),
    );

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        '"not-an-id" is not an agent id, so it cannot be a cursor. Send back ' +
        "the next_cursor from the page before this one, or leave it out to " +
        "start at the newest.",
    });
  });

  it("answers the agent with every living way of reaching it", async () => {
    api = await createApi("agents_fetch_one");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const registered = await post(
      "/api/agents",
      withKey(ada.secret),
      registration(),
    );
    const agentId = String(agentOf(registered).id);

    const one = await get(`/api/agents/${agentId}`, withKey(ada.secret));

    expect(one.status).toBe(200);
    expect(agentOf(one).id).toBe(agentId);
    expect(one.body.connections).toHaveLength(1);
    expect((one.body.connections as Record<string, unknown>[])[0]?.id).toBe(
      connectionOf(registered).id,
    );
  });

  it("says nothing about an agent in another customer's account", async () => {
    api = await createApi("agents_tenancy");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const theirs = await post(
      "/api/agents",
      withKey(grace.secret),
      registration(),
    );
    const agentId = String(agentOf(theirs).id);

    const reaching = await get(`/api/agents/${agentId}`, withKey(ada.secret));
    expect(reaching.status).toBe(404);
    expect(reaching.body).toEqual({
      error: "not_found",
      message:
        "no agent of yours has that id. Check the id, or list your agents with GET /api/agents.",
    });

    // The same sentence for an id nobody ever minted, so a guess tells the
    // guesser nothing.
    const guessed = await get(
      `/api/agents/${newId("agt")}`,
      withKey(ada.secret),
    );
    expect(guessed.body).toEqual(reaching.body);

    // And attaching through somebody else's agent reads the same way.
    const attaching = await post(
      `/api/agents/${agentId}/connections`,
      withKey(ada.secret),
      connectionPayload(),
    );
    expect(attaching.status).toBe(404);
    expect(attaching.body).toEqual(reaching.body);

    expect((await get("/api/agents", withKey(ada.secret))).body.items).toEqual(
      [],
    );
  });
});

describe("what each role may do here", () => {
  it("lets a viewer read agents and every way of reaching them", async () => {
    api = await createApi("agents_viewer_reads");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const vic = await colleagueOf(api.app, ada, "vic@acme.example", "viewer");

    const registered = await post(
      "/api/agents",
      withKey(ada.secret),
      registration(),
    );

    const listed = await get("/api/agents", withKey(vic.secret));
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);

    const one = await get(
      `/api/agents/${String(agentOf(registered).id)}`,
      withKey(vic.secret),
    );
    expect(one.status).toBe(200);
    expect(one.body.connections).toHaveLength(1);
  });

  it("refuses a viewer every write in this group", async () => {
    api = await createApi("agents_viewer_writes_nothing");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const vic = await colleagueOf(api.app, ada, "vic@acme.example", "viewer");

    const registered = await post(
      "/api/agents",
      withKey(ada.secret),
      registration(),
    );

    const refusal = {
      error: "not_permitted",
      message: "a viewer may not configure_agents",
    };

    const registering = await post(
      "/api/agents",
      withKey(vic.secret),
      registration({ name: "Theirs" }),
    );
    expect(registering.status).toBe(403);
    expect(registering.body).toEqual(refusal);

    const attaching = await post(
      `/api/agents/${String(agentOf(registered).id)}/connections`,
      withKey(vic.secret),
      connectionPayload(),
    );
    expect(attaching.status).toBe(403);
    expect(attaching.body).toEqual(refusal);

    expect(await agentRowCount()).toBe(1);
  });

  it("lets a member register and attach with their own key", async () => {
    api = await createApi("agents_member_writes");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const mia = await colleagueOf(api.app, ada, "mia@acme.example", "member");

    const registered = await post(
      "/api/agents",
      withKey(mia.secret),
      registration(),
    );
    expect(registered.status).toBe(201);

    const attached = await post(
      `/api/agents/${String(agentOf(registered).id)}/connections`,
      withKey(mia.secret),
      connectionPayload(),
    );
    expect(attached.status).toBe(201);
  });
});

describe("the project a request names", () => {
  it("takes the organization's project when the key names none and the body names none", async () => {
    api = await createApi("agents_default_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const registered = await post(
      "/api/agents",
      withKey(ada.secret),
      registration(),
    );

    expect(registered.status).toBe(201);
    expect(agentOf(registered).project_id).toBe(ada.projectId);
  });

  it("writes into the project the body names, when it is one of the customer's", async () => {
    api = await createApi("agents_named_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    const registered = await post("/api/agents", withKey(ada.secret), {
      ...registration(),
      project: outbound.id,
    });

    expect(registered.status).toBe(201);
    expect(agentOf(registered).project_id).toBe(outbound.id);
  });

  it("narrows a read to the project the query names", async () => {
    api = await createApi("agents_read_filter");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    // With two projects to choose from, a write naming none is asked to name
    // one — the same words the other route groups answer with, because the
    // oldest-project guess is the silent narrowing this codebase refuses.
    const unnamed = await post(
      "/api/agents",
      withKey(ada.secret),
      registration(),
    );
    expect(unnamed.status).toBe(400);
    expect(unnamed.body).toEqual({
      error: "invalid_request",
      message:
        "this organization holds more than one project and this credential " +
        "names none, so Egma cannot tell which project this is about. Send " +
        "project with the one you mean, or use a key minted for that project.",
    });

    await post("/api/agents", withKey(ada.secret), {
      ...registration(),
      project: ada.projectId,
    });
    await post("/api/agents", withKey(ada.secret), {
      ...registration({ name: "Outbound desk", retellAgentId: "agent_two" }),
      project: outbound.id,
    });

    const whole = await get("/api/agents", withKey(ada.secret));
    expect(
      (whole.body.items as { name: string }[]).map((one) => one.name),
    ).toEqual(["Outbound desk", "Front desk"]);

    const narrowed = await get(
      `/api/agents?project=${outbound.id}`,
      withKey(ada.secret),
    );
    expect(
      (narrowed.body.items as { name: string }[]).map((one) => one.name),
    ).toEqual(["Outbound desk"]);
  });

  /**
   * One rule for reads and writes both. A read that answered an empty list
   * would be saying "you have no agents there" about a project that was never
   * this customer's to ask about.
   */
  it("refuses a project belonging to another customer, on a write and on a read alike", async () => {
    api = await createApi("agents_foreign_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const refusal = {
      error: "not_permitted",
      message:
        `project ${grace.projectId} is not in your organization. A request ` +
        "may name a project of your own organization or leave it out, and " +
        "which organization this is always comes from the key.",
    };

    const writing = await post("/api/agents", withKey(ada.secret), {
      ...registration(),
      project: grace.projectId,
    });
    expect(writing.status).toBe(403);
    expect(writing.body).toEqual(refusal);
    expect(await agentRowCount()).toBe(0);

    const reading = await get(
      `/api/agents?project=${grace.projectId}`,
      withKey(ada.secret),
    );
    expect(reading.status).toBe(403);
    expect(reading.body).toEqual(refusal);
  });

  it("refuses a sibling project the key was not minted for, saying which verb", async () => {
    api = await createApi("agents_scoped_key");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });
    const forDefault = await mintKey(
      api.app,
      ada.cookie,
      "default only",
      ada.projectId,
    );

    const writing = await post("/api/agents", withKey(forDefault), {
      ...registration(),
      project: outbound.id,
    });
    expect(writing.status).toBe(403);
    expect(writing.body).toEqual({
      error: "not_permitted",
      message:
        `this credential acts in project ${ada.projectId}, and the request ` +
        `named ${outbound.id}. A key minted for one product area writes into ` +
        "that one; drop the project, or use a key for the whole organization.",
    });
    expect(await agentRowCount()).toBe(0);

    const reading = await get(
      `/api/agents?project=${outbound.id}`,
      withKey(forDefault),
    );
    expect(reading.status).toBe(403);
    expect(reading.body).toEqual({
      error: "not_permitted",
      message:
        `this credential acts in project ${ada.projectId}, and the request ` +
        `named ${outbound.id}. A key minted for one product area reads that ` +
        "one; drop the project, or use a key for the whole organization.",
    });
  });
});

describe("a request Egma cannot place", () => {
  it("is refused before anything in the body is read", async () => {
    api = await createApi("agents_not_authenticated");
    await signUp(api.app, "ada@acme.example", "Acme");

    const refusal = {
      error: "not_authenticated",
      message:
        "this request carried no session and no usable API key. " +
        "Sign in, or send Authorization: Bearer with an Egma key.",
    };

    // A body that would be refused twice over if anything read it: an unknown
    // key and a connection Egma would turn away. It hears about the key.
    const nobody = await post(
      "/api/agents",
      withKey("egma_sk_this-was-never-a-key-anybody-was-given"),
      { ...registration(), pulled: { vendor: "retell" } },
    );
    expect(nobody.status).toBe(401);
    expect(nobody.body).toEqual(refusal);

    const anonymous = await api.app.inject({
      method: "GET",
      url: "/api/agents",
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual(refusal);
  });
});
