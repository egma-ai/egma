/**
 * The single owner of Egma's code changes in a LiveKit worker.
 *
 * The wizard chooses one final mode before this step runs. This step gives the
 * developer's coding agent the public integration router, the exact LiveKit
 * reference selected by that router, and one task that owns both the worker and
 * its dependency manifest. Later steps may write tests and mock-tool answers,
 * but they never receive authority to edit the worker again.
 *
 * Three changes ride that one dispatch: the Egma SDK entry the mode asks for,
 * the chat setup, and the worker's registered name. They travel together
 * because they are one visit to one file, and a second visit would need a
 * second authority this walk deliberately never grants.
 */

import type { DrivenAgent } from "../acp/driven-agent.ts";
import {
  instructionsWith,
  integrateEgmaReference,
  publicSkill,
} from "../skills/index.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import type { Facts } from "./discovery.ts";
import type { DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import { FACTS, LABEL_WIDTH } from "./facts.ts";
import { MarkerStream, type ParsedLine } from "./markers.ts";
import { ACTION_MARK, DETAIL_MARK, FAILURE_MARK } from "./status.ts";
import { stopReport } from "./stop.ts";
import {
  snapshotWorkerIntegration,
  verifyWorkerIntegrationClaim,
  type WorkerIntegrationContract,
  type WorkerIntegrationMode,
} from "./worker-integration-verifier.ts";

export type { WorkerIntegrationMode } from "./worker-integration-verifier.ts";

const WORKER_ENTRY_FACT = "worker-entry";
const DEPENDENCY_MANIFEST_FACT = "dependency-manifest";
const AGENT_NAME_FACT = "agent-name";
const DISPATCH_NAME_FACT = "dispatch-name";

const NODE_LIVEKIT = /@livekit\/agents/iu;

export function supportsLiveKitSdk(facts: Facts): boolean {
  return !NODE_LIVEKIT.test(facts.get("framework") ?? "");
}

function contextBlock(facts: Facts): readonly string[] {
  const lines: string[] = [];
  for (const fact of FACTS) {
    const value = facts.get(fact.name);
    if (value !== undefined) lines.push(`  ${fact.label.padEnd(LABEL_WIDTH)}  ${value}`);
  }
  return lines.length === 0 ? ["  Nothing was reported about the repository."] : lines;
}

function modeInstructions(mode: WorkerIntegrationMode): readonly string[] {
  switch (mode) {
    case "monitoring":
      return [
        "The final mode is **monitoring**.",
        "Ensure the synchronous monitoring entry is present in its required position.",
      ];
    case "testing":
      return [
        "The final mode is **testing**.",
        "Ensure the awaited testing entry is present in its required position.",
      ];
    case "both":
      return [
        "The final mode is **both**.",
        "Ensure both the synchronous monitoring entry and the awaited testing",
        "entry are present in their required positions.",
      ];
  }
}

function workerIntegrationTask(
  cwd: string,
  facts: Facts,
  mode: WorkerIntegrationMode,
): string {
  return [
    "# Your task",
    "",
    "Reconcile this LiveKit worker with Egma.",
    "",
    "## Final mode",
    "",
    ...modeInstructions(mode),
    "These are the additions this wizard choice authorizes. Preserve every",
    "other existing import, statement, and behavior in the worker, including an",
    "Egma entry that was already there before this task.",
    "",
    "## Chat setup",
    "",
    "Add the chat setup from the reference to the same worker. It is part of",
    "what this run authorizes. It needs no Egma package and no Egma import, so",
    "add it whether or not this worker takes an Egma SDK entry.",
    "",
    "## The worker's name",
    "",
    "Every Egma dispatch is explicit, so the worker must register a name. Give",
    "it one in its worker options when it has none, and keep the name it",
    "already registers under when it has one.",
    "",
    "## Where you may write",
    "",
    `Work in ${cwd}. You may write at most two files: the worker file where the`,
    "LiveKit job entrypoint is and the dependency manifest that already manages",
    "the worker's Python packages. Read whatever committed source you need.",
    "Run no command that reaches the network and install nothing.",
    "",
    "**Never open, write, or mention a `.env` file, or any other environment",
    "file.** Keep environment files unread and unchanged. Egma's own command",
    "owns the environment values used by monitoring.",
    "",
    "## Source of truth",
    "",
    "Use the complete LiveKit reference above. Read the changed files back and",
    "confirm the dependency, requested entries, and their order before reporting",
    "completion.",
    "",
    "## What Egma knows about this repository",
    "",
    ...contextBlock(facts),
    "",
    "## Report the worker",
    "",
    "When the integration is complete, report the worker on one line:",
    "",
    "```text",
    `egma:found ${WORKER_ENTRY_FACT} src/agent.py`,
    "```",
    "",
    "If one job entrypoint cannot be identified, edit nothing and write",
    "`egma:none <what you looked at>`. Do not guess at a file.",
    "",
    "## Report the dependency manifest",
    "",
    "After you have confirmed that the registry dependency `egma>=0.2.0` is declared,",
    "report the existing manifest you verified on one line:",
    "",
    "```text",
    `egma:found ${DEPENDENCY_MANIFEST_FACT} pyproject.toml`,
    "```",
    "",
    "Report the manifest that directly declares `egma`. Use `pyproject.toml` or",
    "a requirements-style manifest. Do not report a JavaScript package manifest.",
    "",
    "## Report the agent name",
    "",
    "Choose the name a person on this team would recognise from committed",
    "source, then report it on one line:",
    "",
    "```text",
    `egma:found ${AGENT_NAME_FACT} front-desk`,
    "```",
    "",
    "## Report the registered worker name",
    "",
    "Report the name this worker registers with LiveKit, after your change, on",
    "one line:",
    "",
    "```text",
    `egma:found ${DISPATCH_NAME_FACT} front-desk`,
    "```",
    "",
    "## Show progress",
    "",
    "Write one `egma:note <what you did>` line for the integration. Write",
    "`egma:abort <reason>` only when something prevents the work, then stop.",
    "Start each marker at the beginning of its line.",
    "",
    "## Completion",
    "",
    "Stop when the requested entries are present in the correct order, existing",
    "worker behavior is preserved, the dependency is present, and all four facts are",
    "reported. Report nothing else.",
  ].join("\n");
}

/*
 * The chat setup rides this dispatch whatever the developer answers later, and
 * nothing reads it back.
 *
 * The walk hands this task over before it asks chat or voice, so a conditional
 * block would wait on an answer this step never sees. Adding it unconditionally
 * costs a voice worker nothing: the six lines read Egma's own dispatch
 * metadata, a production room carries none, and a voice simulation sends none —
 * so the room options outside a chat simulation are the ones the worker always
 * had.
 *
 * `worker-integration-verifier.ts` is deliberately left alone. Its contract is
 * the files that make a Python LiveKit worker use Egma, and the chat setup
 * imports no Egma to find. A worker that never took it is caught at the agent's
 * first utterance, where the wire itself separates a speaking agent from a
 * typing one; the spec ruled out a probe before the run for exactly that
 * reason. A check added here would report on prose rather than on behavior.
 */
export function workerIntegrationInstructions(
  cwd: string,
  facts: Facts,
  mode: WorkerIntegrationMode,
): string {
  return instructionsWith(
    [publicSkill("integrate-egma"), integrateEgmaReference("integrate-livekit")],
    workerIntegrationTask(cwd, facts, mode),
  );
}

export function workerEntryInstructions(
  mode: WorkerIntegrationMode,
): readonly string[] {
  const monitoring = mode === "monitoring" || mode === "both";
  const testing = mode === "testing" || mode === "both";
  return [
    "Egma could not verify the requested entries in your LiveKit worker.",
    "Add the following to the worker before starting a run:",
    "",
    '  1. Add the registry dependency "egma>=0.2.0" to your Python dependencies.',
    ...(monitoring
      ? [
          "  2. Make monitor_livekit(ctx) the first statement of the job entrypoint.",
          "",
          "         from egma import monitor_livekit",
          "",
          "         monitor_livekit(ctx)",
        ]
      : []),
    ...(testing
      ? [
          `  ${monitoring ? "3" : "2"}. After the agent and AgentSession exist, and before AgentSession.start, add:`,
          "",
          "         from egma import mockable",
          "",
          "         await mockable(agent, ctx, session)",
        ]
      : []),
    // The name is not one of the entries this block could not verify. It is
    // the one thing a run still needs from the worker afterwards, and a
    // developer typing the lines above by hand is the developer who has to
    // add it too.
    `  ${monitoring && testing ? "4" : "3"}. Register the worker under a name, with agent_name in its WorkerOptions.`,
    "     A worker with a registered name no longer joins rooms automatically.",
  ];
}

export type WorkerIntegrationOptions = {
  readonly ui: WizardUI;
  readonly drivenAgent: DrivenAgent;
  readonly signal: AbortSignal;
  readonly log: DrivenAgentLog;
  readonly cwd: string;
  readonly facts: Facts;
  readonly mode: WorkerIntegrationMode;
};

export type WorkerIntegration = {
  readonly halted: ExitReport | null;
  readonly entry: string | null;
  readonly contract: WorkerIntegrationContract | null;
  readonly unverifiedReason: string | null;
  readonly agentName: string | null;
  /**
   * The name the worker registers with LiveKit, as this task left it.
   *
   * Discovery reads a committed worker and answers `unknown` for a worker that
   * registers no name. This task is the one place that can change that answer,
   * because it is the visit that adds the name — so what it reports is what
   * the connection step uses when discovery had nothing.
   */
  readonly dispatchName: string | null;
  readonly supportsSdk: boolean;
};

/** Dispatch the one integration task, then verify its claim from disk. */
export async function workerIntegrationStep(
  options: WorkerIntegrationOptions,
): Promise<WorkerIntegration> {
  const { ui, drivenAgent, signal, log } = options;

  if (!supportsLiveKitSdk(options.facts)) {
    ui.pushStatus(
      "This is a Node LiveKit worker, and the Egma SDK is Python only today, so the worker was left unchanged.",
    );
    return {
      halted: null,
      entry: null,
      contract: null,
      unverifiedReason:
        "The Egma SDK is Python only today, so this Node LiveKit worker cannot be integrated.",
      agentName: options.facts.get("agent-name") ?? null,
      dispatchName: null,
      supportsSdk: false,
    };
  }

  // Discovery names the worker before the coding agent can edit it. Keeping
  // this snapshot lets the verifier require the user's requested additions
  // without allowing an older Egma hook to disappear as collateral damage.
  const before = await snapshotWorkerIntegration(
    options.cwd,
    options.facts.get("entrypoint") ?? "",
  );
  if (before.kind === "unverified") {
    ui.pushStatus(`${DETAIL_MARK} ${before.reason}`);
    for (const line of workerEntryInstructions(options.mode)) ui.pushStatus(line);
    return {
      halted: null,
      entry: null,
      contract: null,
      unverifiedReason: before.reason,
      agentName: options.facts.get("agent-name") ?? null,
      dispatchName: null,
      supportsSdk: true,
    };
  }
  const markers = new MarkerStream();
  const claimed: {
    entry: string | null;
    dependency: string | null;
    name: string | null;
    dispatchName: string | null;
    none: string;
  } = {
    entry: null,
    dependency: null,
    name: null,
    dispatchName: null,
    none: "",
  };
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
          if (marker.field === WORKER_ENTRY_FACT) claimed.entry = marker.value;
          if (marker.field === DEPENDENCY_MANIFEST_FACT) {
            claimed.dependency = marker.value;
          }
          if (marker.field === AGENT_NAME_FACT) claimed.name = marker.value;
          if (marker.field === DISPATCH_NAME_FACT) {
            claimed.dispatchName = marker.value;
          }
          break;
        case "none":
          claimed.none = marker.reason;
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
    return null;
  };

  ui.taskStarted();
  let result;
  try {
    result = await drivenAgent.run({
      instructions: workerIntegrationInstructions(
        options.cwd,
        options.facts,
        options.mode,
      ),
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

  const verified =
    claimed.entry === null
      ? null
      : await verifyWorkerIntegrationClaim(
          options.cwd,
          before.snapshot,
          claimed.entry,
          claimed.dependency ?? "",
          options.mode,
        );
  const entry = verified?.kind === "verified" ? verified.file : null;
  if (halted === null) {
    if (entry === null) {
      const why = verified?.kind === "unverified" ? verified.reason : claimed.none;
      if (why.trim() !== "") ui.pushStatus(`${DETAIL_MARK} ${why}`);
      for (const line of workerEntryInstructions(options.mode)) ui.pushStatus(line);
    } else {
      ui.pushStatus(`${ACTION_MARK} Egma's requested worker integration is in ${entry}`);
    }
  }

  const named = claimed.name?.trim() ?? "";
  const dispatched = claimed.dispatchName?.trim() ?? "";
  return {
    halted,
    entry,
    contract: verified?.kind === "verified" ? verified.contract : null,
    unverifiedReason:
      verified?.kind === "unverified"
        ? verified.reason
        : entry === null && claimed.none.trim() !== ""
          ? claimed.none
          : null,
    agentName: named === "" ? null : named,
    dispatchName: dispatched === "" ? null : dispatched,
    supportsSdk: true,
  };
}
