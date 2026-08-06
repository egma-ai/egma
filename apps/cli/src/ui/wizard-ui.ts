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

/**
 * A point the flow waits at for something only the developer knows.
 *
 * It is the same gate pattern, carrying a value: the flow parks, a screen
 * collects the answer, the gate opens. Nothing here draws and nothing here
 * reads a keystroke, so this is still not a prompt method — the screen owns
 * every key, and a developer who answers nothing answers `null`.
 */
export type AskId = "prompts-pointer";

/** The coding agent egma is driving. */
export type DrivenAgent = { readonly id: string; readonly name: string };

export interface WizardUI {
  /** Name the coding agent egma will drive, as soon as it is known. */
  setDrivenAgent(drivenAgent: DrivenAgent | null): void;

  /** Where the coding agent's own output is being kept for this run. */
  setDrivenAgentLog(file: string): void;

  /**
   * Park until the developer has let the flow past this point. A gate that the
   * developer never opens never resolves — closing the wizard is how they say
   * no, and there is no answer for this method to return.
   */
  waitForGate(gate: GateId): Promise<void>;

  /**
   * Park until the developer has answered, or said they have no answer. `null`
   * is a real answer and the flow must handle it.
   */
  waitForAnswer(ask: AskId): Promise<string | null>;

  /** The coding agent has been started and the task is under way. */
  taskStarted(): void;

  /** The task is over, however it ended. */
  taskFinished(): void;

  /** One line describing something the driven agent did. */
  pushStatus(line: string): void;

  /** The coding agent's own account of what it found. */
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
