/**
 * Connecting a Retell voice agent to Egma.
 *
 * There is one flow here. `egma connect` is a plain-line adapter over it, so
 * tests exercise the same provider path a coding agent uses.
 *
 * Nothing in here draws and nothing in here reads a keystroke. The key arrives
 * through `askForKey`, the choice between several agents through `chooseAgent`,
 * and everything the developer should see goes out through `say` — so the same
 * flow runs in a pipe and in a check with nobody watching.
 *
 * Six things happen in order and each one can end the flow honestly: the key is
 * taken, it is checked by listing the account's **voice** agents, one agent is
 * settled on, its configuration is pulled, the developer says how egma should
 * test it — text, web call, phone call, **any of them, several at once** — and,
 * only when the phone was picked, which of the numbers Retell routes to that
 * agent egma should dial. Then one connection is written per lane picked, all
 * of them onto **one** egma agent in one pass: **the lanes that were chosen,
 * and only those.** A key that is wrong and an account that is empty are told
 * apart by name and each is worth one more try — a typo should cost seconds,
 * and a second wrong answer means the answer is somewhere else.
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
import { factValueIssue, MAX_FACT_VALUE_LENGTH } from "../ui/fact-value.ts";
import {
  confirmNumber,
  CUSTOM_LLM_HAS_NO_CONFIGURATION,
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
  "Egma uses this key now to read your Retell agents and confirm the selected setup. " +
  "Egma seals a copy on the agent so production monitoring can be enabled later without asking for the key again. " +
  "Text and Web call also keep a sealed connection copy and use it to run each simulation through Retell. " +
  "A Phone connection keeps no key. The key never lands in this repository.";

/** The exact failure for a key Retell will not take. */
export const INVALID_KEY_LINE =
  "Retell would not take that key. Copy it again from the Retell dashboard, under Settings → API keys.";

/** The exact failure for a key that works on an account with nothing on it. */
export const NO_AGENTS_LINE =
  "That key works, and there are no voice agents on the Retell account it " +
  "belongs to. Paste a key for the account your voice agent is on.";

/** What egma calls the agent when the customer never named it on Retell. */
export const DEFAULT_AGENT_NAME = "voice-agent";

/**
 * How egma tests the agent, chosen by the developer and never by egma.
 *
 * Three lanes, and a Retell voice agent can be tested over any of them — or
 * over several at once, which is the point: chat and voice land as connections
 * on **one** egma agent, and one test suite runs over all of them. Each lane is
 * one connection, and each connection that can run mocked carries its own
 * switch.
 *
 * - `text` — the Retell text mode door, mocks on the moment it is created.
 * - `web-call` — a voice call egma places over the internet, mocks off until
 *   the one consent screen is accepted.
 * - `phone` — the real telephone line, real tools, never mocked.
 */
export type Lane = "text" | "web-call" | "phone";

/** Every lane, in the order a developer reads them: fastest first. */
export const LANES: readonly Lane[] = ["text", "web-call", "phone"];

/** What the developer is choosing between, said the same way on every surface. */
export const LANE_ASK_LINE = "How should Egma test this agent?";

/** The short name of each lane, which is the word on every surface. */
export const LANE_NAMES: Readonly<Record<Lane, string>> = {
  text: "Text",
  "web-call": "Web call",
  phone: "Phone call",
};

/** One help line per lane, in what it tests rather than what it is made of. */
export const LANE_LINES: Readonly<Record<Lane, string>> = {
  text: "Text — Egma talks to the agent in text. No call is placed, and a run takes seconds.",
  "web-call": "Web call — a voice call Egma places over the internet.",
  phone:
    "Phone call — Egma dials the real number, so a run has true telephone " +
    "latency and reaches your real tools.",
};

/**
 * Which lane a connection type is, for a surface holding a record rather than
 * a choice.
 *
 * The connect flow goes the other way — a lane is picked and a connection is
 * written for it — but a run is started against a connection that already
 * exists, and what it reaches is a fact about that connection's kind. `null`
 * for a kind that is not one of these three: the chat API and every LiveKit
 * door are reached through the same runs and are not part of this vocabulary,
 * and calling one of them a lane it is not would be worse than saying nothing.
 */
export function laneOfConnectionType(connectionType: string): Lane | null {
  if (connectionType === "retell_text_mode") return "text";
  if (connectionType === "retell_web_call") return "web-call";
  if (connectionType === "phone_number") return "phone";
  return null;
}

/**
 * What a phone run reaches, said at its start and not only at its setup.
 *
 * The one lane with no mocked world at all. A developer who picked it weeks ago
 * and starts a suite today is told again, at the moment the calls are about to
 * be placed, because this is the run that bills real minutes and moves whatever
 * the agent's tools move.
 */
export const PHONE_RUN_REACHES_REAL_TOOLS =
  "Egma dials the real number, so this run reaches your real tools.";

/** The word a lane is said with on a flag, in an answer, and in a check. */
export function laneNamed(said: string): Lane | null {
  const word = said.trim().toLowerCase();
  return (LANES as readonly string[]).includes(word) ? (word as Lane) : null;
}

/**
 * Why text cannot reach a voice agent whose engine is a custom LLM.
 *
 * Text mode is the door text would open for a voice agent, and it reaches
 * an agent's words and tools through Retell — which holds neither for a custom
 * LLM. So the refusal is Retell's own absence, said in the package's one place
 * for it, and then the one door that does reach such an agent: its phone line,
 * where the agent answers the way its callers reach it. It is the same reason
 * the run-start read and the web flow give, at the moment the engine is read.
 */
export const TEXT_MODE_REFUSES_CUSTOM_LLM =
  `${CUSTOM_LLM_HAS_NO_CONFIGURATION} Choose --lanes phone and test this agent ` +
  "over its phone line instead, which reaches it the way its callers do. " +
  "Nothing was written.";

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

/** The provider values registration needs before it can continue. */
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
const SAFE_PROVIDER_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;
const E164_PHONE_NUMBER = /^\+[1-9][0-9]{1,14}$/u;

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

/** One lane that was picked, and the connection egma wrote for it. */
export type ConnectedLane = {
  readonly lane: Lane;
  readonly connection: RegisteredConnection;
  /** Whether this connection was written or found already there. */
  readonly written: WriteResult;
};

/** One remote write receipt, delivered before the flow makes another request. */
export type RegistrationReceiptEvent = {
  readonly lane: Lane;
  readonly registered: Registered;
  readonly registration: Registration;
};

export type ConnectOutcome =
  | {
      readonly kind: "connected";
      /** The last write's answer, which carries the one agent every lane landed on. */
      readonly registered: Registered;
      readonly config: RetellConfig;
      readonly drift: Drift;
      /** How many agents the account holds, which is why a picker appeared. */
      readonly onTheAccount: number;
      /** Every lane the developer chose, and none that they did not. */
      readonly lanes: readonly Lane[];
      /** One entry per lane, in the order they were written. */
      readonly connections: readonly ConnectedLane[];
      /** The number egma will dial, or `null` when the phone lane was not picked. */
      readonly number: string | null;
      /** Whether the agent and the first connection were written or found. */
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
  /** Nobody picked a lane, so there is nothing to write. */
  | { readonly kind: "unchosen-lanes"; readonly offered: readonly Lane[] }
  /**
   * A picked lane cannot reach this agent, and the reason says why.
   *
   * One shape today: a voice agent picked for text whose response engine is a
   * custom LLM, which text mode cannot reach because Retell holds neither its
   * words nor its tools. It names the lane that does work and the reason a
   * developer reads, and **nothing at all is written** — a pass that half
   * landed would leave a project the developer has to unpick.
   */
  | {
      readonly kind: "incompatible-lane";
      readonly requested: Lane;
      readonly compatible: Lane;
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
   * Which lanes to test over, or `null`/empty when nobody picked one.
   *
   * Asked once the agent is settled and never before it: which numbers exist
   * is a fact about *that* agent, so there is nothing honest to offer until
   * egma knows which one is under test. Several may come back, and each one
   * becomes a connection on the same egma agent in this one pass.
   */
  readonly chooseLanes: (
    offered: readonly Lane[],
  ) => Promise<readonly Lane[] | null>;
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
  /** The exact Egma name said immediately before each registration request. */
  readonly beforeRegistrationAttempt?: (name: string) => void;
  /** A complete remote receipt said before any later request or local write. */
  readonly onRegistered?: (event: RegistrationReceiptEvent) => void;
  /**
   * What Egma should call the agent, when the sitting has already settled it.
   *
   * One name threaded through a sitting that does monitoring and testing both:
   * the row monitoring created holds this name, so registering under it finds
   * that row and adds the connection to it rather than writing a second agent
   * for one voice agent. Omitted, the Retell agent's own name is taken, which
   * is what a testing-only walk does.
   */
  readonly agentName?: string | undefined;
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
      case "agents": {
        // Egma registers Retell **voice** agents only, so a chat-native agent
        // is never offered: the product would have nothing to ask about it.
        // The account being all chat agents reads as an empty one here, which
        // is the honest answer — there is nothing on it egma tests.
        const voice = listed.agents.filter((agent) => agent.modality === "voice");
        if (voice.length > 0) return { kind: "ok", key, agents: voice };
        if (attempt === 0) {
          refusedFor = "no-agents";
          options.say(NO_AGENTS_LINE);
          break;
        }
        return { kind: "no-agents" };
      }
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

/** What egma is being asked to write, for one picked lane. */
type Selected = {
  readonly lane: Lane;
  /** The connection body for that lane, and no other. */
  readonly connection: NewConnection;
};

/**
 * The one connection a lane means.
 *
 * **Three lanes, three doors, and the developer picks the doors.** Text is
 * conducted over Retell's text mode, which runs a chat simulation of a voice
 * agent; a web call is one egma places over the internet; phone dials a real
 * number. The two Retell doors carry the vendor's own agent id and the Retell
 * key, because both conduct their simulations through Retell. **Phone carries
 * the destination number and no durable connection credential** — its
 * request-only platform selection carries the Retell key so the API can confirm
 * the routing during the write, then discards it. The separate agent-platform
 * field records that this onboarding flow found the agent in Retell.
 *
 * Egma registers Retell voice agents only, so there is no second text door to
 * choose between: the chat-native `retell_chat_api` is dormant and no flow
 * offers it.
 */
function selectionFor(
  lane: Lane,
  config: RetellConfig,
  key: RetellKey,
  number: string | null,
): Selected {
  switch (lane) {
    case "phone":
      return {
        lane,
        // No name: the platform's own default is the convention, and one
        // convention in one place cannot drift from itself.
        connection: {
          agentPlatform: "retell",
          connectionType: "phone_number",
          accessVariant: "phone_number.public_e164",
          modality: "voice",
          config: { phoneNumber: number ?? "" },
          agentPlatformSelection: {
            platformAgentId: config.agentId,
            credentials: ConnectionCredentials.defer(() => ({ apiKey: key.reveal() })),
          },
        },
      };
    case "web-call":
      // Mocks stay off on a web call until the one consent screen is accepted,
      // so this flow never asks for them: the connection arrives unmocked and
      // the consent flow is the only thing that turns the switch on.
      return {
        lane,
        connection: {
          agentPlatform: "retell",
          connectionType: "retell_web_call",
          accessVariant: "retell_web_call.api_key",
          modality: "voice",
          config: { retellAgentId: config.agentId },
          credentials: ConnectionCredentials.defer(() => ({ apiKey: key.reveal() })),
        },
      };
    case "text":
      return {
        lane,
        connection: {
          agentPlatform: "retell",
          connectionType: "retell_text_mode",
          accessVariant: "retell_text_mode.api_key",
          // Text mode conducts a chat simulation of a voice agent.
          modality: "chat",
          config: { retellAgentId: config.agentId },
          credentials: ConnectionCredentials.defer(() => ({ apiKey: key.reveal() })),
        },
      };
  }
}

/** Whether a connection already on the platform is the one being asked for. */
function isTheSameReach(held: RegisteredConnection, wanted: NewConnection): boolean {
  if (
    held.agentPlatform !== wanted.agentPlatform ||
    held.connectionType !== wanted.connectionType ||
    held.accessVariant !== wanted.accessVariant ||
    held.modality !== wanted.modality
  ) {
    return false;
  }
  return Object.entries(wanted.config).every(([key, value]) => held.config[key] === value);
}

/**
 * The Retell agent a connection already on the platform reaches, if it names
 * one.
 *
 * Every Retell connection that carries the vendor's own agent id answers here —
 * the chat API, text mode, and the web call alike — because the whole
 * point is telling a name clash apart: a living connection naming this vendor
 * agent means the row that holds it is this agent, whichever modality it was
 * reached by. Only a phone connection names no vendor id, and that is the one
 * case the numbers below have to settle instead.
 */
const RETELL_AGENT_ID_KINDS: readonly string[] = [
  "retell_chat_api",
  "retell_text_mode",
  "retell_web_call",
];

function retellAgentOf(held: RegisteredConnection): string | null {
  if (
    held.agentPlatform !== "retell" ||
    !RETELL_AGENT_ID_KINDS.includes(held.connectionType)
  ) {
    return null;
  }
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
 * **The provider binding tells those apart.** Current Retell agents carry the
 * provider's own agent id on the agent row. Older text and web-call rows carry
 * it on their connection. An older phone-only row may carry neither; current
 * routing can prove a positive match, but a changed route cannot prove that an
 * old number belonged to somebody else.
 *
 * **Where neither signal answers, the write stops.** A lost registration reply
 * can leave a real phone connection behind. Advancing to a suffixed name while
 * Retell cannot prove the existing row's provider identity would turn that
 * uncertain success into a duplicate agent. The record-only command can match
 * the provider agent, lane and number without another remote write.
 */
async function register(
  options: KeyedOptions,
  config: RetellConfig,
  selected: Selected,
  /**
   * The numbers Retell routes to the agent under test, read at most once and
   * only when a name clash actually needs them.
   *
   * `null` when Retell would not say. The registration then stops rather than
   * guessing whether a phone-only row belongs to this agent. Read once and no
   * more, because a listing that failed on the first ask is not going to answer
   * differently on the twentieth.
   */
  numbersOfTheAgent: () => Promise<readonly string[] | null>,
): Promise<Written | ConnectOutcome> {
  const wanted = options.agentName?.trim() || defaultAgentName(config.name);
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
    if (factValueIssue(name) !== null) {
      return {
        kind: "failed",
        reason:
          `Egma needs an agent name on one line, at most ${String(MAX_FACT_VALUE_LENGTH)} characters, ` +
          "without control characters. Nothing was registered.",
      };
    }
    options.beforeRegistrationAttempt?.(name);

    const result = await registerAgent(
      { name, agentPlatform: "retell", connection: selected.connection },
      platform,
    );

    switch (result.kind) {
      case "registered": {
        const providerIdentities = [
          result.registered.agent.platformAgentId,
          (result.registered.connection.config["retellAgentId"] ?? "").trim() ||
            null,
        ].filter((identity): identity is string => identity !== null);
        const requiredLaneIdentityMatches =
          selected.lane === "phone"
            ? result.registered.agent.platformAgentId === config.agentId
            : (result.registered.connection.config["retellAgentId"] ?? "").trim() ===
              config.agentId;
        const providerIdentityMatches =
          requiredLaneIdentityMatches &&
          providerIdentities.length > 0 &&
          providerIdentities.every((identity) => identity === config.agentId);
        if (
          result.registered.agent.agentPlatform !== "retell" ||
          !providerIdentityMatches ||
          !isTheSameReach(result.registered.connection, selected.connection)
        ) {
          return {
            kind: "failed",
            reason:
              "Egma answered without a receipt for the selected Retell agent and lane. No recovery receipt was printed and nothing was recorded locally.",
          };
        }
        return {
          kind: "registered",
          registered: result.registered,
          registration: registrationOf(result.registered),
        };
      }
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

    // Every public provider identity must agree. One matching connection does
    // not make a contradictory agent binding safe, and vice versa.
    if (held.agent.agentPlatform !== "retell") continue;
    const reaches = held.connections
      .map(retellAgentOf)
      .filter((named): named is string => named !== null);
    const providerIdentities = [
      ...(held.agent.platformAgentId === null
        ? []
        : [held.agent.platformAgentId]),
      ...reaches,
    ];
    let providerIdentityProved = false;
    if (providerIdentities.length > 0) {
      if (providerIdentities.every((identity) => identity === config.agentId)) {
        providerIdentityProved = true;
      } else if (providerIdentities.every((identity) => identity !== config.agentId)) {
        // Every public identity names somebody else, so the next name is safe.
        continue;
      } else {
        return {
          kind: "failed",
          reason:
            `Egma returned conflicting Retell provider identities for the existing agent named ${name}. ` +
            "It did not create or attach another connection. Resolve that agent binding before trying again.",
        };
      }
    }

    // Nothing here names a vendor, so the numbers do. An agent reached only by
    // phone is this one exactly when Retell routes one of its numbers to the
    // agent under test. When it routes none of them this is somebody else's
    // agent under the same name. When Retell will not say, stop before a
    // suffixed retry can duplicate an earlier uncertain write.
    const dialled = held.connections
      .filter((one) => one.connectionType === "phone_number")
      .map((one) => one.config["phoneNumber"] ?? "");
    if (!providerIdentityProved && providerIdentities.length === 0 && dialled.length > 0) {
      const routed = await numbersOfTheAgent();
      if (options.signal.aborted) return { kind: "interrupted" };
      providerIdentityProved =
        routed !== null &&
        dialled.some((number) => routed.includes(number));
    }

    if (!providerIdentityProved) {
      const phone = selected.connection.config["phoneNumber"];
      const recovery =
        `egma connect record --platform retell --retell-agent ${config.agentId} ` +
        `--lanes ${selected.lane}` +
        (phone === undefined ? "" : ` --phone-number ${phone}`) +
        ` --url "${options.platform.url}"`;
      return {
        kind: "failed",
        reason:
          `Egma could not prove which Retell agent owns the existing agent named ${name}. ` +
          `It did not create another agent or connection. Run ${recovery} to look for an equivalent earlier remote write, or resolve the old name before registering again.`,
      };
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
        if (!isTheSameReach(added.connection, selected.connection)) {
          return {
            kind: "failed",
            reason:
              `Egma answered without a receipt for the selected ${LANE_NAMES[selected.lane]} connection. ` +
              "No recovery receipt was printed and nothing was recorded locally.",
          };
        }
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
       * `<connection-type>-<n>` itself. There is exactly one ordinary way it can still
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
 * One more lane onto the agent the first lane already landed on.
 *
 * The first picked lane goes through `register`, which settles which egma agent
 * this Retell agent is. Every lane after it is an addition to *that* agent, and
 * that is the whole point of the multi-pick: several ways of testing one voice
 * agent, one results history.
 *
 * A lane already attached is answered rather than written twice, exactly as a
 * repeated single-lane connect is, so running the same pass again is free.
 */
async function attachLane(
  options: ConnectOptions,
  agentId: string,
  selected: Selected,
): Promise<
  | { readonly kind: "attached"; readonly connection: RegisteredConnection; readonly written: WriteResult }
  | ConnectOutcome
> {
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

  const held = await readAgent(agentId, platform);
  if (options.signal.aborted) return { kind: "interrupted" };
  if (held.kind === "not-authenticated") return notSignedIn;
  if (held.kind === "refused" || held.kind === "unreachable") {
    return { kind: "failed", reason: held.reason };
  }
  if (held.kind !== "agent") {
    return {
      kind: "failed",
      reason: `Egma lost the agent this walk had just registered, so ${LANE_NAMES[selected.lane]} was not added. Run egma connect again.`,
    };
  }

  const already = held.connections.find((one) => isTheSameReach(one, selected.connection));
  if (already !== undefined) return { kind: "attached", connection: already, written: "reused" };

  const added = await addConnection(agentId, selected.connection, platform);
  if (options.signal.aborted) return { kind: "interrupted" };
  switch (added.kind) {
    case "added":
      if (!isTheSameReach(added.connection, selected.connection)) {
        return {
          kind: "failed",
          reason:
            `Egma answered without a receipt for the selected ${LANE_NAMES[selected.lane]} connection. ` +
            "No recovery receipt was printed and nothing was recorded locally.",
        };
      }
      return { kind: "attached", connection: added.connection, written: "created" };
    case "not-authenticated":
      return notSignedIn;
    case "not-found":
    case "name-taken":
      return {
        kind: "failed",
        reason:
          `Egma would not add the ${LANE_NAMES[selected.lane]} connection to ` +
          `${held.agent.name}. The lanes before it were written. Run egma connect again.`,
      };
    case "refused":
    case "unreachable":
      return { kind: "failed", reason: added.reason };
  }
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

  if (!E164_PHONE_NUMBER.test(wanted)) {
    return {
      kind: "failed",
      reason:
        "Retell returned a phone number that is not safe E.164 text. Nothing was registered.",
    };
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

  // Confirm the settled agent before the next provider read. The read gives a
  // caller the settled fact before the next provider request begins.
  options.say(`Retell agent ${defaultAgentName(chosen.name)}`, "action");

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
  if (!SAFE_PROVIDER_AGENT_ID.test(config.agentId)) {
    return {
      kind: "failed",
      reason:
        "Retell returned an agent identifier with unsupported characters. Nothing was registered.",
    };
  }

  // The agent is settled, so the one question can be asked: how should Egma
  // test it. Three lanes, several pickable at once, and each pick is one
  // connection on this one egma agent. Egma registers voice agents only, so
  // every lane is offered for every agent that got this far.
  const offered = LANES;
  const picked = (await options.chooseLanes(offered)) ?? [];
  if (options.signal.aborted) return { kind: "interrupted" };
  if (picked.length === 0) return { kind: "unchosen-lanes", offered };
  // Deduplicated and put back in the reading order, so two surfaces answering
  // the same set write the same connections in the same order.
  const lanes = offered.filter((lane) => picked.includes(lane));

  // A voice agent tested in text is conducted over text mode, which reaches an
  // agent's words and tools through Retell — and a custom LLM keeps both on its
  // own socket server, out of that reach. So the engine, already read when the
  // agent was pulled, is refused here, at the door, with its reason and the
  // phone line as the lane that does reach it. Nothing is written: a pass that
  // half landed would leave a project the developer has to unpick.
  if (lanes.includes("text") && config.engine === "custom-llm") {
    return {
      kind: "incompatible-lane",
      requested: "text",
      compatible: "phone",
      reason: TEXT_MODE_REFUSES_CUSTOM_LLM,
    };
  }

  // Read once at most, and only where it is needed: by the phone lane, which
  // needs it to offer anything at all, and by a name clash that has nothing
  // else to go on. A text-only connect on an account nobody has clashed with
  // never asks Retell about telephone numbers.
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

  // The number chooser appears only when the phone lane was picked. A developer
  // who picked only Text is never asked for a phone number.
  const dialling = lanes.includes("phone")
    ? await pickNumber(options, key, config)
    : null;
  if (dialling !== null && dialling.kind !== "number") return dialling;
  if (dialling !== null) routed = dialling.routed;

  const selections = lanes.map((lane) =>
    selectionFor(lane, config, key, dialling?.number ?? null),
  );
  const first = selections[0] as Selected;

  await options.beforeRegistering?.();
  const written = await register(keyed, config, first, numbersOfTheAgent);
  if (written.kind !== "registered") return written;
  options.onRegistered?.({
    lane: first.lane,
    registered: written.registered,
    registration: written.registration,
  });

  const connections: ConnectedLane[] = [
    {
      lane: first.lane,
      connection: written.registered.connection,
      written: written.registration.connection,
    },
  ];
  for (const selected of selections.slice(1)) {
    const attached = await attachLane(options, written.registered.agent.id, selected);
    if (attached.kind !== "attached") return attached;
    options.onRegistered?.({
      lane: selected.lane,
      registered: {
        result: attached.written === "created" ? "connection_added" : "reused",
        agent: written.registered.agent,
        connection: attached.connection,
      },
      registration: { agent: "reused", connection: attached.written },
    });
    connections.push({
      lane: selected.lane,
      connection: attached.connection,
      written: attached.written,
    });
  }

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
    lanes,
    connections,
    number: dialling?.number ?? null,
    registration: written.registration,
  };
}
