/**
 * The wizard's connect step: the same flow the headless verb runs, on a screen.
 *
 * Everything the developer sees is pushed at the UI and everything they type
 * comes back through a gate carrying a value, so this step owns no drawing and
 * no keystroke. That is what lets it be one step in the walk and one command at
 * the same time.
 *
 * The key never touches this module's own state. It arrives from the screen,
 * goes into the flow, and the flow reads it twice — once for a header to the
 * provider, once for a body to egma. Nothing here writes it anywhere.
 */

import { bindRepositoryPlatform } from "../folder/egma-folder.ts";
import type { Registered } from "../platform/agents.ts";
import { readCredentials } from "../platform/credentials.ts";
import type { RetellConfig } from "../retell/client.ts";
import { RetellKey } from "../retell/key.ts";
import {
  connect,
  CUSTODY_LINE,
  KEY_ASK_LINE,
  NO_NUMBERS_LINE,
  registrationLine,
  type ConnectOptions,
  type ConnectOutcome,
  type Reach,
  type Registration,
} from "../retell/connect.ts";
import { DRIFT_LINE } from "../retell/prompt-drift.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import type { ExitReport } from "./exit-line.ts";
import type { PlatformAccess } from "./login-step.ts";
import { ACTION_MARK, DETAIL_MARK } from "./status.ts";
import { stopReport, untilAborted } from "./stop.ts";

export type ConnectStepOptions = {
  readonly ui: WizardUI;
  readonly platform: PlatformAccess;
  /** The folder the repository's prompt is looked for in. */
  readonly cwd: string;
  /** Where the find-the-agent step said the prompts live. */
  readonly repoPrompts: string | null;
  readonly signal: AbortSignal;
  /** Where Retell is. Retell's own address when omitted. */
  readonly retell?: ConnectOptions["retell"];
  readonly fetchImpl?: ConnectOptions["fetchImpl"];
};

/** The two words a reach screen may answer with, and nothing else. */
function reachFrom(answer: string | null): Reach | null {
  return answer === "text" || answer === "phone" ? answer : null;
}

/** The line the wizard closes on, for every way this step can end. */
function reportFor(outcome: ConnectOutcome, signal: AbortSignal): ExitReport {
  switch (outcome.kind) {
    case "connected":
      return {
        kind: "connected",
        agentName: outcome.registered.agent.name,
        connectionName: outcome.registered.connection.name,
      };
    case "no-key":
      return { kind: "failed", reason: "no Retell key was given, so there is nothing to test." };
    case "invalid-key":
      return { kind: "failed", reason: "Retell would not take that key." };
    case "no-agents":
      return { kind: "failed", reason: "there are no agents on that Retell account." };
    case "unchosen":
      return { kind: "failed", reason: "nobody said which Retell agent to test." };
    case "unchosen-reach":
      return {
        kind: "failed",
        reason: `nobody chose ${outcome.offered.join(" or ")}, so nothing was created.`,
      };
    case "incompatible-reach":
      return { kind: "failed", reason: outcome.reason };
    case "no-numbers":
      return { kind: "failed", reason: NO_NUMBERS_LINE };
    case "unchosen-number":
      return { kind: "failed", reason: "nobody said which number Egma should dial." };
    case "interrupted":
      return stopReport(signal, null);
    case "failed":
      return { kind: "failed", reason: outcome.reason };
  }
}

/**
 * How the step ended, and what it registered when it ended well.
 *
 * `connected` is `null` for every ending that is not one, so a step after this
 * cannot read a registration that never happened. What it carries is what the
 * next step is grounded in: the agent and connection egma now holds, and the
 * configuration the provider is actually running.
 */
export type Connected = {
  readonly report: ExitReport;
  readonly connected: {
    readonly registered: Registered;
    readonly config: RetellConfig;
    /** Which way the developer chose, and the only one egma created. */
    readonly reach: Reach;
    /** The number egma will dial, or `null` for a text connection. */
    readonly number: string | null;
    /** Whether the agent and the connection were written or found. */
    readonly registration: Registration;
  } | null;
};

/**
 * Connects, or answers with the line the wizard should close on.
 *
 * Unlike login, every ending here is an ending: past this point egma has no
 * agent to test, so there is nothing for the walk to carry on into.
 */
export async function connectStep(options: ConnectStepOptions): Promise<Connected> {
  const { ui, signal } = options;

  const held = await readCredentials(
    options.platform.credentialsFile,
    options.platform.url,
  );
  if (held === null) {
    return {
      report: {
        kind: "failed",
        reason: "this machine is not signed in to Egma. Run egma login, then try again.",
      },
      connected: null,
    };
  }

  // What went wrong last time, so the screen that asks again can say it above
  // the box rather than leaving the developer to guess what changed.
  let problem: string | null = null;

  // A repository this platform may not write into, carried out of the hook
  // below because the flow has no ending of its own for it.
  const binding: { refused: Error | null } = { refused: null };

  const outcome = await connect({
    platform: { url: held.url, key: held.key },
    cwd: options.cwd,
    repoPrompts: options.repoPrompts,
    signal,
    retell: options.retell,
    fetchImpl: options.fetchImpl,
    say: (line, kind) => {
      if (kind !== "action") problem = line;
      ui.pushStatus(kind === "action" ? `${ACTION_MARK} ${line}` : line);
    },
    // Both waits are wired to the stop signal, because both park on a person.
    // A screen waiting for a keystroke that will never come is the one place a
    // wizard can hang forever, and Ctrl-C at the key box is exactly where a
    // developer who has decided not to hand a key over presses it.
    askForKey: async () => {
      ui.setKeyAsk({ asking: KEY_ASK_LINE, custody: CUSTODY_LINE, problem });
      const typed = await untilAborted(ui.waitForAnswer("retell-key"), signal);
      ui.setKeyAsk(null);
      problem = null;
      return RetellKey.from(typed);
    },
    chooseAgent: async (agents) => {
      ui.setAgentChoices(agents);
      const chosen = await untilAborted(ui.waitForAnswer("retell-agent"), signal);
      ui.setAgentChoices(null);
      return chosen ?? null;
    },
    chooseReach: async (offered) => {
      ui.setReachOffer(offered);
      const chosen = await untilAborted(ui.waitForAnswer("reach"), signal);
      ui.setReachOffer(null);
      return reachFrom(chosen ?? null);
    },
    chooseNumber: async (numbers) => {
      ui.setNumberChoices(numbers);
      const chosen = await untilAborted(ui.waitForAnswer("phone-number"), signal);
      ui.setNumberChoices(null);
      return chosen ?? null;
    },
    // The last moment before this repository owns anything that only one
    // platform can resolve, and the reason this hook exists at all: every
    // ending above it — no key, a key Retell will not take, an empty account,
    // an unanswered choice of agent, reach or number — must leave the
    // repository exactly as the walk found it. Bound any earlier and a wizard
    // closed at the key box would leave an egma folder behind holding nothing
    // but a binding.
    beforeRegistering: async () => {
      try {
        await bindRepositoryPlatform(options.cwd, {
          origin: options.platform.url,
          instance: options.platform.instanceId,
        });
      } catch (cause) {
        // Carried out rather than answered from in here: the flow has no
        // ending for this, and an agent must not be registered on a platform
        // this repository has already refused.
        binding.refused = cause instanceof Error ? cause : new Error(String(cause));
        throw cause;
      }
      ui.pushStatus(
        `${ACTION_MARK} Bound this repository to Egma platform ${options.platform.instanceId}.`,
      );
    },
  }).catch((cause: unknown) => {
    if (binding.refused === null) throw cause;
    return { kind: "failed", reason: binding.refused.message } as const;
  });

  if (outcome.kind !== "connected") {
    return { report: reportFor(outcome, signal), connected: null };
  }

  {
    const { registered, config } = outcome;
    // One agent on the account is confirmed here rather than asked about: the
    // developer reads which one egma took, inside the flow, with nothing to
    // answer.
    ui.pushStatus(`${ACTION_MARK} Retell agent ${config.name}`);
    ui.pushStatus(`${DETAIL_MARK} ${config.agentId}`);
    ui.pushStatus(
      `${ACTION_MARK} ${registered.agent.name} is on Egma, reachable over ${registered.connection.name} (${registered.connection.productLabel}, ${registered.connection.modality}).`,
    );
    ui.pushStatus(
      `${DETAIL_MARK} agent ${outcome.registration.agent}, connection ${outcome.registration.connection}`,
    );
    // A second walk over the same Retell agent finds what the first one wrote.
    // egma says so rather than drawing a line that reads like a fresh
    // registration, and rather than failing over something that worked.
    const already = registrationLine(registered);
    if (already !== null) ui.pushStatus(`${DETAIL_MARK} ${already}`);
    // Shown, never blocking, and only when both halves were really read.
    if (outcome.drift === "differs") ui.pushStatus(DRIFT_LINE);

    return {
      report: reportFor(outcome, signal),
      connected: {
        registered,
        config,
        reach: outcome.reach,
        number: outcome.number,
        registration: outcome.registration,
      },
    };
  }
}
