/**
 * The wizard flow, from the first consent screen to the final status.
 *
 * The flow never draws anything and never reads a keystroke: it pushes state at
 * the UI and parks on a gate. Five steps — sign this machine in, find the voice
 * agent, reach it, write the tests that put it under pressure, and run them —
 * and the shape of the middle three is deliberately one shape: skills plus a
 * task, dispatched to the developer's own coding agent, with every action it
 * takes shown as it happens.
 *
 * The last step is the only one that does not end when it is finished. It ends
 * when the developer has seen a verdict, which is the whole point of the ten
 * minutes before it; the suite carries on running on the platform, and closing
 * a terminal has never stopped one.
 */

import process from "node:process";
import path from "node:path";

import {
  installedCodingAgent,
  type DrivenAgentLaunch,
  type InstalledCodingAgent,
} from "../acp/coding-agents.ts";
import { withDrivenAgent, type DrivenAgent } from "../acp/driven-agent.ts";
import type { Registered, RegisterOptions } from "../platform/agents.ts";
import { signedInAt } from "../platform/signed-in.ts";
import type { ConnectOptions } from "../retell/connect.ts";
import { homeIn } from "../skills/install.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import { connectStep } from "./connect-step.ts";
import { agentPlatformIn, isSupportedAgentPlatform } from "./agent-platform.ts";
import { detect } from "./detection.ts";
import { findTheAgent } from "./discovery.ts";
import { openDrivenAgentLog, type DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import { generateStep } from "./generate-step.ts";
import { logInStep, type PlatformAccess, type WizardPlatform } from "./login-step.ts";
import { connectLiveKitStep } from "./livekit-connect-step.ts";
import { runStep } from "./run-step.ts";
import { ACTION_MARK } from "./status.ts";
import { stopReport, untilAborted } from "./stop.ts";
import {
  INITIAL_WIZARD_STATE,
  transitionWizard,
  type WizardEvent,
  type WizardState,
} from "./wizard-machine.ts";

type WizardFlowBaseOptions = {
  readonly ui: WizardUI;
  readonly cwd: string;
  readonly signal: AbortSignal;
  /** Where the agent's own output is kept. A fresh file per run by default. */
  readonly log?: DrivenAgentLog;
  /**
   * Which egma to sign in to, and where the key goes. Omit and the walk signs
   * in to nothing — which is how the checks that are only about driving a
   * coding agent stay about that.
   */
  readonly platform?: WizardPlatform;
  /** Where Retell is. Retell's own address when omitted. */
  readonly retell?: ConnectOptions["retell"];
  /** Platform transport override for connection setup checks. */
  readonly connectionFetchImpl?: RegisterOptions["fetchImpl"];
  /** How many tests a first suite holds. egma's own default when omitted. */
  readonly howManyTests?: number;
  /**
   * The developer's home, for the global scope of the skill offer.
   *
   * Passed in so that a check can point it somewhere throwaway rather than at
   * the home of whoever is running it. `EGMA_HOME` is deliberately not reused:
   * a developer who moved egma's key elsewhere did not thereby move their
   * coding agent's configuration.
   */
  readonly home?: string;
  /** How long between asks while following a run. egma's default when omitted. */
  readonly runPollMs?: number;
};

export type WizardCodingAgent =
  | { readonly kind: "selected"; readonly launch: DrivenAgentLaunch }
  | {
      readonly kind: "choose";
      readonly installed: readonly InstalledCodingAgent[];
    };

export type WizardFlowOptions = WizardFlowBaseOptions &
  (
    | {
        /** A fixed test/headless choice, kept as the narrow scripted-agent seam. */
        readonly launch: DrivenAgentLaunch;
        readonly codingAgent?: never;
      }
    | {
        /** The installed agents the real wizard offers. */
        readonly codingAgent: WizardCodingAgent;
        readonly launch?: never;
      }
  );

/**
 * Runs the wizard and returns the status it will leave behind.
 *
 * The one thing started here rather than inside the walk is the look around
 * this machine. It is started before the intro is dismissed and shown behind
 * the browser wait, which is the only dead time the walk has: nothing awaits
 * it, no step reads it back, and a look that fails costs nothing.
 *
 * What it does need is a way to stop mattering. A walk can end — quit,
 * interrupted, or simply finished — while the look is still going, and by then
 * the screen it was for is coming down and the exit line is being written under
 * it. So the answer is dropped rather than pushed at a UI that has nothing left
 * to draw on.
 */
export async function runWizard(options: WizardFlowOptions): Promise<ExitReport> {
  const { ui, cwd } = options;

  let walking = true;
  const startDetection = (launch: DrivenAgentLaunch): void => {
    void detect({ cwd, drivenAgentName: launch.name }).then(
      (detection) => {
        if (walking) ui.setDetection(detection);
      },
      () => undefined,
    );
  };

  try {
    return await runWizardFlow(options, startDetection);
  } finally {
    walking = false;
  }
}

async function runWizardFlow(
  options: WizardFlowOptions,
  startDetection: (launch: DrivenAgentLaunch) => void,
): Promise<ExitReport> {
  const { ui, cwd, signal } = options;
  let machine: WizardState = INITIAL_WIZARD_STATE;
  ui.setPhase(machine.phase);
  const advance = (event: WizardEvent): void => {
    const moved = transitionWizard(machine, event);
    if (!moved.ok) throw new Error(moved.error.message);
    machine = moved.state;
    ui.setPhase(machine.phase);
  };

  const codingAgent: WizardCodingAgent =
    "launch" in options
      ? { kind: "selected", launch: options.launch }
      : options.codingAgent;
  let launch: DrivenAgentLaunch;
  if (codingAgent.kind === "selected") {
    launch = codingAgent.launch;
  } else {
    const choices = codingAgent.installed.map(
      ({ id, name, version, executable }) => ({ id, name, version, executable }),
    );
    ui.setCodingAgentChoices(choices);
    if (choices.length === 0) {
      advance({ type: "coding-agent-unavailable" });
      const report: ExitReport = { kind: "no-coding-agent" };
      ui.setExit(report);
      return report;
    }

    const answer = await untilAborted(ui.waitForAnswer("coding-agent"), signal);
    if (signal.aborted) {
      const report = stopReport(signal, "coding agent");
      ui.setExit(report);
      return report;
    }
    const selected = installedCodingAgent(codingAgent.installed, answer ?? "");
    if (selected === null) {
      advance({ type: "coding-agent-unavailable" });
      const report: ExitReport = { kind: "no-coding-agent" };
      ui.setExit(report);
      return report;
    }
    launch = selected.launch;
  }

  advance({ type: "coding-agent-selected", id: launch.id });
  startDetection(launch);

  ui.setDrivenAgent({ id: launch.id, name: launch.name });

  const log = options.log ?? openDrivenAgentLog();
  ui.setDrivenAgentLog(log.file);

  // Which egma, said before the keystroke that agrees to all of it and before
  // egma has asked that address anything. A bare command now reaches egma's own
  // platform by default, so where a repository's identifiers are going is the
  // developer's to read first, not to find out afterwards.
  ui.setPlatform(
    options.platform === undefined
      ? null
      : { url: options.platform.url, bound: options.platform.bound },
  );

  await untilAborted(ui.waitForGate("begin"), signal);
  if (signal.aborted) {
    const report = stopReport(signal, launch.name);
    ui.setExit(report);
    return report;
  }
  advance({ type: "intro-accepted" });

  // Before anything is driven: who this is. Nothing else in the walk can name
  // an agent, a connection or a test until egma knows whose they are.
  //
  // Asking the address who it is happens here, on the far side of the gate, so
  // that a developer who reads the first screen and closes the wizard has sent
  // nothing anywhere. A refusal from it leaves the walk entirely: it is not the
  // walk failing, it is egma declining to talk to an address, and it is
  // answered in the same plain sentence and the same number every verb answers
  // with.
  let platform: PlatformAccess | undefined;
  if (options.platform !== undefined) {
    platform = await options.platform.verify();
    const refusal = await logInStep(platform, ui, signal);
    if (refusal !== null) {
      ui.setExit(refusal);
      return refusal;
    }
  }
  advance({ type: "login-finished" });

  return withDrivenAgent(
    {
      launch,
      cwd,
      ui,
      signal,
      logStderr: (chunk) => log.write(chunk),
      onLogin: (name) =>
        ui.pushStatus(
          `${ACTION_MARK} ${name} needs you to log in. Handing you to its own login.`,
        ),
    },
    (drivenAgent) => runWizardWithAgent(options, platform, log, drivenAgent, advance),
  );
}

/** The wizard work that shares one coding-agent process and ACP session. */
async function runWizardWithAgent(
  options: WizardFlowOptions,
  platform: PlatformAccess | undefined,
  log: DrivenAgentLog,
  drivenAgent: DrivenAgent,
  advance: (event: WizardEvent) => void,
): Promise<ExitReport> {
  const { ui, cwd, signal } = options;

  const found = await findTheAgent({ ui, drivenAgent, cwd, signal, log });

  // Knowing where the agent is defined is not the same as being able to reach
  // it, and everything after this needs both. The step runs only when there is
  // an egma to register on and an agent to register: a run that only drives a
  // coding agent has neither, and asking it for a provider key would be asking
  // for a secret nothing was going to use.
  if (found.report.kind !== "found-agent") {
    if (found.report.kind === "no-agent-context") advance({ type: "agent-not-found" });
    ui.setExit(found.report);
    return found.report;
  }
  if (platform === undefined) {
    ui.setExit(found.report);
    return found.report;
  }

  const agentPlatform = agentPlatformIn(found.facts);
  if (agentPlatform === null) {
    const report: ExitReport = {
      kind: "failed",
      reason:
        "Egma found a voice agent, but could not tell whether it uses Retell or LiveKit. " +
        "Make the agent platform clear in the repository and run Egma again, or configure it in the Egma UI.",
    };
    ui.setExit(report);
    return report;
  }
  if (!isSupportedAgentPlatform(agentPlatform)) {
    advance({ type: "agent-unsupported", platform: agentPlatform });
    const report: ExitReport = {
      kind: "unsupported-agent-platform",
      platform: agentPlatform,
    };
    ui.setExit(report);
    return report;
  }
  advance({ type: "agent-found", platform: agentPlatform });

  // The binding is written inside the connect step, at the last moment before
  // egma asks the platform to create anything — not here. Bound at this line, a
  // walk that ended at the key box, at an unanswered choice of agent, or at
  // "text or phone?" would leave an egma folder behind holding nothing but a
  // binding, in a repository the developer had decided not to connect.
  let connected: {
    readonly report: ExitReport;
    readonly connected: {
      readonly registered: Registered;
      readonly source: { readonly prompt: string | null; readonly toolCount: number | null };
    } | null;
  };
  if (agentPlatform === "retell") {
    const retell = await connectStep({
      ui,
      platform,
      cwd,
      // What the coding agent said about where the words live, carried forward
      // so the two prompts can be compared once Retell answers.
      repoPrompts: found.report.prompts,
      signal,
      retell: options.retell,
    });
    connected = {
      report: retell.report,
      connected:
        retell.connected === null
          ? null
          : {
              registered: retell.connected.registered,
              source: {
                prompt: retell.connected.config.prompt,
                toolCount: retell.connected.config.tools.length,
              },
            },
    };
  } else {
    connected = await connectLiveKitStep({
      ui,
      platform,
      cwd,
      signal,
      suggestedName: found.facts.get("agent-name") ?? path.basename(cwd),
      fetchImpl: options.connectionFetchImpl,
    });
  }

  // Nothing after this can name what a test is about, so a connect that did not
  // connect is where the walk stops.
  const signedIn = await signedInAt(platform);
  if (connected.connected === null || signedIn === null) {
    ui.setExit(connected.report);
    return connected.report;
  }
  advance({ type: "provider-ready" });

  const written = await generateStep({
    ui,
    drivenAgent,
    cwd,
    signal,
    log,
    signedIn,
    registered: connected.connected.registered,
    source: connected.connected.source,
    facts: found.facts,
    onReviewReady: (count) => advance({ type: "tests-ready", count }),
    onReviewApproved: (count) => advance({ type: "review-approved", count }),
    ...(options.howManyTests === undefined ? {} : { howMany: options.howManyTests }),
  });

  // Nothing on egma is nothing to run. Every other ending of the generate step
  // — the developer keeping the files, a coding agent that stopped, a push egma
  // refused — is an ending the developer can act on, and none of them is a run.
  if (written.report.kind !== "tests-pushed" || written.pushed.length === 0) {
    ui.setExit(written.report);
    return written.report;
  }

  const report = await runStep({
    ui,
    signedIn,
    agentId: connected.connected.registered.agent.id,
    connectionId: connected.connected.registered.connection.id,
    testVersionIds: written.pushed,
    suite: written.suite,
    drivenAgentId: drivenAgent.id,
    cwd,
    home: options.home ?? homeIn(process.env),
    signal,
    ...(options.runPollMs === undefined ? {} : { everyMs: options.runPollMs }),
  });
  if (report.kind === "run-started") advance({ type: "wizard-completed" });
  ui.setExit(report);
  return report;
}
