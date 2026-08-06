/**
 * Everything the screens draw from, in one plain object.
 *
 * Screens read this and nothing else, so a screen can be drawn for any state a
 * test can build, and the flow can move the wizard along without knowing that
 * screens exist.
 */

import type { LoginPrompt } from "../../platform/login.ts";
import type { RetellAgent } from "../../retell/client.ts";
import type { KeyAsk } from "../../retell/connect.ts";
import type { Detection } from "../../wizard/detection.ts";
import type { ExitReport } from "../../wizard/exit-line.ts";
import type { TestGate } from "../../wizard/gate.ts";
import type { GenerationProgress } from "../../wizard/test-generation.ts";
import type { AskId, DrivenAgent } from "../wizard-ui.ts";

export type WizardState = {
  readonly drivenAgent: DrivenAgent | null;
  /** Where the coding agent's own output is kept, for a screen that tails it. */
  readonly drivenAgentLog: string | null;
  /** What egma worked out about this machine for itself, or `null` before it has. */
  readonly detection: Detection | null;
  /** What has to be approved in a browser, while it still has to be. */
  readonly login: LoginPrompt | null;
  /** What the developer is typing back at the login screen, so far. */
  readonly loginTyping: string;
  /** True for the moment after the address is copied, so the screen can say so. */
  readonly loginCopied: boolean;
  /**
   * What the flow is waiting to be handed, while it still is.
   *
   * The value itself is never here. A key lives in the screen that collects it
   * for as long as it is being typed and goes straight to the flow, so nothing
   * a screen or a check can read back holds it.
   */
  readonly keyAsk: KeyAsk | null;
  /** The agents a choice is open between, or `null` when none is. */
  readonly agentChoices: readonly RetellAgent[] | null;
  /** The developer has read the intro and said go. */
  readonly begun: boolean;
  /** The developer has read the test list and said run them. */
  readonly agreedToRun: boolean;
  readonly running: boolean;
  readonly finished: boolean;
  /** The question the flow is parked on, or `null` when it is not parked. */
  readonly asking: AskId | null;
  /** How far the coding agent has got through writing test files. */
  readonly generation: GenerationProgress | null;
  /** The tests waiting on one keystroke, or `null` when none are. */
  readonly gate: TestGate | null;
  /** Which row of the gate's list the keys act on. */
  readonly gateAt: number;
  /** What the gate screen has to say about the last attempt to open an editor. */
  readonly editorProblem: string | null;
  readonly statuses: readonly string[];
  readonly summary: string;
  readonly exit: ExitReport | null;
};

export function emptyState(): WizardState {
  return {
    drivenAgent: null,
    drivenAgentLog: null,
    detection: null,
    login: null,
    loginTyping: "",
    loginCopied: false,
    keyAsk: null,
    agentChoices: null,
    begun: false,
    agreedToRun: false,
    running: false,
    finished: false,
    asking: null,
    generation: null,
    gate: null,
    gateAt: 0,
    editorProblem: null,
    statuses: [],
    summary: "",
    exit: null,
  };
}
