/**
 * Find the agent: the wizard's first intelligent step.
 *
 * Nothing about a repository tells egma where a voice agent is. A person would
 * read the code to work it out, so egma has a coding agent read it — the
 * developer's own, on the developer's own machine, with two Egma skills at the
 * top of the task saying what to look for and what to report. The repository
 * never leaves the machine and no skill is ever installed on it.
 *
 * What comes back is marker lines. They become the status lines the developer
 * watches and the card they read at the end; the agent's prose goes to the log.
 *
 * Teams split repositories, so a folder with no voice agent in it is not the end
 * of the walk. egma asks once for a pointer to the prompts, looks there, and
 * only then says plainly that this is the wrong folder to have started in.
 */

import { stat } from "node:fs/promises";
import path from "node:path";

import { driveOneTask } from "../acp/drive.ts";
import type { DrivenAgentLaunch } from "../acp/registry.ts";
import { instructionsWith } from "../skills/index.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import type { DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import { FACTS, LABEL_WIDTH, labelFor } from "./facts.ts";
import { MarkerStream, type Marker, type ParsedLine } from "./markers.ts";
import { ACTION_MARK, DETAIL_MARK, FAILURE_MARK } from "./status.ts";
import { stopReport, untilAborted } from "./stop.ts";

/** What the coding agent reported, keyed by field name. */
export type Facts = ReadonlyMap<string, string>;

export type DiscoveryOutcome =
  | { readonly kind: "found"; readonly facts: Facts }
  /**
   * The agent looked and there is no voice agent in this folder. Whether it
   * said so with `egma:none` or simply reported no facts makes no difference
   * to what happens next, so the two are one outcome. What the agent said is
   * on the screen and in the log either way.
   */
  | { readonly kind: "nothing-found" }
  /** The agent stopped the work itself, and said why. */
  | { readonly kind: "aborted"; readonly reason: string }
  | { readonly kind: "interrupted" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "needs-login"; readonly drivenAgentName: string }
  | { readonly kind: "failed"; readonly reason: string };

export type DiscoveryOptions = {
  readonly ui: WizardUI;
  readonly launch: DrivenAgentLaunch;
  /** The folder to look in. */
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly log: DrivenAgentLog;
};

/** What egma asks the coding agent to do, under the two skills. */
export function discoveryTask(where: string): string {
  return [
    "# Your task",
    "",
    `Find the voice agent in ${where} and report what you find.`,
    "",
    "Work only in that folder. Read the files. Change nothing, install nothing,",
    "and run no command that reaches the network.",
    "",
    "Report with the marker lines the skill above describes, and stop when you",
    "have written them.",
  ].join("\n");
}

/** The instructions dispatched for this step: both skills, then the task. */
export function discoveryInstructions(where: string): string {
  return instructionsWith(["context-finding", "retell"], discoveryTask(where));
}

/**
 * The status line one marker is worth, or `null` when it is not for the screen.
 *
 * Every action egma takes is shown, and an agent saying it found nothing or
 * cannot go on is the most important thing it will say all run. Both therefore
 * reach the screen in the agent's own words: a stop is marked as the failure it
 * is, an empty answer as the quiet note it is.
 */
export function statusLineFor(marker: Marker): string | null {
  switch (marker.kind) {
    case "note":
      return `${ACTION_MARK} ${marker.text}`;
    case "found": {
      const label = labelFor(marker.field);
      if (label === null) return null;
      return `${DETAIL_MARK} ${label.padEnd(LABEL_WIDTH)}  ${marker.value}`;
    }
    case "none":
      return marker.reason === "" ? null : `${DETAIL_MARK} ${marker.reason}`;
    case "abort":
      return marker.reason === ""
        ? `${FAILURE_MARK} Your coding agent stopped, and did not say why.`
        : `${FAILURE_MARK} ${marker.reason}`;
    // Markers a later step asks for. An agent that writes one here has said
    // something this step never asked about: it is kept in the log like every
    // other marker, and it is not a line about finding a voice agent.
    case "plan":
    case "writing":
    case "wrote":
      return null;
  }
}

/**
 * The card at the end of the step: every fact, one per line, aligned.
 *
 * It exists to be read in five seconds, so it says nothing the facts do not.
 */
export function summaryCard(facts: Facts): string {
  const lines = ["Your voice agent"];
  for (const fact of FACTS) {
    const value = facts.get(fact.name);
    if (value === undefined) continue;
    lines.push(`  ${fact.label.padEnd(LABEL_WIDTH)}  ${value}`);
  }
  return lines.join("\n");
}

/**
 * Whether what came back is worth calling a find.
 *
 * A framework name or a prompt location is enough to carry on from. Anything
 * less and egma does not know where the agent is, however much prose arrived
 * alongside it.
 */
function isAFind(facts: Facts): boolean {
  return facts.has("framework") || facts.has("prompts");
}

/** Runs the step once, in one folder. */
export async function discoverIn(options: DiscoveryOptions): Promise<DiscoveryOutcome> {
  const { ui, launch, cwd, signal, log } = options;

  const facts = new Map<string, string>();
  const markers = new MarkerStream();

  /** Reads whole lines: facts are kept, markers are shown, prose is logged. */
  const take = (lines: readonly ParsedLine[]): string | null => {
    let abort: string | null = null;
    for (const line of lines) {
      if (line.kind === "prose") {
        log.write(`${line.text}\n`);
        continue;
      }
      const marker = line.marker;
      if (marker.kind === "found") facts.set(marker.field, marker.value);
      if (marker.kind === "abort") abort = marker.reason;
      // Every marker is kept where the developer can find it afterwards —
      // including a fact this step never asked for, which is still something
      // the agent said. The screen gets the ones that are worth a line.
      log.write(`${JSON.stringify(marker)}\n`);
      const status = statusLineFor(marker);
      if (status !== null) ui.pushStatus(status);
    }
    return abort;
  };

  const result = await driveOneTask({
    launch,
    cwd,
    instructions: discoveryInstructions(cwd),
    ui,
    signal,
    logStderr: (chunk) => log.write(chunk),
    watch: (chunk) => take(markers.push(chunk)),
    onLogin: (name) =>
      ui.pushStatus(`${ACTION_MARK} ${name} needs you to log in. Handing you to its own login.`),
  });

  // An agent's last line often arrives without an ending, so it is read here
  // rather than lost.
  take(markers.flush());

  switch (result.kind) {
    case "interrupted":
      return { kind: "interrupted" };
    case "unreachable":
      return { kind: "unreachable" };
    case "needs-login":
      return { kind: "needs-login", drivenAgentName: result.drivenAgentName };
    case "failed":
      return { kind: "failed", reason: result.reason };
    case "aborted":
      // The agent stopping itself is not the same as finding nothing, and must
      // never be told as if it were. If it reported facts before it stopped,
      // those are still facts.
      if (isAFind(facts)) return { kind: "found", facts };
      return { kind: "aborted", reason: result.reason };
    case "done":
      return isAFind(facts) ? { kind: "found", facts } : { kind: "nothing-found" };
  }
}

async function isFolder(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function reportFor(facts: Facts): ExitReport {
  return {
    kind: "found-agent",
    framework: facts.get("framework") ?? null,
    prompts: facts.get("prompts") ?? null,
  };
}

/**
 * How the step ended, and everything the agent reported while it ran.
 *
 * The report is what the wizard would close on; the facts are what the steps
 * after this one are grounded in. They travel together because a fact that
 * only reached the screen is a fact the next step cannot use.
 */
export type Discovered = {
  readonly report: ExitReport;
  readonly facts: Facts;
};

/** Nothing was reported, for every ending that is not a find. */
const NO_FACTS: Facts = new Map<string, string>();

/**
 * One look in one folder, and the ending it forces.
 *
 * `null` is the one answer that is not an ending: the agent looked, there is
 * nothing here, and the walk has somewhere else to try. Both looks the step
 * makes are this same shape, so neither can grow an ending the other does not
 * have.
 */
async function lookIn(options: DiscoveryOptions): Promise<Discovered | null> {
  const { ui, launch, log, signal } = options;

  ui.taskStarted();
  const outcome = await discoverIn(options);
  ui.taskFinished();

  const ending = (report: ExitReport): Discovered => ({ report, facts: NO_FACTS });

  switch (outcome.kind) {
    case "found":
      ui.setSummary(summaryCard(outcome.facts));
      return { report: reportFor(outcome.facts), facts: outcome.facts };
    case "nothing-found":
      return null;
    case "aborted":
      return ending({
        kind: "coding-agent-stopped",
        drivenAgentName: launch.name,
        reason: outcome.reason,
      });
    case "failed":
      // A failure is the one time the agent's own output is worth reading, so
      // it is the one time the developer is told where it is.
      ui.pushStatus(`What ${launch.name} printed is in ${log.file}`);
      return ending({ kind: "failed", reason: outcome.reason });
    case "interrupted":
      return ending(stopReport(signal, launch.name));
    case "unreachable":
      return ending({ kind: "no-coding-agent" });
    case "needs-login":
      return ending({
        kind: "failed",
        reason: `${outcome.drivenAgentName} is not logged in, and Egma could not hand you to its login. Log in to it, then run egma again.`,
      });
  }
}

/**
 * The whole step: look here, ask once if there is nothing, look there, or say
 * plainly that this is the wrong folder.
 */
export async function findTheAgent(options: DiscoveryOptions): Promise<Discovered> {
  const nothingHere: Discovered = { report: { kind: "no-agent-context" }, facts: NO_FACTS };

  const here = await lookIn(options);
  if (here !== null) return here;

  // Teams keep prompts in a repository of their own, so one folder saying no is
  // not an answer about the team. This is the only question the step asks, and
  // it is asked once. A developer who closes the wizard instead of answering has
  // answered too, so the wait ends with the signal and not only with a keystroke.
  const pointer = await untilAborted(options.ui.waitForAnswer("prompts-pointer"), options.signal);
  if (options.signal.aborted) {
    return { report: stopReport(options.signal, options.launch.name), facts: NO_FACTS };
  }
  if (pointer === undefined || pointer === null || pointer.trim() === "") {
    return nothingHere;
  }

  const where = path.resolve(options.cwd, pointer.trim());
  if (!(await isFolder(where))) {
    options.ui.pushStatus(`${ACTION_MARK} There is no folder at ${pointer.trim()}.`);
    return nothingHere;
  }

  return (await lookIn({ ...options, cwd: where })) ?? nothingHere;
}
