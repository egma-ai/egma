/**
 * The one code edit production monitoring on LiveKit needs, made by the
 * developer's own coding agent under their eyes.
 *
 * `monitor_livekit(ctx)` at the top of the job entrypoint is what turns a
 * worker into one that sends Egma its production evidence. It is a change to
 * somebody's repository, so it is made the way every other change in this
 * walk is made: dispatched to the coding agent that drove the wizard, taught by
 * the shipped SDK-integration skill, shown line by line as it happens, and
 * approved the way that agent's own permission gate approves an edit.
 *
 * **What is on disk is the truth.** A coding agent that reports the edit is not
 * taken at its word: Egma opens the file it named and looks for the call in the
 * code. The check is the same shape the testing seam's is and it stops in the
 * same place — it reads code rather than prose, so a line in a comment or a
 * docstring does not count, and it cannot prove the call is on the path the
 * worker really takes. That is answered for real by the evidence arriving, and
 * this exists to tell an edit that happened from one that did not.
 *
 * **Nothing here touches an environment file.** The skill forbids the coding
 * agent from reading or writing one, and the two variables the entry reads are
 * Egma's own deterministic code to write — with the developer's agreement, into
 * a file Git already ignores.
 *
 * Nothing here is fatal. A worker whose entrypoint nobody can identify gets the
 * lines to add by hand and a key minted for when they do, which is a better
 * ending than stopping a walk that has everything else it needs.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { DrivenAgent } from "../acp/driven-agent.ts";
import { instructionsWith, publicSkill } from "../skills/index.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import type { Facts } from "./discovery.ts";
import type { DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import { FACTS, LABEL_WIDTH } from "./facts.ts";
import { MarkerStream, type ParsedLine } from "./markers.ts";
import { ACTION_MARK, DETAIL_MARK, FAILURE_MARK } from "./status.ts";
import { stopReport } from "./stop.ts";

/** The fact the coding agent reports the edited worker file under. */
const MONITOR_ENTRY_FACT = "monitor-entry";

/** The fact the coding agent reports what this worker should be called under. */
const AGENT_NAME_FACT = "agent-name";

/**
 * The monitoring entry, in the shapes it is really written in.
 *
 * What is allowed to vary is what a person or a model varies: the whitespace,
 * and a module prefix on the name for a worker that imported the package rather
 * than the function. Where it sits in the entrypoint, and that it is not
 * awaited, are the skill's to teach — this is here to tell an edit that
 * happened from one that did not, and refusing a call over its position would
 * be Egma deciding it understands somebody's worker better than they do.
 */
const MONITOR_CALL = /\b(?:[A-Za-z_]\w*\s*\.\s*)*monitor_livekit\s*\(/u;

/** The two ways a Python string opens and the text it runs to. */
const TRIPLE_QUOTES = ['"""', "'''"] as const;

/** A line that is only a `//` comment, which is not Python at all. */
const FOREIGN_COMMENT_LINE = /^\s*\/\//u;

/**
 * The file with everything that is not Python code blanked out.
 *
 * A model asked to add one line writes it in more places than the one that
 * runs: pasted above the call site as a comment, quoted in the docstring it
 * wrote to explain itself, left in a string while it worked something else out.
 * Anything that searched the text alone would say the worker was wired when it
 * is not, and the developer would be told their production traffic was on its
 * way to Egma when nothing was sending it.
 *
 * So the file is read character by character, tracking one piece of state —
 * what, if anything, is being read through to its end — and comments and string
 * bodies become spaces. Newlines survive, so a call written across two lines
 * still reads as one thing.
 */
function pythonCode(source: string): string {
  const out: string[] = new Array<string>(source.length);
  /** What is being read through to its end, or `null` while reading code. */
  let closes: string | null = null;
  let inComment = false;
  let at = 0;

  const keep = (): void => {
    out[at] = source[at] as string;
    at += 1;
  };
  const blank = (howMany: number): void => {
    for (let taken = 0; taken < howMany && at < source.length; taken += 1) {
      out[at] = source[at] === "\n" ? "\n" : " ";
      at += 1;
    }
  };

  while (at < source.length) {
    const here = source[at] as string;

    if (inComment) {
      if (here === "\n") {
        inComment = false;
        keep();
      } else blank(1);
      continue;
    }

    if (closes !== null) {
      // An escape takes the character after it with it, whatever that is.
      if (here === "\\") {
        blank(2);
        continue;
      }
      if (source.startsWith(closes, at)) {
        blank(closes.length);
        closes = null;
        continue;
      }
      if (here === "\n" && closes.length === 1) {
        closes = null;
        keep();
        continue;
      }
      blank(1);
      continue;
    }

    if (here === "#") {
      inComment = true;
      blank(1);
      continue;
    }
    // Tried before the single quotes, so `"""` opens a docstring rather than an
    // empty string followed by one.
    const triple = TRIPLE_QUOTES.find((quotes) => source.startsWith(quotes, at));
    if (triple !== undefined) {
      closes = triple;
      blank(triple.length);
      continue;
    }
    if (here === '"' || here === "'") {
      closes = here;
      blank(1);
      continue;
    }
    keep();
  }

  return out
    .join("")
    .split("\n")
    .map((line) => (FOREIGN_COMMENT_LINE.test(line) ? "" : line))
    .join("\n");
}

type ReportedEntry =
  | { readonly kind: "verified"; readonly file: string }
  | { readonly kind: "unverified"; readonly reason: string };

/**
 * Whether a path the coding agent named is really inside this repository.
 *
 * Twice over, because there are two ways out of a folder: the lexical check
 * catches `../../etc/passwd`, and the resolved check catches a link inside the
 * repository pointing somewhere else.
 */
async function insideRepository(repository: string, file: string): Promise<boolean> {
  const held = (root: string, candidate: string): boolean => {
    const below = path.relative(root, candidate);
    return below !== "" && !below.startsWith("..") && !path.isAbsolute(below);
  };
  if (!held(path.resolve(repository), path.resolve(repository, file))) return false;
  try {
    return held(await realpath(repository), await realpath(path.resolve(repository, file)));
  } catch {
    // Nothing there to resolve, which the read below reports in its own words.
    return true;
  }
}

/** The reported worker file, read and held to what the skill teaches. */
async function reportedEntry(
  repository: string,
  claimed: string,
): Promise<ReportedEntry> {
  const shown = claimed.trim();
  if (shown === "") {
    return { kind: "unverified", reason: "No file was named for Egma's monitoring entry." };
  }
  if (!(await insideRepository(repository, shown))) {
    return {
      kind: "unverified",
      reason: `${shown} is outside this repository, so Egma did not read it.`,
    };
  }

  const file = path.resolve(repository, shown);
  let source: string;
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    source = await readFile(file, "utf8");
  } catch {
    return {
      kind: "unverified",
      reason: `Egma looked for its monitoring entry in ${shown}, and there is no such file here.`,
    };
  }

  if (!MONITOR_CALL.test(pythonCode(source))) {
    return {
      kind: "unverified",
      reason: `Egma read ${shown} and found no monitor_livekit() in it.`,
    };
  }
  return { kind: "verified", file: shown };
}

/**
 * The lines a developer adds themselves when no entrypoint could be found.
 *
 * Deterministic and Egma's own rather than whatever the coding agent chose to
 * print: this is the fallback for a step that did not work, and a fallback that
 * depends on the thing that did not work is not one.
 */
export function monitorEntryInstructions(): readonly string[] {
  return [
    "Egma could not wire its monitoring entry into your LiveKit worker, so this worker sends nothing yet.",
    "Add these yourself and it starts exporting the next time it runs:",
    "",
    '  1. Add "egma" to your Python dependencies.',
    "  2. At the top of your job entrypoint, before ctx.connect(), add:",
    "",
    "         from egma import monitor_livekit",
    "",
    "         monitor_livekit(ctx)",
  ];
}

/** The facts card, as a block a task can carry. */
function contextBlock(facts: Facts): readonly string[] {
  const lines: string[] = [];
  for (const fact of FACTS) {
    const value = facts.get(fact.name);
    if (value === undefined) continue;
    lines.push(`  ${fact.label.padEnd(LABEL_WIDTH)}  ${value}`);
  }
  return lines.length === 0 ? ["  Nothing was reported about the repository."] : lines;
}

/** What Egma asks the coding agent to do, on top of the public skill. */
function monitoringEditTask(cwd: string, facts: Facts): string {
  return [
    "# Your task",
    "",
    "Make this LiveKit worker send its production evidence to Egma.",
    "",
    "## Where you may write",
    "",
    `Work in ${cwd}. You may write exactly two files: the worker file where the`,
    "LiveKit job entrypoint is and the dependency manifest that already manages",
    "the worker's Python packages. Read whatever committed source you need.",
    "Run no command that reaches the network and install nothing.",
    "",
    "**Never open, write, or mention a `.env` file, or any other environment",
    "file.** Egma's own command writes the two variables the monitoring entry",
    "reads, with the developer's agreement. Naming them is teaching and is",
    "welcome; touching the file is not yours to do.",
    "",
    "## What Egma knows about this repository",
    "",
    ...contextBlock(facts),
    "",
    "## 1. Put the Egma monitoring entry in the worker",
    "",
    "Follow the skill above and add **only the monitoring entry**. Do not add the",
    "testing entry: this repository has not asked Egma to run simulations here,",
    "and `mockable` would stand in front of tools nobody asked to mock.",
    "",
    "When the edit is done, report the file on one line:",
    "",
    "```text",
    `egma:found ${MONITOR_ENTRY_FACT} src/agent.py`,
    "```",
    "",
    "If you cannot identify one job entrypoint, edit nothing and write",
    "`egma:none <what you looked at>`. Egma prints the lines for the developer",
    "to add by hand. Do not guess at a file.",
    "",
    "## 2. Say what this agent should be called in Egma",
    "",
    "Read the repository and choose the name a person on this team would",
    "recognise — what the agent is called in its own code, its prompt, or its",
    "package, not the framework's name and not the folder's name unless that",
    "really is what it is called. Report it on one line:",
    "",
    "```text",
    `egma:found ${AGENT_NAME_FACT} front-desk`,
    "```",
    "",
    "## Say what you are doing, as you do it",
    "",
    "This is not optional and it is not decoration. Egma turns these lines into",
    "the list the developer watches fill in while you work. Write each one on a",
    "line of its own, at the very start of the line, with no bullet and no code",
    "fence:",
    "",
    "- an `egma:note <what you did>` line for the edit;",
    "- an `egma:abort <reason>` line only when something prevents the work; stop",
    "  after it.",
    "",
    "## When you are done",
    "",
    "Stop once the worker is edited or reported as not found and the name is",
    "reported. Report nothing else.",
  ].join("\n");
}

/** The public integration skill, then the run-specific task. */
export function monitoringEditInstructions(cwd: string, facts: Facts): string {
  return instructionsWith(
    [publicSkill("integrate-egma")],
    monitoringEditTask(cwd, facts),
  );
}

export type MonitoringEditOptions = {
  readonly ui: WizardUI;
  readonly drivenAgent: DrivenAgent;
  readonly signal: AbortSignal;
  readonly log: DrivenAgentLog;
  readonly cwd: string;
  readonly facts: Facts;
};

export type MonitoringEdit = {
  /** Set only when the walk cannot carry on from here. */
  readonly halted: ExitReport | null;
  /** Whether Egma read the worker back and found the call in its code. */
  readonly wired: boolean;
  /** Where the entry landed, or `null` when nothing was edited. */
  readonly entry: string | null;
  /** What the coding agent said this agent should be called, or `null`. */
  readonly agentName: string | null;
};

/** One dispatch, and then the file read back. */
export async function monitoringEditStep(
  options: MonitoringEditOptions,
): Promise<MonitoringEdit> {
  const { ui, drivenAgent, signal, log } = options;

  const markers = new MarkerStream();
  /**
   * What the agent said, held together in one place.
   *
   * Nothing is claimed from any of it until the file it names has been read:
   * a marker is a claim, and this walk checks claims against the disk.
   */
  const claimed: {
    entry: string | null;
    name: string | null;
    noEntry: string;
  } = { entry: null, name: null, noEntry: "" };

  const take = (lines: readonly ParsedLine[]): null => {
    for (const line of lines) {
      if (line.kind === "prose") {
        log.write(`${line.text}\n`);
        continue;
      }
      const marker = line.marker;
      log.write(`${JSON.stringify(marker)}\n`);
      switch (marker.kind) {
        case "note":
          ui.pushStatus(`${ACTION_MARK} ${marker.text}`);
          break;
        case "found":
          // Kept, not believed: the file is read once the agent has stopped
          // writing, and what it says decides what the developer is told.
          if (marker.field === MONITOR_ENTRY_FACT) claimed.entry = marker.value;
          if (marker.field === AGENT_NAME_FACT) claimed.name = marker.value;
          break;
        case "none":
          claimed.noEntry = marker.reason;
          break;
        case "abort":
          ui.pushStatus(
            `${FAILURE_MARK} ${marker.reason === "" ? `${drivenAgent.name} stopped, and did not say why.` : marker.reason}`,
          );
          break;
        case "plan":
        case "writing":
        case "wrote":
          break;
      }
    }
    // Nothing is written back to the agent: this dispatch takes one edit and
    // two facts, and there is no question to answer mid-turn.
    return null;
  };

  ui.taskStarted();
  let result;
  try {
    result = await drivenAgent.run({
      instructions: monitoringEditInstructions(options.cwd, options.facts),
      watch: (chunk) => take(markers.push(chunk)),
    });
    take(markers.flush());
  } finally {
    ui.taskFinished();
  }

  const halted = ((): ExitReport | null => {
    switch (result.kind) {
      case "interrupted":
        return stopReport(signal, drivenAgent.name);
      case "unreachable":
        return { kind: "no-coding-agent" };
      case "needs-login":
        return {
          kind: "failed",
          reason: `${result.drivenAgentName} is not logged in, and Egma could not hand you to its login. Log in to it, then run egma again.`,
        };
      case "failed":
        ui.pushStatus(`What ${drivenAgent.name} printed is in ${log.file}`);
        return { kind: "failed", reason: result.reason };
      case "done":
      case "aborted":
        return null;
    }
  })();

  const reported =
    claimed.entry === null ? null : await reportedEntry(options.cwd, claimed.entry);
  const entry = reported?.kind === "verified" ? reported.file : null;

  if (halted === null) {
    if (entry === null) {
      const why = reported?.kind === "unverified" ? reported.reason : claimed.noEntry;
      if (why.trim() !== "") ui.pushStatus(`${DETAIL_MARK} ${why}`);
    } else {
      ui.pushStatus(`${ACTION_MARK} Egma's monitoring entry is in ${entry}`);
    }
  }

  const named = claimed.name?.trim() ?? "";
  return {
    halted,
    wired: entry !== null,
    entry,
    agentName: named === "" ? null : named,
  };
}
