/**
 * Everything the screens draw from, in one plain object.
 *
 * Screens read this and nothing else, so a screen can be drawn for any state a
 * test can build, and the flow can move the wizard along without knowing that
 * screens exist.
 */

import type { ExitReport } from "../../wizard/exit-line.ts";
import type { DrivenAgent } from "../wizard-ui.ts";

export type WizardState = {
  readonly agent: DrivenAgent | null;
  readonly taskFile: string | null;
  /** The developer has read the intro and said go. */
  readonly begun: boolean;
  readonly running: boolean;
  readonly finished: boolean;
  readonly statuses: readonly string[];
  readonly summary: string;
  readonly exit: ExitReport | null;
};

export function emptyState(): WizardState {
  return {
    agent: null,
    taskFile: null,
    begun: false,
    running: false,
    finished: false,
    statuses: [],
    summary: "",
    exit: null,
  };
}
