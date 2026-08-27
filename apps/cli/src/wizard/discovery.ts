/**
 * Find the agent: the wizard's first intelligent step.
 *
 * Nothing about a repository tells egma where a voice agent is. A person would
 * read the code to work it out, so egma has a coding agent read it — the
 * developer's own, on the developer's own machine, with the public
 * `integrate-egma` skill saying what to look for. The task itself owns the
 * marker protocol. The repository never leaves the machine and no skill is
 * installed on it.
 *
 * What comes back is marker lines. They become the status lines the developer
 * watches and the card they read at the end; the agent's prose goes to the log.
 *
 * One ACP session has one working folder. If this folder has no voice agent,
 * Egma says so and tells the developer to point the next run at the right
 * folder or configure the agent in the Egma UI.
 */

import type { DrivenAgent } from "../acp/driven-agent.ts";
import {
  instructionsWith,
  publicSkill,
  publicSkillDirectory,
} from "../skills/index.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import type { DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import { FACTS, LABEL_WIDTH, labelFor } from "./facts.ts";
import { MarkerStream, type Marker, type ParsedLine } from "./markers.ts";
import { ACTION_MARK, DETAIL_MARK, FAILURE_MARK } from "./status.ts";
import { stopReport } from "./stop.ts";

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
  readonly drivenAgent: DrivenAgent;
  /** The folder to look in. */
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly log: DrivenAgentLog;
};

/** What Egma adds to the public skill for this one wizard run. */
export function discoveryTask(where: string): string {
  const resources = publicSkillDirectory("integrate-egma");
  return [
    "# Your task",
    "",
    `Find the voice agent in ${where} and report what you find.`,
    "",
    "## Resolve the skill's references",
    "",
    `The public skill above came from \`${resources}\`. Resolve its relative`,
    "reference links from that folder. Those public files are instructions, not",
    "repository evidence. Read one only when the skill's matching evidence",
    "branch says to. Reading that folder is the one exception to the skill's",
    "repository-only rule.",
    "",
    "## Report through Egma's marker lines",
    "",
    "Write `egma:note <what you are reading>` while you work. If there is no",
    "voice agent after a proper search, write `egma:none <reason>`. If something",
    "prevents the search, write `egma:abort <reason>` and stop.",
    "",
    "When facts are ready, write one line per fact in this exact shape:",
    "",
    "```text",
    "egma:found framework retell-sdk",
    "egma:found agent-name front-desk",
    "egma:found dispatch-name front-desk",
    "egma:found entrypoint src/agent.py",
    "egma:found prompts prompts/greeter.md",
    "egma:found tools src/tools/ (2 definitions)",
    "egma:found deploy Retell-hosted, updated by scripts/deploy.ts",
    "egma:found agent-id src/config.ts",
    "```",
    "",
    "Use only these fact names: `framework`, `agent-name`, `dispatch-name`,",
    "`entrypoint`, `prompts`, `tools`, `deploy`, and `agent-id`. For a LiveKit",
    "worker, always report `entrypoint` and report `dispatch-name` as `unknown`",
    "when committed source proves no explicit name. Put every found line in one",
    "final block with",
    "nothing after it.",
    "Start every marker at the beginning of a line, end it with a line break,",
    "and put no ordinary words on that line.",
  ].join("\n");
}

/** The public finder followed by the wizard-specific reference path and protocol. */
export function discoveryInstructions(where: string): string {
  return instructionsWith([publicSkill("integrate-egma")], discoveryTask(where));
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
  const { ui, drivenAgent, cwd, log } = options;

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

  const result = await drivenAgent.run({
    instructions: discoveryInstructions(cwd),
    watch: (chunk) => take(markers.push(chunk)),
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
 * One look in the selected repository folder, and the ending it forces.
 *
 * `null` means the coding agent found no voice agent. The wizard keeps the ACP
 * session rooted in this folder, so it ends with a clear next action instead
 * of silently moving the same task to another folder.
 */
async function lookIn(options: DiscoveryOptions): Promise<Discovered | null> {
  const { ui, drivenAgent, log, signal } = options;

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
        drivenAgentName: drivenAgent.name,
        reason: outcome.reason,
      });
    case "failed":
      // A failure is the one time the agent's own output is worth reading, so
      // it is the one time the developer is told where it is.
      ui.pushStatus(`What ${drivenAgent.name} printed is in ${log.file}`);
      return ending({ kind: "failed", reason: outcome.reason });
    case "interrupted":
      return ending(stopReport(signal, drivenAgent.name));
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
 * The whole step: look in the ACP session's one folder, or say plainly how to
 * point a new run at the right one.
 */
export async function findTheAgent(options: DiscoveryOptions): Promise<Discovered> {
  const nothingHere: Discovered = { report: { kind: "no-agent-context" }, facts: NO_FACTS };

  const here = await lookIn(options);
  return here ?? nothingHere;
}
