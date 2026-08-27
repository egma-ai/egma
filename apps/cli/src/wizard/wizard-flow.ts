/**
 * The wizard flow, from the first consent screen to the final status.
 *
 * The flow never draws anything and never reads a keystroke: it pushes state at
 * the UI and parks on a gate. Sign this machine in, find the voice agent, ask
 * what Egma is here to do, reach the agent, write the tests that put it under
 * pressure, write the mocked world those tests run in, and run them — and the
 * shape of every intelligent step is deliberately one shape: skills plus a
 * task, dispatched to the developer's own coding agent, with every action it
 * takes shown as it happens.
 *
 * The goal decides what the walk does. Testing is the lane above. Monitoring
 * runs the monitoring step and ends there — no connection, no suite, no tests.
 * Both runs monitoring first, says so, and carries one pasted key and one agent
 * name into the testing lane, so a sitting that does both asks every shared
 * question once and leaves one agent row behind rather than two.
 *
 * A repository may run the wizard again. Each completed walk records another
 * target without replacing the targets already committed, and creates another
 * direct suite beside the suites already there.
 *
 * The last step keeps the terminal and any local LiveKit worker open until all
 * simulations and requested grades are terminal. Closing the terminal still
 * does not cancel hosted work.
 */

import process from "node:process";
import path from "node:path";

import {
  installedCodingAgent,
  SUPPORTED_CODING_AGENT_IDS,
  type DrivenAgentLaunch,
  type InstalledCodingAgent,
} from "../acp/coding-agents.ts";
import { withDrivenAgent, type DrivenAgent } from "../acp/driven-agent.ts";
import { folderPathsIn, readConfig } from "../folder/egma-folder.ts";
import {
  startLocalLiveKitWorker,
  type LocalLiveKitWorker,
  type StartLocalLiveKitWorker,
} from "../livekit/local-worker.ts";
import {
  MonitoringTargetRecordError,
  recordMonitoringTarget,
  type MonitoringTargetRecordStage,
} from "../monitoring/record-target.ts";
import type { Registered, RegisterOptions } from "../platform/agents.ts";
import { signedInAt } from "../platform/signed-in.ts";
import type { ConnectOptions } from "../retell/connect.ts";
import { homeIn } from "../skills/install.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import { connectionSetupStep } from "./connection-setup-step.ts";
import {
  monitoringSetupStep,
  type MonitoringSetup,
} from "./monitoring-setup-step.ts";
import {
  agentPlatformIn,
  agentPlatformLabel,
  isSupportedAgentPlatform,
} from "./agent-platform.ts";
import { detect } from "./detection.ts";
import { findTheAgent } from "./discovery.ts";
import { openDrivenAgentLog, type DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import { generateStep } from "./generate-step.ts";
import { logInStep, type PlatformAccess, type WizardPlatform } from "./login-step.ts";
import {
  liveKitConnectionSetupStep,
  type LiveKitConnected,
} from "./livekit-connection-setup-step.ts";
import { mockAuthoringStep } from "./mock-authoring-step.ts";
import { runStep } from "./run-step.ts";
import { ACTION_MARK } from "./status.ts";
import { stopReport, untilAborted } from "./stop.ts";
import {
  workerIntegrationStep,
  type WorkerIntegration,
} from "./worker-integration-step.ts";
import { verifyWorkerIntegration } from "./worker-integration-verifier.ts";
import {
  INITIAL_WIZARD_STATE,
  transitionWizard,
  WIZARD_GOALS,
  type WizardEvent,
  type WizardGoal,
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
  /**
   * How long the monitoring lane waits for the first imported conversation,
   * and how often it asks. Egma's own pace when omitted.
   */
  readonly monitoringWaitMs?: number;
  readonly monitoringPollMs?: number;
  /** Test seam for the foreground LiveKit worker owned by a testing walk. */
  readonly startLiveKitWorker?: StartLocalLiveKitWorker;
};

export type WizardCodingAgent =
  | { readonly kind: "selected"; readonly launch: DrivenAgentLaunch }
  | {
      /** Resolve installed coding agents only after this CLI is authorized. */
      readonly kind: "discover";
      readonly discover: () => Promise<readonly InstalledCodingAgent[]>;
      /** A named choice, or `null` when the wizard should apply its normal policy. */
      readonly requestedId: string | null;
      readonly selection: "interactive" | "headless";
    };

export type WizardFlowOptions = WizardFlowBaseOptions &
  (
    | {
        /** A fixed test/headless choice, kept as the narrow scripted-agent seam. */
        readonly launch: DrivenAgentLaunch;
        readonly codingAgent?: never;
      }
    | {
        /** How the real wizard resolves the coding agent after authorization. */
        readonly codingAgent: WizardCodingAgent;
        readonly launch?: never;
      }
  );

function installedAgentLines(installed: readonly InstalledCodingAgent[]): string[] {
  return installed.map(
    (agent) => `  ${agent.id}  ${agent.name} ${agent.version}  ${agent.executable}`,
  );
}

function noSelectedCodingAgent(
  requested: string | null,
  installed: readonly InstalledCodingAgent[],
): string {
  const first =
    requested === null
      ? "Egma needs --coding-agent when more than one supported coding agent is installed."
      : `Egma could not find an installed supported coding agent called "${requested}".`;
  return [
    first,
    "",
    ...(installed.length === 0
      ? ["No supported coding agents were found."]
      : ["Installed coding agents:", ...installedAgentLines(installed)]),
    "",
    `Supported ids: ${SUPPORTED_CODING_AGENT_IDS.join(", ")}.`,
  ].join("\n");
}

type CodingAgentResolution =
  | { readonly kind: "selected"; readonly launch: DrivenAgentLaunch }
  | { readonly kind: "ended"; readonly report: ExitReport };

async function resolveCodingAgent(
  source: WizardCodingAgent,
  ui: WizardUI,
  signal: AbortSignal,
  enterCodingAgentPhase: () => void,
): Promise<CodingAgentResolution> {
  if (source.kind === "selected") {
    enterCodingAgentPhase();
    return source;
  }

  const installed = await source.discover();
  if (signal.aborted) {
    return { kind: "ended", report: stopReport(signal, "coding agent") };
  }

  if (source.requestedId !== null) {
    enterCodingAgentPhase();
    const selected = installedCodingAgent(installed, source.requestedId);
    if (selected !== null) return { kind: "selected", launch: selected.launch };

    // Headless output keeps the exact requested id and installed inventory
    // before the ordinary paste fallback. The terminal UI leaves only its
    // ordinary no-coding-agent notice after the alternate screen comes down.
    ui.pushStatus(noSelectedCodingAgent(source.requestedId, installed));
    return { kind: "ended", report: { kind: "no-coding-agent" } };
  }

  if (installed.length === 0) {
    enterCodingAgentPhase();
    return { kind: "ended", report: { kind: "no-coding-agent" } };
  }

  if (source.selection === "headless") {
    enterCodingAgentPhase();
    if (installed.length > 1) {
      return {
        kind: "ended",
        report: { kind: "failed", reason: noSelectedCodingAgent(null, installed) },
      };
    }
    return { kind: "selected", launch: installed[0]!.launch };
  }

  const choices = installed.map(
    ({ id, name, version, executable }) => ({ id, name, version, executable }),
  );
  // Open the answer channel before the choices can draw. A fast Arrow, Arrow,
  // Enter sequence may arrive in the same frame that first shows the picker;
  // if the question opens afterwards, that valid answer is lost.
  const answerPromise = ui.waitForAnswer("coding-agent");
  ui.setCodingAgentChoices(choices);
  // Put the ready picker on screen in one render. Rendering an empty picker
  // first leaves a small input-listener handoff while the visible list redraws,
  // and a fast Arrow, Arrow, Enter sequence can land inside that handoff.
  enterCodingAgentPhase();
  const answer = await untilAborted(answerPromise, signal);
  if (signal.aborted) {
    return { kind: "ended", report: stopReport(signal, "coding agent") };
  }
  const selected = installedCodingAgent(installed, answer ?? "");
  return selected === null
    ? { kind: "ended", report: { kind: "no-coding-agent" } }
    : { kind: "selected", launch: selected.launch };
}

/**
 * Runs the wizard and returns the status it will leave behind.
 *
 * The one thing started here rather than inside the walk is the look around
 * this repository. It is started after the welcome gate and shown behind the
 * browser wait. It deliberately does not look for a coding agent: this CLI is
 * authorized before Claude Code, Codex, Cursor, or OpenCode is probed.
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
  const startDetection = (): void => {
    void detect({ cwd, drivenAgentName: null }).then(
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
  startDetection: () => void,
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

  // Which egma, said before the first keystroke and before egma has asked that
  // address anything. A bare command reaches egma's own platform by default, so
  // where this CLI will be authorized is the developer's to read first.
  ui.setPlatform(
    options.platform === undefined ? null : { url: options.platform.url },
  );

  await untilAborted(ui.waitForGate("welcome"), signal);
  if (signal.aborted) {
    const report = stopReport(signal, null);
    ui.setExit(report);
    return report;
  }
  advance({ type: "welcome-accepted" });
  startDetection();

  // CLI authorization is first. No supported coding-agent executable is probed,
  // selected, or started until this step has completed.
  let platform: PlatformAccess | undefined;
  if (options.platform !== undefined) {
    platform = options.platform;
    const refusal = await logInStep(platform, ui, signal);
    if (refusal !== null) {
      ui.setExit(refusal);
      return refusal;
    }
  }
  const codingAgent: WizardCodingAgent =
    "launch" in options
      ? { kind: "selected", launch: options.launch }
      : options.codingAgent;
  const resolved = await resolveCodingAgent(codingAgent, ui, signal, () => {
    advance({ type: "login-finished" });
  });
  if (resolved.kind === "ended") {
    if (resolved.report.kind === "no-coding-agent") {
      advance({ type: "coding-agent-unavailable" });
    }
    ui.setExit(resolved.report);
    return resolved.report;
  }
  const launch = resolved.launch;
  advance({ type: "coding-agent-selected", id: launch.id });
  ui.setDrivenAgent({ id: launch.id, name: launch.name });

  const log = options.log ?? openDrivenAgentLog();
  ui.setDrivenAgentLog(log.file);

  await untilAborted(ui.waitForGate("begin"), signal);
  if (signal.aborted) {
    const report = stopReport(signal, launch.name);
    ui.setExit(report);
    return report;
  }
  advance({ type: "intro-accepted" });

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

/**
 * The one question about what Egma is here to do, asked once.
 *
 * `null` — a closed wizard, a run with nobody watching — is testing, which is
 * the lane every `npx egma` has taken until now. A word nobody offered is
 * testing too: this is a choice among three, not a place to smuggle a fourth.
 */
function goalFrom(said: string | null): WizardGoal {
  return (WIZARD_GOALS as readonly string[]).includes(said ?? "")
    ? (said as WizardGoal)
    : "testing";
}

/** Keep the successful monitoring target in the committed format-2 catalog. */
type MonitoringRecordFailure = {
  readonly stage: MonitoringTargetRecordStage | "credentials" | "unknown";
  readonly detail: string;
};

async function recordMonitoredTarget(
  options: Pick<WizardFlowOptions, "cwd" | "connectionFetchImpl">,
  platform: PlatformAccess,
  monitored: NonNullable<MonitoringSetup["monitored"]>,
): Promise<MonitoringRecordFailure | null> {
  try {
    const signedIn = await signedInAt(platform);
    if (signedIn === null) {
      return {
        stage: "credentials",
        detail: `this machine no longer holds a key for ${platform.url}`,
      };
    }

    await recordMonitoringTarget({
      cwd: options.cwd,
      signedIn,
      target: {
        id: monitored.agentId,
        name: monitored.agentName,
        projectId: monitored.projectId,
      },
      fetchImpl: options.connectionFetchImpl,
    });
    return null;
  } catch (cause) {
    return cause instanceof MonitoringTargetRecordError
      ? { stage: cause.stage, detail: cause.message }
      : {
          stage: "unknown",
          detail: cause instanceof Error ? cause.message : String(cause),
        };
  }
}

/** Preserve the completed remote setup as actionable lines on a failed walk. */
function monitoringRecordFailure(
  setUp: MonitoringSetup,
  monitored: NonNullable<MonitoringSetup["monitored"]>,
  failure: MonitoringRecordFailure,
  platformUrl: string,
): ExitReport {
  const receipt = [
    `url: ${platformUrl}`,
    `agent_id: ${monitored.agentId}`,
    `agent_name: ${monitored.agentName}`,
    `project_id: ${monitored.projectId}`,
    ...(monitored.platformAgentId === null
      ? []
      : [
          `platform_agent_id: ${monitored.platformAgentId}`,
          "pull_production_calls: on",
        ]),
    ...(setUp.report.kind === "monitoring-wired" ? setUp.report.lines : []),
    ...(monitored.monitoringKeyId === null
      ? []
      : [`monitoring_key_id: ${monitored.monitoringKeyId}`]),
    "status: repository-record-failed",
  ];
  const recoveryProof =
    monitored.monitoringKeyId === null
      ? ""
      : ` --monitoring-key-id ${monitored.monitoringKeyId}`;
  return {
    kind: "monitoring-record-failed",
    receipt,
    reason:
      `remote monitoring is ready for agent ${monitored.agentId}, but ${failure.detail} The remote setup remains active. ` +
      `Keep the receipt above. After the repository or Egma connection is fixed, run egma monitoring record --agent ${monitored.agentId}${recoveryProof} --url ${platformUrl}. ` +
      "That recovery command does not create an agent or mint a key.",
  };
}

type ConfiguredMonitoringAgent =
  | { readonly kind: "found"; readonly id: string }
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Resolve monitoring identity without treating a model-written display name
 * as a stable key. One committed agent is unambiguous; several require an
 * explicit stable id outside this promptless wizard.
 */
async function configuredMonitoringAgent(
  cwd: string,
  platformUrl: string,
): Promise<ConfiguredMonitoringAgent> {
  let config: Awaited<ReturnType<typeof readConfig>>;
  try {
    config = await readConfig(folderPathsIn(cwd).config);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return {
      kind: "failed",
      reason:
        `Egma could not read egma/config.yaml before monitoring setup: ${cause instanceof Error ? cause.message : String(cause)} ` +
        "Egma did not create an agent or mint a key.",
    };
  }

  if (config.platform !== null && config.platform.origin !== platformUrl) {
    return {
      kind: "failed",
      reason:
        `This repository records the Egma platform at ${config.platform.origin}, but this run selected ${platformUrl}. ` +
        "Egma did not create an agent or mint a key.",
    };
  }

  if (config.agents.length === 1) {
    return { kind: "found", id: config.agents[0]!.id };
  }
  if (config.agents.length > 1) {
    return {
      kind: "failed",
      reason:
        `egma/config.yaml names ${String(config.agents.length)} agents, so the wizard cannot safely choose one from a coding agent's display name. ` +
        "Use a stable agent id with egma monitoring enable --agent <id>. Egma did not create an agent or mint a key.",
    };
  }
  return { kind: "none" };
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

  // The one question the wizard asks about itself, and it is asked here because
  // here is where it can be asked concretely: Egma has the repository's agent
  // and knows which platform runs it, so each answer speaks about that agent
  // rather than about voice agents in general.
  ui.setGoalAsk({
    platform: agentPlatform,
    platformLabel: agentPlatformLabel(agentPlatform),
    agentName: found.facts.get("agent-name") ?? null,
    goals: WIZARD_GOALS,
  });
  const said = await untilAborted(ui.waitForAnswer("goal"), signal);
  ui.setGoalAsk(null);
  if (signal.aborted) {
    const report = stopReport(signal, drivenAgent.name);
    ui.setExit(report);
    return report;
  }
  const goal = goalFrom(said ?? null);
  advance({ type: "goal-chosen", goal });

  // One task owns the customer's worker and dependency manifest for the whole
  // sitting. It receives the final mode once, before remote monitoring setup,
  // test generation, or mock authoring can begin.
  let workerIntegration: WorkerIntegration | null = null;
  if (agentPlatform === "livekit") {
    workerIntegration = await workerIntegrationStep({
      ui,
      drivenAgent,
      signal,
      log,
      cwd,
      facts: found.facts,
      mode: goal,
    });
    if (workerIntegration.halted !== null) {
      ui.setExit(workerIntegration.halted);
      return workerIntegration.halted;
    }
    if (!workerIntegration.supportsSdk || workerIntegration.contract === null) {
      const report: ExitReport = {
        kind: "failed",
        reason:
          `${workerIntegration.unverifiedReason ?? "Egma could not verify this LiveKit worker's Python integration."} ` +
          "Egma did not create remote resources or start a local worker.",
      };
      ui.setExit(report);
      return report;
    }
  }

  /*
   * Monitoring first, for both goals that want it.
   *
   * The order is a promise rather than a preference: Retell's historical import
   * and a LiveKit worker's own export both take time on the server side, so
   * starting them before the tests are written is what makes a sitting that
   * does both end with Monitoring already filling. What the step leaves behind
   * is what stops the second half being a second sitting — one pasted key, one
   * chosen platform agent, and one agent name.
   */
  let monitored: MonitoringSetup["monitored"] = null;
  if (goal !== "testing") {
    const configured =
      agentPlatform === "livekit"
        ? await configuredMonitoringAgent(cwd, platform.url)
        : ({ kind: "none" } as const);
    if (configured.kind === "failed") {
      const report: ExitReport = { kind: "failed", reason: configured.reason };
      ui.setExit(report);
      return report;
    }
    const setUp = await monitoringSetupStep({
      ui,
      platform,
      cwd,
      signal,
      agentPlatform,
      goal,
      facts: found.facts,
      integratedAgentName: workerIntegration?.agentName ?? null,
      configuredAgentId: configured.kind === "found" ? configured.id : null,
      workerWired: workerIntegration?.entry !== null,
      ...(options.connectionFetchImpl === undefined
        ? {}
        : { fetchImpl: options.connectionFetchImpl }),
      ...(options.monitoringWaitMs === undefined
        ? {}
        : { waitMs: options.monitoringWaitMs }),
      ...(options.monitoringPollMs === undefined
        ? {}
        : { pollMs: options.monitoringPollMs }),
    });
    if (setUp.monitored === null) {
      ui.setExit(setUp.report);
      return setUp.report;
    }
    monitored = setUp.monitored;
    const localRecordFailure = await recordMonitoredTarget(options, platform, monitored);
    if (localRecordFailure !== null) {
      const report = monitoringRecordFailure(
        setUp,
        monitored,
        localRecordFailure,
        platform.url,
      );
      ui.setExit(report);
      return report;
    }
    advance({ type: "monitoring-ready" });

    // Monitoring alone creates no connection, no suite and no tests, so the
    // walk is over — the machine has already reached its terminal on the event
    // above, and the line says what is now happening.
    if (goal === "monitoring") {
      ui.setExit(setUp.report);
      return setUp.report;
    }
  }

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
      readonly localWorker: NonNullable<LiveKitConnected["connected"]>["localWorker"];
    } | null;
  };
  if (agentPlatform === "retell") {
    const retell = await connectionSetupStep({
      ui,
      platform,
      cwd,
      // What the coding agent said about where the words live, carried forward
      // so the two prompts can be compared once Retell answers.
      repoPrompts: found.report.prompts,
      signal,
      // One paste, one picker, one name: whatever monitoring already settled is
      // handed over rather than asked for a second time.
      settled: monitored,
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
              localWorker: null,
            },
    };
  } else {
    connected = await liveKitConnectionSetupStep({
      ui,
      platform,
      cwd,
      signal,
      suggestedName:
        workerIntegration?.agentName ??
        found.facts.get("agent-name") ??
        path.basename(cwd),
      dispatchName: found.facts.get("dispatch-name") ?? "",
      entrypoint: found.facts.get("entrypoint") ?? "",
      // The row monitoring created, when it ran: one agent row for one voice
      // agent, so this connection attaches to it rather than starting a second.
      existingAgent:
        monitored === null
          ? null
          : {
              id: monitored.agentId,
              name: monitored.agentName,
              projectId: monitored.projectId,
            },
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
  advance({ type: "connection-ready" });

  const registered = connected.connected.registered;
  const written = await generateStep({
    ui,
    drivenAgent,
    cwd,
    signal,
    log,
    signedIn,
    registered,
    source: connected.connected.source,
    facts: found.facts,
    // The tests exist, and the mocked world they run in is written next. On
    // Retell there is nothing to write — mock tools are not served there yet —
    // so the lane passes straight to the gate with no screen in between.
    betweenWritingAndReview: async ({ tests, suiteDirectory }) => {
      advance({ type: "tests-ready", count: tests.length });
      if (agentPlatform !== "livekit") return { halted: null };
      const authored = await mockAuthoringStep({
        ui,
        drivenAgent,
        signal,
        log,
        paths: folderPathsIn(cwd),
        context: {
          cwd,
          suiteDirectory,
          facts: found.facts,
          agentName: registered.agent.name,
          tests,
        },
      });
      if (authored.halted !== null) return { halted: authored.halted };
      if (workerIntegration === null || workerIntegration.contract === null) {
        return {
          halted: {
            kind: "failed",
            reason:
              "Egma has no verified LiveKit worker integration, so it did not open review or push tests.",
          },
        };
      }
      const afterAuthoring = await verifyWorkerIntegration(
        cwd,
        workerIntegration.contract,
      );
      if (afterAuthoring.kind === "unverified") {
        return {
          halted: {
            kind: "failed",
            reason:
              `${afterAuthoring.reason} ` +
              "Egma did not open review, push tests, start the local worker, or create a run.",
          },
        };
      }
      advance({ type: "mocks-ready" });
      return {
        halted: null,
        changed:
          workerIntegration === null || workerIntegration.contract === null
            ? []
            : [
                ...new Set([
                  workerIntegration.contract.workerFile,
                  workerIntegration.contract.dependencyFile,
                ]),
              ],
      };
    },
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

  // Read the worker again after every coding-agent task and before starting a
  // local process or creating a run. A later task cannot silently undo the one
  // integration owner's work.
  if (agentPlatform === "livekit" && workerIntegration !== null) {
    const finalVerification =
      workerIntegration.contract === null
        ? {
            kind: "unverified" as const,
            reason:
              workerIntegration.unverifiedReason ??
              "Egma has no verified LiveKit worker integration for this run.",
          }
        : await verifyWorkerIntegration(cwd, workerIntegration.contract);
    if (finalVerification.kind === "unverified") {
      const report: ExitReport = {
        kind: "failed",
        reason:
          `${finalVerification.reason} ` +
          "Egma did not start the local worker or create a run.",
      };
      ui.setExit(report);
      return report;
    }
  }

  let localWorker: LocalLiveKitWorker | null = null;
  if (connected.connected.localWorker !== null) {
    const dependencyManifest = workerIntegration?.contract?.dependencyFile;
    if (dependencyManifest === undefined) {
      const report: ExitReport = {
        kind: "failed",
        reason:
          "Egma has no verified Python dependency manifest for this LiveKit worker, so it did not start the worker or create a run.",
      };
      ui.setExit(report);
      return report;
    }
    ui.pushStatus(
      `${ACTION_MARK} Starting local LiveKit worker ${connected.connected.localWorker.dispatchName}.`,
    );
    const started = await (options.startLiveKitWorker ?? startLocalLiveKitWorker)({
      cwd,
      ...connected.connected.localWorker,
      dependencyManifest,
      signal,
      onOutput: (chunk) => log.write(chunk),
    });
    if (started.kind === "failed") {
      const report: ExitReport = { kind: "failed", reason: started.reason };
      ui.setExit(report);
      return report;
    }
    localWorker = started.worker;
    ui.pushStatus(`${ACTION_MARK} Local LiveKit worker is registered and ready.`);
  }

  let report: ExitReport;
  try {
    report = await runStep({
      ui,
      signedIn,
      // The last screen names both promises when the sitting kept both.
      ...(monitored === null ? {} : { monitoringUrl: platform.url }),
      agentId: connected.connected.registered.agent.id,
      connectionId: connected.connected.registered.connection.id,
      suiteId: written.suite.id,
      expectedTestVersions: written.pushed,
      drivenAgentId: drivenAgent.id,
      cwd,
      home: options.home ?? homeIn(process.env),
      signal,
      ...(localWorker === null ? {} : { localWorker }),
      ...(options.runPollMs === undefined ? {} : { everyMs: options.runPollMs }),
    });
  } finally {
    await localWorker?.stop();
  }
  if (report.kind === "run-started") advance({ type: "wizard-completed" });
  ui.setExit(report);
  return report;
}
