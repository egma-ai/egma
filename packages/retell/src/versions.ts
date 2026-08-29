/**
 * Agent versions, and the engine document each one points at.
 *
 * Retell keeps an agent's words and tools in a second object — a conversation
 * flow, or a Retell LLM — and the agent version holds only a pointer to it.
 * Everything here is about that pointer: what a name resolves to, what the
 * thing it points at holds, how a new version is branched from an old one, and
 * how a write names the exact version it is for.
 *
 * **Nothing here ever lets Retell choose the version.** Every write takes a
 * number and puts it in the query string. Retell's own default is "the latest
 * version", and the latest version is exactly the one a concurrent branch has
 * just minted — so a write that trusted the default is a write that can land
 * on somebody else's draft.
 *
 * **Nothing here publishes anything**, and nothing here is a draft-lane
 * detail: the reads are what any surface needs to look at a Retell agent at a
 * named version.
 */

import {
  ask,
  failureIn,
  parsed,
  plain,
  unreachableFrom,
  type RetellCredential,
  type RetellFailure,
  type RetellReach,
} from "./transport.ts";

/** Retell's three response engines, by the words Retell itself uses. */
export const ENGINE_TYPES = [
  "retell-llm",
  "conversation-flow",
  "custom-llm",
] as const;
export type EngineType = (typeof ENGINE_TYPES)[number];

/**
 * Which engine document an agent version runs on, and which version of it.
 *
 * `engineId` is `""` for a custom LLM, which is not an omission: Retell holds
 * no document for one at all — the brain and the tools are on the customer's
 * own socket server — so there is no id it could carry.
 */
export type EngineReference = {
  readonly type: EngineType;
  readonly engineId: string;
  /** The engine version this agent version points at, or null for none. */
  readonly version: number | null;
};

/** One agent version, as a resolve or a branch answers with it. */
export type AgentVersion = {
  /** The numeric version. Never a tag and never `latest`. */
  readonly version: number;
  readonly engine: EngineReference;
  /** Whether Retell has published it. */
  readonly published: boolean;
};

export type ResolvedAgentVersion =
  | { readonly kind: "version"; readonly agentVersion: AgentVersion }
  | RetellFailure;

export type BranchedAgentVersion =
  | { readonly kind: "branched"; readonly agentVersion: AgentVersion }
  | RetellFailure;

export type DeletedAgentVersion =
  | { readonly kind: "deleted" }
  | RetellFailure;

/** One engine document, whole, at the version it was read at. */
export type EngineConfiguration = {
  readonly reference: EngineReference;
  /** The document exactly as Retell answered it. Never rewritten here. */
  readonly document: Readonly<Record<string, unknown>>;
};

export type ReadEngineConfiguration =
  | { readonly kind: "engine"; readonly engine: EngineConfiguration }
  /**
   * Retell holds no configuration for this engine at all — a custom LLM,
   * whose tools live in the customer's own service. A refusal would say Retell
   * would not answer; this says there was never anything to ask for.
   */
  | { readonly kind: "not-held"; readonly reason: string }
  | RetellFailure;

export type WroteEngineTools = { readonly kind: "written" } | RetellFailure;

/** What a version reference may be: a number, `latest`, or a tag's name. */
export type VersionReference = number | string;

/**
 * Why text mode cannot reach a custom-LLM agent, in Retell's own absence.
 *
 * Exported to the package because two flows now say it — the run-start read
 * that refuses a run over a text-mode connection whose engine turned out to
 * be a custom LLM, and the connect flows that refuse the same engine at the
 * door, at the moment they read it. One sentence in one place, so the two
 * cannot drift into two ideas of why the same agent is out of reach.
 */
export const CUSTOM_LLM_HAS_NO_CONFIGURATION =
  "this agent's response engine is a custom LLM, so Retell holds none of its " +
  "words or tools: they run in your own service, behind the websocket URL " +
  "the agent points at.";

function engineTypeOf(value: unknown): EngineType {
  const named = plain(value);
  if (named === "custom-llm") return "custom-llm";
  if (named === "conversation-flow") return "conversation-flow";
  return "retell-llm";
}

/** The engine reference out of an agent document's `response_engine`. */
export function engineReferenceIn(
  document: Readonly<Record<string, unknown>>,
): EngineReference {
  const held = document["response_engine"];
  const engine =
    typeof held === "object" && held !== null
      ? (held as Record<string, unknown>)
      : {};
  const type = engineTypeOf(engine["type"]);
  const version = engine["version"];
  const engineId =
    type === "conversation-flow"
      ? plain(engine["conversation_flow_id"])
      : type === "retell-llm"
        ? plain(engine["llm_id"])
        : "";
  return {
    type,
    engineId,
    version: typeof version === "number" ? version : null,
  };
}

/**
 * The numeric version an agent document reports for itself.
 *
 * Read rather than echoed back from what was asked for, because what was asked
 * for is exactly what may not be a number: `latest` and a tag both resolve
 * here, and the number they resolve to is the answer this whole read exists
 * for.
 */
function versionIn(document: Readonly<Record<string, unknown>>): number | null {
  const version = document["version"];
  if (typeof version === "number") return version;
  const legacy = document["agent_version"];
  return typeof legacy === "number" ? legacy : null;
}

function agentVersionFrom(
  document: Readonly<Record<string, unknown>>,
): AgentVersion | null {
  const version = versionIn(document);
  if (version === null) return null;
  return {
    version,
    engine: engineReferenceIn(document),
    published: document["is_published"] === true,
  };
}

/**
 * What a version reference resolves to right now, and what it runs on.
 *
 * The one read that turns the customer's own words — `latest`, `prod` — into
 * the number every later step names explicitly. A run captures this once and
 * uses the number from then on, so a tag reassigned mid-run cannot move what a
 * run is testing.
 */
export async function resolveAgentVersion(
  key: RetellCredential,
  agentId: string,
  reference: VersionReference,
  reach: RetellReach = {},
): Promise<ResolvedAgentVersion> {
  let answer;
  try {
    answer = await ask(key, reach, {
      method: "GET",
      path:
        `/get-agent/${encodeURIComponent(agentId)}` +
        `?version=${encodeURIComponent(String(reference))}`,
    });
  } catch (cause) {
    return unreachableFrom(cause);
  }

  const failure = failureIn(answer);
  if (failure !== undefined) return failure;

  const agentVersion = agentVersionFrom(parsed(answer));
  if (agentVersion === null) {
    return {
      kind: "refused",
      reason: "Retell answered an agent version without a version number.",
    };
  }
  return { kind: "version", agentVersion };
}

/** Where one engine document is read, at the version it is asked for. */
function enginePath(reference: EngineReference): string | null {
  const id = encodeURIComponent(reference.engineId);
  if (reference.engineId === "") return null;
  if (reference.type === "conversation-flow") {
    return `/get-conversation-flow/${id}`;
  }
  if (reference.type === "retell-llm") return `/get-retell-llm/${id}`;
  return null;
}

/**
 * One engine's configuration at a named version.
 *
 * The version is part of the reference and is always sent when the reference
 * carries one: reading "whatever is latest" and then writing to a number is
 * two different objects one line apart.
 */
export async function readEngineConfiguration(
  key: RetellCredential,
  reference: EngineReference,
  reach: RetellReach = {},
): Promise<ReadEngineConfiguration> {
  if (reference.type === "custom-llm") {
    return { kind: "not-held", reason: CUSTOM_LLM_HAS_NO_CONFIGURATION };
  }
  const path = enginePath(reference);
  if (path === null) {
    return {
      kind: "refused",
      reason: "This agent names no response engine Retell holds.",
    };
  }

  let answer;
  try {
    answer = await ask(key, reach, {
      method: "GET",
      path:
        reference.version === null
          ? path
          : `${path}?version=${reference.version}`,
    });
  } catch (cause) {
    return unreachableFrom(cause);
  }

  const failure = failureIn(answer);
  if (failure !== undefined) return failure;

  return {
    kind: "engine",
    engine: { reference, document: parsed(answer) },
  };
}

/**
 * A new agent version, branched by Retell from a named base.
 *
 * Retell forks the engine document itself, which is the whole reason this is a
 * branch rather than a copy: a hand-made twin is missing every field egma has
 * never heard of, and the fields egma has never heard of are exactly the ones
 * that make the agent under test the agent the customer ships.
 *
 * Only `base_version` is sent. A title and a description are refused by this
 * endpoint — they belong to publishing — and sending them creates nothing.
 */
export async function branchAgentVersion(
  key: RetellCredential,
  agentId: string,
  baseVersion: number,
  reach: RetellReach = {},
): Promise<BranchedAgentVersion> {
  let answer;
  try {
    answer = await ask(key, reach, {
      method: "POST",
      path: `/create-agent-version/${encodeURIComponent(agentId)}`,
      body: { base_version: baseVersion },
    });
  } catch (cause) {
    return unreachableFrom(cause);
  }

  const failure = failureIn(answer);
  if (failure !== undefined) return failure;

  const agentVersion = agentVersionFrom(parsed(answer));
  if (agentVersion === null) {
    return {
      kind: "refused",
      reason: "Retell answered a branched agent version without a version number.",
    };
  }
  return { kind: "branched", agentVersion };
}

/**
 * Write onto one engine version, naming that version and no other.
 *
 * The version is a required argument rather than a field of the reference, so
 * a caller cannot leave it out and get Retell's default. That default is
 * "latest", and after a branch the latest version is the branch — so a write
 * that leaned on it would land on whichever version was minted most recently
 * anywhere on the account.
 */
export async function writeEngineTools(
  key: RetellCredential,
  target: {
    readonly reference: EngineReference;
    /** The engine version to write onto. Always sent. */
    readonly version: number;
    /** Only the tool arrays. Everything else on the version is left alone. */
    readonly tools: Readonly<Record<string, unknown>>;
  },
  reach: RetellReach = {},
): Promise<WroteEngineTools> {
  const { reference } = target;
  if (reference.type === "custom-llm") {
    return { kind: "refused", reason: CUSTOM_LLM_HAS_NO_CONFIGURATION };
  }
  if (reference.engineId === "") {
    return {
      kind: "refused",
      reason: "This agent names no response engine Retell holds.",
    };
  }

  const id = encodeURIComponent(reference.engineId);
  const path =
    reference.type === "conversation-flow"
      ? `/update-conversation-flow/${id}`
      : `/update-retell-llm/${id}`;

  let answer;
  try {
    answer = await ask(key, reach, {
      method: "PATCH",
      path: `${path}?version=${target.version}`,
      body: target.tools,
    });
  } catch (cause) {
    return unreachableFrom(cause);
  }

  const failure = failureIn(answer);
  return failure ?? { kind: "written" };
}

/**
 * Delete one agent version.
 *
 * `gone` is a success in every teardown that calls this: a version that is not
 * there is a version that is not serving anybody, which is the whole of what a
 * delete is for. The caller decides that, not this verb — a sweep reads it as
 * done, and a proof that a delete really happened reads it as the answer it is.
 */
export async function deleteAgentVersion(
  key: RetellCredential,
  agentId: string,
  version: number,
  reach: RetellReach = {},
): Promise<DeletedAgentVersion> {
  let answer;
  try {
    answer = await ask(key, reach, {
      method: "DELETE",
      path: `/delete-agent-version/${encodeURIComponent(agentId)}/${version}`,
    });
  } catch (cause) {
    return unreachableFrom(cause);
  }

  const failure = failureIn(answer);
  return failure ?? { kind: "deleted" };
}
