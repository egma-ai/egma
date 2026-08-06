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
  /**
   * The agent and a way to reach it are on egma. The walk got past everything
   * that has to happen before a test can name what it is about.
   */
  | {
      readonly kind: "connected";
      readonly agentName: string;
      readonly connectionName: string;
    }
  /** The tests are on egma, and they are files in the repository as well. */
  | { readonly kind: "tests-pushed"; readonly count: number }
  /**
   * The developer read the list and closed the wizard. Nothing was uploaded and
   * nothing was taken away: the files are theirs, in their repository, and the
   * line has to say where.
   */
  | { readonly kind: "tests-kept"; readonly count: number }
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
  /**
   * The developer changed their mind while egma was working.
   *
   * `testsKept` is how many test files were really on disk when it stopped. A
   * stop part way through writing a suite leaves files behind, and a line that
   * only said egma had stopped would leave a developer with a folder they were
   * never told about. Absent, or zero, means the folder holds nothing to say.
   */
  | {
      readonly kind: "interrupted";
      readonly drivenAgentName: string | null;
      readonly testsKept?: number;
    }
  | { readonly kind: "failed"; readonly reason: string };

/** One line means one line, whatever shape the reason arrived in. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Where the files are, said the same way in both endings that mention them. */
const TESTS_FOLDER = "egma/tests/";

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
    case "connected":
      return `egma connected your voice agent: ${report.agentName}, over ${report.connectionName}.`;
    case "tests-pushed":
      return report.count === 1
        ? `egma put 1 test on egma and left it in ${TESTS_FOLDER} — commit it, edit it, then run egma push.`
        : `egma put ${report.count} tests on egma and left them in ${TESTS_FOLDER} — commit them, edit them, then run egma push.`;
    case "tests-kept":
      return report.count === 1
        ? `Nothing was uploaded. Your test is in ${TESTS_FOLDER} — read it, then run egma push.`
        : `Nothing was uploaded. Your ${report.count} tests are in ${TESTS_FOLDER} — read them, then run egma push.`;
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
    case "interrupted": {
      const stopped =
        report.drivenAgentName === null
          ? "egma stopped before the task finished."
          : `egma stopped before the task finished, and shut ${report.drivenAgentName} down.`;
      const kept = report.testsKept ?? 0;
      if (kept === 0) return stopped;
      // The folder is not empty, so the line says so. A developer who finds
      // files they were never told about has been told a half-truth.
      return kept === 1
        ? `${stopped} Your 1 test is in ${TESTS_FOLDER}.`
        : `${stopped} Your ${kept} tests are in ${TESTS_FOLDER}.`;
    }
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
