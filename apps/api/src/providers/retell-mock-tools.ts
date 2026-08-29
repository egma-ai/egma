import { connectionTypeBranchesMockDraft } from "@egma/db";
import {
  bindingDecisionsFor,
  discoverTools,
  listRoutedNumbers,
  readEngineConfiguration,
  resolveAgentVersion,
  versionReferenceIn,
  type BindingDecision,
  type DiscoveredTool,
  type DiscoveryWarning,
  type Fetch as ProviderFetch,
  type RetellCredential,
} from "@egma/retell";

/**
 * What ticking the mock-tools box would find, and the five reasons it is
 * refused.
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
 * The four:
 *
 * 1. **A custom-LLM engine.** The brain and the tools live on the customer's
 *    own socket server; Retell stores no tool configuration this seam could
 *    swap. Not a permanent no — it is structurally a LiveKit-shaped problem,
 *    and it belongs to the Egma SDK's in-process seam when that grows a Retell
 *    adapter.
 * 2. **An agent whose only connection is a phone number.** The phone lane is
 *    the real-telephony lane by design: real carrier, real band, real tools. A
 *    mocked run is a call Egma places itself, and this agent has no lane to
 *    place one over.
 * 3. **Keys that disagree.** The agent's platform key builds the world and a
 *    connection's own key opens the calls. If the two resolve different
 *    accounts or different platform agents, one account would build the draft
 *    while another tried to call it — a failure that would otherwise surface
 *    only after the world was built.
 * 4. **The platform would not answer.** Not a fact about the agent but about
 *    the moment: Retell was unreachable while Egma read the account. Nothing is
 *    changed, and the person is told to try again — a fair fifth, kept apart
 *    from the four because its next move is "wait", not "reconfigure".
 */

export const MOCK_TOOLS_REFUSALS = [
  "custom_llm_engine",
  "phone_only_agent",
  "keys_disagree",
  "platform_unavailable",
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

const PHONE_ONLY =
  "this agent's only connection is a phone number, and a mocked run is never " +
  "dialled: Egma places a web call or a chat against a temporary version it " +
  "creates, so your published number never rings for a test and a real caller " +
  "mid-run always reaches your real agent with your real tools. The phone " +
  "connection keeps the job only it can do — the real carrier leg, the real " +
  "line, real tools — and stays unmocked by design. Add a Retell web-call " +
  "connection to this agent to run mocked simulations.";

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
 * two refusals Egma can answer without touching Retell come before the reads,
 * and the pin question comes after the numbers because it is *about* them.
 */
export async function discoverMockTools(
  input: MockToolsDiscoveryInput,
): Promise<MockToolsDiscovery> {
  // Refusal one of the four, answered from what Egma already holds. The lane list is the
  // registry's own, read through @egma/db, so a third mockable lane added there
  // is a lane the tick offers rather than refuses — the two cannot drift.
  const lanes = input.lanes.filter((lane) =>
    connectionTypeBranchesMockDraft(lane.connectionType),
  );
  if (lanes.length === 0) return refused("phone_only_agent", PHONE_ONLY);

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

  const serving = await resolveAgentVersion(
    key,
    input.platformAgentId,
    versionReferenceIn(numbers),
    reach,
  );
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
