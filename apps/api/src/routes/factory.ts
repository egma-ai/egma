import {
  addConnection,
  createAgent,
  createTest,
  findRetellAgents,
  getAgent,
  getConnection,
  getDefaultPersona,
  getTest,
  InvalidInputError,
  listAgents,
  listConnections,
  listTests,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  ResourceConflictError,
  schema,
  type Agent,
  type Connection,
  type ConnectionType,
  type Modality,
  type NewConnection,
  type Persona,
  type Test,
} from "@egma/db";
import { isId } from "@egma/ids";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";

/**
 * The small resource surface the first repository onboarding flow composes.
 *
 * There is no onboarding-shaped write here. A CLI creates and reads the same
 * agent, connection and test resources every other client will use. Keeping
 * the composition at the edge makes a failed or interrupted setup resumable
 * without teaching the API about a particular terminal flow.
 */

export type FactoryRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

type Body = Record<string, unknown>;

class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

function invalid(message: string): never {
  throw new InvalidRequestError(message);
}

function record(value: unknown): Body {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("the request body must be a JSON object");
  }
  return value as Body;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | undefined {
  const candidate = text(value);
  return candidate === "" ? undefined : candidate;
}

function optionalString(input: Body, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`${field} must be a non-empty string when it is supplied`);
  }
  return value.trim();
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(`${field} must be a list of strings`);
  }
  const found = value.map((entry) => entry.trim());
  if (found.some((entry) => entry === "")) {
    invalid(`${field} must not contain an empty string`);
  }
  return found;
}

function nonEmptyStrings(value: unknown, field: string): string[] {
  const found = strings(value, field);
  if (found.length === 0) invalid(`${field} must contain at least one item`);
  return found;
}

function page(query: unknown, cursorKind: "agt" | "tst"): {
  readonly limit?: number;
  readonly cursor?: string;
  readonly name?: string;
} {
  const input = record(query);
  const rawLimit = optionalText(input.limit);
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  const cursor = optionalText(input.cursor);
  const name = optionalText(input.name);
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > 200)
  ) {
    invalid("limit must be an integer between 1 and 200");
  }
  if (cursor !== undefined && !isId(cursorKind, cursor)) {
    invalid(`cursor must be a ${cursorKind} id`);
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(name === undefined ? {} : { name }),
  };
}

function connectionFrom(value: unknown): NewConnection {
  const input = record(value);
  const type = text(input.type);
  const modality = text(input.modality);
  if (!schema.CONNECTION_TYPES.includes(type as ConnectionType)) {
    invalid(`type must be one of ${schema.CONNECTION_TYPES.join(", ")}`);
  }
  if (!schema.MODALITIES.includes(modality as Modality)) {
    invalid(`modality must be one of ${schema.MODALITIES.join(", ")}`);
  }
  if (type === "phone" && modality !== "voice") {
    invalid("a phone connection must use the voice modality");
  }
  const name = optionalString(input, "name");
  const environment = optionalString(input, "environment");
  const config = record(input.config);
  const credentials =
    input.credentials === undefined ? undefined : record(input.credentials);
  if (type === "retell") {
    if (
      Object.keys(config).length !== 1 ||
      optionalText(config.retellAgentId) === undefined
    ) {
      invalid("a retell connection config must contain retellAgentId");
    }
    if (
      credentials === undefined ||
      Object.keys(credentials).length !== 1 ||
      (optionalText(credentials.apiKey)?.length ?? 0) < 8
    ) {
      invalid("retell credentials must contain an apiKey of at least 8 characters");
    }
  }
  if (type === "phone") {
    if (
      Object.keys(config).length !== 1 ||
      !/^\+[1-9]\d{1,14}$/u.test(text(config.phoneNumber))
    ) {
      invalid("a phone connection config must contain an E.164 phoneNumber");
    }
    if (credentials !== undefined) {
      invalid("a phone connection does not take credentials");
    }
  }
  return {
    ...(name === undefined ? {} : { name }),
    type: type as ConnectionType,
    modality: modality as Modality,
    ...(environment === undefined ? {} : { environment }),
    config,
    ...(credentials === undefined ? {} : { credentials }),
  };
}

function requiredText(value: unknown, field: string): string {
  const found = text(value);
  if (found === "") invalid(`${field} must not be empty`);
  return found;
}

function describedAgent(agent: Agent): Record<string, unknown> {
  return {
    id: agent.id,
    project_id: agent.projectId,
    name: agent.name,
    description: agent.description,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
  };
}

function describedConnection(connection: Connection): Record<string, unknown> {
  return {
    id: connection.id,
    agent_id: connection.agentId,
    project_id: connection.projectId,
    name: connection.name,
    type: connection.type,
    modality: connection.modality,
    topology: connection.topology,
    environment: connection.environment,
    config: connection.config,
    credentials_hint: connection.credentialsHint,
    capabilities: connection.capabilities,
    created_at: connection.createdAt,
    updated_at: connection.updatedAt,
  };
}

function describedTest(test: Test): Record<string, unknown> {
  return {
    id: test.id,
    project_id: test.projectId,
    name: test.name,
    description: test.description,
    version: test.version,
    version_id: test.versionId,
    scenario: test.scenario,
    expected_behaviors: test.expectedBehaviors,
    personas: test.personas.map((persona) => ({
      id: persona.id,
      name: persona.name,
      deleted_at: persona.deletedAt,
    })),
    created_at: test.createdAt,
    updated_at: test.updatedAt,
  };
}

function describedPersona(persona: Persona): Record<string, unknown> {
  return {
    id: persona.id,
    project_id: persona.projectId,
    name: persona.name,
    description: persona.description,
    version: persona.version,
    version_id: persona.versionId,
    traits: persona.traits,
    created_at: persona.createdAt,
    updated_at: persona.updatedAt,
  };
}

function missing(reply: FastifyReply, kind: string, id: string): FastifyReply {
  return reply.code(404).send({
    error: `no_such_${kind}`,
    message: `no ${kind} ${id} is visible in this project`,
  });
}

export async function factoryRoutes(
  app: FastifyInstance,
  options: FactoryRoutesOptions,
): Promise<void> {
  credentialed(app, options);

  app.get("/v1/personas/default", async (request, reply) => {
    const { auth } = requesterOf(request);
    const found = await getDefaultPersona(auth);
    return found === undefined
      ? missing(reply, "default_persona", "default")
      : reply.send(describedPersona(found));
  });

  app.get("/v1/agents", async (request, reply) => {
    const { auth } = requesterOf(request);
    const found = await listAgents(auth, page(request.query, "agt"));
    return reply.send({
      items: found.items.map(describedAgent),
      next_cursor: found.nextCursor ?? null,
    });
  });

  app.get("/v1/agents/retell/:retellAgentId", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { retellAgentId } = request.params as { retellAgentId: string };
    const found = await findRetellAgents(auth, retellAgentId);
    return reply.send({
      items: found.map((agent) => ({
        ...describedAgent(agent),
        connection: describedConnection(agent.connection),
      })),
    });
  });

  app.post("/v1/agents", async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = record(request.body ?? {});
    const description = optionalString(body, "description");
    const created = await createAgent(auth, {
      name: requiredText(body.name, "name"),
      ...(description === undefined ? {} : { description }),
      ...(body.connection === undefined
        ? {}
        : { connection: connectionFrom(body.connection) }),
    });
    return reply.code(201).send({
      ...describedAgent(created),
      ...(created.connection === undefined
        ? {}
        : { connection: describedConnection(created.connection) }),
    });
  });

  app.get("/v1/agents/:agentId", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const found = await getAgent(auth, agentId);
    return found === undefined
      ? missing(reply, "agent", agentId)
      : reply.send(describedAgent(found));
  });

  app.get("/v1/agents/:agentId/connections", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const found = await listConnections(auth, agentId);
    return found === undefined
      ? missing(reply, "agent", agentId)
      : reply.send({ items: found.map(describedConnection) });
  });

  app.post("/v1/agents/:agentId/connections", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const created = await addConnection(
      auth,
      agentId,
      connectionFrom(request.body ?? {}),
    );
    return created === undefined
      ? missing(reply, "agent", agentId)
      : reply.code(201).send(describedConnection(created));
  });

  app.get(
    "/v1/agents/:agentId/connections/:connectionId",
    async (request, reply) => {
      const { auth } = requesterOf(request);
      const { agentId, connectionId } = request.params as {
        agentId: string;
        connectionId: string;
      };
      const found = await getConnection(auth, agentId, connectionId);
      return found === undefined
        ? missing(reply, "connection", connectionId)
        : reply.send(describedConnection(found));
    },
  );

  app.get("/v1/tests", async (request, reply) => {
    const { auth } = requesterOf(request);
    const found = await listTests(auth, page(request.query, "tst"));
    return reply.send({
      items: found.items.map(describedTest),
      next_cursor: found.nextCursor ?? null,
    });
  });

  app.post("/v1/tests", async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = record(request.body ?? {});
    const description = optionalString(body, "description");
    const idempotencyKey = optionalString(body, "idempotency_key");
    const personaIds =
      body.persona_ids === undefined
        ? undefined
        : strings(body.persona_ids, "persona_ids");
    if (personaIds !== undefined) {
      const seen = new Set<string>();
      for (const id of personaIds) {
        if (!isId("prs", id)) invalid(`"${id}" is not a persona id`);
        if (seen.has(id)) invalid(`persona ${id} is named twice`);
        seen.add(id);
      }
    }
    const created = await createTest(auth, {
      name: requiredText(body.name, "name"),
      ...(description === undefined ? {} : { description }),
      scenario: requiredText(body.scenario, "scenario"),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      expectedBehaviors: nonEmptyStrings(
        body.expected_behaviors,
        "expected_behaviors",
      ),
      ...(personaIds === undefined ? {} : { personaIds }),
    });
    return reply.code(201).send(describedTest(created));
  });

  app.get("/v1/tests/:testId", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { testId } = request.params as { testId: string };
    const found = await getTest(auth, testId);
    return found === undefined
      ? missing(reply, "test", testId)
      : reply.send(describedTest(found));
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof InvalidRequestError || error instanceof InvalidInputError) {
      return reply
        .code(400)
        .send({ error: "invalid_request", message: error.message });
    }
    if (error instanceof ResourceConflictError) {
      return reply
        .code(409)
        .send({ error: "resource_conflict", message: error.message });
    }
    if (error instanceof NotPermittedError) {
      return reply
        .code(403)
        .send({ error: "not_permitted", message: error.message });
    }
    if (error instanceof ProjectOutsideOrganizationError) {
      return reply.code(403).send({
        error: "project_outside_organization",
        message: error.message,
      });
    }
    throw error;
  });
}
