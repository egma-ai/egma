/**
 * The one line the wizard leaves behind.
 *
 * Adapted from the PostHog wizard (MIT) — see ../../NOTICE.
 *
 * The wizard draws in the terminal's alternate screen, which the terminal
 * throws away on exit. Everything the developer must keep therefore has to be
 * printed after that screen is released, into the buffer they can scroll back
 * through. It is one line, with no border and no colour, so a terminal
 * triple-click selects it whole.
 */

/** Why the wizard stopped, and what it can honestly say about it. */
export type ExitReport =
  | { readonly kind: "task-done"; readonly drivenAgentName: string; readonly file: string }
  | { readonly kind: "quit" }
  | { readonly kind: "interrupted"; readonly drivenAgentName: string | null }
  | { readonly kind: "failed"; readonly reason: string };

export function buildExitLine(report: ExitReport): string {
  switch (report.kind) {
    case "task-done":
      return `${report.drivenAgentName} read ${report.file} for egma. Nothing in this folder was changed.`;
    case "quit":
      return "egma closed. Nothing ran.";
    case "interrupted":
      return report.drivenAgentName === null
        ? "egma stopped before the task finished."
        : `egma stopped before the task finished, and shut ${report.drivenAgentName} down.`;
    case "failed":
      return `egma could not finish: ${report.reason}`;
  }
}
