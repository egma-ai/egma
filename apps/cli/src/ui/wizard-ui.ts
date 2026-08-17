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

import type { LoginPrompt } from "../platform/login.ts";
import type { RetellAgent, RetellNumber } from "../retell/client.ts";
import type { KeyAsk, Reach } from "../retell/connect.ts";
import type { RunView } from "../run/view.ts";
import type { SkillPlaces } from "../skills/install.ts";
import type { Detection } from "../wizard/detection.ts";
import type { ExitReport } from "../wizard/exit-line.ts";
import type { TestGate } from "../wizard/gate.ts";
import type { GenerationProgress } from "../wizard/test-generation.ts";
import type { WizardPhase } from "../wizard/wizard-machine.ts";

/**
 * A point the flow waits at until the developer has moved past it.
 *
 * `run-tests` is the gate over generated tests, and it is a gate rather than a
 * question for the same reason `begin` is: what is being given is agreement,
 * and a developer who does not agree closes the wizard instead of answering.
 */
export type GateId = "begin" | "run-tests";

export type ConnectionAskId = `connection:${string}`;

export type ConnectionChoice = {
  readonly value: string;
  readonly label: string;
  readonly help?: string | undefined;
};

/** One supported coding agent proved to be installed on this machine. */
export type CodingAgentChoice = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly executable: string;
};

/** One provider field, described by Egma's platform and drawn by the CLI. */
export type ConnectionAsk = {
  readonly id: ConnectionAskId;
  readonly label: string;
  readonly help: string;
  readonly kind: "text" | "url" | "json" | "secret" | "choice";
  readonly required: boolean;
  readonly problem?: string | null | undefined;
  readonly defaultValue?: string | undefined;
  readonly choices?: readonly ConnectionChoice[] | undefined;
  /** Where a secret goes. Omitted for non-secret fields. */
  readonly custody?: string | undefined;
};

/**
 * A point the flow waits at for something only the developer knows.
 *
 * It is the same gate pattern, carrying a value: the flow parks, a screen
 * collects the answer, the gate opens. Nothing here draws and nothing here
 * reads a keystroke, so this is still not a prompt method — the screen owns
 * every key, and a developer who answers nothing answers `null`.
 */
export type AskId =
  | ConnectionAskId
  | "coding-agent"
  | "retell-key"
  | "retell-agent"
  /**
   * Text or phone: the one question whose answer decides what egma creates.
   *
   * A question and never a gate, and one egma never answers on the developer's
   * behalf. Only one of the two dials a real telephone, and egma choosing that
   * for somebody would be egma spending their money.
   */
  | "reach"
  /** Which of the agent's numbers to dial, when Retell routes it more than one. */
  | "phone-number"
  | "existing-tests"
  /**
   * Whether to install the Egma skill, and where.
   *
   * A question rather than a gate because there are three answers and skip is
   * one of them, and a question the developer never answers answers `null` —
   * which is skip. Nothing is written on a `null`, which is what makes "never
   * silent" true for a wizard that was closed as well as for one that was
   * answered.
   */
  | "skills-offer";

/** The coding agent egma is driving. */
export type DrivenAgent = { readonly id: string; readonly name: string };

/**
 * Which egma a walk will use, and how a developer would change it.
 *
 * The address alone is not enough for the screen that shows it. An unbound
 * repository changes egma by naming another one on the command; a bound one
 * cannot — a different `--url` is refused, with the whole move under it — and
 * changes egma by editing the file it already commits. Offering the wrong one
 * of those sends somebody to a command egma turns away, so the fact that
 * decides which is carried here rather than guessed at the screen.
 */
export type PlatformNotice = {
  readonly url: string;
  /** True when `egma/config.yaml` names it. */
  readonly bound: boolean;
};

export interface WizardUI {
  /** The one top-level phase, so unrelated screens cannot coexist. */
  setPhase(phase: WizardPhase): void;

  /** Name the coding agent egma will drive, as soon as it is known. */
  setDrivenAgent(drivenAgent: DrivenAgent | null): void;

  /** The supported coding agents found locally while the choice is open. */
  setCodingAgentChoices(agents: readonly CodingAgentChoice[]): void;

  /** Where the coding agent's own output is being kept for this run. */
  setDrivenAgentLog(file: string): void;

  /**
   * Which egma this walk will use, or `null` when it will use none.
   *
   * Written before the gate that takes the keystroke of consent, and before
   * that address has been asked anything, so whatever draws the first screen
   * can say where this repository's identifiers are about to go. A bare command
   * now reaches egma's own platform when nothing names another, which is
   * exactly why it has to be said rather than assumed.
   */
  setPlatform(chosen: PlatformNotice | null): void;

  /**
   * What egma worked out about this machine for itself, or `null` before it
   * has.
   *
   * Nothing in the flow reads this back and nothing waits on it. It is written
   * once, while the developer is reading, so that the screen they sit in front
   * of during the browser wait has something true on it rather than a spinner.
   */
  setDetection(detection: Detection | null): void;

  /**
   * What login is waiting to be approved, or `null` once it no longer is.
   *
   * This is a write and not a question. The flow says what has to be approved
   * and where; whether that is drawn in a box, printed as two plain lines, or
   * drawn nowhere at all is the UI's business.
   */
  setLogin(prompt: LoginPrompt | null): void;

  /**
   * What the developer has pasted at the login screen since the last look, or
   * `null`. Taken rather than read, so one paste is acted on once.
   *
   * This is still not a prompt: the flow never waits on it and never blocks
   * for it. Typing lands in the UI, the flow looks up between polls, and a UI
   * with nobody at the keyboard answers `null` forever.
   */
  takeLoginPaste(): string | null;

  /**
   * What egma needs handed to it before it can reach the developer's provider,
   * or `null` once it no longer needs it.
   *
   * A write and not a question, exactly as `setLogin` is. The flow says what
   * is wanted and what happens to it; whether that is drawn in a box with the
   * characters hidden or printed as two plain lines is the UI's business.
   */
  setKeyAsk(ask: KeyAsk | null): void;

  /**
   * The agents found on the provider's account, while a choice among them is
   * open, or `null` when there is no choice to make.
   *
   * Set only when there is more than one: one agent is not a choice, and a
   * screen that never appears is how a flow asks nothing.
   */
  setAgentChoices(agents: readonly RetellAgent[] | null): void;

  /**
   * The ways Retell supports for this agent while the choice is open.
   *
   * A write and not a question, exactly as the agent choices are: the flow says
   * the offer is open and the screen collects the word. `null` closes it. The
   * list comes from the selected Retell agent's channel, so the screen cannot
   * offer a connection Retell will refuse.
   */
  setReachOffer(reaches: readonly Reach[] | null): void;

  /**
   * The numbers Retell routes to the chosen agent, while a choice among them is
   * open, or `null` when there is no choice to make.
   *
   * Set only when there is more than one: one number is not a choice, and a
   * screen that never appears is how a flow asks nothing.
   */
  setNumberChoices(numbers: readonly RetellNumber[] | null): void;

  /** The current provider field, without the value the developer types. */
  setConnectionAsk(ask: ConnectionAsk | null): void;

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

  /**
   * How far the coding agent has got through writing test files, or `null`
   * when it is not writing any.
   *
   * A write and not a question. The flow says what has been written, what is
   * being written and what is still to come; whether that is drawn as a pane
   * that fills in or printed as one line per file is the UI's business.
   */
  setGeneration(progress: GenerationProgress | null): void;

  /**
   * The tests waiting on one keystroke, or `null` when none are.
   *
   * Setting it is what opens the `run-tests` gate's screen. Nothing here reads
   * a keystroke: the screen owns every key, including the one that opens a file
   * in an editor, which the flow never sees at all.
   */
  setGate(gate: TestGate | null): void;

  /**
   * The run, as it stands, or `null` when none is going.
   *
   * A write and not a question, like every other pane. The flow says which
   * simulations there are, where each has got to, and which verdict landed
   * first; whether that is drawn as a list that moves or printed as one line
   * per change is the UI's business. The wizard never waits for the whole
   * suite, so this is set for as long as the wizard is open and stops mattering
   * the moment it closes — the run itself carries on either way.
   */
  setRun(run: RunView | null): void;

  /** Where the skill would go, while the offer is open, or `null`. */
  setSkillPlaces(places: SkillPlaces | null): void;

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
