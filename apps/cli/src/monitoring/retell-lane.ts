/**
 * Watching a Retell agent's production traffic, once, for both surfaces.
 *
 * There is one flow here and there is no second one. The wizard is a screen
 * over it and `egma monitoring enable` is plain lines over it, which is what
 * makes the wizard passing its checks evidence that the agent-callable surface
 * works.
 *
 * Nothing in here draws and nothing in here reads a keystroke. The key arrives
 * through `askForKey`, the choice among several agents through `chooseAgent`,
 * and everything the developer should see goes out through `say`.
 *
 * Four things happen in order and each can end the flow honestly: the key is
 * taken, Egma opens the Retell account with it and answers which of its agents
 * this project already knows, one agent is settled on, and one commit starts
 * watching it — registering the agent row when this project has none. Then Egma
 * waits, briefly, for the first imported conversation, because proof beats a
 * promise; an account with nothing to import ends well and says so.
 *
 * **The CLI never speaks to Retell here.** Egma asks Retell on the server side,
 * which is the only way the list can carry what this project already registers
 * and which of those already pull. The key goes to Egma and to nowhere else.
 */

import type { RegisterOptions } from "../platform/agents.ts";
import {
  discoverRetellAgents,
  readAgentMonitoring,
  startMonitoring,
  type DiscoveredAgent,
  type StartRefusal,
} from "../platform/monitoring.ts";
import type { RetellKey } from "../retell/key.ts";

/** What the developer is asked for, said the same way on every surface. */
export const MONITORING_KEY_ASK_LINE =
  "Paste your Retell API key (Retell dashboard → Settings → API keys).";

/**
 * Where the key goes, in one line, said before it is typed.
 *
 * The monitoring key is sealed on the agent that pulls with it — a
 * monitoring-only credential, separate from any secret a connection holds for
 * simulations (ADR-0015). The sentence says the part a developer decides on:
 * it leaves this machine, and it does not stay here.
 */
export const MONITORING_CUSTODY_LINE =
  "It is sent to Egma and stored encrypted on this agent. It never lands in a file here.";

/** The exact failure for a key that opens an account with no voice agents. */
export const NO_VOICE_AGENTS_LINE =
  "That key works, and Egma found no voice agents on the Retell account it " +
  "belongs to. Paste a key for the account your voice agent is on.";

/** What Egma says while it waits, so a pause is never an unexplained one. */
export const WAITING_LINE =
  "Watching. Egma is asking Retell for this agent's finished conversations.";

/** The honest ending for an account with nothing to import yet. */
export const NOTHING_YET_LINE =
  "Nothing has arrived yet. Egma keeps asking, and conversations appear in " +
  "Monitoring as they finish.";

/** How long the flow waits for the first conversation, and how often it asks. */
const WAIT_MS = 20_000;
const POLL_MS = 2_000;

export type WatchOutcome =
  | {
      readonly kind: "watching";
      readonly agentId: string;
      readonly agentName: string;
      /** Which project that agent row is in, for whatever reads it next. */
      readonly projectId: string;
      readonly platformAgentId: string;
      /** Whether this commit brought the agent row into existence. */
      readonly created: boolean;
      /** Whether a production conversation arrived before the wait ran out. */
      readonly arrived: boolean;
    }
  /** Nobody gave a key, so there is nothing to watch with. */
  | { readonly kind: "no-key" }
  /** Egma asked Retell with that key and Retell said no. */
  | { readonly kind: "invalid-key"; readonly reason: string }
  /** The key works and the account has no voice agents on it. */
  | { readonly kind: "no-agents" }
  /** Several agents, and nobody said which. */
  | { readonly kind: "unchosen"; readonly agents: readonly DiscoveredAgent[] }
  /** The platform refused this one start, and said which rule refused it. */
  | { readonly kind: "refused-start"; readonly refusal: StartRefusal }
  | { readonly kind: "interrupted" }
  | { readonly kind: "failed"; readonly reason: string };

export type WatchOptions = {
  /** The Egma being written to, and this machine's key for it. */
  readonly platform: RegisterOptions;
  readonly signal: AbortSignal;
  /** The key, or `null` when the developer has none to give. */
  readonly askForKey: () => Promise<RetellKey | null>;
  /** Which of several, by platform agent id, or `null` when nobody chose. */
  readonly chooseAgent: (
    agents: readonly DiscoveredAgent[],
  ) => Promise<string | null>;
  /** One line about what is happening, for whoever is watching. */
  readonly say: (line: string, kind?: "action") => void;
  /**
   * What to call the agent row this creates, when it creates one.
   *
   * The one name a sitting threads through both halves: the testing lane finds
   * and reuses the row monitoring created rather than writing a second one for
   * the same agent. Left out, the platform agent's own name is taken.
   */
  readonly agentName?: string | null | undefined;
  /**
   * The Egma agent to watch from, when the caller already knows which one.
   *
   * A repository that has been tested already holds an agent row, and the
   * platform agent it reaches is not registered *as* that row — so discovery
   * cannot see the connection between them. Naming it here is what stops a
   * second row appearing in the roster for one voice agent.
   */
  readonly agentId?: string | null | undefined;
  /** How long to wait for the first conversation. Egma's own pace when omitted. */
  readonly waitMs?: number | undefined;
  readonly pollMs?: number | undefined;
  /** The wait itself, so a check can run the whole flow without waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
};

/** The agent a chooser named, out of what was offered, or `null`. */
function agentWithId(
  agents: readonly DiscoveredAgent[],
  id: string | null,
): DiscoveredAgent | null {
  if (id === null) return null;
  const wanted = id.trim();
  return agents.find((one) => one.platformAgentId === wanted) ?? null;
}

async function pause(options: WatchOptions, ms: number): Promise<void> {
  if (options.sleep !== undefined) {
    await options.sleep(ms);
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs the whole flow and answers what happened.
 *
 * Every ending is a value, because every ending means something different to
 * whoever asked — a wrong key is not an empty account, an empty account is not
 * a refusal, and a start the platform turned away is none of the three.
 */
export async function watchRetellAgent(
  options: WatchOptions,
): Promise<WatchOutcome> {
  if (options.signal.aborted) return { kind: "interrupted" };

  const key = await options.askForKey();
  if (options.signal.aborted) return { kind: "interrupted" };
  if (key === null) return { kind: "no-key" };

  const found = await discoverRetellAgents(key, options.platform);
  if (options.signal.aborted) return { kind: "interrupted" };
  switch (found.kind) {
    case "agents":
      break;
    case "refused-key":
      return { kind: "invalid-key", reason: found.reason };
    case "not-authenticated":
      return {
        kind: "failed",
        reason: "Egma would not take this machine's key. Run egma login, then try again.",
      };
    case "refused":
    case "unreachable":
      return { kind: "failed", reason: found.reason };
  }

  const agents = found.agents;
  if (agents.length === 0) {
    options.say(NO_VOICE_AGENTS_LINE);
    return { kind: "no-agents" };
  }

  // One agent is not a choice, so it is not a question. The developer reads
  // which one Egma took, inside the flow, with nothing to answer.
  let chosen: DiscoveredAgent | null =
    agents.length === 1 ? (agents[0] as DiscoveredAgent) : null;
  if (chosen === null) {
    chosen = agentWithId(agents, await options.chooseAgent(agents));
    if (options.signal.aborted) return { kind: "interrupted" };
    if (chosen === null) return { kind: "unchosen", agents };
  }

  /*
   * A platform agent this project already registers is watched from the row it
   * already has, and one it does not is registered by this very commit —
   * watching an unregistered platform agent *means* registering it (ADR-0015).
   *
   * The name is sent only in the second case. Naming a row that already exists
   * would be renaming somebody's agent because a second surface spells it
   * differently.
   */
  const registered = (options.agentId ?? "").trim() || chosen.registeredAgentId;
  const started = await startMonitoring(
    {
      agentPlatform: "retell",
      apiKey: key,
      watch: [
        {
          platformAgentId: chosen.platformAgentId,
          ...(registered === null
            ? { name: (options.agentName ?? chosen.name).trim() || chosen.name }
            : { agentId: registered }),
        },
      ],
    },
    options.platform,
  );
  if (options.signal.aborted) return { kind: "interrupted" };

  switch (started.kind) {
    case "started":
      break;
    case "not-authenticated":
      return {
        kind: "failed",
        reason: "Egma would not take this machine's key. Run egma login, then try again.",
      };
    case "refused":
    case "unreachable":
      return { kind: "failed", reason: started.reason };
  }

  const refusal = started.refused[0];
  if (refusal !== undefined) return { kind: "refused-start", refusal };

  const watching = started.watching[0];
  if (watching === undefined) {
    return {
      kind: "failed",
      reason:
        "Egma answered without saying what it started watching. Check that this Egma platform is up to date.",
    };
  }

  options.say(
    `Egma is watching ${watching.agentName}'s production calls on Retell.`,
    "action",
  );
  options.say(WAITING_LINE);

  const waited = await untilSomethingArrives(options, watching.agentId);
  if (options.signal.aborted) return { kind: "interrupted" };

  return {
    kind: "watching",
    agentId: watching.agentId,
    agentName: watching.agentName,
    projectId: waited.projectId,
    platformAgentId: watching.platformAgentId,
    created: watching.created,
    arrived: waited.arrived,
  };
}

/**
 * Whether a production conversation arrived before the wait ran out.
 *
 * The agent's own last-received time is what is asked, because it is the fact
 * the platform stamps when a pulled conversation lands and the one a person
 * reads afterwards. A read that fails is not the walk failing: watching is
 * already on, so the wait simply ends and the honest sentence is said.
 */
async function untilSomethingArrives(
  options: WatchOptions,
  agentId: string,
): Promise<{ readonly arrived: boolean; readonly projectId: string }> {
  const waitMs = options.waitMs ?? WAIT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const until = Date.now() + waitMs;
  // Read from the same answer the wait polls, because the first ask has it and
  // a second request for one field would be a second thing to keep in step.
  let projectId = "";

  for (;;) {
    const read = await readAgentMonitoring(agentId, options.platform);
    if (options.signal.aborted) return { arrived: false, projectId };
    if (read.kind !== "monitoring") return { arrived: false, projectId };
    projectId = read.monitoring.projectId;
    if (read.monitoring.lastReceivedAt !== null) return { arrived: true, projectId };
    if (Date.now() + pollMs > until) return { arrived: false, projectId };
    await pause(options, pollMs);
    if (options.signal.aborted) return { arrived: false, projectId };
  }
}
