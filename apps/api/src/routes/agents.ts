import {
  addConnection,
  AgentWriteRefusedError,
  getAgent,
  listAgents,
  listConnections,
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
import { isId } from "@egma/ids";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import {
  AGENTS_PROJECT_WORDING,
  resolveAbsentProject,
  resolveNamedProject,
  type ActingRefusal,
} from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { CODES, type RefusalCode } from "../http/refusals.ts";

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

/**
 * What a refusal is, before it becomes a reply.
 *
 * Tagged, so a function answering "a value or a refusal" is told apart by a
 * field that exists for exactly that and never by sniffing for a property the
 * other side might one day grow. The tag is never sent: `refused` below writes
 * out the two fields the contract has, and the status comes off the one code
 * table in `http/refusals.ts`, so this group cannot carry a code that list
 * does not hold.
 */
type Refusal = {
  readonly refused: true;
  readonly error: RefusalCode;
  readonly message: string;
};

function isRefusal(value: unknown): value is Refusal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { refused?: unknown }).refused === true
  );
}

function refused(reply: FastifyReply, refusal: Refusal): FastifyReply {
  return reply
    .code(CODES[refusal.error])
    .send({ error: refusal.error, message: refusal.message });
}

function invalid(message: string): Refusal {
  return { refused: true, error: "invalid_request", message };
}

function notPermitted(message: string): Refusal {
  return { refused: true, error: "not_permitted", message };
}

/**
 * An agent nobody can see reads exactly like an agent nobody wrote. Existence
 * is never confirmed to somebody who could not have seen the thing anyway, so
 * another customer's id and a made-up one get the same sentence.
 */
const NO_SUCH_AGENT: Refusal = {
  refused: true,
  error: "not_found",
  message:
    "no agent of yours has that id. Check the id, or list your agents with " +
    "GET /api/agents.",
};

/**
 * A body value that has to be text when it is there at all. Not the query
 * reader in `http/reading.ts` of the same shape and a near name — this one
 * refuses a wrong type out loud, because a body field carries intent where a
 * query parameter carries at most a filter.
 */
function textWhenGiven(
  value: unknown,
  named: string,
): string | undefined | Refusal {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    return invalid(
      `${named} is written as text, and this request sent ${typeof value}`,
    );
  }
  return value;
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
        `egma no longer keeps what was pulled from the provider, so ${what} ` +
          'has no "pulled" key. Drop it and send ' +
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
 * predicts who moves first when a simulation starts — so a guess would just be
 * wrong, and a supplied one is refused as the unknown key it is.
 */
function connectionIn(value: unknown): NewConnection | Refusal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("a connection is an object, or is left out entirely");
  }
  const body = value as Body;

  const unknown = unknownKeyIn(body, CONNECTION_KEYS, "a connection");
  if (unknown !== undefined) return unknown;

  const name = textWhenGiven(body.name, "a connection's name");
  if (isRefusal(name)) return name;
  const environment = textWhenGiven(body.environment, "a connection's environment");
  if (isRefusal(environment)) return environment;

  return {
    // A name sent blank is passed on rather than dropped, so the factory's own
    // "a connection needs a name" is what comes back. Absent is different and
    // means the smallest free numbered name.
    ...(typeof body.name === "string" ? { name: name ?? "" } : {}),
    // Handed on as they arrived. The registry names an unknown type, a
    // modality the type does not speak and a config key it has no place for,
    // each in its own words.
    type: (typeof body.type === "string" ? body.type : "") as ConnectionType,
    modality: (typeof body.modality === "string"
      ? body.modality
      : "") as Modality,
    ...(environment === undefined ? {} : { environment }),
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
 * A project that is not this customer's, wherever it was named.
 *
 * One sentence for reads and writes both, from one place: the wording is what
 * a client relays to a terminal, so a second copy of it is a second thing to
 * keep in step.
 */
/** This group's wording for a project it must refuse, as a Refusal value. */
function projectOutsideOrganization(projectId: string): Refusal {
  return notPermitted(AGENTS_PROJECT_WORDING.outsideOrganization(projectId));
}

/** An acting.ts answer, carried into this group's tagged-value flow. */
function refusalOf(acting: ActingRefusal): Refusal {
  return acting.code === "not_permitted"
    ? notPermitted(acting.refusal)
    : invalid(acting.refusal);
}

/**
 * The project a request named, checked against what the credential may reach.
 *
 * **One rule for reads and writes.** A surface that refuses a stranger's
 * project on a write and answers an empty list on a read has two rules, and
 * the empty list is the worse half: it reads as "you have no agents there"
 * rather than as "that is not yours to ask about".
 *
 * The check itself is `http/acting.ts`'s — one membership rule for every
 * route group. Only the wording is this group's own, and it lives beside the
 * other group's in that module, where the two can be unified in one edit the
 * day the dev picks a winner.
 */
async function projectNamed(
  auth: AuthContext,
  named: string,
  verb: "writes into" | "reads",
): Promise<string | Refusal> {
  const acting = await resolveNamedProject(auth, named, {
    actsElsewhere: (scoped, asked) =>
      AGENTS_PROJECT_WORDING.actsElsewhere(scoped, asked, verb),
    outsideOrganization: AGENTS_PROJECT_WORDING.outsideOrganization,
  });
  return "auth" in acting ? named : refusalOf(acting);
}

/**
 * Where a write lands, given what it named.
 *
 * A body may name a project and mostly does not. Left out, it is the
 * credential's own — and for a key minted for the whole customer, the
 * organization's project, which in this version there is one of. Nothing about
 * the shape changes when projects become first-class; only the default
 * relaxes.
 */
async function writingIn(
  auth: AuthContext,
  named: string | undefined,
): Promise<AuthContext | Refusal> {
  if (named !== undefined) {
    const project = await projectNamed(auth, named, "writes into");
    return isRefusal(project) ? project : { ...auth, projectId: project };
  }

  // The absent case is acting.ts's whole answer: the key's own project, the
  // single v1 project for a customer-wide key, a fault for zero, and a loud
  // ask for more than one — never the oldest of several, which would be the
  // silent narrowing this codebase has already had to find once.
  const acting = await resolveAbsentProject(auth);
  return "auth" in acting ? acting.auth : refusalOf(acting);
}

/**
 * What a read narrows to. Nothing, unless it named a project — reading across
 * a whole customer is the first-class case, because two projects of one
 * customer are always readable together.
 */
async function readingIn(
  auth: AuthContext,
  named: string | undefined,
): Promise<AuthContext | Refusal> {
  if (named === undefined) return auth;

  const project = await projectNamed(auth, named, "reads");
  return isRefusal(project) ? project : { ...auth, projectId: project };
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

    const name = textWhenGiven(body.name, "an agent's name");
    if (isRefusal(name)) return refused(reply, name);
    const description = textWhenGiven(body.description, "an agent's description");
    if (isRefusal(description)) return refused(reply, description);
    const project = textWhenGiven(body.project, "a project");
    if (isRefusal(project)) return refused(reply, project);

    const inline =
      body.connection === undefined
        ? undefined
        : connectionIn(body.connection);
    if (isRefusal(inline)) return refused(reply, inline);

    const acting = await writingIn(auth, project);
    if (isRefusal(acting)) return refused(reply, acting);

    const registered = await registerAgent(acting, {
      // Empty rather than absent, so the factory's own "an agent needs a name"
      // is what a request with no name hears.
      name: name ?? "",
      ...(description === undefined ? {} : { description }),
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
   *
   * There is no page-size parameter. A page is a page, and the cursor is what
   * carries a reader through the rest — nothing in this API exists because a
   * surface would look incomplete without it.
   */
  app.get("/api/agents", async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Record<string, string | undefined>;

    const named = textWhenGiven(query.project, "a project");
    if (isRefusal(named)) return refused(reply, named);

    const cursor = textWhenGiven(query.cursor, "a cursor");
    if (isRefusal(cursor)) return refused(reply, cursor);
    if (cursor !== undefined && !isId("agt", cursor)) {
      return refused(
        reply,
        invalid(
          `"${cursor}" is not an agent id, so it cannot be a cursor. Send ` +
            "back the next_cursor from the page before this one, or leave it " +
            "out to start at the newest.",
        ),
      );
    }

    const reading = await readingIn(auth, named);
    if (isRefusal(reading)) return refused(reply, reading);

    const page = await listAgents(reading, {
      ...(cursor === undefined ? {} : { cursor }),
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
          refused: true,
          error: "name_taken",
          message: error.message,
        });
      }
      if (error.reason === "needs_a_name") {
        return refused(reply, {
          refused: true,
          error: "unprocessable",
          message: error.message,
        });
      }
      return refused(reply, invalid(error.message));
    }

    // The same answer the routes already give a project of somebody else's,
    // for the moment between the check and the write in which one stopped
    // being the caller's. One sentence, from the one place that writes it.
    if (error instanceof ProjectOutsideOrganizationError) {
      return refused(reply, projectOutsideOrganization(error.projectId));
    }

    if (error instanceof NotPermittedError) {
      return reply
        .code(403)
        .send({ error: "not_permitted", message: error.message });
    }

    throw error;
  });
}
