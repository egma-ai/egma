import {
  bindingDecisionsFor,
  listRoutedNumbers,
  readEngineConfiguration,
  resolveServingAgentVersion,
  versionReferenceIn,
  type AgentVersion,
  type Fetch as ProviderFetch,
  type RetellCredential,
} from "@egma/retell";

/**
 * What a run over a Retell connection reads before it starts.
 *
 * **Both Retell lanes that reach a live agent read the same one fact first:
 * which version is serving.** Resolved once, here, and named explicitly on
 * every request from then on. Retell's own default is "the newest version", and
 * the newest version is exactly the one a concurrent edit — or another run's
 * draft — has just made, so a suite that leaned on the default could be testing
 * two different agents halfway through. Resolving once and pinning the number
 * that comes back is the whole fix, and the number is what the run's record
 * carries — and what the work order hands the simulator, so the version the run
 * conducts against is the version the record names.
 *
 * **What "serving" means is decided in one place for every surface.** The
 * account's numbers are read and this agent's own bindings answer it: a bound
 * version, an environment tag, or — where no binding names anything — the
 * newest *published* version, never Retell's `latest`, which means the newest
 * version *created* and so reaches whichever draft was minted last. That rule
 * is `versionReferenceIn` in the shared client, and the enable-time screen and
 * the mocked builder ask it the same question, so no two surfaces can disagree
 * about which version an agent is tested at.
 *
 * **An agent that publishes nothing and binds nothing is refused here**, before
 * a run row exists, with a sentence naming the ways out. There is no third
 * answer, because the third answer is a run conducted against a draft nobody
 * chose.
 *
 * **The text-mode lane reads one thing more, and refuses on it.** A custom LLM
 * has no configuration on Retell at all: the brain and the tools live on the
 * customer's own socket server, behind a websocket URL, and text mode cannot
 * reach one. The shared client answers that as `not-held` rather than as a
 * failure, because there was never anything to ask for — and that sentence is
 * what a developer is told, plus where the future of reaching such an agent
 * actually lies. A web call is brokered by Retell itself, which reaches a
 * custom LLM perfectly well, so that lane asks no such question.
 *
 * **Nothing here is optional.** A read that fails fails the run, loudly, before
 * a single simulation exists. The alternative is a run whose record names no
 * version, which is a result nobody can tie to an agent.
 */

/** How long the two run-start reads may take together. */
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
 * The serving version, read the one way for whichever lane is asking.
 *
 * **Shared rather than written twice**, because the two lanes make the identical
 * request for the identical reason, and two copies of it would be two places for
 * the answer to "which version is this run against" to drift. Each of the three
 * failures is a sentence about the connection, never about the request that met
 * it, and the credential is used and never returned, logged, or quoted — the
 * shared client owns that discipline.
 *
 * **Two requests, and the first one is what stops a screen and a run
 * disagreeing.** The account's numbers are read, and this agent's own bindings
 * decide the reference — a number bound to a version, a number riding an
 * environment tag, and `latest_published` only where no binding names anything.
 * That is the same reference `versionReferenceIn` gives the enable-time screen
 * and the mocked builder, resolved through the same verb. Asking for the
 * published pointer here regardless would have let a screen call an agent
 * mockable, on the strength of a number bound to version 5, while the run
 * refused it for publishing nothing — two surfaces reading one account and
 * telling a developer two different things about it.
 */
async function readServingVersion(
  lane: LaneReach,
): Promise<
  | { readonly kind: "serving"; readonly agentVersion: AgentVersion }
  | Exclude<PlatformWorldRead, { readonly kind: "world" }>
> {
  const listed = await listRoutedNumbers(lane.key, lane.reach);
  if (listed.kind === "invalid-key") {
    return {
      kind: "refused",
      message:
        "Retell rejected this connection's stored API key, so Egma could not " +
        "read which version of the agent is serving. Update the connection " +
        "before starting another run.",
    };
  }
  // No fallback. A run whose reference Egma could not work out is a run that
  // would test whichever version a guess landed on, and the whole of this file
  // exists so that a result names an agent a reader can go back to.
  if (listed.kind !== "numbers") {
    return unavailable("this agent's phone numbers");
  }
  const reference = versionReferenceIn(
    bindingDecisionsFor(listed.numbers, lane.agentId),
  );

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
 * The version a web-call run will conduct against.
 *
 * **One read and no gate.** A web call is brokered by Retell, so every engine
 * Retell will place a call against is one this lane reaches — including a custom
 * LLM, whose brain the broker talks to on the customer's own socket. There is
 * nothing here to refuse an agent for. A mocked web-call run asks Retell for
 * more than this, and it asks after the run row exists, in the builder that owns
 * putting the account back.
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

  const serving = await readServingVersion(lane);
  if (serving.kind !== "serving") return serving;
  return { kind: "world", agentVersion: serving.agentVersion.version };
}

/**
 * The version a text-mode run will conduct against, once this lane can reach it.
 *
 * The second read is a gate and not a stamp: what comes back decides whether
 * text mode can reach this agent at all, and nothing of it is kept.
 */
export async function readTextModeWorld(
  input: {
    readonly apiKey: string;
    readonly agentId: string;
  },
  fetchImpl: ProviderFetch = fetch,
  timeoutMilliseconds = READ_TIMEOUT_MILLISECONDS,
): Promise<PlatformWorldRead> {
  const lane = laneReach(
    input,
    "Retell text-mode",
    fetchImpl,
    timeoutMilliseconds,
  );
  if ("kind" in lane) return lane;
  const { key, agentId, reach } = lane;

  const serving = await readServingVersion(lane);
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
