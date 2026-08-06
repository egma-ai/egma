import type {
  Agent,
  Connection,
  CreatedAgent,
  Page,
  Persona,
  Test,
} from "./types.ts";

type Json = Record<string, unknown>;
type WirePage<T> = { readonly items: readonly T[]; readonly next_cursor: string | null };
type WireAgent = {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly connection?: WireConnection;
};
type WireConnection = {
  readonly id: string;
  readonly agent_id: string;
  readonly project_id: string;
  readonly name: string;
  readonly type: string;
  readonly modality: string;
  readonly config: Readonly<Record<string, string>>;
  readonly credentials_hint: string | null;
};
type WireTest = {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  readonly version_id: string;
  readonly scenario: string;
  readonly expected_behaviors: readonly string[];
  readonly personas: readonly {
    readonly id: string;
    readonly name: string;
    readonly deleted_at: string | null;
  }[];
};
type WirePersona = {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
};

function agentFrom(value: WireAgent): Agent {
  return {
    id: value.id,
    projectId: value.project_id,
    name: value.name,
    description: value.description,
  };
}

function connectionFrom(value: WireConnection): Connection {
  return {
    id: value.id,
    agentId: value.agent_id,
    projectId: value.project_id,
    name: value.name,
    type: value.type,
    modality: value.modality,
    config: value.config,
    credentialsHint: value.credentials_hint,
  };
}

function testFrom(value: WireTest): Test {
  return {
    id: value.id,
    projectId: value.project_id,
    name: value.name,
    description: value.description,
    version: value.version,
    versionId: value.version_id,
    scenario: value.scenario,
    expectedBehaviors: value.expected_behaviors,
    personas: value.personas.map((persona) => ({
      id: persona.id,
      name: persona.name,
      deletedAt: persona.deleted_at,
    })),
  };
}

function personaFrom(value: WirePersona): Persona {
  return { id: value.id, projectId: value.project_id, name: value.name };
}

/**
 * A credential may leave the machine only over TLS. Loopback HTTP stays useful
 * for local development, where there is no network hop to protect.
 */
export function egmaBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`"${value}" is not a valid Egma base URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "the Egma base URL must use HTTPS, except for a local development server",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("the Egma base URL must not contain a username or password");
  }
  return url.toString().replace(/\/+$/u, "");
}

export class EgmaApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, body: unknown) {
    const answer =
      typeof body === "object" && body !== null
        ? (body as { error?: unknown; message?: unknown })
        : {};
    const message =
      typeof answer.message === "string"
        ? answer.message
        : `Egma answered HTTP ${status}`;
    super(message);
    this.name = "EgmaApiError";
    this.status = status;
    this.code = typeof answer.error === "string" ? answer.error : undefined;
  }
}

export class EgmaApi {
  readonly baseUrl: string;
  readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = egmaBaseUrl(baseUrl);
    this.apiKey = apiKey;
  }

  private async request<T>(
    method: "GET" | "POST",
    route: string,
    body?: Json,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) throw new EgmaApiError(response.status, answer);
    return answer as T;
  }

  async listAgents(cursor?: string, name?: string): Promise<Page<Agent>> {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor !== undefined) query.set("cursor", cursor);
    if (name !== undefined) query.set("name", name);
    const found = await this.request<WirePage<WireAgent>>(
      "GET",
      `/v1/agents?${query.toString()}`,
    );
    return {
      items: found.items.map(agentFrom),
      ...(found.next_cursor === null ? {} : { nextCursor: found.next_cursor }),
    };
  }

  async getAgent(id: string): Promise<Agent> {
    return agentFrom(
      await this.request("GET", `/v1/agents/${encodeURIComponent(id)}`),
    );
  }

  async findRetellAgents(retellAgentId: string): Promise<CreatedAgent[]> {
    const found = await this.request<{ readonly items: WireAgent[] }>(
      "GET",
      `/v1/agents/retell/${encodeURIComponent(retellAgentId)}`,
    );
    return found.items.map((agent) => ({
      ...agentFrom(agent),
      ...(agent.connection === undefined
        ? {}
        : { connection: connectionFrom(agent.connection) }),
    }));
  }

  async createAgent(input: Json): Promise<CreatedAgent> {
    const created = await this.request<WireAgent>("POST", "/v1/agents", input);
    return {
      ...agentFrom(created),
      ...(created.connection === undefined
        ? {}
        : { connection: connectionFrom(created.connection) }),
    };
  }

  async listConnections(
    agentId: string,
  ): Promise<{ readonly items: Connection[] }> {
    const found = await this.request<{ readonly items: WireConnection[] }>(
      "GET",
      `/v1/agents/${encodeURIComponent(agentId)}/connections`,
    );
    return { items: found.items.map(connectionFrom) };
  }

  async getConnection(
    agentId: string,
    connectionId: string,
  ): Promise<Connection> {
    return connectionFrom(
      await this.request(
        "GET",
        `/v1/agents/${encodeURIComponent(agentId)}/connections/${encodeURIComponent(connectionId)}`,
      ),
    );
  }

  async createConnection(agentId: string, input: Json): Promise<Connection> {
    return connectionFrom(
      await this.request(
        "POST",
        `/v1/agents/${encodeURIComponent(agentId)}/connections`,
        input,
      ),
    );
  }

  async listTests(cursor?: string, name?: string): Promise<Page<Test>> {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor !== undefined) query.set("cursor", cursor);
    if (name !== undefined) query.set("name", name);
    const found = await this.request<WirePage<WireTest>>(
      "GET",
      `/v1/tests?${query.toString()}`,
    );
    return {
      items: found.items.map(testFrom),
      ...(found.next_cursor === null ? {} : { nextCursor: found.next_cursor }),
    };
  }

  async getTest(id: string): Promise<Test> {
    return testFrom(
      await this.request("GET", `/v1/tests/${encodeURIComponent(id)}`),
    );
  }

  async createTest(input: Json): Promise<Test> {
    return testFrom(await this.request("POST", "/v1/tests", input));
  }

  async getDefaultPersona(): Promise<Persona> {
    return personaFrom(await this.request("GET", "/v1/personas/default"));
  }

  listApiKeys(): Promise<unknown> {
    return this.request("GET", "/api/keys");
  }
}
