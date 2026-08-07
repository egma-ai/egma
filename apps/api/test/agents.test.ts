import { readFile } from "node:fs/promises";
import path from "node:path";

import { createApiKey, createProject, type AuthContext, type Role } from "@egma/db";
import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { hashApiKeySecret } from "../src/auth/api-key.ts";
import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/**
 * What a developer's `connect` can count on.
 *
 * Registering an agent is the first write anybody makes against egma, and it
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

type Person = {
  readonly userId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly cookie: string;
};

async function signUp(email: string, organizationName: string): Promise<Person> {
  const created = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: { email, password: "a-long-enough-password", organizationName },
  });
  expect(created.statusCode, created.body).toBe(201);

  const landed = created.json() as {
    userId: string;
    organization: { id: string };
    project: { id: string };
  };

  return {
    userId: landed.userId,
    organizationId: landed.organization.id,
    projectId: landed.project.id,
    cookie: cookiesFrom(created.headers["set-cookie"]),
  };
}

/** A colleague at a named role, added the way the product adds one. */
async function colleagueOf(
  host: Person,
  email: string,
  role: Role,
): Promise<Person> {
  const invited = await api.app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { cookie: host.cookie },
    payload: { email, role },
  });
  expect(invited.statusCode, invited.body).toBe(201);

  const link = (invited.json() as { accept_url: string }).accept_url;
  const joined = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      email,
      password: "a-long-enough-password",
      invitationToken: new URL(link).searchParams.get("token"),
    },
  });
  expect(joined.statusCode, joined.body).toBe(201);

  return {
    userId: (joined.json() as { userId: string }).userId,
    organizationId: host.organizationId,
    projectId: host.projectId,
    cookie: cookiesFrom(joined.headers["set-cookie"]),
  };
}

function contextFor(person: Person, role: Role): AuthContext {
  return {
    userId: person.userId,
    organizationId: person.organizationId,
    projectId: person.projectId,
    role,
    via: "session",
  };
}

/**
 * A key minted for somebody, and the secret only this test will ever see.
 * Minted through the module rather than the route so that the role it acts at
 * is stated by the test rather than inferred.
 */
async function keyFor(
  person: Person,
  role: Role,
  options: { readonly projectId?: string | null } = {},
): Promise<string> {
  const secret = `egma_sk_${newId("key")}`;
  await createApiKey(contextFor(person, role), {
    hash: hashApiKeySecret(secret),
    prefix: "egma_sk_",
    displaySuffix: secret.slice(-4),
    name: `${role} key`,
    projectId: options.projectId ?? null,
  });
  return secret;
}

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
  const response = await api.app.inject({ method: "POST", url, headers, payload });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function get(
  url: string,
  headers: Record<string, string>,
): Promise<Answer> {
  const response = await api.app.inject({ method: "GET", url, headers });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
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

describe("registering an agent", () => {
  it("writes the agent and the first way of reaching it in one request", async () => {
    api = await createApi("agents_register");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const registered = await post("/api/agents", withKey(key), registration());

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

    const { rows } = await api.database.sql<{ agents: string; connections: string }>(
      `select
         (select count(*) from agent) as agents,
         (select count(*) from connection) as connections`,
    );
    expect(rows[0]).toEqual({ agents: "1", connections: "1" });
  });

  it("leaves no agent behind when the connection payload is refused", async () => {
    api = await createApi("agents_all_or_nothing");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const refused = await post("/api/agents", withKey(key), {
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
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const claimed = await post("/api/agents", withKey(key), {
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
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const refused = await post("/api/agents", withKey(key), { name: "   " });

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message: "an agent needs a name",
    });
  });
});

describe("registering the same vendor agent again", () => {
  it("answers what is already there, with the credential rotated whole", async () => {
    api = await createApi("agents_reused");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const first = await post(
      "/api/agents",
      withKey(key),
      registration({ apiKey: "retell-secret-first-0000AAAA" }),
    );
    expect(first.body.result).toBe("created");

    const again = await post(
      "/api/agents",
      withKey(key),
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
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const chat = await post("/api/agents", withKey(key), registration());
    const voice = await post(
      "/api/agents",
      withKey(key),
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

    const one = await get(`/api/agents/${agentOf(chat).id}`, withKey(key));
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
   * The refusals this file asserts elsewhere are exactly what a caller would
   * see then — which is why this has to be a real race rather than two calls
   * in a row.
   */
  it("resolves racing registrations to one agent, not several", async () => {
    api = await createApi("agents_race");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    // One request first, so nothing below is measuring a cold path rather
    // than a race.
    expect((await get("/api/agents", withKey(key))).status).toBe(200);

    const racing = await Promise.all(
      Array.from({ length: 6 }, () =>
        post("/api/agents", withKey(key), registration({ name: "Racing" })),
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

describe("the vendor payload egma no longer keeps", () => {
  /**
   * Nothing ever read it back, and a stored copy of what lives at the provider
   * rots from the moment it is written. Dropping it silently would leave a
   * client believing egma held something it does not, so a body carrying it is
   * refused by name.
   */
  it("is refused as an unknown key, loudly rather than ignored", async () => {
    api = await createApi("agents_pulled_dropped");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const refused = await post("/api/agents", withKey(key), {
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
        "egma no longer keeps what was pulled from the provider, so a " +
        'registration has no "pulled" key. Drop it and send name, ' +
        "description, project, connection; the agent's content stays at the " +
        "provider, where egma reads it fresh rather than out of a copy that " +
        "would go stale.",
    });
    expect(await agentRowCount()).toBe(0);
  });

  it("refuses any other key a registration has no place for", async () => {
    api = await createApi("agents_unknown_key");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const refused = await post("/api/agents", withKey(key), {
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

  it("refuses a caller-supplied topology, which the type decides", async () => {
    api = await createApi("agents_topology_derived");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const refused = await post("/api/agents", withKey(key), {
      name: "Front desk",
      connection: {
        type: "retell",
        modality: "chat",
        topology: "egma-dials-in",
        config: { retellAgentId: "agent_in_retell_1" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
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
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const registered = await post("/api/agents", withKey(key), registration());
    const agentId = agentOf(registered).id as string;

    const second = await post(
      `/api/agents/${agentId}/connections`,
      withKey(key),
      {
        type: "retell",
        modality: "voice",
        config: { retellAgentId: "agent_in_retell_2" },
        credentials: { apiKey: "retell-secret-B2C3D4E5WXYZ" },
      },
    );

    expect(second.status).toBe(201);
    expect(connectionOf(registered).name).toBe("retell-1");
    expect(connectionOf(second).name).toBe("retell-2");
  });

  it("is refused when a living connection on the agent already holds it", async () => {
    api = await createApi("agents_connection_name_taken");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const registered = await post("/api/agents", withKey(key), registration());
    const agentId = agentOf(registered).id as string;

    const clash = await post(`/api/agents/${agentId}/connections`, withKey(key), {
      name: "retell-1",
      type: "retell",
      modality: "voice",
      config: { retellAgentId: "agent_in_retell_2" },
      credentials: { apiKey: "retell-secret-B2C3D4E5WXYZ" },
    });

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
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    await post("/api/agents", withKey(key), registration());

    // A different vendor agent, so the reuse rule does not answer this one —
    // the name is the whole of what refuses it.
    const clash = await post(
      "/api/agents",
      withKey(key),
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
   * shape a caller can reach is checked, because "absent from every read" is
   * the promise and one leaky endpoint would be the whole of the failure.
   */
  it("is absent from every read shape, and only its last four characters come back", async () => {
    api = await createApi("agents_sealed");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");
    const secret = "retell-secret-A1B2C3D4WXYZ";

    const registered = await post(
      "/api/agents",
      withKey(key),
      registration({ apiKey: secret }),
    );
    const agentId = agentOf(registered).id as string;

    const attached = await post(
      `/api/agents/${agentId}/connections`,
      withKey(key),
      {
        type: "retell",
        modality: "voice",
        config: { retellAgentId: "agent_in_retell_2" },
        credentials: { apiKey: secret },
      },
    );

    const one = await get(`/api/agents/${agentId}`, withKey(key));
    const listed = await get("/api/agents", withKey(key));

    for (const shape of [registered, attached, one, listed]) {
      const written = JSON.stringify(shape.body);
      expect(written).not.toContain(secret);
      expect(written).not.toContain("A1B2C3D4");
    }

    for (const held of one.body.connections as Record<string, unknown>[]) {
      expect(Object.keys(held).filter((named) => /credential/.test(named))).toEqual([
        "credentials_hint",
      ]);
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
  it("answers one envelope with a working cursor", async () => {
    api = await createApi("agents_list_cursor");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    for (const name of ["First", "Second", "Third"]) {
      expect((await post("/api/agents", withKey(key), { name })).status).toBe(201);
    }

    const page = await get("/api/agents?limit=2", withKey(key));
    expect(page.status).toBe(200);
    const first = page.body.items as { name: string }[];
    expect(first.map((one) => one.name)).toEqual(["Third", "Second"]);
    expect(page.body.next_cursor).toBeTypeOf("string");

    const rest = await get(
      `/api/agents?limit=2&cursor=${String(page.body.next_cursor)}`,
      withKey(key),
    );
    expect((rest.body.items as { name: string }[]).map((one) => one.name)).toEqual([
      "First",
    ]);
    expect(rest.body.next_cursor).toBeNull();
  });

  it("refuses a page size that is not a count", async () => {
    api = await createApi("agents_list_limit");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const refused = await get("/api/agents?limit=none", withKey(key));

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        'limit is how many agents one page may carry, at most 200, and "none" is not a count.',
    });
  });

  it("answers the agent with every living way of reaching it", async () => {
    api = await createApi("agents_fetch_one");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const registered = await post("/api/agents", withKey(key), registration());
    const agentId = agentOf(registered).id as string;

    const one = await get(`/api/agents/${agentId}`, withKey(key));

    expect(one.status).toBe(200);
    expect(agentOf(one).id).toBe(agentId);
    expect(one.body.connections).toHaveLength(1);
    expect((one.body.connections as Record<string, unknown>[])[0]?.id).toBe(
      connectionOf(registered).id,
    );
  });

  it("says nothing about an agent in another customer's account", async () => {
    api = await createApi("agents_tenancy");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");
    const adasKey = await keyFor(ada, "admin");
    const gracesKey = await keyFor(grace, "admin");

    const theirs = await post("/api/agents", withKey(gracesKey), registration());
    const agentId = agentOf(theirs).id as string;

    const reaching = await get(`/api/agents/${agentId}`, withKey(adasKey));
    expect(reaching.status).toBe(404);
    expect(reaching.body).toEqual({
      error: "not_found",
      message:
        "no agent of yours has that id. Check the id, or list your agents with GET /api/agents.",
    });

    // The same sentence for an id nobody ever minted, so a guess tells the
    // guesser nothing.
    const guessed = await get(`/api/agents/${newId("agt")}`, withKey(adasKey));
    expect(guessed.body).toEqual(reaching.body);

    // And attaching through somebody else's agent reads the same way.
    const attaching = await post(
      `/api/agents/${agentId}/connections`,
      withKey(adasKey),
      {
        type: "retell",
        modality: "voice",
        config: { retellAgentId: "agent_in_retell_2" },
        credentials: { apiKey: "retell-secret-B2C3D4E5WXYZ" },
      },
    );
    expect(attaching.status).toBe(404);
    expect(attaching.body).toEqual(reaching.body);

    expect((await get("/api/agents", withKey(adasKey))).body.items).toEqual([]);
  });
});

describe("what each role may do here", () => {
  it("lets a viewer read agents and every way of reaching them", async () => {
    api = await createApi("agents_viewer_reads");
    const ada = await signUp("ada@acme.example", "Acme");
    const vic = await colleagueOf(ada, "vic@acme.example", "viewer");
    const adasKey = await keyFor(ada, "admin");
    const vicsKey = await keyFor(vic, "viewer");

    const registered = await post("/api/agents", withKey(adasKey), registration());
    const agentId = agentOf(registered).id as string;

    const listed = await get("/api/agents", withKey(vicsKey));
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);

    const one = await get(`/api/agents/${agentId}`, withKey(vicsKey));
    expect(one.status).toBe(200);
    expect(one.body.connections).toHaveLength(1);
  });

  it("refuses a viewer every write in this group", async () => {
    api = await createApi("agents_viewer_writes_nothing");
    const ada = await signUp("ada@acme.example", "Acme");
    const vic = await colleagueOf(ada, "vic@acme.example", "viewer");
    const adasKey = await keyFor(ada, "admin");
    const vicsKey = await keyFor(vic, "viewer");

    const registered = await post("/api/agents", withKey(adasKey), registration());
    const agentId = agentOf(registered).id as string;

    const refusal = {
      error: "not_permitted",
      message: "a viewer may not configure_agents",
    };

    const registering = await post(
      "/api/agents",
      withKey(vicsKey),
      registration({ name: "Theirs" }),
    );
    expect(registering.status).toBe(403);
    expect(registering.body).toEqual(refusal);

    const attaching = await post(
      `/api/agents/${agentId}/connections`,
      withKey(vicsKey),
      {
        type: "retell",
        modality: "voice",
        config: { retellAgentId: "agent_in_retell_2" },
        credentials: { apiKey: "retell-secret-B2C3D4E5WXYZ" },
      },
    );
    expect(attaching.status).toBe(403);
    expect(attaching.body).toEqual(refusal);

    expect(await agentRowCount()).toBe(1);
  });

  it("lets a member register and attach with their own key", async () => {
    api = await createApi("agents_member_writes");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");
    const miasKey = await keyFor(mia, "member");

    const registered = await post("/api/agents", withKey(miasKey), registration());
    expect(registered.status).toBe(201);

    const attached = await post(
      `/api/agents/${String(agentOf(registered).id)}/connections`,
      withKey(miasKey),
      {
        type: "retell",
        modality: "voice",
        config: { retellAgentId: "agent_in_retell_2" },
        credentials: { apiKey: "retell-secret-B2C3D4E5WXYZ" },
      },
    );
    expect(attached.status).toBe(201);
  });
});

describe("which project a write lands in", () => {
  it("takes the organization's project when the key names none and the body names none", async () => {
    api = await createApi("agents_default_project");
    const ada = await signUp("ada@acme.example", "Acme");
    const forEverything = await keyFor(ada, "admin", { projectId: null });

    const registered = await post(
      "/api/agents",
      withKey(forEverything),
      registration(),
    );

    expect(registered.status).toBe(201);
    expect(agentOf(registered).project_id).toBe(ada.projectId);
  });

  it("writes into the project the body names, when it is one of the customer's", async () => {
    api = await createApi("agents_named_project");
    const ada = await signUp("ada@acme.example", "Acme");
    const forEverything = await keyFor(ada, "admin", { projectId: null });
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    const registered = await post("/api/agents", withKey(forEverything), {
      ...registration(),
      project: outbound.id,
    });

    expect(registered.status).toBe(201);
    expect(agentOf(registered).project_id).toBe(outbound.id);
  });

  it("refuses a project belonging to another customer", async () => {
    api = await createApi("agents_foreign_project");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");
    const forEverything = await keyFor(ada, "admin", { projectId: null });

    const reaching = await post("/api/agents", withKey(forEverything), {
      ...registration(),
      project: grace.projectId,
    });

    expect(reaching.status).toBe(403);
    expect(reaching.body).toEqual({
      error: "not_permitted",
      message:
        `project ${grace.projectId} is not in your organization. A write may ` +
        "name a project of your own organization or leave it out, and which " +
        "organization this is always comes from the key.",
    });
    expect(await agentRowCount()).toBe(0);
  });

  it("refuses a sibling project the key was not minted for", async () => {
    api = await createApi("agents_scoped_key");
    const ada = await signUp("ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });
    const forDefault = await keyFor(ada, "admin", { projectId: ada.projectId });

    const reaching = await post("/api/agents", withKey(forDefault), {
      ...registration(),
      project: outbound.id,
    });

    expect(reaching.status).toBe(403);
    expect(reaching.body).toEqual({
      error: "not_permitted",
      message:
        `this credential acts in project ${ada.projectId}, and the request ` +
        `named ${outbound.id}. A key minted for one product area writes into ` +
        "that one; drop the project, or use a key for the whole organization.",
    });
    expect(await agentRowCount()).toBe(0);
  });
});

describe("a request egma cannot place", () => {
  it("is refused before anything in the body is read", async () => {
    api = await createApi("agents_not_authenticated");
    await signUp("ada@acme.example", "Acme");

    const refusal = {
      error: "not_authenticated",
      message:
        "this request carried no session and no usable API key. " +
        "Sign in, or send Authorization: Bearer with an egma key.",
    };

    // A body that would be refused twice over if anything read it: an unknown
    // key and a connection egma would turn away. It hears about the key.
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

describe("the paths this group answers on", () => {
  /**
   * A browser reaches egma at one origin, and the pages process forwards the
   * API's paths to the API. A path with no rule there is a path Next answers
   * itself, with a 404 nobody can debug from the outside — so the rules are
   * asserted here rather than discovered by somebody opening a page. Per path
   * and never a catch-all: the pages process owns `/api/health` and a
   * wildcard would take it.
   */
  it("are forwarded by the process a browser loads the pages from", async () => {
    const rewrites = await readFile(
      path.join(import.meta.dirname, "../../web/next.config.ts"),
      "utf8",
    );

    expect(rewrites).toContain('source: "/api/agents"');
    expect(rewrites).toContain('source: "/api/agents/:path*"');
  });
});
