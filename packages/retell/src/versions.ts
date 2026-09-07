/**
 * Read agent versions and their flow or Retell LLM engine references.
 * Require explicit versions for writes so concurrent drafts cannot change the target.
 * Use Retell branching to preserve unknown engine fields. Nothing here publishes.
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

/**
 * Where an engine of either kind keeps the values it renders variables from.
 *
 * One top-level key with one spelling on a conversation flow and on a Retell
 * LLM alike, which is why it is named once here rather than at each end: the
 * read that captures a version's defaults and the write that puts them back
 * must be looking at the same field.
 */
export const DEFAULT_DYNAMIC_VARIABLES = "default_dynamic_variables";

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

export type WroteEngineTools =
  | {
      readonly kind: "written";
      /**
       * The version Retell reports it wrote, or null when it named none.
       *
       * Read back rather than assumed to equal the version asked for: Retell's
       * reference documents neither that an update edits in place nor that it
       * mints a new version, and a PATCH that minted one would leave an engine
       * version no documented endpoint can delete. The caller compares.
       */
      readonly version: number | null;
    }
  | RetellFailure;

/**
 * What a version reference may be: a number, `latest`, `latest_published`, or
 * an environment tag's name — Retell's own type, accepted wherever egma accepts
 * a version at all.
 */
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

/**
 * Retell's word for an engine kind, read back into egma's union — with
 * `retell-llm` as the answer for anything unrecognized, which is Retell's own
 * default engine. Exported so a note that stored the word can be read back into
 * a reference without a second opinion about what the words are.
 */
export function engineTypeOf(value: unknown): EngineType {
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

/** Newest published agent version. Unlike latest, this excludes unpublished drafts. */
export const LATEST_PUBLISHED = "latest_published";

/**
 * Shared recovery instructions when no published version is available:
 * publish a version in Retell or pin this agent's phone binding to a version or tag.
 */
export const PUBLISH_OR_BIND_A_VERSION =
  "Two ways open it. Publish in Retell the version you want tested — that is " +
  "the one Egma reaches when nothing else names one. Or pin a Retell phone " +
  "number that routes to this agent to a version or to an environment tag: " +
  "Egma follows that binding wherever it points, published or not.";

/**
 * What a developer whose agent has published nothing is told when a **run** is
 * refused for it.
 *
 * One sentence in one place, because three run-start surfaces say it — the
 * web-call lane's, the text-mode lane's, and the mocked world's serving read —
 * and three phrasings of one refusal would read as three different problems.
 * The enable-time read has its own lead-in and the same doors.
 */
export function noPublishedVersion(agentId: string): string {
  return (
    `Retell agent ${agentId} has no published version, and no phone number ` +
    "routing to it names one either. Egma conducts a run against the version " +
    "real callers reach and never against a draft, so there is nothing here " +
    `to test. ${PUBLISH_OR_BIND_A_VERSION}`
  );
}

export type ResolvedServingVersion =
  | { readonly kind: "version"; readonly agentVersion: AgentVersion }
  /** The agent is there, and nothing on it is published. */
  | { readonly kind: "none-published"; readonly reason: string }
  | RetellFailure;

/**
 * Resolve a run's reference once to a numeric version.
 * For latest_published, require a published result. On 404, make one additional
 * read to distinguish an existing unpublished agent from a missing agent.
 * Other explicit references pass through unchanged.
 */
export async function resolveServingAgentVersion(
  key: RetellCredential,
  agentId: string,
  reference: VersionReference,
  reach: RetellReach = {},
): Promise<ResolvedServingVersion> {
  const resolved = await resolveAgentVersion(key, agentId, reference, reach);
  if (reference !== LATEST_PUBLISHED) return resolved;

  if (resolved.kind === "version") {
    return resolved.agentVersion.published
      ? resolved
      : { kind: "none-published", reason: noPublishedVersion(agentId) };
  }
  if (resolved.kind !== "gone") return resolved;

  // The one disambiguating read. Positive evidence only: the agent answers, and
  // what it answers is a draft. Anything else — the agent gone too, the read
  // failing, a published `latest` that `latest_published` somehow missed —
  // leaves the original answer standing rather than inventing a diagnosis.
  const newest = await resolveAgentVersion(key, agentId, "latest", reach);
  if (newest.kind === "version" && !newest.agentVersion.published) {
    return { kind: "none-published", reason: noPublishedVersion(agentId) };
  }
  return resolved;
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
 * Branch from base_version through Retell so unknown engine fields are preserved.
 * Send only base_version; title and description belong to publishing.
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
 * Patch tools and routing defaults together on the explicitly named engine version.
 * Separate writes could leave tool URLs referring to unset variables.
 */
export async function writeEngineTools(
  key: RetellCredential,
  target: {
    readonly reference: EngineReference;
    /** The engine version to write onto. Always sent. */
    readonly version: number;
    /** Only the tool arrays. Everything else on the version is left alone. */
    readonly tools: Readonly<Record<string, unknown>>;
    /**
     * The whole `default_dynamic_variables` map, where this write sets one.
     *
     * Whole rather than a patch of it, because Retell replaces the map: a
     * write of Egma's entries alone would delete the customer's. Left out —
     * or empty — and the key is not sent at all, so a write that has no
     * routing variables to declare never touches the customer's defaults.
     */
    readonly defaults?: Readonly<Record<string, unknown>> | undefined;
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

  const defaults = target.defaults ?? {};
  let answer;
  try {
    answer = await ask(key, reach, {
      method: "PATCH",
      path: `${path}?version=${target.version}`,
      body: {
        ...target.tools,
        ...(Object.keys(defaults).length === 0
          ? {}
          : { [DEFAULT_DYNAMIC_VARIABLES]: defaults }),
      },
    });
  } catch (cause) {
    return unreachableFrom(cause);
  }

  const failure = failureIn(answer);
  if (failure !== undefined) return failure;
  // **What Retell says it wrote, handed back rather than dropped.** The docs do
  // not say whether a PATCH edits the named version in place or mints a new
  // one, and only this field tells the truth per call. It matters because there
  // is no documented way to remove a stray *flow* version — no
  // delete-conversation-flow-version exists — so a write that quietly minted
  // one would leave litter nothing can clean. The caller compares it to the
  // version it asked for.
  return { kind: "written", version: versionIn(parsed(answer)) };
}

/**
 * Delete an agent version using the version query parameter, not a path segment.
 * A 404 is not proof of absence; finishMockedWorld verifies the version listing.
 * Deletion leaves its flow version behind, with no single-version cleanup here;
 * the teardown records that residue.
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
      path: `/delete-agent-version/${encodeURIComponent(agentId)}?version=${version}`,
    });
  } catch (cause) {
    return unreachableFrom(cause);
  }

  const failure = failureIn(answer);
  return failure ?? { kind: "deleted" };
}

/** One agent version, as the listing names it. */
export type AgentVersionSummary = {
  readonly version: number;
  readonly published: boolean;
};

export type ListedAgentVersions =
  | {
      readonly kind: "versions";
      readonly versions: readonly AgentVersionSummary[];
    }
  | RetellFailure;

/** How many versions one listing request asks for. */
const VERSION_PAGE_SIZE = 1000;

/** A provider must finish a listing before it can hold this process forever. */
const MAX_VERSION_PAGES = 100;

/**
 * A listed version, or `null` for a row this reader cannot make one of.
 *
 * **A row that does not parse is not a row that is not there.** This listing's
 * only caller is a proof of absence, and a dropped row would be read as one
 * version fewer — so `"106"` arriving as a string where a number was expected
 * would empty the whole list and green-light a put-back that deleted nothing.
 * The caller refuses the page instead; nothing here is ever skipped quietly.
 */
function versionSummaryFrom(row: unknown): AgentVersionSummary | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const held = row as Record<string, unknown>;
  const version = held["version"];
  if (typeof version !== "number") return null;
  return { version, published: held["is_published"] === true };
}

/**
 * Read the complete /list-agent-versions/ listing to verify version absence.
 * Reject malformed pages, nonadvancing cursors, and full pages without a cursor.
 * An ambiguous listing must not be treated as a successful deletion.
 */
export async function listAgentVersions(
  key: RetellCredential,
  agentId: string,
  reach: RetellReach = {},
): Promise<ListedAgentVersions> {
  const versions: AgentVersionSummary[] = [];
  let paginationKey: string | undefined;
  const seenPaginationKeys = new Set<string>();

  try {
    for (let page = 0; page < MAX_VERSION_PAGES; page += 1) {
      const query = new URLSearchParams({
        limit: String(VERSION_PAGE_SIZE),
        ...(paginationKey === undefined
          ? {}
          : { pagination_key: paginationKey }),
      });
      const answer = await ask(key, reach, {
        method: "GET",
        path:
          `/list-agent-versions/${encodeURIComponent(agentId)}` +
          `?${query.toString()}`,
      });

      // A 404 here is a fact about **this request**, exactly as it is on the
      // delete: Retell answers the same three digits for an agent it does not
      // hold and for a route it does not have. So it is handed back as `gone`
      // and never read as proof of anything — the caller that is proving a
      // deletion treats every answer but an agreeing listing as "Egma cannot
      // say". See `finishMockedWorld`.
      const failure = failureIn(answer);
      if (failure !== undefined) return failure;

      const held = parsed(answer);
      const bare = Array.isArray(held);
      const rows = bare ? (held as unknown[]) : held["items"];
      if (!Array.isArray(rows)) {
        return {
          kind: "refused",
          reason: "Retell answered a malformed agent-version page.",
        };
      }
      for (const row of rows) {
        const summary = versionSummaryFrom(row);
        // Refused, never skipped: a row this reader cannot understand would
        // otherwise leave the list one version short, and one version short is
        // exactly how a version that is still there reads as absent.
        if (summary === null) {
          return {
            kind: "refused",
            reason: "Retell answered an agent version Egma could not read.",
          };
        }
        versions.push(summary);
      }

      // A bare array carries no cursor, so the only page is the whole listing —
      // unless it came back full, and a full one is refused rather than read as
      // complete.
      if (bare) {
        return rows.length >= VERSION_PAGE_SIZE
          ? {
              kind: "refused",
              reason:
                "Retell answered a full page of agent versions and no cursor.",
            }
          : { kind: "versions", versions };
      }
      if (held["has_more"] !== true) return { kind: "versions", versions };

      const next = plain(held["pagination_key"]);
      if (next === "" || seenPaginationKeys.has(next)) {
        return {
          kind: "refused",
          reason: "Retell answered an agent-version page without a new cursor.",
        };
      }
      seenPaginationKeys.add(next);
      paginationKey = next;
    }
  } catch (cause) {
    return unreachableFrom(cause);
  }

  return {
    kind: "refused",
    reason: "Retell answered too many agent-version pages.",
  };
}
