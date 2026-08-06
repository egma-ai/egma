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
 *
 * One ending needs more than a line: the developer has to copy something. That
 * arrives as a notice printed above the line, never instead of it, so the line
 * is still the last thing in scrollback and still selects whole.
 */

import { pasteFallbackMessage } from "./no-coding-agent.ts";

/** Why the wizard stopped, and what it can honestly say about it. */
export type ExitReport =
  | {
      readonly kind: "found-agent";
      readonly framework: string | null;
      readonly prompts: string | null;
    }
  /** Nothing here looks like a voice agent, and the pointer did not help. */
  | { readonly kind: "no-agent-context" }
  /** There is no coding agent on this machine for egma to drive. */
  | { readonly kind: "no-coding-agent" }
  /**
   * The coding agent stopped the work itself and said why. It is not the same
   * as finding nothing, and saying it was would put words in the agent's mouth.
   */
  | {
      readonly kind: "coding-agent-stopped";
      readonly drivenAgentName: string;
      readonly reason: string;
    }
  | { readonly kind: "quit" }
  | { readonly kind: "interrupted"; readonly drivenAgentName: string | null }
  | { readonly kind: "failed"; readonly reason: string };

/** One line means one line, whatever shape the reason arrived in. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function foundLine(framework: string | null, prompts: string | null): string {
  const facts: string[] = [];
  if (framework !== null) facts.push(framework);
  if (prompts !== null) facts.push(`prompts in ${prompts}`);
  if (facts.length === 0) return "egma found your voice agent.";
  return `egma found your voice agent: ${facts.join(", ")}.`;
}

export function buildExitLine(report: ExitReport): string {
  switch (report.kind) {
    case "found-agent":
      return foundLine(report.framework, report.prompts);
    case "no-agent-context":
      return "egma found no voice agent to test. Run egma again where your agent is defined.";
    case "no-coding-agent":
      return "egma found no coding agent on this machine that it can drive, so it printed what to paste into yours instead.";
    case "coding-agent-stopped":
      return oneLine(report.reason) === ""
        ? `${report.drivenAgentName} stopped before it found your voice agent, and did not say why.`
        : `${report.drivenAgentName} stopped before it found your voice agent: ${oneLine(report.reason)}`;
    case "quit":
      return "egma closed. Nothing ran.";
    case "interrupted":
      return report.drivenAgentName === null
        ? "egma stopped before the task finished."
        : `egma stopped before the task finished, and shut ${report.drivenAgentName} down.`;
    case "failed":
      return `egma could not finish: ${oneLine(report.reason)}`;
  }
}

/**
 * What is printed above the exit line, or `null` when the line says it all.
 *
 * The only ending that needs one is the machine with no coding agent on it: a
 * message is the whole answer there, and a message the developer cannot copy is
 * not one.
 */
export function buildExitNotice(report: ExitReport): string | null {
  return report.kind === "no-coding-agent" ? pasteFallbackMessage() : null;
}
