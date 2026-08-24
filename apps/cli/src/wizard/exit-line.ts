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
  type SkillPlaces,
  type SkillScope,
} from "../skills/install.ts";
import { pasteFallbackMessage } from "./no-coding-agent.ts";
import type { WizardGoal } from "./wizard-machine.ts";

/**
 * What the developer said to the skill offer, and what egma did about it.
 *
 * `not-offered` is a real answer: the installer knows a long list of coding
 * agents and egma will not aim an install at one that is not on it.
 * `install-failed` is a real answer too — an offer accepted and not kept has to
 * say so, or a developer walks away believing their agent learned something.
 */
export type SkillOutcome =
  | {
      readonly kind: "installed";
      readonly scope: SkillScope;
      readonly places: SkillPlaces;
      /** Where the installer said each skill went, in its own words. */
      readonly landed: readonly string[];
    }
  | { readonly kind: "skipped"; readonly drivenAgentName: string }
  | { readonly kind: "install-failed"; readonly reason: string }
  | { readonly kind: "not-offered" };

/**
 * The path to watching production traffic that needs no terminal, said once.
 *
 * The machine with no coding agent on it is told this, because the wizard's own
 * monitoring lane needs a coding agent on LiveKit and a terminal on both.
 */
export const WEB_MONITORING_POINTER =
  "To watch production traffic, open Egma in your browser and start monitoring from its Monitoring page.";

/**
 * Where the conversations show up, said the one way.
 *
 * The web is iterating, so the pointer names Egma and its Monitoring page and
 * never a screen's address — a line naming a path is a line that goes stale
 * without anybody editing it.
 */
export function monitoringPointer(platformUrl: string | null): string {
  return platformUrl === null
    ? "Open Egma in your browser and watch them arrive on its Monitoring page."
    : `Open Egma at ${platformUrl} and watch them arrive on its Monitoring page.`;
}

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
      /**
       * Which Egma to open for the production traffic this sitting also set up,
       * or `null` when it set none up.
       *
       * The both lane ends with two promises kept, and a last screen that named
       * only one of them would leave the developer to remember the other.
       */
      readonly monitoringUrl?: string | null | undefined;
    }
  /**
   * Egma is watching a platform agent's production calls.
   *
   * `arrived` is proof rather than a promise: the flow waits briefly for the
   * first imported conversation, and an account with nothing to import ends
   * exactly as well — with a sentence that says so rather than one that implies
   * something went wrong.
   */
  | {
      readonly kind: "monitoring-started";
      readonly agentName: string;
      readonly arrived: boolean;
      /** Whether this walk also wrote the agent's row into the roster. */
      readonly registered: boolean;
      readonly platformUrl: string | null;
    }
  /**
   * A LiveKit worker is wired to push its production evidence.
   *
   * Nothing here waits: push is observed, never declared, so there is no switch
   * to read back and no arrival to prove. The two lines are the deliverable and
   * they are printed whether the `.env` write happened or not — a deployment
   * needs them either way.
   */
  | {
      readonly kind: "monitoring-wired";
      readonly agentName: string;
      /** The file the lines landed in, or `null` when Egma would not write it. */
      readonly envFile: string | null;
      /** Why Egma did not write it, when it did not. */
      readonly envRefusal: string | null;
      /** The two lines, for wherever this worker really runs. */
      readonly lines: readonly string[];
      /** Whether the coding agent's edit was found in the worker. */
      readonly wired: boolean;
      readonly platformUrl: string | null;
    }
  /**
   * The platform refused to start watching, and said which rule refused it.
   *
   * A nonzero ending on purpose: the monitoring lane's deliverable is that
   * watching is really on, so a walk that did not manage it must not answer a
   * shell the way a walk that did answers. Two sentences survive — Egma's own
   * about what to do, and the platform's own for whatever is reading.
   */
  | {
      readonly kind: "monitoring-refused";
      /** Egma's own sentence, then the platform's. */
      readonly lines: readonly string[];
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
   * The repository has an egma folder already, so it is not a new one.
   *
   * v1 of the wizard onboards new repositories. A second run over a folder
   * somebody already committed would half-write another suite into it, so it
   * refuses before it starts anything and says the one thing that redoes setup.
   *
   * `hasSuites` is why the refusal is two sentences and not one. A folder
   * holding tests can be pushed and run as it stands, and saying so is the
   * useful half of this line. A folder holding only a binding — which is what
   * an earlier walk that stopped between binding and registering leaves behind
   * — cannot: `egma push` refuses it for the contract it does not yet have, and
   * sending somebody to that command would be egma naming a command egma turns
   * away.
   */
  | {
      readonly kind: "already-onboarded";
      readonly folder: string;
      readonly hasSuites: boolean;
    }
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
    case "connected":
      return `Egma connected your voice agent: ${report.agentName}, over ${report.connectionName}.`;
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
      return (
        "Egma found no coding agent on this machine that it can drive, so it printed what to paste into yours instead. " +
        WEB_MONITORING_POINTER
      );
    case "monitoring-started": {
      const watching = `✓ Egma is watching ${report.agentName}'s production calls.`;
      const what = report.arrived
        ? "The first conversation has already arrived."
        : "Nothing has arrived yet — Egma keeps asking, and conversations appear as they finish.";
      return `${watching} ${what} ${monitoringPointer(report.platformUrl)}`;
    }
    case "monitoring-wired": {
      const wired = report.wired
        ? `✓ ${report.agentName} pushes its production evidence to Egma.`
        : `${report.agentName} is on Egma, and its worker still needs the monitoring line added by hand.`;
      const where =
        report.envFile === null
          ? "Egma wrote no environment file, so put the lines below wherever this worker gets its environment."
          : `Egma put the two lines in ${report.envFile}, and they are below for wherever this worker really runs.`;
      return `${wired} ${where} ${monitoringPointer(report.platformUrl)}`;
    }
    case "monitoring-refused":
      return `Egma did not start watching: ${oneLine(report.lines[0] ?? "")}`;
    case "already-onboarded": {
      const redo = `Delete or rename ${report.folder} and run egma again to redo setup`;
      return (
        `Egma is already set up here: ${report.folder} exists, and the wizard only works with new repositories for now. ` +
        (report.hasSuites
          ? `${redo}, or use egma push and egma run on the tests that are already there.`
          : `${redo}.`)
      );
    }
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
  /*
   * The two lines a monitored worker exports with, each alone on its own line.
   *
   * They carry a live credential and a developer copies them into a deployment
   * environment, so they are printed after the screen comes down — where a
   * terminal's triple-click takes one whole — rather than only on a screen the
   * terminal throws away.
   */
  if (report.kind === "monitoring-wired") {
    return [
      buildExitLine(report),
      "",
      ...report.lines,
      ...(report.envRefusal === null ? [] : ["", report.envRefusal]),
    ];
  }
  // Egma's own sentence is the line; the platform's own rides under it, whole,
  // for whatever is reading rather than looking.
  if (report.kind === "monitoring-refused") {
    const relayed = report.lines.slice(1);
    return relayed.length === 0
      ? [buildExitLine(report)]
      : [buildExitLine(report), "", ...relayed];
  }
  if (report.kind !== "run-started") return [buildExitLine(report)];
  return [
    buildExitLine(report),
    "",
    // Alone, undecorated, and with no query on it. A person opens this and the
    // browser they approved this machine in is already signed in — which is
    // exactly why no token has to ride the address, and none ever does.
    report.resultsUrl,
    ...(report.monitoringUrl == null
      ? []
      : ["", monitoringPointer(report.monitoringUrl)]),
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
      return installedLine(report.skill.scope, report.skill.places, report.skill.landed);
    case "skipped":
      return skippedLine(report.skill.drivenAgentName);
    case "install-failed":
      return report.skill.reason;
    case "not-offered":
      return null;
  }
}
