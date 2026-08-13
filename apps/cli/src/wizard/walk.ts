/**
 * The walk: what the wizard actually does, once, from start to exit line.
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

import type { DrivenAgentLaunch } from "../acp/registry.ts";
import { signedInAt } from "../platform/signed-in.ts";
import type { ConnectOptions } from "../retell/connect.ts";
import { homeIn } from "../skills/install.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import { alreadyConnected } from "./already-connected.ts";
import { connectStep } from "./connect-step.ts";
import { detect } from "./detection.ts";
import { findTheAgent } from "./discovery.ts";
import { openDrivenAgentLog, type DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import { generateStep } from "./generate-step.ts";
import { logInStep, type PlatformAccess } from "./login-step.ts";
import { runStep } from "./run-step.ts";
import { ACTION_MARK } from "./status.ts";
import { stopReport, untilAborted } from "./stop.ts";

export type WalkOptions = {
  readonly ui: WizardUI;
  readonly launch: DrivenAgentLaunch;
  readonly cwd: string;
  readonly signal: AbortSignal;
  /** Where the agent's own output is kept. A fresh file per run by default. */
  readonly log?: DrivenAgentLog;
  /**
   * Which egma to sign in to, and where the key goes. Omit and the walk signs
   * in to nothing — which is how the checks that are only about driving a
   * coding agent stay about that.
   */
  readonly platform?: PlatformAccess;
  /** Where Retell is. Retell's own address when omitted. */
  readonly retell?: ConnectOptions["retell"];
  /** How many tests a first suite holds. egma's own default when omitted. */
  readonly howManyTests?: number;
  /**
   * Stay on the run screen until every simulation has been judged.
   *
   * Off by default, and that default is the product's own decision: the wizard
   * ends when the developer has seen a verdict, because the suite carries on on
   * the platform whether a terminal is open or not. Turned on for the case that
   * decision does not serve — somebody watching all of it, on purpose.
   */
  readonly waitForSuite?: boolean;
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

/**
 * Runs the walk and returns the line the wizard will leave behind.
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
export async function walk(options: WalkOptions): Promise<ExitReport> {
  const { ui, cwd, launch } = options;

  let walking = true;
  void detect({ cwd, drivenAgentName: launch.name }).then(
    (detection) => {
      if (walking) ui.setDetection(detection);
    },
    () => undefined,
  );

  try {
    return await walkThrough(options);
  } finally {
    walking = false;
  }
}

async function walkThrough(options: WalkOptions): Promise<ExitReport> {
  const { ui, launch, cwd, signal } = options;

  ui.setDrivenAgent({ id: launch.id, name: launch.name });

  const log = options.log ?? openDrivenAgentLog();
  ui.setDrivenAgentLog(log.file);

  await untilAborted(ui.waitForGate("begin"), signal);
  if (signal.aborted) {
    const report = stopReport(signal, launch.name);
    ui.setExit(report);
    return report;
  }

  // Before anything is driven: who this is. Nothing else in the walk can name
  // an agent, a connection or a test until egma knows whose they are.
  if (options.platform !== undefined) {
    const refusal = await logInStep(options.platform, ui, signal);
    if (refusal !== null) {
      ui.setExit(refusal);
      return refusal;
    }
  }

  const found = await findTheAgent({ ui, launch, cwd, signal, log });

  // Knowing where the agent is defined is not the same as being able to reach
  // it, and everything after this needs both. The step runs only when there is
  // an egma to register on and an agent to register: a run that only drives a
  // coding agent has neither, and asking it for a provider key would be asking
  // for a secret nothing was going to use.
  if (found.report.kind !== "found-agent" || options.platform === undefined) {
    ui.setExit(found.report);
    return found.report;
  }

  // A repository that has been through connect once does not go through it
  // again. The folder names an agent and a way to reach it, the platform
  // confirms both for this key, and everything the step would ask for — the
  // provider key above all — is a question whose answer is already on disk.
  //
  // Checked against the platform rather than read off the file, because two
  // identifiers in a committed file are a claim: a clone of somebody else's
  // repository names an agent this key cannot see, and a walk that believed it
  // would run a suite against something the developer never chose.
  const held = await alreadyConnected(
    { url: options.platform.url, key: (await signedInAt(options.platform))?.key ?? "" },
    cwd,
  );
  if (held !== null) {
    ui.pushStatus(
      `${ACTION_MARK} ${held.registered.agent.name} is already connected, over ${held.registered.connection.name}.`,
    );
  }

  // The binding is written inside the connect step, at the last moment before
  // egma asks the platform to create anything — not here. Bound at this line, a
  // walk that ended at the key box, at an unanswered choice of agent, or at
  // "text or phone?" would leave an egma folder behind holding nothing but a
  // binding, in a repository the developer had decided not to connect.
  const connected = held !== null ? null : await connectStep({
    ui,
    platform: options.platform,
    cwd,
    // What the coding agent said about where the words live, carried forward
    // so the two prompts can be compared once the provider's is in hand.
    repoPrompts: found.report.prompts,
    signal,
    retell: options.retell,
  });

  // Nothing after this can name what a test is about, so a connect that did not
  // connect is where the walk stops.
  const signedIn = await signedInAt(options.platform);
  if (connected !== null && (connected.connected === null || signedIn === null)) {
    ui.setExit(connected.report);
    return connected.report;
  }
  if (signedIn === null) {
    const report: ExitReport = {
      kind: "failed",
      reason: "this machine is not signed in to egma. Run egma login, then try again.",
    };
    ui.setExit(report);
    return report;
  }

  const registered = held?.registered ?? connected?.connected?.registered;
  if (registered === undefined) {
    const report: ExitReport = { kind: "failed", reason: "there is no agent to test." };
    ui.setExit(report);
    return report;
  }

  // The provider's own words, when connect fetched them. A skipped connect has
  // none, and none is a shape this already has: an agent whose model the
  // customer runs themselves keeps its prompt out of the provider too, and the
  // generator works from the repository that discovery just read.
  const providerConfig = connected?.connected?.config ?? {
    agentId: "",
    name: registered.agent.name,
    modality: registered.connection.modality === "chat" ? ("chat" as const) : ("voice" as const),
    voice: null,
    engine: "retell-llm" as const,
    prompt: null,
    tools: [],
  };

  const written = await generateStep({
    ui,
    launch,
    cwd,
    signal,
    log,
    signedIn,
    registered,
    config: providerConfig,
    facts: found.facts,
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
    agentId: registered.agent.id,
    connectionId: registered.connection.id,
    testVersionIds: written.pushed,
    suite: written.suite,
    drivenAgentId: launch.id,
    cwd,
    home: options.home ?? homeIn(process.env),
    signal,
    ...(options.runPollMs === undefined ? {} : { everyMs: options.runPollMs }),
    ...(options.waitForSuite === undefined ? {} : { waitForSuite: options.waitForSuite }),
  });
  ui.setExit(report);
  return report;
}
