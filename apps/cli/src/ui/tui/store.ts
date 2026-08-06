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
import type { ExitReport } from "../../wizard/exit-line.ts";
import type { DrivenAgent, GateId } from "../wizard-ui.ts";

/** The screens of the walk, in order. */
export const WALK_SCREENS: Sequence = [
  { id: "intro", isComplete: (state) => state.begun },
  { id: "run" },
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

  setAgent(agent: DrivenAgent | null): void {
    this.change({ agent });
  }

  setTaskFile(taskFile: string): void {
    this.change({ taskFile });
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
