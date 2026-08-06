/**
 * Find the agent: the wizard's first intelligent step.
 *
 * Nothing about a repository tells egma where a voice agent is. A person would
 * read the code to work it out, so egma has a coding agent read it — the
 * developer's own, on the developer's own machine, with two egma skills at the
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
import { MarkerStream, type Marker, type ParsedLine } from "./markers.ts";
import { ACTION_MARK, DETAIL_MARK } from "./status.ts";
import { stopReport, untilAborted } from "./stop.ts";

/** The facts the step exists to bring back, and what they are called on screen. */
const FIELDS = [
  ["framework", "Framework"],
  ["prompts", "Prompts"],
  ["tools", "Tools"],
  ["deploy", "Deploy"],
  ["agent-id", "Agent id"],
] as const;

const LABEL_WIDTH = Math.max(...FIELDS.map(([, label]) => label.length));

/** What the coding agent reported, keyed by field name. */
export type Facts = ReadonlyMap<string, string>;

export type DiscoveryOutcome =
  | { readonly kind: "found"; readonly facts: Facts }
  /** The agent looked and there is no voice agent in this folder. */
  | { readonly kind: "nothing-found" }
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

function labelFor(field: string): string | null {
  return FIELDS.find(([name]) => name === field)?.[1] ?? null;
}

/** The status line one marker is worth, or `null` when it is not for the screen. */
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
    case "abort":
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
  for (const [field, label] of FIELDS) {
    const value = facts.get(field);
    if (value === undefined) continue;
    lines.push(`  ${label.padEnd(LABEL_WIDTH)}  ${value}`);
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
  let reportedNothing = false;

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
      if (marker.kind === "none") reportedNothing = true;
      if (marker.kind === "abort") abort = marker.reason;
      const status = statusLineFor(marker);
      // A fact this step never asked for is still something the agent said, so
      // it is kept where the developer can find it rather than dropped.
      if (status === null) log.write(`${JSON.stringify(marker)}\n`);
      else ui.pushStatus(status);
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
      // The agent stopping itself is not the same as finding nothing, but if it
      // reported facts before it stopped they are still facts.
      return isAFind(facts) ? { kind: "found", facts } : { kind: "nothing-found" };
    case "done":
      if (reportedNothing && !isAFind(facts)) return { kind: "nothing-found" };
      return isAFind(facts) ? { kind: "found", facts } : { kind: "nothing-found" };
  }
}

export type FindOptions = DiscoveryOptions;

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

function endFor(
  outcome: Exclude<DiscoveryOutcome, { kind: "found" } | { kind: "nothing-found" }>,
  options: FindOptions,
): ExitReport {
  switch (outcome.kind) {
    case "interrupted":
      return stopReport(options.signal, options.launch.name);
    case "unreachable":
      return { kind: "no-coding-agent" };
    case "needs-login":
      return {
        kind: "failed",
        reason: `${outcome.drivenAgentName} is not logged in, and egma could not hand you to its login. Log in to it, then run egma again.`,
      };
    case "failed":
      return { kind: "failed", reason: outcome.reason };
  }
}

/**
 * The whole step: look here, ask once if there is nothing, look there, or say
 * plainly that this is the wrong folder.
 */
export async function findTheAgent(options: FindOptions): Promise<ExitReport> {
  const { ui, log } = options;

  ui.taskStarted();
  const here = await discoverIn(options);
  ui.taskFinished();

  if (here.kind === "found") {
    ui.setSummary(summaryCard(here.facts));
    return reportFor(here.facts);
  }
  if (here.kind !== "nothing-found") {
    // A failure is the one time the agent's own output is worth reading, so it
    // is the one time the developer is told where it is.
    if (here.kind === "failed") ui.pushStatus(`What ${options.launch.name} printed is in ${log.file}`);
    return endFor(here, options);
  }

  // Teams keep prompts in a repository of their own, so one folder saying no is
  // not an answer about the team. This is the only question the step asks, and
  // it is asked once. A developer who closes the wizard instead of answering has
  // answered too, so the wait ends with the signal and not only with a keystroke.
  const pointer = await untilAborted(ui.waitForAnswer("prompts-pointer"), options.signal);
  if (options.signal.aborted) return stopReport(options.signal, options.launch.name);
  if (pointer === undefined || pointer === null || pointer.trim() === "") {
    return { kind: "no-agent-context" };
  }

  const where = path.resolve(options.cwd, pointer.trim());
  if (!(await isFolder(where))) {
    ui.pushStatus(`${ACTION_MARK} There is no folder at ${pointer.trim()}.`);
    return { kind: "no-agent-context" };
  }

  ui.taskStarted();
  const there = await discoverIn({ ...options, cwd: where });
  ui.taskFinished();

  if (there.kind === "found") {
    ui.setSummary(summaryCard(there.facts));
    return reportFor(there.facts);
  }
  if (there.kind === "nothing-found") return { kind: "no-agent-context" };
  if (there.kind === "failed") ui.pushStatus(`What ${options.launch.name} printed is in ${log.file}`);
  return endFor(there, options);
}
