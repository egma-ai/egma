/**
 * The seam between what the wizard does and what the developer sees.
 *
 * Adapted from the PostHog wizard (MIT) — see ../../NOTICE.
 *
 * There is deliberately no method here that asks a question. Flow logic pushes
 * state and then parks on a gate; the screens own every keystroke. That is what
 * lets the same flow run under a terminal UI, under a plain log, and under a
 * test with nobody watching — and it is why a flow test can never accidentally
 * depend on how a screen is drawn.
 */

import type { ExitReport } from "../wizard/exit-line.ts";

/** A point the flow waits at until the developer has moved past it. */
export type GateId = "begin";

/** The agent egma is driving. */
export type DrivenAgent = { readonly id: string; readonly name: string };

export interface WizardUI {
  /** Name the agent egma will drive, as soon as it is known. */
  setAgent(agent: DrivenAgent | null): void;

  /** Name the file the one task is about. */
  setTaskFile(file: string): void;

  /**
   * Park until the developer has let the flow past this point. A gate that the
   * developer never opens never resolves — closing the wizard is how they say
   * no, and there is no answer for this method to return.
   */
  waitForGate(gate: GateId): Promise<void>;

  /** The agent has been started and the task is under way. */
  taskStarted(): void;

  /** The task is over, however it ended. */
  taskFinished(): void;

  /** One line describing something the driven agent did. */
  pushStatus(line: string): void;

  /** The agent's own account of what it found. */
  setSummary(text: string): void;

  /** What the wizard will leave behind when it closes. */
  setExit(report: ExitReport): void;

  readonly log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    success(message: string): void;
  };
}
