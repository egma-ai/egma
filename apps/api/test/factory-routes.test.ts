import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@egma/ids";

import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

type Person = {
  readonly cookie: string;
};

async function signUp(email: string, organizationName: string): Promise<Person> {
  const response = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: { email, password: "a-long-enough-password", organizationName },
  });
  expect(response.statusCode, response.body).toBe(201);
  return { cookie: cookiesFrom(response.headers["set-cookie"]) };
}

async function viewerOf(host: Person, email: string): Promise<Person> {
  const invited = await api.app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { cookie: host.cookie },
    payload: { email, role: "viewer" },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  const token = new URL(
    (invited.json() as { accept_url: string }).accept_url,
  ).searchParams.get("token");
  const joined = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      email,
      password: "a-long-enough-password",
      invitationToken: token,
    },
  });
  expect(joined.statusCode, joined.body).toBe(201);
  return { cookie: cookiesFrom(joined.headers["set-cookie"]) };
}

const retellConnection = {
  name: "retell-chat",
  type: "retell",
  modality: "chat",
  environment: "development",
  config: { retellAgentId: "agent_external_123" },
  credentials: { apiKey: "retell_secret_123456" },
} as const;

describe("the first factory API", () => {
  it("requires a credential on every resource list", async () => {
    api = await createApi("factory_anonymous");

    for (const url of ["/v1/agents", "/v1/tests"]) {
      const response = await api.app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json()).toMatchObject({ error: "not_authenticated" });
    }
  });

  it("lets a viewer read but never author agents or tests", async () => {
    api = await createApi("factory_viewer");
    const owner = await signUp("ada@acme.example", "Acme");
    const viewer = await viewerOf(owner, "vic@acme.example");

    const listed = await api.app.inject({
      method: "GET",
      url: "/v1/agents",
      headers: { cookie: viewer.cookie },
    });
    expect(listed.statusCode).toBe(200);

    for (const request of [
      { url: "/v1/agents", payload: { name: "Front desk" } },
      {
        url: "/v1/tests",
        payload: {
          name: "First call",
          scenario: "A caller asks for an appointment.",
          expected_behaviors: ["Offers a time"],
        },
      },
    ]) {
      const response = await api.app.inject({
        method: "POST",
        url: request.url,
        headers: { cookie: viewer.cookie },
        payload: request.payload,
      });
      expect(response.statusCode, request.url).toBe(403);
      expect(response.json()).toMatchObject({ error: "not_permitted" });
    }
  });

  it("keeps projects apart and never returns a submitted provider secret", async () => {
    api = await createApi("factory_tenancy_secret");
    const acme = await signUp("ada@acme.example", "Acme");
    const globex = await signUp("grace@globex.example", "Globex");

    const created = await api.app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { cookie: acme.cookie },
      payload: { name: "Front desk", connection: retellConnection },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.body).not.toContain(retellConnection.credentials.apiKey);
    expect(created.json()).toHaveProperty("project_id");
    expect(created.json()).not.toHaveProperty("projectId");
    const body = created.json() as {
      id: string;
      connection: { id: string };
    };

    const fetched = await api.app.inject({
      method: "GET",
      url: `/v1/agents/${body.id}/connections/${body.connection.id}`,
      headers: { cookie: acme.cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body).not.toContain(retellConnection.credentials.apiKey);
    expect(fetched.json()).not.toHaveProperty("credentials");

    const byProvider = await api.app.inject({
      method: "GET",
      url: `/v1/agents/retell/${retellConnection.config.retellAgentId}`,
      headers: { cookie: acme.cookie },
    });
    expect(byProvider.statusCode).toBe(200);
    expect(
      (byProvider.json() as { items: { id: string }[] }).items.map(
        (agent) => agent.id,
      ),
    ).toEqual([body.id]);

    const defaultPersona = await api.app.inject({
      method: "GET",
      url: "/v1/personas/default",
      headers: { cookie: acme.cookie },
    });
    expect(defaultPersona.statusCode).toBe(200);
    expect(defaultPersona.json()).toMatchObject({
      id: expect.stringMatching(/^prs_/),
      project_id: expect.stringMatching(/^prj_/),
    });

    const foreign = await api.app.inject({
      method: "GET",
      url: `/v1/agents/${body.id}`,
      headers: { cookie: globex.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ error: "no_such_agent" });
  });

  it("returns a stable 400 for bad input and writes no partial resources", async () => {
    api = await createApi("factory_invalid");
    const owner = await signUp("ada@acme.example", "Acme");
    const before = await api.database.sql<{ agents: string; tests: string }>(
      `select
         (select count(*) from agent) as agents,
         (select count(*) from test) as tests`,
    );

    const requests = [
      { method: "POST", url: "/v1/agents", payload: [] },
      { method: "POST", url: "/v1/agents", payload: { name: "One", description: 42 } },
      {
        method: "POST",
        url: "/v1/agents",
        payload: {
          name: "Front desk",
          connection: { ...retellConnection, config: {} },
        },
      },
      {
        method: "POST",
        url: "/v1/tests",
        payload: { name: "First call", scenario: "A caller asks." },
      },
      {
        method: "POST",
        url: "/v1/tests",
        payload: {
          name: "First call",
          scenario: "A caller asks.",
          expected_behaviors: ["Answers"],
          persona_ids: [newId("prs")],
        },
      },
      { method: "GET", url: "/v1/agents?limit=abc" },
    ] as const;

    for (const request of requests) {
      const response = await api.app.inject({
        ...request,
        headers: { cookie: owner.cookie },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_request" });
    }

    const after = await api.database.sql<{ agents: string; tests: string }>(
      `select
         (select count(*) from agent) as agents,
         (select count(*) from test) as tests`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("uses 409 for a valid create whose live name is already taken", async () => {
    api = await createApi("factory_conflict");
    const owner = await signUp("ada@acme.example", "Acme");
    const first = await api.app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { cookie: owner.cookie },
      payload: { name: "Front desk" },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await api.app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { cookie: owner.cookie },
      payload: { name: "Front desk" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: "resource_conflict" });

    const listed = await api.app.inject({
      method: "GET",
      url: "/v1/agents?name=Front%20desk",
      headers: { cookie: owner.cookie },
    });
    expect(listed.json()).toMatchObject({ next_cursor: null });
  });

  it("serializes concurrent onboarding test creates by idempotency key", async () => {
    api = await createApi("factory_idempotent_test");
    const owner = await signUp("ada@acme.example", "Acme");
    const request = () =>
      api.app.inject({
        method: "POST",
        url: "/v1/tests",
        headers: { cookie: owner.cookie },
        payload: {
          name: "First simulation",
          scenario: "A caller asks for the next appointment.",
          expected_behaviors: ["Offers a time"],
          idempotency_key: "egma-init:agent_external_123",
        },
      });

    const [first, second] = await Promise.all([request(), request()]);
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect((first.json() as { id: string }).id).toBe(
      (second.json() as { id: string }).id,
    );
    const counted = await api.database.sql<{ count: string }>(
      "select count(*) as count from test",
    );
    expect(counted.rows).toEqual([{ count: "1" }]);
  });
});
