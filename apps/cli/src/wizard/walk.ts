/**
 * The walk: what the wizard actually does, once, from start to exit line.
 *
 * The flow never draws anything and never reads a keystroke: it pushes state at
 * the UI and parks on a gate. Two steps so far — sign this machine in, then find
 * the voice agent — and the shape of the second is deliberate, because every
 * intelligent step after it is the same shape: skills plus a task, dispatched to
 * the developer's own coding agent, with every action it takes shown as it
 * happens.
 */

import type { DrivenAgentLaunch } from "../acp/registry.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import { findTheAgent } from "./discovery.ts";
import { openDrivenAgentLog, type DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
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
};

/** Runs the walk and returns the line the wizard will leave behind. */
export async function walk(options: WalkOptions): Promise<ExitReport> {
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

  const report = await findTheAgent({ ui, launch, cwd, signal, log });
  ui.setExit(report);
  return report;
}
