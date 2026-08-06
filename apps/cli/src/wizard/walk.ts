/**
 * The walk: what the wizard actually does, once, from start to exit line.
 *
 * The flow never draws anything and never reads a keystroke: it pushes state at
 * the UI and parks on a gate. Four steps — sign this machine in, find the voice
 * agent, reach it, and write the tests that put it under pressure — and the
 * shape of the last three is deliberately one shape: skills plus a task,
 * dispatched to the developer's own coding agent, with every action it takes
 * shown as it happens.
 */

import type { DrivenAgentLaunch } from "../acp/registry.ts";
import { signedInAt } from "../platform/signed-in.ts";
import type { ConnectOptions } from "../retell/connect.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import { connectStep } from "./connect-step.ts";
import { detect } from "./detection.ts";
import { findTheAgent } from "./discovery.ts";
import { openDrivenAgentLog, type DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import { generateStep } from "./generate-step.ts";
import { logInStep, type PlatformAccess } from "./login-step.ts";
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

  const connected = await connectStep({
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
  if (connected.connected === null || signedIn === null) {
    ui.setExit(connected.report);
    return connected.report;
  }

  const report = await generateStep({
    ui,
    launch,
    cwd,
    signal,
    log,
    signedIn,
    registered: connected.connected.registered,
    config: connected.connected.config,
    facts: found.facts,
    ...(options.howManyTests === undefined ? {} : { howMany: options.howManyTests }),
  });
  ui.setExit(report);
  return report;
}
