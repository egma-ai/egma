/**
 * Setting production monitoring up, on a screen — one step whose work forks by
 * platform inside it.
 *
 * The two platforms want opposite things, and that is not an accident of this
 * codebase but of how ingestion works. **Retell is pull**: Egma asks the
 * platform for finished conversations with the customer's own key, so what the
 * terminal collects is that key and which agent to spend it on, and the switch
 * that says so is the one declared monitoring choice in the product. **LiveKit
 * is push**: the worker sends its own evidence, so nothing is declared
 * anywhere — what the terminal does instead is get the SDK's monitoring entry
 * into the worker, mint the key that entry exports with, and put it where the
 * process will find it.
 *
 * One state, two shapes of work, and the goal decides what follows either of
 * them: monitoring alone ends here, and both carries on into the testing lane
 * with one agent name and one pasted key threaded through it.
 *
 * Everything the developer sees is pushed at the UI and everything they type
 * comes back through a gate carrying a value, so this step owns no drawing and
 * no keystroke — which is what lets the promptless verb run the very same
 * flows underneath.
 */

import path from "node:path";

import type { DrivenAgent } from "../acp/driven-agent.ts";
import {
  LIVEKIT_CLOSING_LINE,
  wireLiveKitMonitoring,
} from "../monitoring/livekit-lane.ts";
import { ENV_CONSENT_LINE } from "../monitoring/env-file.ts";
import { refusalLines } from "../monitoring/refusals.ts";
import {
  MONITORING_CUSTODY_LINE,
  MONITORING_KEY_ASK_LINE,
  NOTHING_YET_LINE,
  watchRetellAgent,
  type WatchOutcome,
} from "../monitoring/retell-lane.ts";
import type { RegisterOptions } from "../platform/agents.ts";
import { readCredentials } from "../platform/credentials.ts";
import { RetellKey } from "../retell/key.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import type { Facts } from "./discovery.ts";
import type { DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import type { PlatformAccess } from "./login-step.ts";
import {
  monitorEntryInstructions,
  monitoringEditStep,
  type MonitoringEdit,
} from "./monitoring-edit.ts";
import { ACTION_MARK, DETAIL_MARK } from "./status.ts";
import { stopReport, untilAborted } from "./stop.ts";
import type { WizardAgentPlatform } from "./wizard-machine.ts";

/**
 * What the both lane says before it does anything, because order is a promise.
 *
 * The word on screen is *conversations*: `trace` is a storage word and never
 * reaches a developer, however natural it feels to whoever wrote the poller.
 */
export const MONITORING_FIRST_LINE =
  "Setting monitoring up first, so your production conversations start coming in while you write tests.";

export type MonitoringSetupOptions = {
  readonly ui: WizardUI;
  readonly platform: PlatformAccess;
  /** The repository this walk is in. */
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly drivenAgent: DrivenAgent;
  readonly log: DrivenAgentLog;
  readonly agentPlatform: WizardAgentPlatform;
  /** Which lane this is: monitoring alone, or monitoring and then testing. */
  readonly goal: "monitoring" | "both";
  /** What the find-the-agent step reported, by fact name. */
  readonly facts: Facts;
  readonly fetchImpl?: RegisterOptions["fetchImpl"];
  /** How long to wait for the first conversation. Egma's own pace when omitted. */
  readonly waitMs?: number | undefined;
  readonly pollMs?: number | undefined;
};

/**
 * How the step ended, and what the rest of the sitting inherits from it.
 *
 * `monitored` is `null` for every ending that is not one, so a step after this
 * cannot build on monitoring that never started. What it carries is the whole
 * of what the testing half needs to be the same sitting rather than a second
 * one: the agent row monitoring created or found, its name, and — on Retell —
 * the key that was already pasted and the platform agent already chosen.
 */
export type MonitoringSetup = {
  readonly report: ExitReport;
  readonly monitored: {
    readonly agentId: string;
    /** The one name threaded through both halves of the sitting. */
    readonly agentName: string;
    /** Which project that row landed in, for whatever the testing half reads. */
    readonly projectId: string;
    /**
     * The account key, already pasted, for the testing half's own custody.
     *
     * One paste fills both tables. It is held in memory for the length of the
     * sitting and sealed separately on each row; nothing writes it down here.
     */
    readonly retellKey: RetellKey | null;
    /** The platform agent already chosen, so no second picker is drawn. */
    readonly platformAgentId: string | null;
  } | null;
};

function ending(reason: string): MonitoringSetup {
  return { report: { kind: "failed", reason }, monitored: null };
}

/** The Retell lane's endings, as the line the wizard would close on. */
function reportForWatch(
  outcome: Exclude<WatchOutcome, { kind: "watching" }>,
  signal: AbortSignal,
): ExitReport {
  switch (outcome.kind) {
    case "no-key":
      return {
        kind: "failed",
        reason: "no Retell key was given, so there is nothing to watch with.",
      };
    case "invalid-key":
      return { kind: "failed", reason: outcome.reason };
    case "no-agents":
      return {
        kind: "failed",
        reason: "there are no voice agents on that Retell account.",
      };
    case "unchosen":
      return {
        kind: "failed",
        reason: "nobody said which agent Egma should watch.",
      };
    case "refused-start":
      return { kind: "monitoring-refused", lines: refusalLines(outcome.refusal) };
    case "interrupted":
      return stopReport(signal, null);
    case "failed":
      return { kind: "failed", reason: outcome.reason };
  }
}

export async function monitoringSetupStep(
  options: MonitoringSetupOptions,
): Promise<MonitoringSetup> {
  const { ui, signal } = options;

  // Said before anything happens, because the order is the promise: the
  // historical import and the worker's own export run in the background while
  // the developer writes tests.
  if (options.goal === "both") ui.pushStatus(MONITORING_FIRST_LINE);

  const held = await readCredentials(
    options.platform.credentialsFile,
    options.platform.url,
  );
  if (held === null) {
    return ending(
      "this machine is not signed in to Egma. Run egma login, then try again.",
    );
  }

  const access: RegisterOptions = {
    url: held.url,
    key: held.key,
    signal,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };

  return options.agentPlatform === "retell"
    ? watchOnRetell(options, access)
    : pushFromLiveKit(options, access);
}

/**
 * Retell: one paste, one agent, one commit — and a brief wait for proof.
 */
async function watchOnRetell(
  options: MonitoringSetupOptions,
  access: RegisterOptions,
): Promise<MonitoringSetup> {
  const { ui, signal } = options;

  // What went wrong last time, so a screen that asks again can say it above the
  // box rather than leaving the developer to guess what changed.
  let problem: string | null = null;
  /*
   * The key the developer pastes, kept for the length of this sitting.
   *
   * It is held here rather than answered out of the flow because the both lane
   * needs it twice — sealed on the agent by the start, and sealed on the
   * connection by the testing half — and asking twice in one sitting for one
   * secret is the thing this whole arrangement exists to avoid.
   */
  let pasted: RetellKey | null = null;

  const outcome = await watchRetellAgent({
    platform: access,
    signal,
    say: (line, kind) =>
      ui.pushStatus(kind === "action" ? `${ACTION_MARK} ${line}` : line),
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    // The one name a sitting threads through both halves. Discovery's own word
    // for the agent is the starting point, so the row Egma writes is called
    // what the repository calls it.
    agentName: options.facts.get("agent-name") ?? null,
    askForKey: async () => {
      ui.setKeyAsk({
        asking: MONITORING_KEY_ASK_LINE,
        custody: MONITORING_CUSTODY_LINE,
        problem,
      });
      const typed = await untilAborted(ui.waitForAnswer("retell-key"), signal);
      ui.setKeyAsk(null);
      problem = null;
      pasted = RetellKey.from(typed);
      return pasted;
    },
    chooseAgent: async (agents) => {
      ui.setMonitoringAgentChoices(agents);
      const chosen = await untilAborted(
        ui.waitForAnswer("monitoring-agent"),
        signal,
      );
      ui.setMonitoringAgentChoices(null);
      return chosen ?? null;
    },
  });

  if (outcome.kind !== "watching") {
    return { report: reportForWatch(outcome, signal), monitored: null };
  }

  if (outcome.created) {
    ui.pushStatus(`${ACTION_MARK} ${outcome.agentName} is on Egma, watching Retell.`);
  }
  ui.pushStatus(`${DETAIL_MARK} agent ${outcome.agentId}, Retell ${outcome.platformAgentId}`);
  if (!outcome.arrived) ui.pushStatus(NOTHING_YET_LINE);

  return {
    report: {
      kind: "monitoring-started",
      agentName: outcome.agentName,
      arrived: outcome.arrived,
      registered: outcome.created,
      platformUrl: options.platform.url,
    },
    monitored: {
      agentId: outcome.agentId,
      agentName: outcome.agentName,
      projectId: outcome.projectId,
      retellKey: pasted,
      platformAgentId: outcome.platformAgentId,
    },
  };
}

/**
 * LiveKit: the edit belongs to the coding agent, the credential to Egma.
 *
 * The dispatch goes first because its answer decides the rest: the coding
 * agent reads the repository and says what this worker should be called, and
 * that name is the one the roster row takes and the one the testing half reuses.
 */
async function pushFromLiveKit(
  options: MonitoringSetupOptions,
  access: RegisterOptions,
): Promise<MonitoringSetup> {
  const { ui, signal } = options;

  const edited: MonitoringEdit = await monitoringEditStep({
    ui,
    drivenAgent: options.drivenAgent,
    signal,
    log: options.log,
    cwd: options.cwd,
    facts: options.facts,
  });
  if (edited.halted !== null) {
    return { report: edited.halted, monitored: null };
  }
  if (!edited.wired) {
    // Not fatal, and not silent: the worker is Egma's to teach and the
    // developer's to change, so the lines they add by hand are printed and the
    // key is still minted for when they do.
    for (const line of monitorEntryInstructions()) ui.pushStatus(line);
  }

  // The one keystroke before a live credential is written into a working tree.
  ui.setEnvConsent(ENV_CONSENT_LINE);
  await untilAborted(ui.waitForGate("write-env"), signal);
  ui.setEnvConsent(null);
  if (signal.aborted) {
    return { report: stopReport(signal, options.drivenAgent.name), monitored: null };
  }

  const wired = await wireLiveKitMonitoring({
    platform: access,
    cwd: options.cwd,
    signal,
    agentName:
      edited.agentName ??
      options.facts.get("agent-name") ??
      path.basename(options.cwd),
    say: (line, kind) =>
      ui.pushStatus(kind === "action" ? `${ACTION_MARK} ${line}` : line),
  });

  if (wired.kind === "interrupted") {
    return { report: stopReport(signal, options.drivenAgent.name), monitored: null };
  }
  if (wired.kind === "failed") {
    return ending(wired.reason);
  }

  ui.pushStatus(`${DETAIL_MARK} project key ${wired.keyLooksLike}`);
  ui.pushStatus(LIVEKIT_CLOSING_LINE);

  return {
    report: {
      kind: "monitoring-wired",
      agentName: wired.agent.name,
      envFile: wired.env.kind === "written" ? wired.env.file : null,
      envRefusal: wired.env.kind === "refused" ? wired.env.reason : null,
      lines: wired.lines,
      wired: edited.wired,
      platformUrl: options.platform.url,
    },
    monitored: {
      agentId: wired.agent.id,
      agentName: wired.agent.name,
      projectId: wired.agent.projectId,
      retellKey: null,
      platformAgentId: null,
    },
  };
}
