import { connectionTypeBranchesMockDraft } from "@egma/db";
import {
  bindingDecisionsFor,
  discoverTools,
  listRoutedNumbers,
  PUBLISH_OR_NAME_A_VERSION,
  readEngineConfiguration,
  resolveServingAgentVersion,
  versionReferenceIn,
  type BindingDecision,
  type DiscoveredTool,
  type DiscoveryWarning,
  type Fetch as ProviderFetch,
  type RetellCredential,
} from "@egma/retell";

/**
 * What enabling mock tools would find, and the three reasons it is refused.
 *
 * The refusals are here, together, on purpose. Each one is a different fact
 * about the customer's account, and each has a different next move — so
 * collapsing them into "mocking is unavailable" would leave a person with a
 * disabled control and no idea what to do. A screen shows the sentence; the API
 * carries the same sentence; and both come from this one function, so they
 * cannot say different things.
 *
 * **Pinning a `latest`-riding number is not one of them.** It is one of the
 * four promises the single consent screen carries, so there is no second
 * per-number checkbox to decline and no refusal to raise for declining it.
 *
 * **Having no web-call lane yet is not one of them either.** It used to be:
 * the tick refused an agent whose only connection is a phone number and told
 * the person to add a connection no flow could create. The consent flow mints
 * that connection itself now, so the dead end cannot exist and the refusal that
 * named it is gone with it.
 *
 * The four:
 *
 * 1. **A custom-LLM engine.** The brain and the tools live on the customer's
 *    own socket server; Retell stores no tool configuration this seam could
 *    swap. Not a permanent no — it is structurally a LiveKit-shaped problem,
 *    and it belongs to the Egma SDK's in-process seam when that grows a Retell
 *    adapter.
 * 2. **Keys that disagree.** The agent's platform key builds the world and a
 *    connection's own key opens the calls. If the two resolve different
 *    accounts or different platform agents, one account would build the draft
 *    while another tried to call it — a failure that would otherwise surface
 *    only after the world was built.
 * 3. **The platform would not answer.** Not a fact about the agent but about
 *    the moment: Retell was unreachable while Egma read the account. Nothing is
 *    changed, and the person is told to try again — kept apart from the other
 *    two because its next move is "wait", not "reconfigure".
 * 4. **Nothing published.** The agent is there and every version on it is a
 *    draft. A mocked run is conducted against the version real callers reach
 *    and never against a draft, so there is nothing here to stand in front of.
 *    Its own reason rather than a shade of "keys disagree", because the two are
 *    different facts with different next moves: that one says the key cannot
 *    see the agent, this one says the agent has nothing to serve. Retell
 *    answers both with the same 404, and the resolve tells them apart by
 *    reading what the account says rather than by reading a status code — the
 *    same mechanism the run-start read uses, so a person meets one fact once.
 */

export const MOCK_TOOLS_REFUSALS = [
  "custom_llm_engine",
  "keys_disagree",
  "platform_unavailable",
  "never_published",
] as const;
export type MockToolsRefusalReason = (typeof MOCK_TOOLS_REFUSALS)[number];

export type MockToolsRefusal = {
  readonly reason: MockToolsRefusalReason;
  readonly message: string;
};

/** What a lane looks like to this check: a connection Egma could mock over. */
export type MockableLane = {
  readonly connectionType: string;
  /** The platform agent this connection reaches, where it names one. */
  readonly platformAgentId: string;
};

export type MockToolsDiscovery = {
  readonly mockable: boolean;
  readonly refusal: MockToolsRefusal | null;
  readonly engine: string | null;
  readonly servingVersion: number | null;
  readonly tools: readonly DiscoveredTool[];
  readonly warnings: readonly DiscoveryWarning[];
  readonly numbers: readonly BindingDecision[];
};

export type MockToolsDiscoveryInput = {
  /** The agent's own sealed platform key, opened. */
  readonly apiKey: string;
  /** The platform's id for the agent the tick is on. */
  readonly platformAgentId: string;
  /**
   * Every live connection on this agent, so the phone-only refusal and the
   * two-keys check can both be answered from what Egma already holds.
   */
  readonly lanes: readonly MockableLane[];
  readonly fetchImpl?: ProviderFetch | undefined;
};

const CUSTOM_LLM =
  "this agent's response engine is a custom LLM, so Retell holds none of its " +
  "words or tools: they run in your own service, behind the websocket URL the " +
  "agent points at. Egma cannot stand in front of a tool Retell never sees. " +
  "Tools that run inside your own process are what the Egma SDK's in-process " +
  "seam is for, and a Retell adapter for it is where this agent belongs.";

function keysDisagree(named: string, held: string): string {
  return (
    `this agent's platform identity is Retell agent ${held}, and a connection ` +
    `on it reaches Retell agent ${named}. Egma would build the mocked world on ` +
    "one agent and place the calls against another, so every mocked run would " +
    "reach a version that was never mocked. Point the agent and its " +
    "connections at the same Retell agent, with a key for the same account."
  );
}

const PLATFORM_AWAY =
  "Retell did not answer while Egma read this agent. Nothing was changed. Try " +
  "again.";

/**
 * The agent is there, and every version on it is a draft.
 *
 * The lead-in is this screen's voice — the tick explains what a mocked run
 * *would* find, where a run start refuses one outright — and the way out is the
 * shared clause, so the two surfaces can never name different doors out of one
 * dead end.
 */
const NEVER_PUBLISHED =
  "this agent has no published version on Retell. A mocked run is conducted " +
  "against the version real callers reach and never against a draft, so " +
  `there is nothing here for Egma to stand in front of. ${PUBLISH_OR_NAME_A_VERSION}`;

function refused(
  reason: MockToolsRefusalReason,
  message: string,
  found: Partial<MockToolsDiscovery> = {},
): MockToolsDiscovery {
  return {
    mockable: false,
    refusal: { reason, message },
    engine: null,
    servingVersion: null,
    tools: [],
    warnings: [],
    numbers: [],
    ...found,
  };
}

/**
 * Read the account and answer the whole question, refusals included.
 *
 * The order is chosen so that a person is told the most useful thing first: the
 * refusal Egma can answer without touching Retell comes before the reads, and
 * the numbers come after them because the bindings are what they are about.
 */
export async function discoverMockTools(
  input: MockToolsDiscoveryInput,
): Promise<MockToolsDiscovery> {
  // The lanes a mocked run could be conducted over, read through @egma/db so
  // the registry's own list and this one cannot drift. **An empty list is not a
  // refusal**: the consent flow mints the web-call connection when the agent has
  // none, so an agent reached only by phone today is an agent the flow can give
  // a mockable lane to, and this read answers what that lane would cover.
  const lanes = input.lanes.filter((lane) =>
    connectionTypeBranchesMockDraft(lane.connectionType),
  );

  // The keys-disagree refusal, the half that costs nothing: a connection naming a different
  // platform agent from the one the tick is on. The other half — two keys on
  // two accounts — is caught by the reads below, which use the agent's key
  // against the agent's own id and fail if that account does not hold it.
  const disagreeing = lanes.find(
    (lane) =>
      lane.platformAgentId !== "" &&
      lane.platformAgentId !== input.platformAgentId,
  );
  if (disagreeing !== undefined) {
    return refused(
      "keys_disagree",
      keysDisagree(disagreeing.platformAgentId, input.platformAgentId),
    );
  }

  const key: RetellCredential = { reveal: () => input.apiKey };
  const reach = {
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    signal: AbortSignal.timeout(20_000),
  };

  const listed = await listRoutedNumbers(key, reach);
  if (listed.kind !== "numbers") {
    return refused(
      listed.kind === "invalid-key" ? "keys_disagree" : "platform_unavailable",
      listed.kind === "invalid-key"
        ? "Retell would not take the key stored for this agent. Connect the " +
            "agent to its platform again with a key for the account that holds it."
        : PLATFORM_AWAY,
    );
  }
  const numbers = bindingDecisionsFor(listed.numbers, input.platformAgentId);

  // The same resolve a run start makes, through the same helper and over the
  // same reference — a screen that explains what ticking will do and a run that
  // is about to do it must not be able to disagree about which version that is,
  // nor about what stops them.
  const serving = await resolveServingAgentVersion(
    key,
    input.platformAgentId,
    versionReferenceIn(numbers),
    reach,
  );
  // The agent answered and has published nothing. Its own refusal rather than
  // the two-keys one below: Retell says 404 to both "this key cannot see that
  // agent" and "that agent has published nothing", and telling a person to
  // reconnect their key when what they need to do is publish is a wrong
  // instruction dressed as a diagnosis. The resolve separates them by reading
  // the account, not the status code.
  if (serving.kind === "none-published") {
    return refused("never_published", NEVER_PUBLISHED, { numbers });
  }
  if (serving.kind !== "version") {
    // A key that reads the account but cannot see this agent is the other half
    // of the two-keys check: the account the key opens does not hold the agent
    // the tick is on.
    return refused(
      serving.kind === "gone" || serving.kind === "invalid-key"
        ? "keys_disagree"
        : "platform_unavailable",
      serving.kind === "gone"
        ? `the Retell account this agent's key opens does not hold agent ` +
            `${input.platformAgentId}. The key and the agent have to be the ` +
            "same account's."
        : PLATFORM_AWAY,
      { numbers },
    );
  }

  const engine = serving.agentVersion.engine;
  const configuration = await readEngineConfiguration(key, engine, reach);
  // The custom-LLM refusal.
  if (configuration.kind === "not-held") {
    return refused("custom_llm_engine", CUSTOM_LLM, {
      engine: engine.type,
      servingVersion: serving.agentVersion.version,
      numbers,
    });
  }
  if (configuration.kind !== "engine") {
    return refused("platform_unavailable", PLATFORM_AWAY, {
      engine: engine.type,
      servingVersion: serving.agentVersion.version,
      numbers,
    });
  }

  const found = discoverTools(configuration.engine);

  return {
    mockable: true,
    refusal: null,
    engine: engine.type,
    servingVersion: serving.agentVersion.version,
    tools: found.tools,
    warnings: found.warnings,
    numbers,
  };
}
