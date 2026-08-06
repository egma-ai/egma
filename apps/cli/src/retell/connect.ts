/**
 * Connecting a Retell voice agent to egma, once, for both surfaces.
 *
 * There is one flow here and there is no second one. The wizard is a screen
 * over it and `egma connect` is plain lines over it, which is what makes the
 * wizard passing its checks evidence that the agent-callable surface works.
 *
 * Nothing in here draws and nothing in here reads a keystroke. The key arrives
 * through `askForKey`, the choice between several agents through `chooseAgent`,
 * and everything the developer should see goes out through `say` — so the same
 * flow runs on a screen, in a pipe, and in a check with nobody watching.
 *
 * Four things happen in order and each one can end the flow honestly: the key
 * is taken, it is checked by listing the account's agents, one agent is settled
 * on, and its configuration is pulled and registered. A key that is wrong and
 * an account that is empty are told apart by name and each is worth one more
 * try — a typo should cost seconds, and a second wrong answer means the answer
 * is somewhere else.
 */

import { registerAgent, type Registered, type RegisterOptions } from "../platform/agents.ts";
import {
  listAgents,
  pullAgent,
  type RetellAgent,
  type RetellConfig,
  type RetellReach,
} from "./client.ts";
import type { RetellKey } from "./key.ts";
import { compareWithRepo, type Drift } from "./prompt-drift.ts";

/** What the developer is asked for, said the same way on every surface. */
export const KEY_ASK_LINE = "Paste your Retell API key (Retell dashboard → Settings → API keys).";

/**
 * Where the key goes, in one line, said before it is typed.
 *
 * It is the whole of what egma promises about the key, and it is said at the
 * moment the developer decides whether to hand it over rather than afterwards.
 */
export const CUSTODY_LINE =
  "It is sent to egma and stored encrypted. It never lands in a file here.";

/** The exact failure for a key Retell will not take. */
export const INVALID_KEY_LINE =
  "Retell would not take that key. Copy it again from the Retell dashboard, under Settings → API keys.";

/** The exact failure for a key that works on an account with nothing on it. */
export const NO_AGENTS_LINE =
  "That key works, and there are no agents on the Retell account it belongs to. " +
  "Paste a key for the account your voice agent is on.";

/** What egma calls the agent when the customer never named it on Retell. */
export const DEFAULT_AGENT_NAME = "voice-agent";

/** What the wizard is waiting to be given, while it still is. */
export type KeyAsk = {
  /** What is being asked for. */
  readonly asking: string;
  /** Where it goes, in one line, said before it is typed. */
  readonly custody: string;
  /** Why the last answer did not work, or `null` on the first ask. */
  readonly problem: string | null;
};

/** The ask as plain lines, for the surfaces that print rather than draw. */
export function keyAskLines(ask: KeyAsk): readonly string[] {
  return [...(ask.problem === null ? [] : [ask.problem]), ask.asking, ask.custody];
}

/** How many times a name already held is tried again with a number on the end. */
const NAME_ATTEMPTS = 20;

export type ConnectOutcome =
  | {
      readonly kind: "connected";
      readonly registered: Registered;
      readonly config: RetellConfig;
      readonly drift: Drift;
      /** How many agents the account holds, which is why a picker appeared. */
      readonly onTheAccount: number;
    }
  /** Nobody gave a key, so there is nothing to connect with. */
  | { readonly kind: "no-key" }
  /** Twice refused by Retell. */
  | { readonly kind: "invalid-key" }
  /** Twice a key for an account with no agents on it. */
  | { readonly kind: "no-agents" }
  /** Several agents, and nobody said which. */
  | { readonly kind: "unchosen"; readonly agents: readonly RetellAgent[] }
  | { readonly kind: "interrupted" }
  | { readonly kind: "failed"; readonly reason: string };

export type ConnectOptions = {
  /** The egma being written to, and this machine's key for it. */
  readonly platform: { readonly url: string; readonly key: string };
  /** The folder the repository's prompt is looked for in. */
  readonly cwd: string;
  /** Where the find-the-agent step said the prompts live, if it ran. */
  readonly repoPrompts: string | null;
  readonly signal: AbortSignal;
  /** The key, or `null` when the developer has none to give. */
  readonly askForKey: () => Promise<RetellKey | null>;
  /** Which of several, by id, or `null` when nobody chose. */
  readonly chooseAgent: (agents: readonly RetellAgent[]) => Promise<string | null>;
  /** One line about what is happening, for whoever is watching. */
  readonly say: (line: string) => void;
  /** Where Retell is. Retell's own address when omitted. */
  readonly retell?: RetellReach | undefined;
  readonly fetchImpl?: RegisterOptions["fetchImpl"];
};

/**
 * What egma calls the agent, from what the customer calls it on Retell.
 *
 * Their name, kept: the developer already knows it, and a name egma invented
 * would be one more thing to reconcile later.
 */
export function defaultAgentName(retellName: string): string {
  const trimmed = retellName.trim();
  return trimmed === "" ? DEFAULT_AGENT_NAME : trimmed;
}

/** The chosen agent out of a list, by id, or `null` when the id is not one. */
function agentWithId(agents: readonly RetellAgent[], id: string | null): RetellAgent | null {
  if (id === null) return null;
  const wanted = id.trim();
  return agents.find((agent) => agent.id === wanted) ?? null;
}

/**
 * The key, checked, and the agents it can reach — or the ending it forces.
 *
 * The two failures worth a second try are told apart by name and re-asked once
 * each. A second failure of either kind is an ending: the answer is not in this
 * terminal, and asking a third time only wastes the developer's evening.
 */
async function keyAndAgents(
  options: ConnectOptions,
): Promise<
  | { readonly kind: "ok"; readonly key: RetellKey; readonly agents: readonly RetellAgent[] }
  | ConnectOutcome
> {
  /**
   * What the last key was refused for, once it has been.
   *
   * It survives the re-ask, so a developer who has nothing better to try — and
   * a promptless run, which has nobody to ask a second time — is told what
   * actually went wrong rather than being told they gave no key.
   */
  let refusedFor: "invalid-key" | "no-agents" | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.signal.aborted) return { kind: "interrupted" };

    const key = await options.askForKey();
    if (options.signal.aborted) return { kind: "interrupted" };
    if (key === null) return refusedFor === null ? { kind: "no-key" } : { kind: refusedFor };

    const listed = await listAgents(key, options.retell ?? {});
    if (options.signal.aborted) return { kind: "interrupted" };

    switch (listed.kind) {
      case "agents":
        if (listed.agents.length > 0) return { kind: "ok", key, agents: listed.agents };
        if (attempt === 0) {
          refusedFor = "no-agents";
          options.say(NO_AGENTS_LINE);
          break;
        }
        return { kind: "no-agents" };
      case "invalid-key":
        if (attempt === 0) {
          refusedFor = "invalid-key";
          options.say(INVALID_KEY_LINE);
          break;
        }
        return { kind: "invalid-key" };
      case "refused":
        // Not a key problem and not an empty account, so asking again would be
        // asking the developer to fix something that is not theirs.
        return { kind: "failed", reason: listed.reason };
      case "unreachable":
        return { kind: "failed", reason: listed.reason };
    }
  }

  return { kind: "failed", reason: "egma could not check that Retell key." };
}

/** The key, carried between the two halves of the flow, never stored. */
type KeyedOptions = ConnectOptions & { readonly key: RetellKey };

/**
 * Writes the agent and its connection, taking the next free name when a living
 * agent already holds the one asked for.
 *
 * The platform names connections that way for the same reason, so a second run
 * in the same project lands beside the first instead of refusing.
 */
async function register(
  options: KeyedOptions,
  config: RetellConfig,
): Promise<{ readonly kind: "registered"; readonly registered: Registered } | ConnectOutcome> {
  const wanted = defaultAgentName(config.name);

  for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt += 1) {
    if (options.signal.aborted) return { kind: "interrupted" };

    const result = await registerAgent(
      {
        name: attempt === 1 ? wanted : `${wanted}-${attempt}`,
        connection: {
          // No name: the platform's own default is the convention, and one
          // convention in one place cannot drift from itself.
          type: "retell",
          modality: config.modality,
          config: { retellAgentId: config.agentId },
          credentials: options.key,
        },
        pulled: {
          vendor: "retell",
          documents: config.documents,
          prompt: config.prompt,
          voice: config.voice,
          tools: config.tools,
        },
      },
      {
        url: options.platform.url,
        key: options.platform.key,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      },
    );

    switch (result.kind) {
      case "registered":
        return { kind: "registered", registered: result.registered };
      case "name-taken":
        continue;
      case "not-authenticated":
        return {
          kind: "failed",
          reason: "egma would not take this machine's key. Run egma login, then try again.",
        };
      case "refused":
      case "unreachable":
        return { kind: "failed", reason: result.reason };
    }
  }

  return {
    kind: "failed",
    reason: `every name from "${wanted}" onwards is already taken in this project. Rename one of them, or say which agent this is.`,
  };
}

/**
 * Runs the whole flow and answers what happened.
 *
 * Every ending is a value, because every ending means something different to
 * whoever asked — a wrong key is not an empty account, an empty account is not
 * a refusal, and a machine that never answered is none of the three.
 */
export async function connect(options: ConnectOptions): Promise<ConnectOutcome> {
  const checked = await keyAndAgents(options);
  if (checked.kind !== "ok") return checked;

  const { key, agents } = checked;
  const keyed: KeyedOptions = { ...options, key };

  // One agent is not a choice, so it is not a question. The developer sees
  // which one it is and the flow carries on.
  let chosen: RetellAgent | null = agents.length === 1 ? (agents[0] as RetellAgent) : null;
  if (chosen === null) {
    chosen = agentWithId(agents, await options.chooseAgent(agents));
    if (options.signal.aborted) return { kind: "interrupted" };
    if (chosen === null) return { kind: "unchosen", agents };
  }

  const pulled = await pullAgent(key, chosen, options.retell ?? {});
  if (options.signal.aborted) return { kind: "interrupted" };

  switch (pulled.kind) {
    case "config":
      break;
    case "invalid-key":
      return { kind: "invalid-key" };
    case "gone":
      return {
        kind: "failed",
        reason: "that agent is no longer on the Retell account. Run egma again to see what is.",
      };
    case "refused":
    case "unreachable":
      return { kind: "failed", reason: pulled.reason };
  }

  const config = pulled.config;
  const written = await register(keyed, config);
  if (written.kind !== "registered") return written;

  // Shown, never blocking: the drift is worked out after everything that
  // matters is already written, so a slow or unreadable file cannot cost the
  // developer the connection. One word comes back and nothing else does — the
  // repository's own words stay in the folder they were read from.
  const drift = await compareWithRepo({
    cwd: options.cwd,
    said: options.repoPrompts,
    running: config.prompt,
  });

  return {
    kind: "connected",
    registered: written.registered,
    config,
    drift,
    onTheAccount: agents.length,
  };
}
