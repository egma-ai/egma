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
 * Six things happen in order and each one can end the flow honestly: the key is
 * taken, it is checked by listing the account's agents, one agent is settled
 * on, its configuration is pulled, the developer says whether egma should reach
 * it by text or by phone — and, for the phone, which of the numbers Retell
 * routes to that agent egma should dial. Then one connection is written: **the
 * one that was chosen, and only that one.** A key that is wrong and an account
 * that is empty are told apart by name and each is worth one more try — a typo
 * should cost seconds, and a second wrong answer means the answer is somewhere
 * else.
 *
 * **Nothing here writes to Retell.** Every request it makes is a read: the
 * account's agents, one agent's own document, its response engine, the
 * account's numbers, and one number's own document. egma reaches a customer's
 * agent; it does not configure it.
 */

import {
  addConnection,
  agentNamed,
  readAgent,
  registerAgent,
  type NewConnection,
  type Registered,
  type RegisteredConnection,
  type RegisterOptions,
} from "../platform/agents.ts";
import { ConnectionCredentials } from "../platform/connection-credentials.ts";
import {
  confirmNumber,
  listAgents,
  listNumbers,
  numbersAnswering,
  pullAgent,
  type RetellAgent,
  type RetellConfig,
  type RetellNumber,
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
  "It is sent to Egma and stored encrypted. It never lands in a file here.";

/** The exact failure for a key Retell will not take. */
export const INVALID_KEY_LINE =
  "Retell would not take that key. Copy it again from the Retell dashboard, under Settings → API keys.";

/** The exact failure for a key that works on an account with nothing on it. */
export const NO_AGENTS_LINE =
  "That key works, and there are no agents on the Retell account it belongs to. " +
  "Paste a key for the account your voice agent is on.";

/** What egma calls the agent when the customer never named it on Retell. */
export const DEFAULT_AGENT_NAME = "voice-agent";

/**
 * How egma reaches the agent, chosen by the developer and never by egma.
 *
 * A Retell voice agent is reached by phone. A genuine Retell chat agent is
 * reached by text. Voice-over-text stays unavailable until Egma implements
 * Retell Agent Playground Completion; the shipped chat adapter cannot safely
 * conduct that path.
 */
export type Reach = "text" | "phone";

/** What the developer is choosing between, said the same way on every surface. */
export const REACH_ASK_LINE = "How should Egma reach this agent?";

/** One line per way, said in what it tests rather than in what it is made of. */
export const REACH_LINES: Readonly<Record<Reach, string>> = {
  text: "Text — Egma exchanges messages with the agent. No phone call, nothing dialled.",
  phone:
    "Phone — Egma dials one of the agent's numbers and talks to it over the " +
    "telephone network, the way the people who call it do.",
};

/** What a developer can do after asking Retell for the wrong connection kind. */
export const VOICE_REQUIRES_PHONE_LINE =
  "Retell says this is a voice agent. Voice agents can be reached only by phone, not text. " +
  "Choose phone and try again. Nothing was written.";

/** What a developer can do after asking Retell for a phone connection to chat. */
export const CHAT_REQUIRES_TEXT_LINE =
  "Retell says this is a chat agent. Chat agents can be reached only by text, not phone. " +
  "Choose text and try again. Nothing was written.";

/** What the developer is asked when the phone was chosen. */
export const NUMBER_ASK_LINE =
  "Which number should Egma dial? These are the numbers Retell routes to this agent.";

/** The exact target, said before Egma stores a phone connection. */
export function dialLine(number: string): string {
  return `Egma will dial ${number}.`;
}

/** The exact failure for an agent Retell routes no number to. */
export const NO_NUMBERS_LINE =
  "Retell routes no phone number to that agent, so there is nothing for Egma to " +
  "dial. Assign a number to it in the Retell dashboard, under Phone Numbers, " +
  "then try again.";

/**
 * What egma says when connecting found something already there.
 *
 * Registering the same Retell agent twice is safe on purpose — a coding agent
 * retrying after a network failure it could not read must never mint a second
 * identity — so egma answers the registration that exists and says so. Saying
 * nothing would leave a developer counting agents to find out; treating it as a
 * failure would tell them to fix something that is working. So it is said, in
 * plain words, on the ordinary success path.
 *
 * One sentence per surface-independent case, written here because both the
 * screen and the printed lines say it and two copies of one sentence drift.
 */
export function registrationLine(registered: Registered): string | null {
  switch (registered.result) {
    case "created":
      // Nothing to add: the line beside this one already says what was written.
      return null;
    case "reused":
      return (
        `This voice agent was already registered as ${registered.agent.name}, and ` +
        `${registered.connection.name} was already the way Egma reaches it. Nothing ` +
        `new was registered.`
      );
    case "connection_added":
      return (
        `This voice agent was already registered as ${registered.agent.name}, so Egma ` +
        `added ${registered.connection.name} as another way of reaching it. No second ` +
        `agent was registered.`
      );
  }
}

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

/**
 * Which of the two things a write turned out to be, said for each half.
 *
 * The platform answers one word for the pair — created, reused, the same agent
 * reached a new way — and that is one word too few for whoever is retrying.
 * "The agent was already there and the connection is new" and "both are new"
 * are different facts about somebody's project, and a coding agent deciding
 * whether its retry worked needs both of them.
 */
export type WriteResult = "created" | "reused";

export type Registration = {
  readonly agent: WriteResult;
  readonly connection: WriteResult;
};

export type ConnectOutcome =
  | {
      readonly kind: "connected";
      readonly registered: Registered;
      readonly config: RetellConfig;
      readonly drift: Drift;
      /** How many agents the account holds, which is why a picker appeared. */
      readonly onTheAccount: number;
      /** Which way the developer chose, and the only one egma wrote. */
      readonly reach: Reach;
      /** The number egma will dial, or `null` for a text connection. */
      readonly number: string | null;
      /** Whether each half was written or found already there. */
      readonly registration: Registration;
    }
  /** Nobody gave a key, so there is nothing to connect with. */
  | { readonly kind: "no-key" }
  /** Twice refused by Retell. */
  | { readonly kind: "invalid-key" }
  /** Twice a key for an account with no agents on it. */
  | { readonly kind: "no-agents" }
  /** Several agents, and nobody said which. */
  | { readonly kind: "unchosen"; readonly agents: readonly RetellAgent[] }
  /** Nobody chose one of the provider-safe ways offered for this agent. */
  | { readonly kind: "unchosen-reach"; readonly offered: readonly Reach[] }
  /** The requested reach does not match the selected Retell agent's channel. */
  | {
      readonly kind: "incompatible-reach";
      readonly requested: Reach;
      readonly compatible: Reach;
      readonly reason: string;
    }
  /** Retell routes no number to the chosen agent, so there is nothing to dial. */
  | { readonly kind: "no-numbers" }
  /** Several numbers reach the agent, and nobody said which to dial. */
  | { readonly kind: "unchosen-number"; readonly numbers: readonly RetellNumber[] }
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
  /**
   * Text or phone, or `null` when nobody chose.
   *
   * Asked once the agent is settled and never before it: which numbers exist
   * is a fact about *that* agent, so there is nothing honest to offer until
   * egma knows which one is under test.
   */
  readonly chooseReach: (offered: readonly Reach[]) => Promise<Reach | null>;
  /**
   * Which number to dial, in E.164, or `null` when nobody chose.
   *
   * Only ever called with more than one, exactly as the agent choice is: one
   * number Retell routes to the agent is not a choice, and asking about it
   * would be a question with one answer.
   */
  readonly chooseNumber: (numbers: readonly RetellNumber[]) => Promise<string | null>;
  /** One line about what is happening, for whoever is watching. */
  readonly say: (line: string, kind?: "action") => void;
  /**
   * Run at the last moment before egma is asked to create anything, and only
   * then.
   *
   * This is where the caller writes down which platform is about to own what
   * comes back. It is a hook rather than something the caller does first
   * because "the last moment" is in here: every ending above it — no key, a key
   * Retell will not take, an empty account, an unanswered choice — leaves the
   * platform with nothing in it, and must leave the repository the same way.
   */
  readonly beforeRegistering?: () => Promise<void>;
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

  return { kind: "failed", reason: "Egma could not check that Retell key." };
}

/** The key, carried between the two halves of the flow, never stored. */
type KeyedOptions = ConnectOptions & { readonly key: RetellKey };

/** What egma is being asked to write, once the reach has been chosen. */
type Selected = {
  readonly reach: Reach;
  /** The connection body for the chosen reach, and no other. */
  readonly connection: NewConnection;
  /** The number egma will dial, or `null` for a text connection. */
  readonly number: string | null;
};

/**
 * The one connection the chosen reach means.
 *
 * **Text is only a direct connection to a genuine Retell chat agent.** A voice
 * agent cannot take this branch until the Agent Playground Completion adapter
 * exists. **Phone carries the destination number and nothing else** —
 * no Retell identifier and no credential — because the public telephone network
 * neither knows nor cares what answers, and a phone connection that named a
 * provider would be claiming knowledge egma does not use.
 */
function selectionFor(
  reach: Reach,
  config: RetellConfig,
  key: RetellKey,
  number: string | null,
): Selected {
  if (reach === "phone") {
    return {
      reach,
      // No name: the platform's own default is the convention, and one
      // convention in one place cannot drift from itself.
      connection: {
        type: "phone",
        modality: "voice",
        config: { phoneNumber: number ?? "" },
      },
      number,
    };
  }
  return {
    reach,
    connection: {
      type: "retell",
      // Only Retell chat agents reach this branch. Their vendor identity is the
      // connection target, and no phone number is read or stored.
      modality: "chat",
      config: { retellAgentId: config.agentId },
      credentials: ConnectionCredentials.defer(() => ({ apiKey: key.reveal() })),
    },
    number: null,
  };
}

/** Whether a connection already on the platform is the one being asked for. */
function isTheSameReach(held: RegisteredConnection, wanted: NewConnection): boolean {
  if (held.type !== wanted.type || held.modality !== wanted.modality) return false;
  return Object.entries(wanted.config).every(([key, value]) => held.config[key] === value);
}

/** The Retell agent a connection already on the platform reaches, if it names one. */
function retellAgentOf(held: RegisteredConnection): string | null {
  if (held.type !== "retell") return null;
  const named = held.config["retellAgentId"];
  return named === undefined || named === "" ? null : named;
}

/** What a write turned out to be, for each half, out of the platform's one word. */
function registrationOf(registered: Registered): Registration {
  switch (registered.result) {
    case "created":
      return { agent: "created", connection: "created" };
    case "reused":
      return { agent: "reused", connection: "reused" };
    case "connection_added":
      return { agent: "reused", connection: "created" };
  }
}

type Written = {
  readonly kind: "registered";
  readonly registered: Registered;
  readonly registration: Registration;
};

/**
 * Writes the selected connection, and the agent under it when there is not one
 * already.
 *
 * **A second walk over one Retell agent must land on the first walk's agent.**
 * Two egma agents for one Retell agent split a team's results history in half,
 * and that is the failure this whole function exists to prevent.
 *
 * The platform settles the easy half itself: a retell connection carries the
 * vendor's own agent id, so registering the same one twice answers what is
 * already there with the key rotated whole. What it cannot settle is a **phone**
 * connection, which carries a number and no vendor identity at all — the
 * platform has nothing to match on, so it would write a second agent every
 * time.
 *
 * So the refusal is read rather than worked around. `name-taken` means a living
 * agent in this project already holds the name egma derives from the Retell
 * agent's own, and exactly one of two things is true of it:
 *
 * - **It is this agent.** When the same reach is already attached, that
 *   connection answers and nothing is written at all.
 * - **It is a different agent** wearing the same name, which a real
 *   account does produce. Then the name is taken and the next one is tried,
 *   exactly as before.
 *
 * **Two signals tell those apart, and a phone-only agent needs the second.** A
 * retell connection carries the vendor's own agent id and answers outright. A
 * phone connection carries a number, and Retell knows which numbers it routes to
 * the agent under test — so a number it routes here says "this is it", and a
 * number it does not says "this is somebody else" just as clearly.
 *
 * **Where neither signal answers, the next name is taken.** An agent reached
 * only by phone, with Retell unable to say which numbers it routes, is an agent
 * egma cannot identify — and the two ways of being wrong about it are not
 * equally bad. Guess "this is it" and two voice agents share one egma agent and
 * one results history, which nothing can unpick afterwards. Guess "somebody
 * else" and there is a spare agent in the project, which a developer can delete
 * in one command. So ambiguity goes to the next name, every time. An agent with
 * no living connection at all is the one case with nothing to be wrong about —
 * there is no history to split — and the chosen connection joins it.
 */
async function register(
  options: KeyedOptions,
  config: RetellConfig,
  selected: Selected,
  /**
   * The numbers Retell routes to the agent under test, read at most once and
   * only when a name clash actually needs them.
   *
   * `null` when Retell would not say. That is not a reason to refuse the
   * registration, and it is not a reason to guess either: it means this agent
   * cannot be identified, so the next name is taken and the developer gets a
   * spare agent rather than a merged history. Read once and no more, because a
   * listing that failed on the first ask is not going to answer differently on
   * the twentieth.
   */
  numbersOfTheAgent: () => Promise<readonly string[] | null>,
): Promise<Written | ConnectOutcome> {
  const wanted = defaultAgentName(config.name);
  const platform: RegisterOptions = {
    url: options.platform.url,
    key: options.platform.key,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  };
  const notSignedIn: ConnectOutcome = {
    kind: "failed",
    reason: "Egma would not take this machine's key. Run egma login, then try again.",
  };

  for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt += 1) {
    if (options.signal.aborted) return { kind: "interrupted" };
    const name = attempt === 1 ? wanted : `${wanted}-${attempt}`;

    const result = await registerAgent(
      { name, connection: selected.connection },
      platform,
    );

    switch (result.kind) {
      case "registered":
        return {
          kind: "registered",
          registered: result.registered,
          registration: registrationOf(result.registered),
        };
      case "not-authenticated":
        return notSignedIn;
      case "refused":
      case "unreachable":
        return { kind: "failed", reason: result.reason };
      case "name-taken":
        break;
    }

    // Somebody holds the name. Which somebody decides everything below.
    const found = await agentNamed(name, platform);
    if (options.signal.aborted) return { kind: "interrupted" };
    if (found.kind === "not-authenticated") return notSignedIn;
    if (found.kind === "refused" || found.kind === "unreachable") {
      return { kind: "failed", reason: found.reason };
    }
    // Gone between the refusal and the read. Asking again is the whole answer.
    if (found.kind === "not-found") continue;

    const held = await readAgent(found.agent.id, platform);
    if (options.signal.aborted) return { kind: "interrupted" };
    if (held.kind === "not-authenticated") return notSignedIn;
    if (held.kind === "refused" || held.kind === "unreachable") {
      return { kind: "failed", reason: held.reason };
    }
    if (held.kind === "not-found") continue;

    // A connection naming another Retell agent settles it: this is somebody
    // else's agent under the same name, and the next name is tried.
    const reaches = held.connections
      .map(retellAgentOf)
      .filter((named): named is string => named !== null);
    if (reaches.length > 0 && !reaches.includes(config.agentId)) continue;

    // Nothing here names a vendor, so the numbers do. An agent reached only by
    // phone is this one exactly when Retell routes one of its numbers to the
    // agent under test. When it routes none of them — and when Retell would not
    // say at all — this is somebody else's agent under the same name, and the
    // next name is tried. Ambiguity goes that way on purpose: see above.
    const dialled = held.connections
      .filter((one) => one.type === "phone")
      .map((one) => one.config["phoneNumber"] ?? "");
    if (reaches.length === 0 && dialled.length > 0) {
      const routed = await numbersOfTheAgent();
      if (options.signal.aborted) return { kind: "interrupted" };
      if (routed === null || !dialled.some((number) => routed.includes(number))) continue;
    }

    // The same reach, already attached. Nothing is written and both halves
    // answer as they stand — which is what makes running this twice free.
    const already = held.connections.find((one) =>
      isTheSameReach(one, selected.connection),
    );
    if (already !== undefined) {
      return {
        kind: "registered",
        registered: { result: "reused", agent: held.agent, connection: already },
        registration: { agent: "reused", connection: "reused" },
      };
    }

    const added = await addConnection(found.agent.id, selected.connection, platform);
    switch (added.kind) {
      case "added":
        return {
          kind: "registered",
          registered: {
            result: "connection_added",
            agent: held.agent,
            connection: added.connection,
          },
          registration: { agent: "reused", connection: "created" },
        };
      case "not-authenticated":
        return notSignedIn;
      // The agent went away between the read and the write. Going round again
      // is the whole answer: the next pass finds whatever is there now.
      case "not-found":
        continue;
      /**
       * Nothing here names a connection, so the platform picks the first free
       * `<type>-<n>` itself. There is exactly one ordinary way it can still
       * answer that the name is held: **two connects adding the same reach at
       * the same instant.** Both got past the check above while neither had
       * written anything, then one lost the connection-name index.
       *
       * The loser's answer is a *reuse*, and it is read rather than assumed:
       * the winner has committed by the time the index refused this write, so
       * the agent is read again and the connection that is now there answers.
       * That is exactly what the same race one level up already does — two
       * simultaneous registrations settle to one agent because the loser waits
       * on the index and then reads committed work — and doing it differently
       * here would tell a developer their egma is out of date when the only
       * thing that happened is that their other terminal got there first.
       *
       * The out-of-date sentence is kept for the case it was written for: the
       * name really is held and nothing on the agent is the reach that was
       * refused, which means the platform names connections in a way this
       * build cannot predict.
       */
      case "name-taken": {
        const now = await readAgent(found.agent.id, platform);
        if (options.signal.aborted) return { kind: "interrupted" };
        if (now.kind === "not-authenticated") return notSignedIn;
        if (now.kind === "refused" || now.kind === "unreachable") {
          return { kind: "failed", reason: now.reason };
        }
        if (now.kind === "not-found") continue;

        const raced = now.connections.find((one) =>
          isTheSameReach(one, selected.connection),
        );
        if (raced !== undefined) {
          return {
            kind: "registered",
            registered: { result: "reused", agent: now.agent, connection: raced },
            registration: { agent: "reused", connection: "reused" },
          };
        }
        return {
          kind: "failed",
          reason:
            `Egma would not name the new connection on ${now.agent.name}, ` +
            "and nothing else was changed. Check that this Egma instance is up to date.",
        };
      }
      case "refused":
      case "unreachable":
        return { kind: "failed", reason: added.reason };
    }
  }

  return {
    kind: "failed",
    reason: `every name from "${wanted}" onwards is already taken in this project. Rename one of them, or say which agent this is.`,
  };
}

/**
 * The number egma will dial, out of the ones Retell routes to this agent.
 *
 * Two reads, and both of them are reads. The account's numbers are listed
 * because Retell has no per-agent listing, and the one the developer settles on
 * is then read at its own address — immediately before egma writes a connection
 * that will be dialled for real, and against the same field the listing was
 * filtered on. A number that stopped answering this agent in between is an
 * ending rather than a call to somebody else's telephone.
 *
 * A number the agent does not answer is never offered, so this cannot end with
 * egma dialling a number for an agent that is not under test.
 */
async function pickNumber(
  options: ConnectOptions,
  key: RetellKey,
  config: RetellConfig,
): Promise<
  | {
      readonly kind: "number";
      readonly number: string;
      /** Every number Retell routes here, so nothing lists them twice. */
      readonly routed: readonly string[];
    }
  | ConnectOutcome
> {
  const listed = await listNumbers(key, options.retell ?? {});
  if (options.signal.aborted) return { kind: "interrupted" };

  switch (listed.kind) {
    case "numbers":
      break;
    case "invalid-key":
      return { kind: "invalid-key" };
    case "refused":
    case "unreachable":
      return { kind: "failed", reason: listed.reason };
  }

  const mine = numbersAnswering(listed.numbers, config.agentId);
  if (mine.length === 0) {
    options.say(NO_NUMBERS_LINE);
    return { kind: "no-numbers" };
  }

  // One number is not a choice, exactly as one agent is not. The developer
  // reads which one egma took, inside the flow, with nothing to answer.
  let wanted = mine.length === 1 ? (mine[0] as RetellNumber).number : null;
  if (wanted === null) {
    wanted = (await options.chooseNumber(mine))?.trim() ?? null;
    if (options.signal.aborted) return { kind: "interrupted" };
    if (wanted === null || wanted === "") return { kind: "unchosen-number", numbers: mine };
    if (!mine.some((one) => one.number === wanted)) {
      return { kind: "unchosen-number", numbers: mine };
    }
  }

  const confirmed = await confirmNumber(key, wanted, options.retell ?? {});
  if (options.signal.aborted) return { kind: "interrupted" };

  switch (confirmed.kind) {
    case "number":
      break;
    case "invalid-key":
      return { kind: "invalid-key" };
    case "gone":
      return {
        kind: "failed",
        reason: `${wanted} is no longer on the Retell account. Run egma again to see which numbers are.`,
      };
    case "refused":
    case "unreachable":
      return { kind: "failed", reason: confirmed.reason };
  }

  if (!confirmed.number.answeredBy.includes(config.agentId)) {
    return {
      kind: "failed",
      reason: `Retell no longer routes ${wanted} to ${config.name}, so Egma will not register it as the way to reach that agent. Run egma again to see which numbers it answers.`,
    };
  }

  options.say(dialLine(wanted), "action");

  return {
    kind: "number",
    number: confirmed.number.number,
    routed: mine.map((one) => one.number),
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

  // The agent is settled, so what egma may offer is settled with it. Asking
  // before this point would be offering a phone the agent may have no number
  // for.
  const compatibleReach: Reach = config.modality === "voice" ? "phone" : "text";
  const offered: readonly Reach[] = [compatibleReach];
  const reach = await options.chooseReach(offered);
  if (options.signal.aborted) return { kind: "interrupted" };
  if (reach === null) return { kind: "unchosen-reach", offered };
  if (config.modality === "voice" && reach !== "phone") {
    return {
      kind: "incompatible-reach",
      requested: reach,
      compatible: compatibleReach,
      reason: VOICE_REQUIRES_PHONE_LINE,
    };
  }
  if (config.modality === "chat" && reach !== "text") {
    return {
      kind: "incompatible-reach",
      requested: reach,
      compatible: compatibleReach,
      reason: CHAT_REQUIRES_TEXT_LINE,
    };
  }

  // Read once at most, and only where it is needed: by the phone branch, which
  // needs it to offer anything at all, and by a name clash that has nothing
  // else to go on. A text connect on an account nobody has clashed with never
  // asks Retell about telephone numbers.
  let routed: readonly string[] | null | undefined;
  const numbersOfTheAgent = async (): Promise<readonly string[] | null> => {
    if (routed !== undefined) return routed;
    const listed = await listNumbers(key, options.retell ?? {});
    routed =
      listed.kind === "numbers"
        ? numbersAnswering(listed.numbers, config.agentId).map((one) => one.number)
        : null;
    return routed;
  };

  const dialling = reach === "phone" ? await pickNumber(options, key, config) : null;
  if (dialling !== null && dialling.kind !== "number") return dialling;
  if (dialling !== null) routed = dialling.routed;
  const selected = selectionFor(reach, config, key, dialling?.number ?? null);

  await options.beforeRegistering?.();
  const written = await register(keyed, config, selected, numbersOfTheAgent);
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
    reach: selected.reach,
    number: selected.number,
    registration: written.registration,
  };
}
