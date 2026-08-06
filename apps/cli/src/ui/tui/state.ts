/**
 * Everything the screens draw from, in one plain object.
 *
 * Screens read this and nothing else, so a screen can be drawn for any state a
 * test can build, and the flow can move the wizard along without knowing that
 * screens exist.
 */

import type { LoginPrompt } from "../../platform/login.ts";
import type { ExitReport } from "../../wizard/exit-line.ts";
import type { DrivenAgent } from "../wizard-ui.ts";

export type WizardState = {
  readonly drivenAgent: DrivenAgent | null;
  /** Where the coding agent's own output is kept, for a screen that tails it. */
  readonly drivenAgentLog: string | null;
  readonly taskFile: string | null;
  /** What has to be approved in a browser, while it still has to be. */
  readonly login: LoginPrompt | null;
  /** What the developer is typing back at the login screen, so far. */
  readonly loginTyping: string;
  /** True for the moment after the address is copied, so the screen can say so. */
  readonly loginCopied: boolean;
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
    drivenAgent: null,
    drivenAgentLog: null,
    taskFile: null,
    login: null,
    loginTyping: "",
    loginCopied: false,
    begun: false,
    running: false,
    finished: false,
    statuses: [],
    summary: "",
    exit: null,
  };
}
