/**
 * The state the screens read, the gates the flow parks on.
 *
 * Adapted from the PostHog wizard (MIT) — see ../../../NOTICE.
 *
 * A gate is a promise that settles while a condition on the state holds. It is
 * how asynchronous flow logic waits for a decision a human makes on screen
 * without the flow ever asking a question: the flow parks, a keystroke changes
 * state, and the gate opens. A gate that never opens keeps the flow parked,
 * which is exactly right — closing the wizard is how a developer says no.
 *
 * A gate whose condition goes false again is shut again, with a promise nobody
 * has settled. That is what lets the same decision be asked for twice over two
 * different lists: agreement is to the list that was on the screen, so a list
 * that changes is a list nobody has agreed to yet.
 */

import { WizardRouter, type ScreenName, type Sequence } from "./router.ts";
import { emptyState, type WizardState } from "./state.ts";
import type { LoginPrompt } from "../../platform/login.ts";
import type { RetellAgent } from "../../retell/client.ts";
import type { KeyAsk } from "../../retell/connect.ts";
import type { RunView } from "../../run/view.ts";
import type { SkillPlaces } from "../../skills/install.ts";
import type { Detection } from "../../wizard/detection.ts";
import type { ExitReport } from "../../wizard/exit-line.ts";
import type { TestGate } from "../../wizard/gate.ts";
import type { GenerationProgress } from "../../wizard/test-generation.ts";
import type { AskId, DrivenAgent, GateId } from "../wizard-ui.ts";

/** The screens of the walk, in order. */
export const WALK_SCREENS: Sequence = [
  { id: "intro", isComplete: (state) => state.begun },
  // Login shows only while there is something to approve, and stops showing the
  // moment there is not — which is the router working the flow out from state
  // rather than the flow navigating anywhere.
  { id: "login", show: (state) => state.login !== null },
  // Only ever on while the flow is parked on that one question, and gone the
  // moment it is answered — which is the router working the way it should.
  { id: "prompts-pointer", show: (state) => state.asking === "prompts-pointer" },
  { id: "retell-key", show: (state) => state.asking === "retell-key" },
  // Never reached with one agent on the account, because the flow only opens
  // this question when there is a choice to make.
  { id: "retell-agent", show: (state) => state.asking === "retell-agent" },
  { id: "existing-tests", show: (state) => state.asking === "existing-tests" },
  // The last question the wizard asks, over the run screen it interrupts: the
  // run keeps moving underneath while the developer decides.
  { id: "skills-offer", show: (state) => state.asking === "skills-offer" },
  // The list, while it is waiting on the one keystroke it exists for.
  { id: "gate", show: (state) => state.gate !== null },
  // The files arriving, one at a time, while they arrive.
  { id: "generating", show: (state) => state.generation !== null },
  // The run, from the moment it is created until the wizard closes. It never
  // completes on this screen: the wizard leaves and the suite carries on.
  { id: "run", show: (state) => state.run !== null },
  { id: "task" },
];

/** The condition each gate waits for. */
const GATE_CONDITIONS: Readonly<Record<GateId, (state: WizardState) => boolean>> = {
  begin: (state) => state.begun,
  "run-tests": (state) => state.agreedToRun,
};

type Gate = {
  readonly condition: (state: WizardState) => boolean;
  promise: Promise<void>;
  open: () => void;
  opened: boolean;
};

/** A question the flow is parked on, and the promise waiting for its answer. */
type OpenQuestion = {
  readonly promise: Promise<string | null>;
  readonly settle: (answer: string | null) => void;
};

/** The most recent status lines kept in memory, oldest dropped first. */
const MAX_STATUS_LINES = 200;

/** Give a gate a promise nobody has settled, so it parks whoever waits on it. */
function shut(gate: Gate): void {
  gate.opened = false;
  gate.promise = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
}

export class WizardStore {
  private state: WizardState = emptyState();
  private readonly listeners = new Set<() => void>();
  private readonly gates = new Map<GateId, Gate>();
  private readonly answers = new Map<AskId, OpenQuestion>();
  /** What the login screen has handed over and the flow has not taken yet. */
  private pastedLogin: string | null = null;

  readonly router: WizardRouter;

  constructor(screens: Sequence = WALK_SCREENS) {
    this.router = new WizardRouter(screens);
    for (const [id, condition] of Object.entries(GATE_CONDITIONS)) {
      const gate: Gate = {
        condition,
        promise: Promise.resolve(),
        open: () => undefined,
        opened: false,
      };
      shut(gate);
      this.gates.set(id as GateId, gate);
    }
  }

  get snapshot(): WizardState {
    return this.state;
  }

  get activeScreen(): ScreenName {
    return this.router.resolve(this.state);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): WizardState => this.state;

  /** Park until this gate's condition is true. */
  getGate(gate: GateId): Promise<void> {
    return this.gates.get(gate)?.promise ?? Promise.resolve();
  }

  /**
   * Park on a question until a screen answers it.
   *
   * The same pattern as a gate, carrying a value. It is the flow that says a
   * question is open and the screen that closes it, so no screen can be reached
   * for a question nobody asked.
   */
  ask(ask: AskId): Promise<string | null> {
    const held = this.answers.get(ask);
    if (held !== undefined) return held.promise;

    let settle!: (answer: string | null) => void;
    const promise = new Promise<string | null>((resolve) => {
      settle = resolve;
    });
    this.answers.set(ask, { promise, settle });
    this.change({ asking: ask });
    return promise;
  }

  /** A screen's answer to the open question. `null` means "I have none". */
  answer(ask: AskId, value: string | null): void {
    const open = this.answers.get(ask);
    if (open === undefined) return;
    this.change({ asking: this.state.asking === ask ? null : this.state.asking });
    open.settle(value);
  }

  // ── The flow's writes ────────────────────────────────────────────────

  setDrivenAgent(drivenAgent: DrivenAgent | null): void {
    this.change({ drivenAgent });
  }

  setDrivenAgentLog(drivenAgentLog: string): void {
    this.change({ drivenAgentLog });
  }

  setDetection(detection: Detection | null): void {
    this.change({ detection });
  }

  setLogin(login: LoginPrompt | null): void {
    this.change(
      login === null
        ? { login, loginTyping: "", loginCopied: false }
        : { login },
    );
  }

  setKeyAsk(keyAsk: KeyAsk | null): void {
    this.change({ keyAsk });
  }

  setAgentChoices(agentChoices: readonly RetellAgent[] | null): void {
    this.change({ agentChoices });
  }

  setGeneration(generation: GenerationProgress | null): void {
    this.change({ generation });
  }

  /**
   * Put a list up, or take it down.
   *
   * A list going up is a question being asked, so the answer to the last one is
   * forgotten with it: the platform can turn a test away after the keystroke,
   * and the list that comes back is a different list. Agreement is to what was
   * on the screen, and nothing here can tell one list from another — so every
   * list is asked about, and the wizard cannot walk past a list nobody read.
   */
  setGate(gate: TestGate | null): void {
    this.change(
      gate === null ? { gate, editorProblem: null } : { gate, gateAt: 0, agreedToRun: false },
    );
  }

  setRun(run: RunView | null): void {
    this.change({ run });
  }

  setSkillPlaces(skillPlaces: SkillPlaces | null): void {
    this.change({ skillPlaces });
  }

  /** Hands over what was typed back, and forgets it, so it is acted on once. */
  takeLoginPaste(): string | null {
    const typed = this.pastedLogin;
    this.pastedLogin = null;
    return typed;
  }

  taskStarted(): void {
    this.change({ running: true });
  }

  taskFinished(): void {
    this.change({ running: false, finished: true });
  }

  pushStatus(line: string): void {
    const statuses = [...this.state.statuses, line];
    this.change({ statuses: statuses.slice(-MAX_STATUS_LINES) });
  }

  setSummary(summary: string): void {
    this.change({ summary });
  }

  setExit(exit: ExitReport): void {
    this.change({ exit });
  }

  // ── The screens' writes ──────────────────────────────────────────────

  /** The consent keystroke. Opens the `begin` gate. */
  begin(): void {
    if (this.state.begun) return;
    this.change({ begun: true });
  }

  /** The keystroke over the test list. Opens the `run-tests` gate. */
  runTests(): void {
    if (this.state.agreedToRun) return;
    this.change({ agreedToRun: true });
  }

  /**
   * Move the gate's selection, kept inside the list however far it is pushed.
   *
   * The list is the tests going up and the files being held back, in that
   * order: both are files, and the key that opens one opens the other.
   */
  moveGate(by: number): void {
    const gate = this.state.gate;
    const lines = (gate?.rows.length ?? 0) + (gate?.heldBack.length ?? 0);
    if (lines === 0) return;
    const at = Math.min(Math.max(this.state.gateAt + by, 0), lines - 1);
    this.change({ gateAt: at, editorProblem: null });
  }

  /** Why the last attempt to open an editor did not open one, or `null`. */
  setEditorProblem(editorProblem: string | null): void {
    this.change({ editorProblem });
  }

  /** What the developer is typing back at the login screen, as they type it. */
  typeLogin(loginTyping: string): void {
    this.change({ loginTyping });
  }

  /** Hand what was typed to the flow, and clear the line it was typed on. */
  submitLogin(): void {
    const typed = this.state.loginTyping.trim();
    if (typed === "") return;
    this.pastedLogin = typed;
    this.change({ loginTyping: "" });
  }

  /** The address has been put on the clipboard, and the screen may say so. */
  linkCopied(): void {
    this.change({ loginCopied: true });
  }

  private change(patch: Partial<WizardState>): void {
    this.state = { ...this.state, ...patch };
    for (const gate of this.gates.values()) {
      const holds = gate.condition(this.state);
      if (!gate.opened && holds) {
        gate.opened = true;
        gate.open();
        continue;
      }
      // The decision was taken back, which is what a second list on the same
      // screen is. Whoever waited on the old promise has long since walked on;
      // whoever asks from here is parked until the new list is agreed to.
      if (gate.opened && !holds) shut(gate);
    }
    for (const listener of this.listeners) listener();
  }
}
