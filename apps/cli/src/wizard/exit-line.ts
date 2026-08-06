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
 *
 * The ending the whole walk is for needs more than a line for a different
 * reason: there are three separate things a developer takes away from it — the
 * address their results are at, where their tests now live, and the sentence
 * they hand their coding agent. Each is a thing somebody copies, so each is on
 * a line of its own with nothing else on it and no decoration around it. A
 * terminal's triple-click takes a line; anything sharing that line with an
 * address comes with it.
 */

import {
  installedLine,
  skippedLine,
  type SkillScope,
} from "../skills/install.ts";
import { pasteFallbackMessage } from "./no-coding-agent.ts";

/**
 * What the developer said to the skill offer, and what egma did about it.
 *
 * `not-offered` is a real answer: egma knows where two coding agents keep
 * their skills, and it will not write a file into a directory an agent it does
 * not know may never read.
 */
export type SkillOutcome =
  | {
      readonly kind: "installed";
      readonly scope: SkillScope;
      readonly file: string;
      readonly drivenAgentName: string;
    }
  | { readonly kind: "skipped"; readonly drivenAgentName: string }
  | { readonly kind: "not-offered" };

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
   * The whole walk, done: the tests are on egma, a run of them is going, and
   * verdicts have started arriving. The wizard does not wait for the rest —
   * the run is on the platform and carries on without a terminal.
   */
  | {
      readonly kind: "run-started";
      /** Where a person opens what happened. No token ever rides it. */
      readonly resultsUrl: string;
      /** How many simulations had a verdict when the wizard closed. */
      readonly graded: number;
      readonly total: number;
      /** What became of the skill offer, so skipping is never silent. */
      readonly skill: SkillOutcome;
    }
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
  | { readonly kind: "interrupted"; readonly drivenAgentName: string | null }
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

/** The headline of the ending the walk exists for. */
function runStartedLine(graded: number, total: number): string {
  if (graded === 0) {
    return `✓ Your first run is live — ${total} ${total === 1 ? "simulation" : "simulations"}, none graded yet.`;
  }
  if (graded >= total) {
    return `✓ Your first run is live — all ${total} graded.`;
  }
  return `✓ Your first run is live — ${graded} of ${total} graded so far.`;
}

/** Where the tests are now, and what to do to them next. */
const TESTS_ARE_CODE = `Tests are code now: ${TESTS_FOLDER} (committed). Edit them, then egma push.`;

/**
 * The sentence a developer hands their coding agent.
 *
 * It is one line and it is the whole handoff: where to read what this
 * repository points at, and where to find every verb from there. A developer
 * who installed the skill does not need it; a developer who skipped does, and
 * the line costs the first one nothing.
 */
const HAND_YOUR_AGENT =
  'Hand your coding agent this: "Read egma/config.yaml, then egma --help — you can pull, push, and trigger runs from here."';

export function buildExitLine(report: ExitReport): string {
  switch (report.kind) {
    case "found-agent":
      return foundLine(report.framework, report.prompts);
    case "run-started":
      return runStartedLine(report.graded, report.total);
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
    case "interrupted":
      return report.drivenAgentName === null
        ? "egma stopped before the task finished."
        : `egma stopped before the task finished, and shut ${report.drivenAgentName} down.`;
    case "failed":
      return `egma could not finish: ${oneLine(report.reason)}`;
  }
}

/**
 * Everything that survives the wizard, in the order it is printed.
 *
 * Every ending but one is a single line and comes back as one. The ending the
 * walk is for is a short block, and its shape is the promise: a headline, the
 * results address alone on its line, and then the two sentences a developer
 * takes with them. The blank lines between them are the only decoration, and
 * they are there so that no line has anything beside it.
 */
export function exitLines(report: ExitReport): readonly string[] {
  if (report.kind !== "run-started") return [buildExitLine(report)];
  return [
    buildExitLine(report),
    "",
    // Alone, undecorated, and with no query on it. A person opens this and the
    // browser they approved this machine in is already signed in — which is
    // exactly why no token has to ride the address, and none ever does.
    report.resultsUrl,
    "",
    TESTS_ARE_CODE,
    HAND_YOUR_AGENT,
  ];
}

/**
 * What is printed above the exit line, or `null` when the line says it all.
 *
 * Two endings need one. A machine with no coding agent on it needs the words to
 * paste elsewhere — a message is the whole answer there, and a message the
 * developer cannot copy is not one. And a walk that reached the skill offer has
 * to say what became of it: **the offer is never silent in either direction**,
 * so an install says where the file went and a skip says that nothing was
 * written, and both survive the screen the wizard drew them on.
 */
export function buildExitNotice(report: ExitReport): string | null {
  if (report.kind === "no-coding-agent") return pasteFallbackMessage();
  if (report.kind !== "run-started") return null;

  switch (report.skill.kind) {
    case "installed":
      return installedLine(report.skill.scope, report.skill.file, report.skill.drivenAgentName);
    case "skipped":
      return skippedLine(report.skill.drivenAgentName);
    case "not-offered":
      return null;
  }
}
