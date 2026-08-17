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

import { dialLine } from "../retell/connect.ts";
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
      /** A file was already there, and the line has to say it is gone. */
      readonly replaced: boolean;
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
      /**
       * The number every simulation will dial, or `null` where nothing is
       * dialled.
       *
       * **It is on the ending because it is the one fact in the walk that costs
       * somebody money**, and the wizard's own screen cannot keep it: the
       * alternate screen is thrown away on exit, and a number said only there
       * was said to nobody. A text connection dials nothing and says nothing.
       */
      readonly dialled: string | null;
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
      /**
       * The number every simulation in that run will dial, or `null` where
       * nothing is dialled. Carried the whole way here for the reason above:
       * this is the ending the walk is for, and the number has to survive it.
       */
      readonly dialled: string | null;
    }
  /**
   * The developer read the list and did not run them. Nothing was uploaded and
   * nothing was taken away: the files are theirs, in their repository, and the
   * line has to say where.
   *
   * `stopped` is Ctrl-C rather than `q`. At this screen the two are the same
   * decision — nothing is running, the files are written, and the list is
   * offering `q` beside them — so both leave the same files and the same
   * sentence about where they are. It is kept apart only because a shell reads
   * an interruption as an interruption, and a run somebody stopped must not
   * answer a shell as though it finished.
   */
  | { readonly kind: "tests-kept"; readonly count: number; readonly stopped: boolean }
  /** The selected repository folder does not contain a voice agent we can prove. */
  | { readonly kind: "no-agent-context" }
  /** The repository is understood, but this CLI has no setup path for it yet. */
  | {
      readonly kind: "unsupported-agent-platform";
      readonly platform: "pipecat" | "vapi";
    }
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

/**
 * A reason, split into the sentence that goes on the line and the block that
 * goes under it.
 *
 * Almost every reason is one paragraph and stays one line, whatever whitespace
 * it arrived with — a wrapped sentence or a stack trace squashed onto one line
 * is still readable, and it keeps the promise that the last thing in scrollback
 * selects whole with one triple-click.
 *
 * A reason that arrived as a paragraph **and** a block is the exception, and
 * the block is the reason it exists: the refusal that keeps a repository on its
 * own platform ends with every line a developer deletes to move it, and a
 * coding agent is supposed to act on those lines without a person reading them
 * out. Squashed into the sentence they are unreadable and unusable, so they
 * survive as lines. A blank line is what marks one, which is exactly how the
 * refusal is built.
 */
function saidAndBlock(reason: string): readonly [string, readonly string[]] {
  const at = reason.indexOf("\n\n");
  if (at === -1) return [oneLine(reason), []];
  return [oneLine(reason.slice(0, at)), reason.slice(at + 2).split("\n")];
}

/** Where the files are, said the same way in both endings that mention them. */
const TESTS_FOLDER = "egma/tests/";

function foundLine(framework: string | null, prompts: string | null): string {
  const facts: string[] = [];
  if (framework !== null) facts.push(framework);
  if (prompts !== null) facts.push(`prompts in ${prompts}`);
  if (facts.length === 0) return "Egma found your voice agent.";
  return `Egma found your voice agent: ${facts.join(", ")}.`;
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
    case "connected": {
      const connected = `Egma connected your voice agent: ${report.agentName}, over ${report.connectionName}.`;
      // The number rides the same line rather than a second one, because it is
      // part of what was connected rather than a separate thing to copy — and
      // this ending is a line a triple-click takes whole.
      return report.dialled === null ? connected : `${connected} ${dialLine(report.dialled)}`;
    }
    case "tests-pushed":
      return report.count === 1
        ? `Egma put 1 test on Egma and left it in ${TESTS_FOLDER} — commit it, edit it, then run egma push.`
        : `Egma put ${report.count} tests on Egma and left them in ${TESTS_FOLDER} — commit them, edit them, then run egma push.`;
    case "tests-kept": {
      const where =
        report.count === 1
          ? `Your test is in ${TESTS_FOLDER} — read it, then run egma push.`
          : `Your ${report.count} tests are in ${TESTS_FOLDER} — read them, then run egma push.`;
      return report.stopped ? `Egma stopped. ${where}` : `Nothing was uploaded. ${where}`;
    }
    case "no-agent-context":
      return "Egma could not find a voice agent. Use its folder or configure it in the UI.";
    case "unsupported-agent-platform": {
      const named = report.platform === "pipecat" ? "Pipecat" : "Vapi";
      return (
        `Egma found a ${named} voice agent, but this CLI cannot connect ${named} yet. ` +
        "Configure it in the Egma UI; CLI support is coming soon."
      );
    }
    case "no-coding-agent":
      return "Egma found no coding agent on this machine that it can drive, so it printed what to paste into yours instead.";
    case "coding-agent-stopped":
      return oneLine(report.reason) === ""
        ? `${report.drivenAgentName} stopped before it found your voice agent, and did not say why.`
        : `${report.drivenAgentName} stopped before it found your voice agent: ${oneLine(report.reason)}`;
    case "quit":
      return "Egma closed. Nothing ran.";
    case "interrupted": {
      const stopped =
        report.drivenAgentName === null
          ? "Egma stopped before the task finished."
          : `Egma stopped before the task finished, and shut ${report.drivenAgentName} down.`;
      const kept = report.testsKept ?? 0;
      if (kept === 0) return stopped;
      // The folder is not empty, so the line says so. A developer who finds
      // files they were never told about has been told a half-truth.
      return kept === 1
        ? `${stopped} Your 1 test is in ${TESTS_FOLDER}.`
        : `${stopped} Your ${kept} tests are in ${TESTS_FOLDER}.`;
    }
    case "failed":
      return `Egma could not finish: ${saidAndBlock(report.reason)[0]}`;
  }
}

/**
 * Everything that survives the wizard, in the order it is printed.
 *
 * Every ending but two is a single line and comes back as one. The ending the
 * walk is for is a short block, and its shape is the promise: a headline, the
 * results address alone on its line, and then the two sentences a developer
 * takes with them. The blank lines between them are the only decoration, and
 * they are there so that no line has anything beside it.
 *
 * The other is a failure that arrived carrying a block — which today is one
 * refusal, the one that keeps a repository on the platform it is bound to and
 * ends with every line a developer deletes to move it. It goes under the line,
 * whole and one line each, because that block is what a coding agent acts on
 * and a squashed copy of it is neither readable nor usable.
 */
export function exitLines(report: ExitReport): readonly string[] {
  if (report.kind === "failed") {
    const [, block] = saidAndBlock(report.reason);
    return block.length === 0
      ? [buildExitLine(report)]
      : [buildExitLine(report), "", ...block];
  }
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
 *
 * **The number Egma will dial survives here for exactly that reason.** The
 * wizard says it as it works, in a panel on the alternate screen — where it
 * lived for about a twentieth of a second before the next lines pushed it out,
 * and where a run that painted no frame in that window said it to nobody at
 * all. It is the one fact in the walk that costs somebody money, so it belongs
 * where the developer still has it once the screen is gone.
 */
export function buildExitNotice(report: ExitReport): string | null {
  if (report.kind === "no-coding-agent") return pasteFallbackMessage();
  if (report.kind !== "run-started") return null;

  // In the order the walk did them: the number was dialled before the offer was
  // made. Each is its own paragraph, because each is a separate fact and the
  // block's whole shape is that nothing shares a line with anything else.
  const kept: string[] = [];
  if (report.dialled !== null) kept.push(dialLine(report.dialled));
  const offer = skillNotice(report.skill);
  if (offer !== null) kept.push(offer);
  return kept.length === 0 ? null : kept.join("\n\n");
}

/** What became of the skill offer, said in a line, or nothing where none was made. */
function skillNotice(skill: SkillOutcome): string | null {
  switch (skill.kind) {
    case "installed":
      return installedLine(skill.scope, skill.file, skill.drivenAgentName, skill.replaced);
    case "skipped":
      return skippedLine(skill.drivenAgentName);
    case "not-offered":
      return null;
  }
}
