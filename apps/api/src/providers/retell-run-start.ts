import {
  bindingDecisionsFor,
  LATEST_PUBLISHED,
  listRoutedNumbers,
  readEngineConfiguration,
  resolveServingAgentVersion,
  versionReferenceIn,
  type AgentVersion,
  type Fetch as ProviderFetch,
  type RetellCredential,
  type VersionReference,
} from "@egma/retell";

/**
 * Resolve a serving version before creating a Retell text or web-call run.
 * Use shared binding resolution, falling back to latest published when no
 * binding selects a version. Do not use Retell's newest-created draft default.
 * Text mode also requires readable engine configuration and rejects custom
 * LLMs; web calls do not apply that engine gate. Mocked web calls later build
 * a temporary version through their own lifecycle.
 */

/**
 * How long one lane's run-start reads may take together.
 *
 * Up to three requests on the text-mode lane — the account's numbers, the
 * version, and that version's engine — and two on the web-call lane, which
 * needs no engine read.
 */
const READ_TIMEOUT_MILLISECONDS = 15_000;

/**
 * What any run-start platform read answers with.
 *
 * Named for the job rather than for this lane, because the run route dispatches
 * on it: a second kind that reads its platform before a run answers in these
 * same three shapes or the route cannot treat the two alike.
 */
export type PlatformWorldRead =
  | {
      readonly kind: "world";
      /**
       * The serving version this run will name on every request, and record.
       *
       * The only thing a run start takes from the read. The three classes of a
       * version's tools are computed live for the enable-time screen and stored
       * nowhere, so a run start has no use for them: a list frozen here would
       * go stale the moment the customer edits the agent.
       */
      readonly agentVersion: number;
    }
  /**
   * A settled fact about this agent, which retrying will not change: its
   * engine is out of this lane's reach, or Retell no longer holds it.
   */
  | { readonly kind: "refused"; readonly message: string }
  /** Retell would not answer. The same request later may well work. */
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Where the future of reaching a custom-LLM agent is, said beside the refusal.
 *
 * A refusal that only says no leaves a developer with nowhere to go. Their
 * agent's brain runs in their own process, and the seam that reaches a process
 * is the SDK's, not an HTTP door on somebody else's platform.
 */
const CUSTOM_LLM_NEXT_MOVE =
  "Egma reaches an agent's own process through its SDK, and a Retell adapter " +
  "there is where testing a custom-LLM agent belongs. Run these tests over a " +
  "phone connection in the meantime, which reaches the agent the way its " +
  "callers do.";

function credential(value: string): RetellCredential {
  return { reveal: () => value };
}

/** Retell would not answer, said the same way whichever read met it. */
function unavailable(what: string): {
  readonly kind: "unavailable";
  readonly message: string;
} {
  return {
    kind: "unavailable",
    message:
      `Retell did not answer while Egma read ${what} for this run. ` +
      "Nothing was started. Try again shortly.",
  };
}

/** What one lane needs to reach Retell, worked out once for both of them. */
type LaneReach = {
  readonly key: RetellCredential;
  readonly agentId: string;
  readonly reach: {
    readonly fetchImpl: ProviderFetch;
    readonly signal: AbortSignal;
  };
};

/**
 * Resolve the shared serving-version reference. Run starts inspect number
 * bindings; connection validation skips that listing and uses latest published.
 * Registration checks reachability without choosing a run version.
 */
async function readServingVersion(
  lane: LaneReach,
  /**
   * Whether the agent's number bindings decide the version.
   *
   * True for a run start, which is conducted against one version and must
   * agree with every other surface about which. False for the connect door,
   * which pins nothing and asks only whether this lane can reach the agent.
   */
  bindings: boolean,
): Promise<
  | { readonly kind: "serving"; readonly agentVersion: AgentVersion }
  | Exclude<PlatformWorldRead, { readonly kind: "world" }>
> {
  let reference: VersionReference = LATEST_PUBLISHED;
  if (bindings) {
    const listed = await listRoutedNumbers(lane.key, lane.reach);
    if (listed.kind === "invalid-key") {
      return {
        kind: "refused",
        message:
          "Retell rejected this connection's stored API key, so Egma could " +
          "not read which version of the agent is serving. Update the " +
          "connection before starting another run.",
      };
    }
    // No fallback. A run whose reference Egma could not work out is a run that
    // would test whichever version a guess landed on, and the whole of this
    // file exists so that a result names an agent a reader can go back to.
    if (listed.kind !== "numbers") {
      return unavailable("this agent's phone numbers");
    }
    reference = versionReferenceIn(
      bindingDecisionsFor(listed.numbers, lane.agentId),
    );
  }

  const resolved = await resolveServingAgentVersion(
    lane.key,
    lane.agentId,
    reference,
    lane.reach,
  );
  // The agent is there and has published nothing. A settled fact about the
  // agent, so it is a refusal rather than a "try again", and the sentence is
  // the package's one sentence for it — the mocked world's serving read says
  // the same words, so a developer meets one refusal and not three.
  if (resolved.kind === "none-published") {
    return { kind: "refused", message: resolved.reason };
  }
  if (resolved.kind === "invalid-key") {
    return {
      kind: "refused",
      message:
        "Retell rejected this connection's stored API key, so Egma could not " +
        "read which version of the agent is serving. Update the connection " +
        "before starting another run.",
    };
  }
  if (resolved.kind === "gone") {
    return {
      kind: "refused",
      message:
        `Retell no longer holds agent ${lane.agentId}. Choose another agent ` +
        "before starting another run.",
    };
  }
  if (resolved.kind !== "version") return unavailable("the serving version");
  return { kind: "serving", agentVersion: resolved.agentVersion };
}

/**
 * The trimmed agent identifier and the reach to read it with, or the refusal.
 *
 * A connection that names no agent is a registration that never finished, and
 * saying so names the door it came through rather than leaving a developer to
 * work out which of their connections is empty.
 */
function laneReach(
  input: { readonly apiKey: string; readonly agentId: string },
  named: string,
  fetchImpl: ProviderFetch,
  timeoutMilliseconds: number,
): LaneReach | { readonly kind: "refused"; readonly message: string } {
  const agentId = input.agentId.trim();
  if (agentId === "") {
    return {
      kind: "refused",
      message:
        `This ${named} connection names no agent, so there is nothing to ` +
        "conduct against. Register the connection again with the agent's own " +
        "identifier from Retell.",
    };
  }
  return {
    key: credential(input.apiKey),
    agentId,
    // Retell's own address, always. Where Retell answers is not a stored config
    // key on these doors: a customer-writable one would decide where this
    // connection's sealed key is sent, and the control plane is the thing
    // making the request. The seam a test stands in is `fetchImpl`.
    reach: {
      fetchImpl,
      signal: AbortSignal.timeout(Math.max(1, timeoutMilliseconds)),
    },
  };
}

/**
 * Resolve the web-call serving version without the text-mode engine gate.
 * Mock-draft creation is a separate step after the run exists.
 */
export async function readWebCallWorld(
  input: {
    readonly apiKey: string;
    readonly agentId: string;
  },
  fetchImpl: ProviderFetch = fetch,
  timeoutMilliseconds = READ_TIMEOUT_MILLISECONDS,
): Promise<PlatformWorldRead> {
  const lane = laneReach(
    input,
    "Retell web-call",
    fetchImpl,
    timeoutMilliseconds,
  );
  if ("kind" in lane) return lane;

  const serving = await readServingVersion(lane, true);
  if (serving.kind !== "serving") return serving;
  return { kind: "world", agentVersion: serving.agentVersion.version };
}

/**
 * Resolve the version and require engine configuration supported by text mode.
 * Run starts inspect bindings; connection validation passes bindings: false.
 */
export async function readTextModeWorld(
  input: {
    readonly apiKey: string;
    readonly agentId: string;
  },
  fetchImpl: ProviderFetch = fetch,
  timeoutMilliseconds = READ_TIMEOUT_MILLISECONDS,
  bindings = true,
): Promise<PlatformWorldRead> {
  const lane = laneReach(
    input,
    "Retell text-mode",
    fetchImpl,
    timeoutMilliseconds,
  );
  if ("kind" in lane) return lane;
  const { key, agentId, reach } = lane;

  const serving = await readServingVersion(lane, bindings);
  if (serving.kind !== "serving") return serving;

  const { agentVersion } = serving;
  const engine = agentVersion.engine;

  const configuration = await readEngineConfiguration(key, engine, reach);
  if (configuration.kind === "not-held") {
    // Retell's own absence, word for word, and then where to go instead.
    return {
      kind: "refused",
      message: `${configuration.reason} ${CUSTOM_LLM_NEXT_MOVE}`,
    };
  }
  if (configuration.kind === "invalid-key" || configuration.kind === "gone") {
    return {
      kind: "refused",
      message:
        `Egma resolved agent ${agentId} to version ${agentVersion.version}, ` +
        "and Retell would not give up that version's tools. Egma will not " +
        "conduct against a world it could not read, so the run was not " +
        "started.",
    };
  }
  if (configuration.kind !== "engine") {
    return unavailable(`version ${agentVersion.version}'s tools`);
  }

  // The configuration is read and then dropped. It answered the only question
  // this lane had of it — is this engine one text mode can reach — and the
  // three classes of its tools belong to the enable-time screen, which computes
  // them live rather than from a list a run start happened to freeze.
  return { kind: "world", agentVersion: agentVersion.version };
}
