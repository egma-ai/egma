import {
  addConnection,
  AgentWriteRefusedError,
  getAgent,
  LARGEST_PAGE_SIZE,
  listAgents,
  listConnections,
  listProjects,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  registerAgent,
  type Agent,
  type AuthContext,
  type Connection,
  type ConnectionType,
  type Modality,
  type NewConnection,
} from "@egma/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";

/**
 * Registering an agent, reading it back, and attaching another way to reach it.
 *
 * The group mirrors the factory behind it, and three shapes are load-bearing:
 *
 * - **Agent-rooted, always.** A connection is only ever reached through its
 *   agent, so there is no `/api/connections`. Naming the wrong agent answers
 *   exactly what naming a connection that does not exist answers.
 * - **No resource is rooted at a project, and the organization is in no
 *   address at all.** A write may *name* a project in its body and a read may
 *   filter by one; which customer this is comes from the credential and from
 *   nowhere else, which is what stops a copied key writing into somebody
 *   else's account by asking nicely.
 * - **A sealed secret never comes back.** What arrives is sealed before it
 *   touches a row, and every read answers its last four characters and nothing
 *   more. The field is absent from the read shape rather than blanked, so
 *   leaking one through a serializer is not a thing that can be forgotten.
 *
 * **Registering is retry-safe by construction.** A create carrying an inline
 * connection goes through the factory's reuse rule, and the reply's `result`
 * says which of the three things happened — created, reused, or the same agent
 * reached a new way. A coding agent retrying after an uncertain network
 * failure therefore never mints a second identity for one vendor agent, and
 * never has to guess whether it did.
 *
 * **The inline connection and the standalone one are one body shape**, read by
 * one function below. Two dialects for one thing is how a client comes to
 * work on one path and fail on the other.
 */

export type AgentRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

type Body = Record<string, unknown>;

/** What a refusal is, before it becomes a reply. */
type Refusal = {
  readonly status: number;
  readonly error: string;
  readonly message: string;
};

function refused(reply: FastifyReply, refusal: Refusal): FastifyReply {
  return reply
    .code(refusal.status)
    .send({ error: refusal.error, message: refusal.message });
}

function invalid(message: string): Refusal {
  return { status: 400, error: "invalid_request", message };
}

/**
 * An agent nobody can see reads exactly like an agent nobody wrote. Existence
 * is never confirmed to somebody who could not have seen the thing anyway, so
 * another customer's id and a made-up one get the same sentence.
 */
const NO_SUCH_AGENT: Refusal = {
  status: 404,
  error: "not_found",
  message:
    "no agent of yours has that id. Check the id, or list your agents with " +
    "GET /api/agents.",
};

/** A value that has to be text when it is there at all. */
function textOr(
  value: unknown,
  named: string,
): { readonly text: string | undefined } | Refusal {
  if (value === undefined || value === null) return { text: undefined };
  if (typeof value !== "string") {
    return invalid(
      `${named} is written as text, and this request sent ${typeof value}`,
    );
  }
  return { text: value };
}

function isRefusal(value: object): value is Refusal {
  return "status" in value;
}

/**
 * The unknown-key gate, written once for both objects a registration carries.
 *
 * Refusing by name rather than ignoring is what turns a typo into an answer a
 * coding agent can act on, and it is what makes the dropped vendor payload
 * loud: a client still sending it hears so, instead of watching egma quietly
 * keep nothing.
 */
function unknownKeyIn(
  body: Body,
  held: readonly string[],
  what: string,
): Refusal | undefined {
  for (const key of Object.keys(body)) {
    if (held.includes(key)) continue;
    if (key === "pulled") {
      return invalid(
        "egma no longer keeps what was pulled from the provider, so a " +
          'registration has no "pulled" key. Drop it and send ' +
          `${held.join(", ")}; the agent's content stays at the provider, ` +
          "where egma reads it fresh rather than out of a copy that would go " +
          "stale.",
      );
    }
    return invalid(`${what} has no key "${key}"; it holds ${held.join(", ")}`);
  }
  return undefined;
}

const AGENT_KEYS = ["name", "description", "project", "connection"] as const;
const CONNECTION_KEYS = [
  "name",
  "type",
  "modality",
  "environment",
  "config",
  "credentials",
] as const;

/**
 * One connection payload, read the one way — inline on a registration and
 * standalone on an attach.
 *
 * Almost nothing is checked here: the registry behind the seam owns what a
 * type's config holds, which modalities it speaks and whether it takes a
 * credential, and it says so in sentences written to be relayed. Duplicating
 * any of that would produce a second opinion that could disagree. What this
 * does own is the shape of the envelope: which keys exist at all, and that the
 * ones carrying text carry text.
 *
 * **Topology is not in the list on purpose.** It is derived from the type — it
 * predicts who moves first when a simulation starts — so a caller's guess
 * would just be wrong, and a supplied one is refused as the unknown key it is.
 */
function connectionIn(value: unknown): NewConnection | Refusal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("a connection is an object, or is left out entirely");
  }
  const body = value as Body;

  const unknown = unknownKeyIn(body, CONNECTION_KEYS, "a connection");
  if (unknown !== undefined) return unknown;

  const name = textOr(body.name, "a connection's name");
  if (isRefusal(name)) return name;
  const environment = textOr(body.environment, "a connection's environment");
  if (isRefusal(environment)) return environment;

  return {
    ...(name.text === undefined ? {} : { name: name.text }),
    // Handed on as they arrived. The registry names an unknown type, a
    // modality the type does not speak and a config key it has no place for,
    // each in its own words.
    type: (typeof body.type === "string" ? body.type : "") as ConnectionType,
    modality: (typeof body.modality === "string"
      ? body.modality
      : "") as Modality,
    ...(environment.text === undefined
      ? {}
      : { environment: environment.text }),
    config: (body.config ?? {}) as Readonly<Record<string, unknown>>,
    ...(body.credentials === undefined
      ? {}
      : {
          credentials: body.credentials as Readonly<Record<string, unknown>>,
        }),
  };
}

/** An agent, as every read of one describes it. */
function describedAgent(one: Agent): Record<string, unknown> {
  return {
    id: one.id,
    project_id: one.projectId,
    name: one.name,
    description: one.description,
    created_at: one.createdAt.toISOString(),
    updated_at: one.updatedAt.toISOString(),
  };
}

/**
 * A connection, as every read of one describes it.
 *
 * The sealed envelope has no line here and no line in the type this is built
 * from, so there is no serializer to remember to strip it in.
 * `credentials_hint` is the whole of what comes back: enough to tell one
 * provider key from another, and enough to see that a rotation landed.
 */
function describedConnection(one: Connection): Record<string, unknown> {
  return {
    id: one.id,
    agent_id: one.agentId,
    project_id: one.projectId,
    name: one.name,
    type: one.type,
    modality: one.modality,
    topology: one.topology,
    environment: one.environment,
    config: one.config,
    credentials_hint: one.credentialsHint,
    capabilities: one.capabilities,
    created_at: one.createdAt.toISOString(),
    updated_at: one.updatedAt.toISOString(),
  };
}

/**
 * Where a write lands, given what it named.
 *
 * A body may name a project and mostly does not. Named, it has to be one this
 * credential may act in; left out, it is the credential's own — and for a key
 * minted for the whole customer, the organization's project, which in this
 * version there is one of. Nothing about the shape changes when projects
 * become first-class; only the default relaxes.
 *
 * A key minted for one project is answered rather than quietly widened. It
 * reads that project and cannot be argued out of it, so naming a sibling
 * project is refused with both named rather than silently ignored.
 */
async function actingIn(
  auth: AuthContext,
  named: string | undefined,
): Promise<AuthContext | Refusal> {
  if (named === undefined || named === "") {
    if (auth.projectId !== undefined) return auth;

    const projects = await listProjects(auth);
    const home = projects[0];
    if (home === undefined) {
      return {
        status: 403,
        error: "not_permitted",
        message:
          "this organization has no project to write into, which should not " +
          "be possible — sign in to egma and open the organization to check.",
      };
    }
    return { ...auth, projectId: home.id };
  }

  if (auth.projectId !== undefined && named !== auth.projectId) {
    return {
      status: 403,
      error: "not_permitted",
      message:
        `this credential acts in project ${auth.projectId}, and the request ` +
        `named ${named}. A key minted for one product area writes into that ` +
        "one; drop the project, or use a key for the whole organization.",
    };
  }

  // Whether it belongs to this customer at all is the factory's own check,
  // made against the live row rather than against anything a client sent.
  return { ...auth, projectId: named };
}

export async function agentRoutes(
  app: FastifyInstance,
  options: AgentRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * Register an agent, with the first way of reaching it written in the same
   * request.
   *
   * Both rows or neither: a connection payload the registry turns away leaves
   * no agent behind, because the two inserts share one transaction. And the
   * reuse rule runs inside that same transaction, so two machines registering
   * one vendor agent at the same instant settle to one agent rather than one
   * of them losing a race it should never have been in.
   */
  app.post("/api/agents", async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    const unknown = unknownKeyIn(body, AGENT_KEYS, "a registration");
    if (unknown !== undefined) return refused(reply, unknown);

    const name = textOr(body.name, "an agent's name");
    if (isRefusal(name)) return refused(reply, name);
    const description = textOr(body.description, "an agent's description");
    if (isRefusal(description)) return refused(reply, description);
    const project = textOr(body.project, "a project");
    if (isRefusal(project)) return refused(reply, project);

    const inline =
      body.connection === undefined
        ? undefined
        : connectionIn(body.connection);
    if (inline !== undefined && isRefusal(inline)) {
      return refused(reply, inline);
    }

    const acting = await actingIn(auth, project.text);
    if (isRefusal(acting)) return refused(reply, acting);

    const registered = await registerAgent(acting, {
      // Empty rather than absent, so the factory's own "an agent needs a name"
      // is what a request with no name hears.
      name: name.text ?? "",
      ...(description.text === undefined
        ? {}
        : { description: description.text }),
      ...(inline === undefined ? {} : { connection: inline }),
    });

    // Created and extended each wrote a row; reused wrote none, and saying 201
    // for that would be the protocol claiming something the `result` field is
    // there to deny.
    return reply.code(registered.result === "reused" ? 200 : 201).send({
      result: registered.result,
      agent: describedAgent(registered.agent),
      ...(registered.connection === undefined
        ? {}
        : { connection: describedConnection(registered.connection) }),
    });
  });

  /**
   * One page of the agents this credential can reach, newest first.
   *
   * A project is a filter in the query and never a level in the address. The
   * cursor is the last id of the page: the ids sort by mint time, so a list
   * changing underneath a reader never shows a row twice and never skips one.
   */
  app.get("/api/agents", async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Record<string, string | undefined>;

    const asked =
      query.limit === undefined || query.limit === ""
        ? undefined
        : Number(query.limit);
    if (asked !== undefined && (!Number.isInteger(asked) || asked < 1)) {
      return refused(
        reply,
        invalid(
          `limit is how many agents one page may carry, at most ` +
            `${LARGEST_PAGE_SIZE}, and "${query.limit}" is not a count.`,
        ),
      );
    }

    const named =
      query.project === undefined || query.project === ""
        ? undefined
        : query.project;
    if (
      named !== undefined &&
      auth.projectId !== undefined &&
      named !== auth.projectId
    ) {
      return refused(reply, {
        status: 403,
        error: "not_permitted",
        message:
          `this credential acts in project ${auth.projectId}, and the request ` +
          `named ${named}. A key minted for one product area reads that one; ` +
          "drop the project, or use a key for the whole organization.",
      });
    }

    // A whole customer's agents when nothing narrows them, which is the
    // first-class case: two projects of one customer are always readable
    // together, and the filter narrows rather than unlocks.
    const reading: AuthContext =
      named === undefined ? auth : { ...auth, projectId: named };

    const page = await listAgents(reading, {
      // Asking for more than a page holds is answered with a page rather than
      // a refusal: nothing the reader asked for is missing, it just arrives
      // over more requests.
      ...(asked === undefined
        ? {}
        : { limit: Math.min(asked, LARGEST_PAGE_SIZE) }),
      ...(query.cursor === undefined || query.cursor === ""
        ? {}
        : { cursor: query.cursor }),
    });

    return reply.send({
      items: page.items.map(describedAgent),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this answer is an older shape that never had one".
      next_cursor: page.nextCursor ?? null,
    });
  });

  /** The agent, and every living way of reaching it. */
  app.get("/api/agents/:agentId", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };

    const one = await getAgent(auth, agentId);
    if (one === undefined) return refused(reply, NO_SUCH_AGENT);

    const connections = (await listConnections(auth, agentId)) ?? [];
    return reply.send({
      agent: describedAgent(one),
      connections: connections.map(describedConnection),
    });
  });

  /**
   * Another way of reaching an agent that already exists — the same body an
   * inline connection travels in, and the defaulted name one number further
   * along.
   */
  app.post("/api/agents/:agentId/connections", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };

    const wanted = connectionIn(request.body ?? {});
    if (isRefusal(wanted)) return refused(reply, wanted);

    const added = await addConnection(auth, agentId, wanted);
    if (added === undefined) return refused(reply, NO_SUCH_AGENT);

    return reply.code(201).send({ connection: describedConnection(added) });
  });

  /**
   * The refusals this group owns, each answered as an answer rather than as a
   * fault, and each carrying the sentence the layer below wrote.
   *
   * The sentences are relayed word for word on purpose. A client relays them
   * to a terminal a coding agent is reading, so the wording is the contract —
   * and paraphrasing here would put a second, quieter copy of it in a file
   * nobody would think to check.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof AgentWriteRefusedError) {
      if (error.reason === "name_taken") {
        return refused(reply, {
          status: 409,
          error: "name_taken",
          message: error.message,
        });
      }
      if (error.reason === "needs_a_name") {
        return refused(reply, {
          status: 422,
          error: "unprocessable",
          message: error.message,
        });
      }
      return refused(reply, invalid(error.message));
    }

    // A project of somebody else's, named in a body. It is a permission
    // answer rather than a not-found one: the caller named a real thing and
    // may not act there, and the reply says so without saying whose it is.
    if (error instanceof ProjectOutsideOrganizationError) {
      return refused(reply, {
        status: 403,
        error: "not_permitted",
        message:
          `project ${error.projectId} is not in your organization. A write ` +
          "may name a project of your own organization or leave it out, and " +
          "which organization this is always comes from the key.",
      });
    }

    if (error instanceof NotPermittedError) {
      return reply
        .code(403)
        .send({ error: "not_permitted", message: error.message });
    }

    throw error;
  });
}
