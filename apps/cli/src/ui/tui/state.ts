/**
 * Everything the screens draw from, in one plain object.
 *
 * Screens read this and nothing else, so a screen can be drawn for any state a
 * test can build, and the flow can move the wizard along without knowing that
 * screens exist.
 */

import type { LoginPrompt } from "../../platform/login.ts";
import type { RetellAgent, RetellNumber } from "../../retell/client.ts";
import type { KeyAsk, Reach } from "../../retell/connect.ts";
import type { RunView } from "../../run/view.ts";
import type { SkillPlaces } from "../../skills/install.ts";
import type { Detection } from "../../wizard/detection.ts";
import type { ExitReport } from "../../wizard/exit-line.ts";
import type { TestGate } from "../../wizard/gate.ts";
import type { GenerationProgress } from "../../wizard/test-generation.ts";
import type { WizardPhase } from "../../wizard/wizard-machine.ts";
import type {
  AskId,
  CodingAgentChoice,
  ConnectionAsk,
  DrivenAgent,
  GoalAsk,
  PlatformNotice,
} from "../wizard-ui.ts";

export type WizardState = {
  readonly phase: WizardPhase;
  readonly drivenAgent: DrivenAgent | null;
  /** Supported coding agents found on this machine, before one is selected. */
  readonly codingAgentChoices: readonly CodingAgentChoice[];
  /** Where the coding agent's own output is kept, for a screen that tails it. */
  readonly drivenAgentLog: string | null;
  /**
   * Which egma this walk will use, or `null` when it will use none.
   *
   * Set before the intro is dismissed, so the screen that takes the keystroke
   * of consent is the screen that says where this repository's identifiers are
   * about to go — and, with it, the one thing that decides how a developer
   * reading that screen would use a different egma.
   */
  readonly platform: PlatformNotice | null;
  /** What egma worked out about this machine for itself, or `null` before it has. */
  readonly detection: Detection | null;
  /** What has to be approved in a browser, while it still has to be. */
  readonly login: LoginPrompt | null;
  /** What Egma is being asked to do for this agent, while the choice is open. */
  readonly goalAsk: GoalAsk | null;
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
  /** The provider-safe ways currently offered. */
  readonly reachOptions: readonly Reach[] | null;
  /** The numbers a choice is open between, or `null` when none is. */
  readonly numberChoices: readonly RetellNumber[] | null;
  /** The provider field being collected. Its answer never enters this state. */
  readonly connectionAsk: ConnectionAsk | null;
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
  /** The run, as it stands, or `null` when none is going. */
  readonly run: RunView | null;
  /** Where the skill would go, while the offer is open, or `null`. */
  readonly skillPlaces: SkillPlaces | null;
  readonly statuses: readonly string[];
  readonly summary: string;
  readonly exit: ExitReport | null;
};

export function emptyState(): WizardState {
  return {
    phase: "coding-agent",
    drivenAgent: null,
    codingAgentChoices: [],
    drivenAgentLog: null,
    platform: null,
    detection: null,
    login: null,
    goalAsk: null,
    loginTyping: "",
    loginCopied: false,
    keyAsk: null,
    agentChoices: null,
    reachOptions: null,
    numberChoices: null,
    connectionAsk: null,
    begun: false,
    agreedToRun: false,
    running: false,
    finished: false,
    asking: null,
    generation: null,
    gate: null,
    gateAt: 0,
    editorProblem: null,
    run: null,
    skillPlaces: null,
    statuses: [],
    summary: "",
    exit: null,
  };
}
