/**
 * Which screen is on, worked out from state rather than navigated to.
 *
 * Adapted from the PostHog wizard (MIT) — see ../../../NOTICE.
 *
 * A screen list is data: each entry may say when it applies and when it is
 * finished, and the router shows the first one that applies and is not
 * finished. Nothing in the flow navigates, so no screen can be reached in a
 * state it cannot render, and adding a screen is adding a list entry.
 *
 * On top of that sits a stack of interruptions — the thing that must be dealt
 * with now, drawn over whatever was underneath, with the flow resuming exactly
 * where it was when the stack empties.
 */

import type { WizardState } from "./state.ts";

export type ScreenId =
  | "intro"
  | "login"
  | "prompts-pointer"
  | "retell-key"
  | "retell-agent"
  | "existing-tests"
  | "generating"
  | "gate"
  | "task";

/** An interruption drawn over the flow. The stack is empty in the walk. */
export type OverlayId = never;

export type ScreenName = ScreenId | OverlayId;

export type Screen = {
  readonly id: ScreenId;
  /** Omit to always apply. */
  readonly show?: (state: WizardState) => boolean;
  /** Omit when the screen is never finished on its own. */
  readonly isComplete?: (state: WizardState) => boolean;
};

export type Sequence = readonly [Screen, ...Screen[]];

export class WizardRouter {
  private readonly overlays: OverlayId[] = [];
  private readonly sequence: Sequence;

  constructor(sequence: Sequence) {
    this.sequence = sequence;
  }

  /** The first screen that applies and is not finished. */
  resolve(state: WizardState): ScreenName {
    const top = this.overlays.at(-1);
    if (top !== undefined) return top;

    for (const entry of this.sequence) {
      if (entry.show && !entry.show(state)) continue;
      if (entry.isComplete && entry.isComplete(state)) continue;
      return entry.id;
    }
    return this.sequence[this.sequence.length - 1]!.id;
  }

  get hasOverlay(): boolean {
    return this.overlays.length > 0;
  }

  pushOverlay(overlay: OverlayId): void {
    this.overlays.push(overlay);
  }

  popOverlay(): void {
    this.overlays.pop();
  }
}
