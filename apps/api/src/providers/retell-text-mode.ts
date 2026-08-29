import {
  readEngineConfiguration,
  resolveAgentVersion,
  toolCoverageOf,
  toolsOf,
  type Fetch as ProviderFetch,
  type RetellCredential,
  type ToolCoverage,
} from "@egma/retell";

/**
 * What a run over a Retell text mode connection reads before it starts.
 *
 * Two reads and no writes, in this order and for these reasons:
 *
 * 1. **Which version is serving.** Resolved once, here, and named explicitly on
 *    every request from then on. Retell's own default is "the newest version",
 *    and the newest version is exactly the one a concurrent edit has just made
 *    — so a suite that leaned on the default could be testing two different
 *    agents halfway through. Resolving `latest` once and pinning the number it
 *    answers is the whole fix.
 * 2. **What that version's tools are.** Which of them Egma can stand in front
 *    of, which execute inside Retell where nothing reaches, and which Egma does
 *    not intercept yet — the three classes, read from the configuration rather
 *    than guessed from what a conversation happened to call.
 *
 * **A custom LLM is refused here, with Retell's own absence as the reason.**
 * Retell holds no configuration for one at all: the brain and the tools live on
 * the customer's own socket server, behind a websocket URL. The shared client
 * answers that as `not-held` rather than as a failure, because there was never
 * anything to ask for — and that sentence is what a developer is told, plus
 * where the future of reaching such an agent actually lies.
 *
 * **Nothing here is optional.** A resolve or a tool read that fails fails the
 * run, loudly, before a single simulation exists. The alternative is a suite
 * conducted against a world nobody read, whose coverage stamp would be a claim
 * about tools Egma never saw.
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
      /** The serving version this run will name on every request. */
      readonly agentVersion: number;
      /**
       * The three classes of that version's tools, read before any turn.
       *
       * Answered to the caller and stored nowhere: it is what an enable-time
       * screen shows, computed live, and the record has no room for a list
       * that would go stale the moment the customer edits the agent.
       */
      readonly coverage: ToolCoverage;
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

/**
 * What Egma asks Retell for when it asks "which version is serving".
 *
 * `latest` is Retell's own word for it, and asking for it **once** is the
 * opposite of leaning on it: what comes back is a number, and the number is
 * what every later request names.
 */
const WHAT_IS_SERVING = "latest";

/** Retell would not answer, said the same way whichever read met it. */
function unavailable(what: string): PlatformWorldRead {
  return {
    kind: "unavailable",
    message:
      `Retell did not answer while Egma read ${what} for this run. ` +
      "Nothing was started. Try again shortly.",
  };
}

/**
 * The version this run will conduct against, and that version's tools.
 *
 * The credential is used for these two requests and is never returned, logged,
 * or put into a refusal — the shared client owns that discipline, and every
 * sentence below is written from Egma's own words rather than from Retell's
 * answer body.
 */
export async function readTextModeWorld(
  input: {
    readonly apiKey: string;
    readonly agentId: string;
  },
  fetchImpl: ProviderFetch = fetch,
  timeoutMilliseconds = READ_TIMEOUT_MILLISECONDS,
): Promise<PlatformWorldRead> {
  const agentId = input.agentId.trim();
  if (agentId === "") {
    return {
      kind: "refused",
      message:
        "This Retell text-mode connection names no agent, so there is " +
        "nothing to conduct against. Register the connection again with the " +
        "agent's own identifier from Retell.",
    };
  }

  const key = credential(input.apiKey);
  // Retell's own address, always. Where Retell answers is not a stored config
  // key on this door: a customer-writable one would decide where this
  // connection's sealed key is sent, and the control plane is the thing making
  // the request. The seam a test stands in is `fetchImpl`.
  const reach = {
    fetchImpl,
    signal: AbortSignal.timeout(Math.max(1, timeoutMilliseconds)),
  };

  const resolved = await resolveAgentVersion(
    key,
    agentId,
    WHAT_IS_SERVING,
    reach,
  );
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
        `Retell no longer holds agent ${agentId}. Choose another agent before ` +
        "starting another run.",
    };
  }
  if (resolved.kind !== "version") return unavailable("the serving version");

  const { agentVersion } = resolved;
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

  return {
    kind: "world",
    agentVersion: agentVersion.version,
    // The three classes, from the configuration and from nothing else. What
    // a conversation later calls cannot add to this: a tool that is in the
    // agent and never called is still a tool a screen has to account for.
    coverage: toolCoverageOf(toolsOf(configuration.engine)),
  };
}
