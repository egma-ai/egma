import {
  addConnection,
  AgentAlreadyBoundError,
  agentMonitoringKey,
  AgentWriteRefusedError,
  authorize,
  archiveAgent,
  archiveConnection,
  enablePullProductionCalls,
  connectionOptionMetadata,
  ConnectionRestoreRefusedError,
  getAgent,
  getConnection,
  IdentityConflictError,
  listAgents,
  listConnections,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  registerAgent,
  restoreAgent,
  restoreConnection,
  sealAgentMonitoringKey,
  UnprocessableInputError,
  updateAgent,
  updateConnection,
  type Agent,
  type AccessVariant,
  type AgentPlatform,
  type AgentWithConnections,
  type AuthContext,
  type Connection,
  type ConnectionType,
  type Modality,
  type NewConnection,
  type RestoreCredential,
} from "@egma/db";
import { isId } from "@egma/ids";
import { agentOperations } from "@egma/platform-api/contract";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import {
  AGENTS_PROJECT_WORDING,
  resolveAbsentProject,
  resolveNamedProject,
  type ActingRefusal,
} from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import {
  confirmRetellCandidate,
  discoverRetellAgents,
} from "../providers/retell.ts";
import {
  CODES,
  identityConflict,
  type RefusalCode,
} from "../http/refusals.ts";

/**
 * Registering an agent, reading it back, and attaching another way to reach it.
 *
 * The group mirrors the factory behind it, and three shapes are load-bearing:
 *
 * - **Agent-rooted, always.** A connection is only ever reached through its
 *   agent, so there is no `/v1/connections`. Naming the wrong agent answers
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
  /** Test seam for Retell account reads. Production uses the global fetch. */
  readonly retellFetch?: typeof fetch | undefined;
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
    "GET /v1/agents.",
};

/** The same answer, one level down: through the wrong agent, or not at all. */
const NO_SUCH_CONNECTION: Refusal = {
  refused: true,
  error: "not_found",
  message:
    "no connection of yours has that id on that agent. Check both ids, or " +
    "read the agent with GET /v1/agents/{agentId}.",
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
          `Egma no longer keeps what was pulled from the provider, so ${what} ` +
          'has no "pulled" key. Drop it and send ' +
          `${held.join(", ")}; the agent's content stays at the provider, ` +
          "where Egma reads it fresh rather than out of a copy that would go " +
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
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return invalid(`${named} is written as true or false`);
}

/** How many rows one page may hold, before the access layer's own ceiling. */
const LARGEST_PAGE = 200;

/** Shorter than any key a platform issues, so it cannot be one. */
const SHORTEST_KEY = 8;

function boundedLimit(value: unknown): number | undefined | Refusal {
  if (value === undefined || value === null || value === "") return undefined;
  const asked = Number(value);
  if (!Number.isInteger(asked) || asked < 1 || asked > LARGEST_PAGE) {
    return invalid(
      `pageSize is a whole number between 1 and ${LARGEST_PAGE}; a page is ` +
        "carried on with nextPageToken rather than made larger.",
    );
  }
  return asked;
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
  const named = textWhenGiven(query.projectId, "a project");
  if (isRefusal(named)) return named;
  return verb === "reads" ? readingIn(auth, named) : writingIn(auth, named);
}

const AGENT_EDIT_KEYS = ["name"] as const;
const ARCHIVE_KEYS = [] as const;
const AGENT_RESTORE_KEYS = ["name"] as const;
const CONNECTION_EDIT_KEYS = [
  "name",
  "environment",
  "config",
  "credentials",
] as const;
const CONNECTION_RESTORE_KEYS = ["name", "credential"] as const;

const AGENT_KEYS = ["name", "agentPlatform", "projectId", "connection"] as const;
const CONNECTION_KEYS = [
  "name",
  "agentPlatform",
  "connectionType",
  "accessVariant",
  "modality",
  "environment",
  "config",
  "credentials",
  "platformAgentId",
  "pullProductionCalls",
  "agentPlatformSelection",
] as const;

function agentPlatformIn(value: unknown): AgentPlatform | Refusal {
  const named = textWhenGiven(value, "an agent platform");
  if (isRefusal(named)) return named;
  if (named !== "retell" && named !== "livekit") {
    return invalid(
      "an agent platform is required and must be retell or livekit",
    );
  }
  return named;
}

/**
 * Which Retell agent this connection reaches, and the key that proves it.
 *
 * **One shape, two spellings.** A request says `platformAgentId` beside
 * `credentials` (the flow the connect sheet uses since 2026-08-24), or wraps
 * both in the older `agentPlatformSelection` envelope. They are read into this
 * before anything else looks at them, so the confirmation, the seal and the
 * switch all have exactly one thing to read.
 *
 * The key is optional here and only here: an agent that already holds its
 * sealed copy is never asked for it again, and the route lends that copy to
 * the confirmation.
 */
type RetellChoice = {
  readonly platformAgentId: string;
  readonly apiKey: string | undefined;
};

type AgentPlatformSelection = {
  readonly platformAgentId: string;
  readonly apiKey: string;
};

/** The external agent selection to recheck, never a stored connection fact. */
function agentPlatformSelectionIn(
  value: unknown,
): AgentPlatformSelection | undefined | Refusal {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("agentPlatformSelection is an object returned by agent discovery");
  }
  const selection = value as Body;
  const unknown = unknownKeyIn(
    selection,
    ["platformAgentId", "credentials"],
    "an agent platform selection",
  );
  if (unknown !== undefined) return unknown;

  const platformAgentId = textWhenGiven(
    selection.platformAgentId,
    "a platform agent id",
  );
  if (isRefusal(platformAgentId)) return platformAgentId;
  if (platformAgentId === undefined) {
    return invalid("agentPlatformSelection needs platformAgentId");
  }
  if (
    typeof selection.credentials !== "object" ||
    selection.credentials === null ||
    Array.isArray(selection.credentials)
  ) {
    return invalid("agentPlatformSelection needs account credentials");
  }
  const credentials = selection.credentials as Body;
  const unknownCredential = unknownKeyIn(
    credentials,
    ["apiKey"],
    "agent platform credentials",
  );
  if (unknownCredential !== undefined) return unknownCredential;
  const apiKey = textWhenGiven(credentials.apiKey, "a Retell API key");
  if (isRefusal(apiKey)) return apiKey;
  if (apiKey === undefined || apiKey.trim().length < SHORTEST_KEY) {
    return {
      refused: true,
      error: "unprocessable",
      message: "Paste a Retell API key, then try again.",
    };
  }
  return {
    platformAgentId: platformAgentId.trim(),
    apiKey: apiKey.trim(),
  };
}

/**
 * One connection payload, read the one way — inline on a registration and
 * standalone on an attach.
 *
 * Almost nothing is checked here: the registry behind the seam owns what a
 * access variant's config fields and credential rule, and the kind's modalities,
 * credential, and it says so in sentences written to be relayed. Duplicating
 * any of that would produce a second opinion that could disagree. What this
 * does own is the shape of the envelope: which keys exist at all, and that the
 * ones carrying text carry text.
 *
 * **Topology is not in the list on purpose.** It is derived from the connection type — it
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
    // Handed on as they arrived. The registry names an unsupported tuple, a
    // config key it has no place for, and a credential that does not belong,
    // each in its own words.
    agentPlatform:
      body.agentPlatform === null
        ? null
        : ((typeof body.agentPlatform === "string"
            ? body.agentPlatform
            : "") as AgentPlatform),
    connectionType: (typeof body.connectionType === "string"
      ? body.connectionType
      : "") as ConnectionType,
    accessVariant: (typeof body.accessVariant === "string"
      ? body.accessVariant
      : "") as AccessVariant,
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
 * Which Retell agent a connection request names, whichever spelling it used.
 *
 * A request that says both is refused rather than reconciled: two answers to
 * one question is exactly the shape that lets a client believe it picked one
 * agent while Egma wrote another.
 */
function retellChoiceIn(
  body: Body,
  selection: AgentPlatformSelection | undefined,
): RetellChoice | undefined | Refusal {
  const named = textWhenGiven(body.platformAgentId, "a platform agent id");
  if (isRefusal(named)) return named;

  if (selection !== undefined) {
    if (named !== undefined) {
      return invalid(
        "a connection names the picked agent in platformAgentId or in " +
          "agentPlatformSelection, and not in both",
      );
    }
    return { platformAgentId: selection.platformAgentId, apiKey: selection.apiKey };
  }
  if (named === undefined || named.trim() === "") return undefined;

  const credentials =
    typeof body.credentials === "object" &&
    body.credentials !== null &&
    !Array.isArray(body.credentials)
      ? (body.credentials as Body)
      : undefined;
  const apiKey = textWhenGiven(credentials?.apiKey, "a Retell API key");
  if (isRefusal(apiKey)) return apiKey;

  return {
    platformAgentId: named.trim(),
    ...(apiKey === undefined ? { apiKey: undefined } : { apiKey: apiKey.trim() }),
  };
}

/** Whether this save also starts pulling the agent's production calls. */
function pullFlagIn(value: unknown): boolean | Refusal {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    return invalid("pullProductionCalls is written as true or false");
  }
  return value;
}

/**
 * What a confirmed Retell connection leaves behind for the routes to finish:
 * the connection to write, and the custody facts the agent takes from it.
 */
type ConfirmedConnection = {
  readonly connection: NewConnection;
  /** Present only for Retell, which is the only platform with an account. */
  readonly custody?: { readonly platformAgentId: string; readonly apiKey: string };
};

/**
 * Confirm the picked Retell agent with the key, immediately before the write.
 *
 * **Discovery is only a snapshot**, so the id a person picked minutes ago is
 * re-read here: the agent still exists, it is still the right modality, and —
 * for a phone connection — the number typed into the sheet is still routed to
 * that agent. A number that has stopped answering is refused rather than
 * stored, which is the whole reason the save spends a round trip.
 *
 * Only the normalized connection reaches the database. The key travels no
 * further than the agent's own sealed column, and Retell chat keeps its own
 * copy on the connection because that access method needs it for every
 * simulation.
 */
async function confirmRetellAgent(
  wanted: NewConnection,
  choice: RetellChoice | undefined,
  lentKey: string | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<ConfirmedConnection | Refusal> {
  if (wanted.agentPlatform !== "retell") {
    if (choice !== undefined) {
      return invalid(
        "platformAgentId names an agent on a platform Egma can list, and only " +
          "Retell is one",
      );
    }
    return { connection: wanted };
  }
  if (choice === undefined) {
    /*
     * **A phone connection is the one that cannot be taken on trust.** A
     * number is not an identity: it is routed at the provider and can stop
     * answering for the agent it was picked for, so Egma has to re-read the
     * route before it stores one. Every other Retell connection carries the
     * platform agent id in its own config, where the registry checks it.
     */
    if (
      wanted.connectionType === "phone_number" &&
      wanted.accessVariant === "phone_number.public_e164" &&
      wanted.modality === "voice"
    ) {
      return invalid(
        "a Retell phone connection needs platformAgentId so Egma can confirm " +
          "the number still reaches the selected agent",
      );
    }
    return { connection: wanted };
  }

  const apiKey = choice.apiKey ?? lentKey;
  if (apiKey === undefined || apiKey.trim().length < SHORTEST_KEY) {
    return {
      refused: true,
      error: "unprocessable",
      message: "Paste a Retell API key, then try again.",
    };
  }

  const candidate = (() => {
    if (
      wanted.connectionType === "retell_chat_api" &&
      wanted.accessVariant === "retell_chat_api.api_key" &&
      wanted.modality === "chat"
    ) {
      return {
        connectionType: "retell_chat_api" as const,
        config: { retellAgentId: choice.platformAgentId },
      };
    }
    if (
      wanted.connectionType === "phone_number" &&
      wanted.accessVariant === "phone_number.public_e164" &&
      wanted.modality === "voice" &&
      typeof wanted.config["phoneNumber"] === "string"
    ) {
      return {
        connectionType: "phone_number" as const,
        config: { phoneNumber: wanted.config["phoneNumber"] },
      };
    }
    return undefined;
  })();
  if (candidate === undefined) {
    return invalid(
      "a Retell connection is the chat API or a phone number, and a phone " +
        "connection carries the number Egma dials in config.phoneNumber",
    );
  }

  const checked = await confirmRetellCandidate(
    apiKey,
    choice.platformAgentId,
    candidate,
    fetchImpl,
  );
  if (checked.kind === "invalid_key") {
    return {
      refused: true,
      error: "unprocessable",
      message:
        "Retell did not accept that API key. Copy it again from Retell, then try again.",
    };
  }
  if (checked.kind === "rejected") {
    return { refused: true, error: "unprocessable", message: checked.message };
  }
  if (checked.kind === "unavailable") {
    return { refused: true, error: "unavailable", message: checked.message };
  }

  const { credentials: _unconfirmedCredentials, ...withoutCredentials } = wanted;
  return {
    connection: {
      ...withoutCredentials,
      agentPlatform: checked.candidate.agentPlatform,
      connectionType: checked.candidate.connectionType,
      accessVariant: checked.candidate.accessVariant,
      modality: checked.candidate.modality,
      config: checked.candidate.config,
      ...(checked.candidate.connectionType === "retell_chat_api"
        ? { credentials: { apiKey } }
        : {}),
    },
    custody: { platformAgentId: choice.platformAgentId, apiKey },
  };
}

/**
 * The custody half of a connect save: the key lands on the agent, and the
 * checkbox — when it was ticked — starts the pull.
 *
 * **The seal happens whether or not the switch does.** A key is pasted once
 * per agent, ever, so the agent has to hold it from the first save even when
 * nobody asked for monitoring yet; that is what lets the next connect flow for
 * the same agent ask for no key at all.
 *
 * **A refusal here is relayed, never thrown.** The binding rule and the pull
 * switch both answer in sentences a person reads, so they come back as
 * refusals rather than as a fault. `boundElsewhere` below is checked before
 * the connection is written wherever the agent is known in advance, so the
 * ordinary way to meet this rule is a save that wrote nothing at all.
 */
async function takeCustody(
  acting: AuthContext,
  agentId: string,
  custody: { readonly platformAgentId: string; readonly apiKey: string },
  pull: boolean,
): Promise<Refusal | undefined> {
  try {
    await sealAgentMonitoringKey(acting, {
      agentId,
      agentPlatform: "retell",
      platformAgentId: custody.platformAgentId,
      apiKey: custody.apiKey,
    });
    if (pull) {
      await enablePullProductionCalls(acting, {
        agentId,
        agentPlatform: "retell",
        platformAgentId: custody.platformAgentId,
        apiKey: custody.apiKey,
      });
    }
    return undefined;
  } catch (error) {
    if (error instanceof UnprocessableInputError) {
      return { refused: true, error: "unprocessable", message: error.message };
    }
    if (lostToPullUniqueness(error)) {
      return {
        refused: true,
        error: "unprocessable",
        message:
          `${custody.platformAgentId} is already watched by another agent in ` +
          "this project. One Egma agent watches one Retell agent, so turn " +
          "that agent's switch off first, or connect without ticking Pull " +
          "production calls.",
      };
    }
    throw error;
  }
}

/**
 * The agent a registration would land on, when it would land on one that
 * already exists — asked before anything is written.
 *
 * **A registration can reuse.** `registerAgent` matches a living connection
 * naming the same vendor agent and answers with the agent that already holds
 * it, so a request that names no agent id can still settle on one that is
 * already bound. That is the path where the binding rule used to be met only
 * *after* the agent and its connection were written, which left a live
 * connection on an agent the save was refused for — and a second press wrote
 * a second one.
 *
 * **It reads the reuse key rather than re-deciding reuse.** The factory owns
 * the rule and keeps owning it; this asks the same question of the page of
 * agents the project can already answer with, and it asks it only for the one
 * connection shape that has a reuse key. Everything else creates a fresh,
 * unbound agent, which no binding rule can refuse.
 *
 * A miss here is not a hole: `takeCustody` still meets the access layer's own
 * refusal, and the register route undoes its connection when it does.
 */
async function reusedAgentFor(
  acting: AuthContext,
  wanted: NewConnection,
): Promise<Agent | undefined> {
  const vendorAgent = wanted.config["retellAgentId"];
  if (
    wanted.connectionType !== "retell_chat_api" ||
    typeof vendorAgent !== "string" ||
    vendorAgent === ""
  ) {
    return undefined;
  }
  const page = await listAgents(acting, {});
  return page.items.find((one) =>
    one.connections.some(
      (connection) =>
        connection.connectionType === "retell_chat_api" &&
        connection.config["retellAgentId"] === vendorAgent,
    ),
  );
}

/**
 * Whether a write lost to the one-switched-on-agent rule.
 *
 * The same reading `monitoring.ts` does, and for the same reason: the index is
 * what decides, because a read that checked first and wrote second would be a
 * race with the very next request. What it buys here is the sentence — without
 * it a person who ticked "Pull production calls" for a platform agent another
 * egma agent already watches got a fault, after their connection was written.
 *
 * It walks the `cause` chain because the query layer hands the driver's error
 * back wrapped.
 */
function lostToPullUniqueness(error: unknown): boolean {
  for (
    let at: unknown = error, depth = 0;
    at !== undefined && at !== null && depth < 4;
    depth += 1
  ) {
    if (typeof at !== "object") break;
    const carrier = at as { constraint?: unknown; cause?: unknown };
    if (carrier.constraint === "agent_pulled_platform_agent_unique") return true;
    at = carrier.cause;
  }
  return false;
}

/**
 * The binding rule, asked *before* anything is written.
 *
 * **One egma agent binds to one platform agent.** The access layer refuses the
 * second binding inside the transaction that would replace the first, which is
 * where the rule has to live to be race-free. This asks the same question one
 * step earlier, so the ordinary refusal leaves no connection behind on an
 * agent the save was never allowed to touch.
 *
 * It is not a substitute for the guard underneath and is not written as one:
 * two saves arriving together both read `null` here and one of them still
 * meets the real rule in the transaction.
 */
function boundElsewhere(
  known: Agent,
  choice: RetellChoice | undefined,
): Refusal | undefined {
  if (choice === undefined) return undefined;
  if (
    known.platformAgentId === null ||
    known.platformAgentId === choice.platformAgentId
  ) {
    return undefined;
  }
  return {
    refused: true,
    error: "unprocessable",
    message: new AgentAlreadyBoundError(
      known.name,
      known.platformAgentId,
      choice.platformAgentId,
    ).message,
  };
}

/**
 * An agent, as every read of one describes it.
 *
 * **The provider's half of an agent has no line here and never will.** Prompt,
 * model and tools live at the provider, where egma cannot freeze them and has
 * no business editing them; what egma owns is the name, the platform binding
 * and the identity every result accumulates against. A read that carried a copy of
 * provider configuration would be a copy going stale from the moment it was
 * taken, and an editor built on it would be egma quietly becoming a second
 * place to configure an agent.
 */
function describedAgent(one: Agent): Record<string, unknown> {
  return {
    id: one.id,
    projectId: one.projectId,
    name: one.name,
    // Which platform runs this agent, that platform's own id for it, and
    // whether egma is pulling its production calls. Null until somebody binds
    // it; the key itself never leaves the row, only its hint.
    agentPlatform: one.agentPlatform,
    platformAgentId: one.platformAgentId,
    monitoringKeyPresent: one.monitoringApiKeyHint !== null,
    monitoringApiKeyHint: one.monitoringApiKeyHint,
    pullProductionCalls: one.pullProductionCalls,
    // Whether it pulls and when it last received: the two monitoring facts an
    // agent states about itself, and never a condition word beside them.
    lastReceivedAt: one.lastReceivedAt?.toISOString() ?? null,
    archived: one.archivedAt !== null,
    archivedAt: one.archivedAt?.toISOString() ?? null,
    createdAt: one.createdAt.toISOString(),
    updatedAt: one.updatedAt.toISOString(),
  };
}

/**
 * A connection, as every read of one describes it.
 *
 * The sealed envelope has no line here and no line in the type this is built
 * from, so there is no serializer to remember to strip it in.
 * `credentialsHint` is the whole of what comes back: enough to tell one
 * provider key from another, and enough to see that a rotation landed.
 */
function describedConnection(one: Connection): Record<string, unknown> {
  return {
    id: one.id,
    agentId: one.agentId,
    projectId: one.projectId,
    name: one.name,
    agentPlatform: one.agentPlatform,
    connectionType: one.connectionType,
    accessVariant: one.accessVariant,
    modality: one.modality,
    // The registry derives this from the four technical facts above. It is the
    // one customer-facing name that agent lists and connection pages share.
    productLabel: one.productLabel,
    topology: one.topology,
    environment: one.environment,
    config: one.config,
    // Whether there is a credential at all, and the hint — never the secret,
    // and never a blank field a serializer could one day be taught to fill.
    credentialPresent: one.credentialsHint !== null,
    credentialsHint: one.credentialsHint,
    archived: one.archivedAt !== null,
    archivedAt: one.archivedAt?.toISOString() ?? null,
    createdAt: one.createdAt.toISOString(),
    updatedAt: one.updatedAt.toISOString(),
  };
}

/**
 * An agent as a *list* of them describes it: the identity above, and every
 * living way egma can reach it.
 *
 * **One shape, not a second dialect.** The connections are the same objects
 * `GET /v1/agents/{agentId}` answers, described by the same function, so a
 * client that can read a connection from one read can read it from the other.
 * The alternative — a smaller connection here, a fuller one there — is how a
 * client comes to work on one path and fail on the other.
 *
 * They are the living ones. An archived connection is how egma *used* to reach
 * an agent, and that question is asked of the agent's own read with
 * `?archived=true`, exactly as it always was.
 */
function describedListedAgent(
  one: AgentWithConnections,
): Record<string, unknown> {
  return {
    ...describedAgent(one),
    connections: one.connections.map(describedConnection),
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
 *
 * This function decides whether the credential may reach the project. Reading
 * where the caller wrote the project down is a separate concern in the route.
 */
async function reachableProject(
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
    const project = await reachableProject(auth, named, "writes into");
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

  const project = await reachableProject(auth, named, "reads");
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
    regrade: "regrade traces",
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

  /** Read supported simulation connection candidates from one agent platform. */
  registerPlatformOperation(
    app,
    agentOperations.discoverAgents,
    async (request, reply) => {
      const { auth } = requesterOf(request);
      const body = (request.body ?? {}) as Body;
      const unknown = unknownKeyIn(
        body,
        ["agentPlatform", "credentials", "agentId"],
        "an agent discovery",
      );
      if (unknown !== undefined) return refused(reply, unknown);

      const agentPlatform = textWhenGiven(
        body.agentPlatform,
        "an agent platform",
      );
      if (isRefusal(agentPlatform)) return refused(reply, agentPlatform);
      if (agentPlatform !== "retell") {
        return refused(reply, {
          refused: true,
          error: "unprocessable",
          message: "Choose Retell as the agent platform, then try again.",
        });
      }

      const namedAgent = textWhenGiven(body.agentId, "an agent");
      if (isRefusal(namedAgent)) return refused(reply, namedAgent);

      /*
       * **A key is pasted once per agent, ever.** So a listing either carries
       * the paste, or names the agent whose sealed copy it wants to spend.
       * Naming both is a request with two answers to one question, and the
       * plaintext never travels back out either way.
       */
      let pasted: string | undefined;
      if (body.credentials !== undefined) {
        if (
          typeof body.credentials !== "object" ||
          body.credentials === null ||
          Array.isArray(body.credentials)
        ) {
          return refused(reply, {
            refused: true,
            error: "unprocessable",
            message: "Paste a Retell API key, then try again.",
          });
        }
        const credentials = body.credentials as Body;
        const unknownCredential = unknownKeyIn(
          credentials,
          ["apiKey"],
          "Retell account credentials",
        );
        if (unknownCredential !== undefined) {
          return refused(reply, unknownCredential);
        }
        const apiKey = textWhenGiven(credentials.apiKey, "a Retell API key");
        if (isRefusal(apiKey)) return refused(reply, apiKey);
        if (apiKey === undefined || apiKey.trim().length < SHORTEST_KEY) {
          return refused(reply, {
            refused: true,
            error: "unprocessable",
            message: "Paste a Retell API key, then try again.",
          });
        }
        pasted = apiKey.trim();
      }

      if (pasted !== undefined && namedAgent !== undefined) {
        return refused(
          reply,
          invalid(
            "a discovery carries a pasted key or names the agent whose stored " +
              "key to spend, and not both",
          ),
        );
      }

      const acting = await actingProject(auth, request, "writes into");
      if (isRefusal(acting)) return refused(reply, acting);
      authorize(acting, "configure_agents", {
        organizationId: acting.organizationId,
        projectId: acting.projectId,
      });

      const spending =
        pasted ??
        (namedAgent === undefined
          ? undefined
          : await agentMonitoringKey(acting, namedAgent));
      if (spending === undefined) {
        return refused(reply, {
          refused: true,
          error: "unprocessable",
          message: "Paste a Retell API key, then try again.",
        });
      }

      const found = await discoverRetellAgents(spending, options.retellFetch);
      if (found.kind === "invalid_key") {
        return refused(reply, {
          refused: true,
          error: "unprocessable",
          message:
            "Retell did not accept that API key. Copy it again from Retell, then try again.",
        });
      }
      if (found.kind === "unavailable") {
        return refused(reply, {
          refused: true,
          error: "unavailable",
          message: found.message,
        });
      }
      return reply.send({ agents: found.agents });
    },
  );

  /**
   * Every simulation connection option egma supports, as a form may be drawn
   * from it.
   *
   * **The web application must never keep its own copy of any of this.** The
   * registry decides which config keys an access variant holds, which modalities the kind
   * speaks, and whether a credential is required, forbidden or optional; a
   * second handwritten copy in a browser would be a second opinion able to
   * disagree with the gate, and the disagreement would surface as a form that
   * asks for the wrong things and a create that refuses for reasons the form
   * cannot explain.
   *
   * **What crosses is labels, field shapes, the credential rule and two adapter
   * facts.** No gate function, no hint function, no refusal sentence, no
   * credential value. It is built by reading the registry rather than by
   * copying it, so nothing can be left behind when an option is added.
   */
  registerPlatformOperation(
    app,
    agentOperations.listConnectionOptions,
    async (_request, reply) => {
      return reply.send({
        items: connectionOptionMetadata().map((option) => ({
          agentPlatform: option.agentPlatform,
          agentPlatformLabel: option.agentPlatformLabel,
          connectionType: option.connectionType,
          accessVariant: option.accessVariant,
          accessVariantLabel: option.accessVariantLabel,
          modality: option.modality,
          productLabel: option.productLabel,
          topology: option.topology,
          // Whether egma can conduct a run over this option at all, and whether
          // it ships anything that can measure one of its targets. Two different
          // facts, and a form says both rather than implying either.
          simulatorAdapter: option.simulatorAdapter,
          fields: option.fields.map((field) => ({
            key: field.key,
            label: field.label,
            kind: field.kind,
            required: field.required,
            help: field.help,
            afterCredentials: field.afterCredentials === true,
          })),
          credentialRule: option.credentialRule,
          credentialHelp: option.credentialHelp,
          credentialFields: option.credentialFields.map((field) => ({
            field: field.field,
            label: field.label,
            kind: field.kind,
            required: field.required,
            help: field.help,
          })),
        })),
      });
    },
  );

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
  registerPlatformOperation(app, agentOperations.registerAgent, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;
    const query = (request.query ?? {}) as Record<string, unknown>;

    const unknown = unknownKeyIn(body, AGENT_KEYS, "a registration");
    if (unknown !== undefined) return refused(reply, unknown);

    const name = textWhenGiven(body.name, "an agent's name");
    if (isRefusal(name)) return refused(reply, name);
    const agentPlatform = agentPlatformIn(body.agentPlatform);
    if (isRefusal(agentPlatform)) return refused(reply, agentPlatform);
    /*
     * **The query and the body**, with the query winning when both name a
     * project. A door that reads only one of the two ignores the other rather
     * than refusing it, which once made this route write to the wrong project.
     *
     * The connection gate stays this group's own, and it has to run first: a
     * `projectId` that is not text is refused **by name** here, and
     * a permissive reader would treat it as absent and silently fall back to
     * the credential's own project.
     */
    const said = textWhenGiven(body.projectId, "a project");
    if (isRefusal(said)) return refused(reply, said);

    const project = given(text(query.projectId)) ?? given(text(body.projectId));

    const inline =
      body.connection === undefined
        ? undefined
        : connectionIn(body.connection);
    if (isRefusal(inline)) return refused(reply, inline);
    const inlineBody = (body.connection ?? {}) as Body;
    const inlineSelection =
      body.connection === undefined
        ? undefined
        : agentPlatformSelectionIn(inlineBody.agentPlatformSelection);
    if (isRefusal(inlineSelection)) return refused(reply, inlineSelection);
    const inlineChoice =
      body.connection === undefined
        ? undefined
        : retellChoiceIn(inlineBody, inlineSelection);
    if (isRefusal(inlineChoice)) return refused(reply, inlineChoice);
    const pull = pullFlagIn(inlineBody.pullProductionCalls);
    if (isRefusal(pull)) return refused(reply, pull);

    const acting = await writingIn(auth, project);
    if (isRefusal(acting)) return refused(reply, acting);
    authorize(acting, "configure_agents", {
      organizationId: acting.organizationId,
      projectId: acting.projectId,
    });

    const confirmedInline =
      inline === undefined
        ? undefined
        : await confirmRetellAgent(
            inline,
            inlineChoice,
            undefined,
            options.retellFetch,
          );
    if (isRefusal(confirmedInline)) return refused(reply, confirmedInline);

    /*
     * The agent this registration would reuse, and whether it is already bound
     * somewhere else. Asked here so the ordinary refusal writes nothing at all.
     */
    if (confirmedInline !== undefined) {
      const reusing = await reusedAgentFor(acting, confirmedInline.connection);
      const bound =
        reusing === undefined ? undefined : boundElsewhere(reusing, inlineChoice);
      if (bound !== undefined) return refused(reply, bound);
    }

    const registered = await registerAgent(acting, {
      // Empty rather than absent, so the factory's own "an agent needs a name"
      // is what a request with no name hears.
      name: name ?? "",
      agentPlatform,
      ...(confirmedInline === undefined
        ? {}
        : { connection: confirmedInline.connection }),
    });

    /*
     * The key lands on the agent this registration settled on — created,
     * reused or extended alike — because custody belongs to the identity, not
     * to the request that happened to carry the paste.
     */
    if (confirmedInline?.custody !== undefined) {
      /*
       * A registration can reuse an agent that already exists, so this is the
       * path where the binding rule can be met without the request ever naming
       * an agent id. The refusal is the access layer's own sentence.
       */
      const stopped = await takeCustody(
        acting,
        registered.agent.id,
        confirmedInline.custody,
        pull,
      );
      if (stopped !== undefined) {
        /*
         * **A refusal un-writes exactly what this request wrote, and nothing
         * else.** That is the whole rule, and each of its three halves was
         * learned by getting it wrong:
         *
         * - **The connection, when this request created one.** `created` and
         *   `connection_added` each wrote a row; `reused` wrote none. On
         *   `reused` the connection predates this request — the registration
         *   rotated its credential and nothing more — so archiving it would
         *   take away a working way into an agent over a refusal that was only
         *   ever about the pull switch, and could leave that agent with no way
         *   in at all.
         * - **Never the agent.** An agent this request created is unbound the
         *   instant it is written, so its custody step can only be refused if
         *   another writer bound it in the window between the insert and the
         *   seal — which means the agent is theirs, and `archiveAgent`
         *   cascades over every live connection on it, including the one they
         *   had just attached.
         * - **Never a row this request only read.** The pre-check above
         *   catches the ordinary case before anything is written at all; this
         *   is the raced one, and a racing request owns less than it thinks.
         *
         * A refused creator therefore leaves at worst an empty live agent row,
         * which is a row and not a loss.
         */
        if (
          registered.connection !== undefined &&
          registered.result !== "reused"
        ) {
          await archiveConnection(
            acting,
            registered.agent.id,
            registered.connection.id,
          );
        }
        return refused(reply, stopped);
      }
    }

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
   * `pageSize` chooses up to 200 agents. `pageToken` carries a reader through
   * the rest without repeating or skipping a row when the list changes.
   *
   * **Each agent carries its living connections.** Which agents egma can reach,
   * and how, is the question a list of agents is opened to answer, and one
   * request answers it for the whole page. There is no flag for it: a read that
   * sometimes carried them and sometimes did not would be two shapes behind one
   * address, and a client would work against one of them by accident.
   */
  registerPlatformOperation(app, agentOperations.listAgents, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Record<string, string | undefined>;

    const named = textWhenGiven(query.projectId, "a project");
    if (isRefusal(named)) return refused(reply, named);

    const pageToken = textWhenGiven(query.pageToken, "a page token");
    if (isRefusal(pageToken)) return refused(reply, pageToken);
    if (pageToken !== undefined && !isId("agt", pageToken)) {
      return refused(
        reply,
        invalid(
          `"${pageToken}" is not an agent id, so it cannot be a page token. Send ` +
            "back the nextPageToken from the page before this one, or leave it " +
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

    const pageSize = boundedLimit(query.pageSize);
    if (isRefusal(pageSize)) return refused(reply, pageSize);

    const page = await listAgents(reading, {
      ...(pageToken === undefined ? {} : { cursor: pageToken }),
      ...(search === undefined ? {} : { search }),
      ...(archived === undefined ? {} : { archived }),
      ...(pageSize === undefined ? {} : { limit: pageSize }),
    });

    return reply.send({
      agents: page.items.map(describedListedAgent),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this answer is an older shape that never had one".
      nextPageToken: page.nextCursor ?? null,
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
  registerPlatformOperation(app, agentOperations.getAgent, async (request, reply) => {
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
  registerPlatformOperation(app, agentOperations.addConnection, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const body = (request.body ?? {}) as Body;

    const wanted = connectionIn(body);
    if (isRefusal(wanted)) return refused(reply, wanted);
    const selection = agentPlatformSelectionIn(body.agentPlatformSelection);
    if (isRefusal(selection)) return refused(reply, selection);
    const choice = retellChoiceIn(body, selection);
    if (isRefusal(choice)) return refused(reply, choice);
    const pull = pullFlagIn(body.pullProductionCalls);
    if (isRefusal(pull)) return refused(reply, pull);

    const acting = await actingProject(auth, request, "writes into");
    if (isRefusal(acting)) return refused(reply, acting);
    authorize(acting, "configure_agents", {
      organizationId: acting.organizationId,
      projectId: acting.projectId,
    });
    /*
     * **The agent is read before the write when a Retell agent was picked**,
     * because two questions depend on it: whether it exists at all, and
     * whether it is already bound to a different platform agent. Asking after
     * the connection was written would leave a connection on an agent this
     * save was never allowed to bind.
     */
    const known = choice === undefined ? undefined : await getAgent(acting, agentId);
    if (choice !== undefined && known === undefined) {
      return refused(reply, NO_SUCH_AGENT);
    }
    const bound = known === undefined ? undefined : boundElsewhere(known, choice);
    if (bound !== undefined) return refused(reply, bound);
    /*
     * **The key this agent already holds is lent to the confirmation.** One
     * paste per agent, ever: a second connection onto the same agent asks for
     * no key, so the sealed copy is what proves the picked agent — and it is
     * read here rather than sent back to the browser to be sent in again.
     */
    const lent =
      choice?.apiKey === undefined
        ? await agentMonitoringKey(acting, agentId)
        : undefined;
    const confirmed = await confirmRetellAgent(
      wanted,
      choice,
      lent,
      options.retellFetch,
    );
    if (isRefusal(confirmed)) return refused(reply, confirmed);

    const added = await addConnection(acting, agentId, confirmed.connection);
    if (added === undefined) return refused(reply, NO_SUCH_AGENT);

    if (confirmed.custody !== undefined) {
      const stopped = await takeCustody(acting, agentId, confirmed.custody, pull);
      if (stopped !== undefined) {
        /*
         * **A refused save leaves nothing live behind**, the same backstop the
         * register path carries. `boundElsewhere` above catches the ordinary
         * case before a row exists; this is the raced one — two requests both
         * read an unbound agent, both write, and custody serializes them, so
         * the loser is holding a connection on an agent it was not allowed to
         * bind. For Retell chat that connection carries its own sealed key,
         * which makes leaving it a live way in rather than only a stray row.
         *
         * The agent is never archived here: this path is only ever given one
         * that already existed, so it was not this request's to remove.
         */
        await archiveConnection(acting, agentId, added.id);
        return refused(reply, stopped);
      }
    }

    return reply.code(201).send({ connection: describedConnection(added) });
  });

  /**
   * The Egma-owned half of an agent, edited last-writer-wins: the revision
   * column was dropped pre-launch (ADR-0015), so two people editing one agent
   * from two browsers is a silent overwrite.
   *
   * The name and nothing else. The provider's prompt, model and tools are not
   * here, are not in the read, and are not coming: they live where the customer
   * configures them, and egma being a second place to edit them would make two
   * answers to one question with no rule to choose between.
   */
  registerPlatformOperation(app, agentOperations.updateAgent, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const body = (request.body ?? {}) as Body;

    const unknown = unknownKeyIn(body, AGENT_EDIT_KEYS, "an agent edit");
    if (unknown !== undefined) return refused(reply, unknown);

    const name = textWhenGiven(body.name, "an agent's name");
    if (isRefusal(name)) return refused(reply, name);

    const acting = await actingProject(auth, request, "writes into");
    if (isRefusal(acting)) return refused(reply, acting);

    const updated = await updateAgent(acting, agentId, {
      ...(name === undefined ? {} : { name }),
    });

    if (updated === undefined) return refused(reply, NO_SUCH_AGENT);
    return reply.send({ agent: describedAgent(updated) });
  });

  /**
   * Take an agent out of new work, with every active way of reaching it and
   * every piece of work that was going over one.
   */
  registerPlatformOperation(app, agentOperations.archiveAgent, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const body = (request.body ?? {}) as Body;

    const unknown = unknownKeyIn(body, ARCHIVE_KEYS, "an archive");
    if (unknown !== undefined) return refused(reply, unknown);

    const acting = await actingProject(auth, request, "writes into");
    if (isRefusal(acting)) return refused(reply, acting);

    const archived = await archiveAgent(acting, agentId);
    if (archived === undefined) return refused(reply, NO_SUCH_AGENT);

    return reply.send({
      agent: describedAgent(archived.agent),
      // What went with it, said plainly, because a person who archives an
      // agent has just stopped work they may have been watching.
      archivedConnections: archived.connections,
      canceledRunCount: archived.canceledRunCount,
    });
  });

  /**
   * Bring an agent back — and only the agent. Its connections stay archived
   * until each is restored on its own access variant's credential terms.
   */
  registerPlatformOperation(app, agentOperations.restoreAgent, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { agentId } = request.params as { agentId: string };
    const body = (request.body ?? {}) as Body;

    const unknown = unknownKeyIn(body, AGENT_RESTORE_KEYS, "a restore");
    if (unknown !== undefined) return refused(reply, unknown);
    const name = textWhenGiven(body.name, "an agent's name");
    if (isRefusal(name)) return refused(reply, name);

    const acting = await actingProject(auth, request, "writes into");
    if (isRefusal(acting)) return refused(reply, acting);

    const restored = await restoreAgent(acting, agentId, {
      ...(name === undefined ? {} : { name }),
    });
    if (restored === undefined) return refused(reply, NO_SUCH_AGENT);
    return reply.send({ agent: describedAgent(restored) });
  });

  /** One way of reaching an agent, archived or not. */
  registerPlatformOperation(app, agentOperations.getConnection, async (request, reply) => {
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
  registerPlatformOperation(
    app,
    agentOperations.updateConnection,
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
      });

      if (updated === undefined) return refused(reply, NO_SUCH_CONNECTION);

      return reply.send({ connection: describedConnection(updated) });
    },
  );

  /** Stop reaching an agent this way, and settle the work that was. */
  registerPlatformOperation(
    app,
    agentOperations.archiveConnection,
    async (request, reply) => {
      const { auth } = requesterOf(request);
      const { agentId, connectionId } = request.params as {
        agentId: string;
        connectionId: string;
      };
      const body = (request.body ?? {}) as Body;

      const unknown = unknownKeyIn(body, ARCHIVE_KEYS, "an archive");
      if (unknown !== undefined) return refused(reply, unknown);

      const acting = await actingProject(auth, request, "writes into");
      if (isRefusal(acting)) return refused(reply, acting);

      const archived = await archiveConnection(acting, agentId, connectionId);
      if (archived === undefined) return refused(reply, NO_SUCH_CONNECTION);

      return reply.send({
        connection: describedConnection(archived.connection),
        canceledRunCount: archived.canceledRunCount,
      });
    },
  );

  /**
   * Bring a connection back, on the terms its own access variant sets — and never on
   * the credential it was archived with.
   */
  registerPlatformOperation(
    app,
    agentOperations.restoreConnection,
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
      const name = textWhenGiven(body.name, "a connection's name");
      if (isRefusal(name)) return refused(reply, name);

      const credential = restoreCredentialIn(body.credential);
      if (isRefusal(credential)) return refused(reply, credential);

      const acting = await actingProject(auth, request, "writes into");
      if (isRefusal(acting)) return refused(reply, acting);

      const restored = await restoreConnection(acting, agentId, connectionId, {
        ...(name === undefined ? {} : { name }),
        ...(credential === undefined ? {} : { credential }),
      });
      if (restored === undefined) return refused(reply, NO_SUCH_CONNECTION);
      return reply.send({ connection: describedConnection(restored) });
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
      if (
        error.reason === "needs_a_name" ||
        // The payload is well formed and every value in it is a real one; what
        // is wrong is the pair, which is what `unprocessable` is for.
        error.reason === "platform_contradicts_agent"
      ) {
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

    // The one refusal here whose sentence is not the layer below's. Two route
    // groups answer it and each names its own resource word, so the error
    // carries the data and `identityConflict` writes the sentence.
    if (error instanceof IdentityConflictError) {
      return refused(reply, {
        refused: true,
        error: "identity_conflict",
        message: identityConflict(error.resource, error.resourceId),
      });
    }

    if (error instanceof ConnectionRestoreRefusedError) {
      return refused(reply, {
        refused: true,
        error: error.reason,
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
