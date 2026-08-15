import {
  addConnection,
  AgentWriteRefusedError,
  archiveAgent,
  archiveConnection,
  CAPABILITY_CATALOG,
  capabilityStanding,
  CapabilityCheckFailedError,
  connectionTypeMetadata,
  ConnectionRestoreRefusedError,
  getAgent,
  getConnection,
  IdentityConflictError,
  listAgents,
  listConnections,
  NoCapabilityAdapterError,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  refreshConnectionCapabilities,
  registerAgent,
  restoreAgent,
  restoreConnection,
  updateAgent,
  updateConnection,
  type Agent,
  type AuthContext,
  type Connection,
  type ConnectionType,
  type Modality,
  type NewConnection,
  type RestoreCredential,
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

/** The same answer, one level down: through the wrong agent, or not at all. */
const NO_SUCH_CONNECTION: Refusal = {
  refused: true,
  error: "not_found",
  message:
    "no connection of yours has that id on that agent. Check both ids, or " +
    "read the agent with GET /api/agents/{agentId}.",
};

/**
 * What a Restore brings for the credential.
 *
 * Three words rather than a bare credential object, because "left out" has to
 * be able to mean *I choose to have none* on the shapes where a credential is
 * genuinely optional. A shape that took absence as its answer would leave the
 * archived envelope in place for exactly one reading of the request, and that
 * reading is the one this whole rule exists to make impossible.
 */
function restoreCredentialIn(
  value: unknown,
): RestoreCredential | undefined | Refusal {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    return invalid(
      'a credential choice is an object shaped { "choice": "replace", ' +
        '"credentials": { … } } or { "choice": "clear" }',
    );
  }
  const held = value as Body;
  for (const key of Object.keys(held)) {
    if (key !== "choice" && key !== "credentials") {
      return invalid(
        `a credential choice has no key "${key}"; it holds choice, credentials`,
      );
    }
  }

  if (held.choice === "clear") {
    if (held.credentials !== undefined) {
      return invalid(
        "a credential choice of clear removes the stored credential, so it " +
          "carries none. Send choice replace to put a new one in its place.",
      );
    }
    return { choice: "clear" };
  }

  if (held.choice !== "replace") {
    return invalid(
      'a credential choice is "replace" or "clear", and this request said ' +
        `${JSON.stringify(held.choice)}`,
    );
  }

  if (
    typeof held.credentials !== "object" ||
    held.credentials === null ||
    Array.isArray(held.credentials)
  ) {
    return invalid(
      "a credential choice of replace carries the new credential under " +
        "credentials",
    );
  }

  return {
    choice: "replace",
    credentials: held.credentials as Readonly<Record<string, unknown>>,
  };
}

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

/**
 * A query flag, read strictly. `true` and `false` and nothing else — a flag
 * that quietly read "yes", "1" and an empty string as true would make
 * `?archived` and `?archived=false` mean the same thing, and one of them is
 * somebody asking for the archived half.
 */
function flagWhenGiven(
  value: unknown,
  named: string,
): boolean | undefined | Refusal {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return invalid(`${named} is written as true or false`);
}

/** How many rows one page may hold, before the access layer's own ceiling. */
const LARGEST_PAGE = 200;

function boundedLimit(value: unknown): number | undefined | Refusal {
  if (value === undefined || value === null || value === "") return undefined;
  const asked = Number(value);
  if (!Number.isInteger(asked) || asked < 1 || asked > LARGEST_PAGE) {
    return invalid(
      `limit is a whole number between 1 and ${LARGEST_PAGE}; a page is ` +
        "carried on with next_cursor rather than made larger.",
    );
  }
  return asked;
}

/**
 * The revision an edit was written against, which a browser always sends.
 *
 * Compulsory here rather than in the access layer, and that is the split: the
 * layer below makes the check impossible to get wrong, and this decides who has
 * to make it. A terminal writing a rename has no editor to have gone stale, and
 * demanding a revision there would turn every scripted change into two
 * requests. A browser has a form somebody had open, and that is exactly the
 * thing this protects.
 */
function revisionIn(body: Body, required: boolean): string | undefined | Refusal {
  const given = textWhenGiven(body.expected_revision, "expected_revision");
  if (isRefusal(given)) return given;
  if (given === undefined && required) {
    return {
      refused: true,
      error: "unprocessable",
      message:
        "this edit did not say which revision it was written against. Read " +
        "the resource, then send the update with expected_revision set to " +
        "the revision it names.",
    };
  }
  return given;
}

/**
 * The project a request about one agent acts in.
 *
 * **Every route that names an agent or a connection goes through this, reads
 * included.** The reason is the session's default: a browser's context is built
 * with the organization's *first* project in it, because that is all the door
 * knows before a request names one. A route that then used the context as it
 * found it would scope every read and every write to that first project — so
 * somebody working in a second project would open an agent and be told there is
 * no such agent, and, worse, an archive aimed at one project would be evaluated
 * against another.
 *
 * The spec is explicit that this must not happen: project middleware validates
 * the URL's project and adds it to the request, and the first project must
 * never become the fixed authorization scope. `readingIn` and `writingIn` below
 * are that validation, and they narrow only — the organization still comes from
 * the credential, so naming a project can only ever pick among what this
 * membership already reaches.
 *
 * It is also what keeps a plain fault out of the handler. `archiveAgent` and
 * `restoreAgent` refuse a credential acting in no project, exactly as the
 * grader, persona and mock-tool factories refuse their own project-scoped
 * writes — and, exactly as there, the API resolves a project before calling, so
 * the refusal is documentation of an invariant rather than a 500 waiting for an
 * organization-wide key to find it.
 */
async function actingProject(
  auth: AuthContext,
  request: { readonly query?: unknown },
  verb: "writes into" | "reads",
): Promise<AuthContext | Refusal> {
  const query = (request.query ?? {}) as Record<string, string | undefined>;
  const named = textWhenGiven(query.project, "a project");
  if (isRefusal(named)) return named;
  return verb === "reads" ? readingIn(auth, named) : writingIn(auth, named);
}

/** Whether the caller is a browser, which is what makes a revision compulsory. */
function fromBrowser(auth: AuthContext): boolean {
  return auth.via === "session";
}

const AGENT_EDIT_KEYS = ["name", "description", "expected_revision"] as const;
const ARCHIVE_KEYS = ["expected_revision"] as const;
const AGENT_RESTORE_KEYS = ["expected_revision", "name"] as const;
const CONNECTION_EDIT_KEYS = [
  "name",
  "environment",
  "config",
  "credentials",
  "expected_revision",
] as const;
const CONNECTION_RESTORE_KEYS = [
  "expected_revision",
  "name",
  "credential",
] as const;

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

/**
 * An agent, as every read of one describes it.
 *
 * **The provider's half of an agent has no line here and never will.** Prompt,
 * model and tools live at the provider, where egma cannot freeze them and has
 * no business editing them; what egma owns is the name, the description and
 * the identity every result accumulates against. A read that carried a copy of
 * provider configuration would be a copy going stale from the moment it was
 * taken, and an editor built on it would be egma quietly becoming a second
 * place to configure an agent.
 */
function describedAgent(one: Agent): Record<string, unknown> {
  return {
    id: one.id,
    project_id: one.projectId,
    name: one.name,
    description: one.description,
    // What an edit has to be written against. Absent from no read, so a client
    // never has to make a second request to be able to make a first edit.
    revision: one.revision,
    archived: one.archivedAt !== null,
    archived_at: one.archivedAt?.toISOString() ?? null,
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
    variant_id: one.variantId,
    modality: one.modality,
    topology: one.topology,
    environment: one.environment,
    config: one.config,
    // Whether there is a credential at all, and the hint — never the secret,
    // and never a blank field a serializer could one day be taught to fill.
    credential_present: one.credentialsHint !== null,
    credentials_hint: one.credentialsHint,
    capabilities: describedCapabilities(one),
    revision: one.revision,
    archived: one.archivedAt !== null,
    archived_at: one.archivedAt?.toISOString() ?? null,
    created_at: one.createdAt.toISOString(),
    updated_at: one.updatedAt.toISOString(),
  };
}

/**
 * What is known about a target, said so that `unknown` can never be mistaken
 * for `nothing is supported`.
 *
 * The state is always present and the evidence is present only with it. A
 * client reading `state: "unknown"` knows to say so on screen and to offer
 * Refresh; a client reading `state: "known"` with an empty list knows the
 * target was measured and has none of these, which is a different sentence
 * entirely.
 */
function describedCapabilities(one: Connection): Record<string, unknown> {
  const held = one.capabilities;
  return {
    state: held.state,
    // What the adapter looked at, beside what it found. Both, because a reader
    // holding only the second cannot tell a settled absence from an unasked
    // question — and `standing` below is the answer built from the pair, so a
    // client never has to work the rule out for itself.
    measured: held.state === "known" ? held.measured : null,
    supported: held.state === "known" ? held.supported : null,
    checked_at: held.state === "known" ? held.checkedAt.toISOString() : null,
    source: held.state === "known" ? held.source : null,
    standing: Object.fromEntries(
      CAPABILITY_CATALOG.map((entry) => [
        entry.key,
        capabilityStanding(held, entry.key),
      ]),
    ),
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
  return { refused: true, error: acting.code, message: acting.refusal };
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

/**
 * A permission's name, as a sentence says it.
 *
 * The permission table's words are for the table — one row, one name, easy to
 * audit — and they are not English. A refusal a person reads has to name the
 * action the way they would, and an action with no phrase here falls back to
 * its own name with the underscores taken out, so a permission added later is
 * readable before anybody remembers to come back here.
 */
function plainly(action: string): string {
  const said: Record<string, string> = {
    configure_agents: "create or change agents and connections",
    author_definitions: "create or change tests, personas and graders",
    start_and_cancel_runs: "start or cancel runs",
    revisit_verdicts: "regrade or correct verdicts",
  };
  return said[action] ?? action.split("_").join(" ");
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
   * Every connection type egma supports, as a form may be drawn from it.
   *
   * **The web application must never keep its own copy of any of this.** The
   * registry decides which config keys a shape holds, which modalities the type
   * speaks, and whether a credential is required, forbidden or optional; a
   * second handwritten copy in a browser would be a second opinion able to
   * disagree with the gate, and the disagreement would surface as a form that
   * asks for the wrong things and a create that refuses for reasons the form
   * cannot explain.
   *
   * **What crosses is labels, field shapes, the credential rule and two adapter
   * facts.** No gate function, no hint function, no refusal sentence, no
   * credential value. It is built by reading the registry rather than by
   * copying it, so nothing can be left behind when a type is added.
   */
  app.get("/api/connection-types", async (_request, reply) => {
    return reply.send({
      items: connectionTypeMetadata().map((type) => ({
        type: type.type,
        label: type.label,
        modalities: type.modalities,
        topology: type.topology,
        // Whether egma can conduct a run over this type at all, and whether it
        // ships anything that can measure one of its targets. Two different
        // facts, and a form says both rather than implying either.
        simulator_adapter: type.simulatorAdapter,
        capability_discovery: type.capabilityDiscovery,
        variants: type.variants.map((variant) => ({
          id: variant.id,
          label: variant.label,
          chosen_by: variant.chosenBy,
          fields: variant.fields.map((field) => ({
            key: field.key,
            label: field.label,
            kind: field.kind,
            required: field.required,
            help: field.help,
          })),
          credential_rule: variant.credentialRule,
          credential_help: variant.credentialHelp,
          credential_fields: variant.credentialFields.map((field) => ({
            field: field.field,
            label: field.label,
            kind: field.kind,
            required: field.required,
            help: field.help,
          })),
        })),
      })),
    });
  });

  /**
   * The capability catalog: the stable keys a test may require and a connection
   * may be found to support.
   *
   * One list, server-owned, read by both editors. A free-text capability would
   * let two people write the same requirement two ways and would make every
   * comparison between what a test needs and what a target has a guess.
   */
  app.get("/api/capabilities", async (_request, reply) => {
    return reply.send({
      items: CAPABILITY_CATALOG.map((entry) => ({
        key: entry.key,
        label: entry.label,
        description: entry.description,
      })),
    });
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

    const search = textWhenGiven(query.search, "a search");
    if (isRefusal(search)) return refused(reply, search);

    const archived = flagWhenGiven(query.archived, "archived");
    if (isRefusal(archived)) return refused(reply, archived);

    const limit = boundedLimit(query.limit);
    if (isRefusal(limit)) return refused(reply, limit);

    const page = await listAgents(reading, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(search === undefined ? {} : { search }),
      ...(archived === undefined ? {} : { archived }),
      ...(limit === undefined ? {} : { limit }),
    });

    return reply.send({
      items: page.items.map(describedAgent),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this answer is an older shape that never had one".
      next_cursor: page.nextCursor ?? null,
    });
  });

  /**
   * The agent, and every way of reaching it — the active ones, or the archived
   * ones when the query asks for those.
   *
   * **An archived agent reads.** Following a link to one has to work: its runs
   * are still evidence, and Restore has to be reachable from somewhere. What
   * archiving takes away is entry into new work, and that is enforced where new
   * work is created.
   */
  app.get("/api/agents/:agentId", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const query = (request.query ?? {}) as Record<string, string | undefined>;

    const archived = flagWhenGiven(query.archived, "archived");
    if (isRefusal(archived)) return refused(reply, archived);

    const acting = await actingProject(auth, request, "reads");
    if (isRefusal(acting)) return refused(reply, acting);

    const one = await getAgent(acting, agentId);
    if (one === undefined) return refused(reply, NO_SUCH_AGENT);

    const connections =
      (await listConnections(acting, agentId, {
        ...(archived === undefined ? {} : { archived }),
      })) ?? [];
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

    const acting = await actingProject(auth, request, "writes into");
    if (isRefusal(acting)) return refused(reply, acting);

    const added = await addConnection(acting, agentId, wanted);
    if (added === undefined) return refused(reply, NO_SUCH_AGENT);

    return reply.code(201).send({ connection: describedConnection(added) });
  });

  /**
   * The Egma-owned half of an agent, edited against the revision the editor
   * was opened on.
   *
   * Name and description and nothing else. The provider's prompt, model and
   * tools are not here, are not in the read, and are not coming: they live
   * where the customer configures them, and egma being a second place to edit
   * them would make two answers to one question with no rule to choose between.
   */
  app.patch("/api/agents/:agentId", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const body = (request.body ?? {}) as Body;

    const unknown = unknownKeyIn(body, AGENT_EDIT_KEYS, "an agent edit");
    if (unknown !== undefined) return refused(reply, unknown);

    const name = textWhenGiven(body.name, "an agent's name");
    if (isRefusal(name)) return refused(reply, name);
    const revision = revisionIn(body, fromBrowser(auth));
    if (isRefusal(revision)) return refused(reply, revision);

    const description =
      body.description === null
        ? null
        : textWhenGiven(body.description, "an agent's description");
    if (isRefusal(description)) return refused(reply, description);

    const acting = await actingProject(auth, request, "writes into");
    if (isRefusal(acting)) return refused(reply, acting);

    const updated = await updateAgent(acting, agentId, {
      ...(name === undefined ? {} : { name }),
      // Absent keeps it; an explicit null clears it. The two are different
      // requests and are read as different requests.
      ...(body.description === undefined ? {} : { description }),
      ...(revision === undefined ? {} : { expectedRevision: revision }),
    });

    if (updated === undefined) return refused(reply, NO_SUCH_AGENT);
    return reply.send({ agent: describedAgent(updated) });
  });

  /**
   * Take an agent out of new work, with every active way of reaching it and
   * every piece of work that was going over one.
   */
  app.post("/api/agents/:agentId/archive", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const body = (request.body ?? {}) as Body;

    const unknown = unknownKeyIn(body, ARCHIVE_KEYS, "an archive");
    if (unknown !== undefined) return refused(reply, unknown);
    const revision = revisionIn(body, fromBrowser(auth));
    if (isRefusal(revision)) return refused(reply, revision);

    const acting = await actingProject(auth, request, "writes into");
    if (isRefusal(acting)) return refused(reply, acting);

    const archived = await archiveAgent(acting, agentId, {
      ...(revision === undefined ? {} : { expectedRevision: revision }),
    });
    if (archived === undefined) return refused(reply, NO_SUCH_AGENT);

    return reply.send({
      agent: describedAgent(archived.agent),
      // What went with it, said plainly, because a person who archives an
      // agent has just stopped work they may have been watching.
      archived_connections: archived.connections,
      canceled_runs: archived.canceledRuns,
    });
  });

  /**
   * Bring an agent back — and only the agent. Its connections stay archived
   * until each is restored on its own shape's credential terms.
   */
  app.post("/api/agents/:agentId/restore", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const body = (request.body ?? {}) as Body;

    const unknown = unknownKeyIn(body, AGENT_RESTORE_KEYS, "a restore");
    if (unknown !== undefined) return refused(reply, unknown);
    const revision = revisionIn(body, fromBrowser(auth));
    if (isRefusal(revision)) return refused(reply, revision);
    const name = textWhenGiven(body.name, "an agent's name");
    if (isRefusal(name)) return refused(reply, name);

    const acting = await actingProject(auth, request, "writes into");
    if (isRefusal(acting)) return refused(reply, acting);

    const restored = await restoreAgent(acting, agentId, {
      ...(revision === undefined ? {} : { expectedRevision: revision }),
      ...(name === undefined ? {} : { name }),
    });
    if (restored === undefined) return refused(reply, NO_SUCH_AGENT);
    return reply.send({ agent: describedAgent(restored) });
  });

  /** One way of reaching an agent, archived or not. */
  app.get("/api/agents/:agentId/connections/:connectionId", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId, connectionId } = request.params as {
      agentId: string;
      connectionId: string;
    };

    const acting = await actingProject(auth, request, "reads");
    if (isRefusal(acting)) return refused(reply, acting);

    const one = await getConnection(acting, agentId, connectionId);
    if (one === undefined) return refused(reply, NO_SUCH_CONNECTION);
    return reply.send({ connection: describedConnection(one) });
  });

  /**
   * Change a connection: its name, its label, its config, or the whole of its
   * credential.
   *
   * **The credential replaces whole or is left alone.** There is no merge,
   * because a merge would mean reading the stored plaintext back out to edit
   * it, and the one door to that opens for egma's own simulator and for
   * nothing else. Rotation is therefore just this request carrying a whole new
   * credential, which is why there is no separate rotate verb to keep in step
   * with this one.
   */
  app.patch(
    "/api/agents/:agentId/connections/:connectionId",
    async (request, reply) => {
      const { auth } = requesterOf(request);
      const { agentId, connectionId } = request.params as {
        agentId: string;
        connectionId: string;
      };
      const body = (request.body ?? {}) as Body;

      const unknown = unknownKeyIn(
        body,
        CONNECTION_EDIT_KEYS,
        "a connection edit",
      );
      if (unknown !== undefined) return refused(reply, unknown);

      const name = textWhenGiven(body.name, "a connection's name");
      if (isRefusal(name)) return refused(reply, name);
      const environment =
        body.environment === null
          ? null
          : textWhenGiven(body.environment, "a connection's environment");
      if (isRefusal(environment)) return refused(reply, environment);
      const revision = revisionIn(body, fromBrowser(auth));
      if (isRefusal(revision)) return refused(reply, revision);

      const acting = await actingProject(auth, request, "writes into");
      if (isRefusal(acting)) return refused(reply, acting);

      const updated = await updateConnection(acting, agentId, connectionId, {
        ...(name === undefined ? {} : { name }),
        ...(body.environment === undefined ? {} : { environment }),
        ...(body.config === undefined
          ? {}
          : { config: body.config as Readonly<Record<string, unknown>> }),
        ...(body.credentials === undefined
          ? {}
          : {
              credentials: body.credentials as Readonly<
                Record<string, unknown>
              >,
            }),
        ...(revision === undefined ? {} : { expectedRevision: revision }),
      });

      if (updated === undefined) return refused(reply, NO_SUCH_CONNECTION);
      return reply.send({ connection: describedConnection(updated) });
    },
  );

  /** Stop reaching an agent this way, and settle the work that was. */
  app.post(
    "/api/agents/:agentId/connections/:connectionId/archive",
    async (request, reply) => {
      const { auth } = requesterOf(request);
      const { agentId, connectionId } = request.params as {
        agentId: string;
        connectionId: string;
      };
      const body = (request.body ?? {}) as Body;

      const unknown = unknownKeyIn(body, ARCHIVE_KEYS, "an archive");
      if (unknown !== undefined) return refused(reply, unknown);
      const revision = revisionIn(body, fromBrowser(auth));
      if (isRefusal(revision)) return refused(reply, revision);

      const acting = await actingProject(auth, request, "writes into");
      if (isRefusal(acting)) return refused(reply, acting);

      const archived = await archiveConnection(acting, agentId, connectionId, {
        ...(revision === undefined ? {} : { expectedRevision: revision }),
      });
      if (archived === undefined) return refused(reply, NO_SUCH_CONNECTION);

      return reply.send({
        connection: describedConnection(archived.connection),
        canceled_runs: archived.canceledRuns,
      });
    },
  );

  /**
   * Bring a connection back, on the terms its own shape sets — and never on
   * the credential it was archived with.
   */
  app.post(
    "/api/agents/:agentId/connections/:connectionId/restore",
    async (request, reply) => {
      const { auth } = requesterOf(request);
      const { agentId, connectionId } = request.params as {
        agentId: string;
        connectionId: string;
      };
      const body = (request.body ?? {}) as Body;

      const unknown = unknownKeyIn(
        body,
        CONNECTION_RESTORE_KEYS,
        "a restore",
      );
      if (unknown !== undefined) return refused(reply, unknown);
      const revision = revisionIn(body, fromBrowser(auth));
      if (isRefusal(revision)) return refused(reply, revision);
      const name = textWhenGiven(body.name, "a connection's name");
      if (isRefusal(name)) return refused(reply, name);

      const credential = restoreCredentialIn(body.credential);
      if (isRefusal(credential)) return refused(reply, credential);

      const acting = await actingProject(auth, request, "writes into");
      if (isRefusal(acting)) return refused(reply, acting);

      const restored = await restoreConnection(acting, agentId, connectionId, {
        ...(revision === undefined ? {} : { expectedRevision: revision }),
        ...(name === undefined ? {} : { name }),
        ...(credential === undefined ? {} : { credential }),
      });
      if (restored === undefined) return refused(reply, NO_SUCH_CONNECTION);
      return reply.send({ connection: describedConnection(restored) });
    },
  );

  /** Ask this connection's adapter what its target can do, and record it. */
  app.post(
    "/api/agents/:agentId/connections/:connectionId/capabilities/refresh",
    async (request, reply) => {
      const { auth } = requesterOf(request);
      const { agentId, connectionId } = request.params as {
        agentId: string;
        connectionId: string;
      };

      const acting = await actingProject(auth, request, "writes into");
      if (isRefusal(acting)) return refused(reply, acting);

      const refreshed = await refreshConnectionCapabilities(
        acting,
        agentId,
        connectionId,
      );
      if (refreshed === undefined) return refused(reply, NO_SUCH_CONNECTION);
      return reply.send({ connection: describedConnection(refreshed) });
    },
  );

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

    if (error instanceof IdentityConflictError) {
      return refused(reply, {
        refused: true,
        error: "identity_conflict",
        message: error.message,
      });
    }

    if (error instanceof ConnectionRestoreRefusedError) {
      return refused(reply, {
        refused: true,
        error: error.reason,
        message: error.message,
      });
    }

    if (error instanceof NoCapabilityAdapterError) {
      return refused(reply, {
        refused: true,
        error: "no_capability_adapter",
        message: error.message,
      });
    }

    if (error instanceof CapabilityCheckFailedError) {
      return refused(reply, {
        refused: true,
        error: "capability_check_failed",
        message: error.message,
      });
    }

    /**
     * Who is asking may not, said in the product's own sentence.
     *
     * The layer below writes a sentence for a terminal — `a viewer may not
     * configure_agents` — which names an internal action word and reads as an
     * error rather than as a next move. This is the browser's reader: it names
     * the role somebody holds, what it cannot do in ordinary words, and the one
     * person who can change it. The code is what a client branches on and is
     * unchanged; only the sentence is.
     */
    if (error instanceof NotPermittedError) {
      return reply.code(403).send({
        error: "not_permitted",
        message:
          `Your ${error.role} role cannot ${plainly(error.action)}. Ask an ` +
          "organization admin to change your role, then try again.",
      });
    }

    throw error;
  });
}
