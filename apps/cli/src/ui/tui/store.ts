/**
 * The state the screens read, the gates the flow parks on.
 *
 * Adapted from the PostHog wizard (MIT) — see ../../../NOTICE.
 *
 * A gate is a promise that settles the first time a condition on the state
 * becomes true. It is how asynchronous flow logic waits for a decision a human
 * makes on screen without the flow ever asking a question: the flow parks, a
 * keystroke changes state, and the gate opens. A gate that never opens keeps
 * the flow parked, which is exactly right — closing the wizard is how a
 * developer says no.
 */

import { WizardRouter, type ScreenName, type Sequence } from "./router.ts";
import { emptyState, type WizardState } from "./state.ts";
import type { LoginPrompt } from "../../platform/login.ts";
import type { ExitReport } from "../../wizard/exit-line.ts";
import type { DrivenAgent, GateId } from "../wizard-ui.ts";

/** The screens of the walk, in order. */
export const WALK_SCREENS: Sequence = [
  { id: "intro", isComplete: (state) => state.begun },
  // Login shows only while there is something to approve, and stops showing the
  // moment there is not — which is the router working the flow out from state
  // rather than the flow navigating anywhere.
  { id: "login", show: (state) => state.login !== null },
  { id: "task" },
];

/** The condition each gate waits for. */
const GATE_CONDITIONS: Readonly<Record<GateId, (state: WizardState) => boolean>> = {
  begin: (state) => state.begun,
};

type Gate = {
  readonly condition: (state: WizardState) => boolean;
  readonly promise: Promise<void>;
  readonly open: () => void;
  opened: boolean;
};

/** The most recent status lines kept in memory, oldest dropped first. */
const MAX_STATUS_LINES = 200;

export class WizardStore {
  private state: WizardState = emptyState();
  private readonly listeners = new Set<() => void>();
  private readonly gates = new Map<GateId, Gate>();
  /** What the login screen has handed over and the flow has not taken yet. */
  private pastedLogin: string | null = null;

  readonly router: WizardRouter;

  constructor(screens: Sequence = WALK_SCREENS) {
    this.router = new WizardRouter(screens);
    for (const [id, condition] of Object.entries(GATE_CONDITIONS)) {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      this.gates.set(id as GateId, { condition, promise, open, opened: false });
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

  // ── The flow's writes ────────────────────────────────────────────────

  setDrivenAgent(drivenAgent: DrivenAgent | null): void {
    this.change({ drivenAgent });
  }

  setDrivenAgentLog(drivenAgentLog: string): void {
    this.change({ drivenAgentLog });
  }

  setTaskFile(taskFile: string): void {
    this.change({ taskFile });
  }

  setLogin(login: LoginPrompt | null): void {
    this.change(
      login === null
        ? { login, loginTyping: "", loginCopied: false }
        : { login },
    );
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
      if (!gate.opened && gate.condition(this.state)) {
        gate.opened = true;
        gate.open();
      }
    }
    for (const listener of this.listeners) listener();
  }
}
