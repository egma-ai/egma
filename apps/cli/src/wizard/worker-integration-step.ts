/**
 * Give the developer's coding agent the complete LiveKit integration task.
 *
 * The coding agent owns the intelligent repository work. The wizard consumes
 * its reported paths and names, but does not parse or approve customer source.
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
import { acceptRepositoryFileClaim } from "./repository-file-claim.ts";
import { ACTION_MARK, DETAIL_MARK, FAILURE_MARK } from "./status.ts";
import { stopReport } from "./stop.ts";

export type WorkerIntegrationMode = "monitoring" | "testing" | "both";

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
    "Make the repository changes needed for this integration. Preserve unrelated",
    "worker behavior and every Egma capability that is already present.",
    "",
    ...(mode === "monitoring"
      ? []
      : [
          "## Chat setup",
          "",
          "Add the chat setup from the reference to the same worker. It is part of",
          "what this run authorizes. It needs no Egma package and no Egma import.",
          "",
          "## The worker's name",
          "",
          "Every Egma dispatch is explicit, so the worker must register a name. Give",
          "it one in its worker options when it has none, and keep the name it",
          "already registers under when it has one.",
          "",
        ]),
    "## Where you may write",
    "",
    `Work in ${cwd}. Change the worker, its Python dependency files, its lockfile,`,
    "and any directly related local test or configuration needed to complete the",
    "integration. Use the dependency system this repository already uses. Run",
    "relevant local validation and package-manager commands when needed. Do not",
    "deploy the worker or create or change remote resources.",
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
    "After you have confirmed that the worker environment installs Egma Python",
    "SDK 0.2.0 or newer, report the dependency manifest on one line:",
    "",
    "```text",
    `egma:found ${DEPENDENCY_MANIFEST_FACT} pyproject.toml`,
    "```",
    "",
    "Report the Python manifest that the worker uses. For a local worker, Egma's",
    "launcher currently supports `pyproject.toml` and `requirements.txt`.",
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
    ...(mode === "monitoring"
      ? []
      : [
          "## Report the registered worker name",
          "",
          "Report the name this worker registers with LiveKit, after your change, on",
          "one line:",
          "",
          "```text",
          `egma:found ${DISPATCH_NAME_FACT} front-desk`,
          "```",
          "",
        ]),
    "## Show progress",
    "",
    "Write one `egma:note <what you did>` line for the integration. Write",
    "`egma:abort <reason>` only when something prevents the work, then stop.",
    "Start each marker at the beginning of its line.",
    "",
    "## Completion",
    "",
    "Stop when the requested entries are present in the correct order, existing",
    `worker behavior is preserved, the dependency is present, and all ${mode === "monitoring" ? "three" : "four"} facts are`,
    "reported. Report nothing else.",
  ].join("\n");
}

/*
 * The chat setup rides this dispatch whatever modality the developer chooses
 * later. A production or voice room has no chat mark, so its room options stay
 * unchanged. Chat correctness is proved by the wire when the agent first
 * answers, not by a second parser of the worker's source.
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
    "The coding agent did not report a completed LiveKit worker integration.",
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
    ...(testing
      ? [
          `  ${monitoring ? "4" : "3"}. Register the worker under a name, with agent_name in its WorkerOptions.`,
          "     A worker with a registered name no longer joins rooms automatically.",
        ]
      : []),
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
  readonly files: {
    readonly worker: string;
    readonly dependencyManifest: string;
  } | null;
  readonly reason: string | null;
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

/** Dispatch the integration task, then accept its repository-local receipt. */
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
      files: null,
      reason:
        "The Egma SDK is Python only today, so this Node LiveKit worker cannot be integrated.",
      agentName: options.facts.get("agent-name") ?? null,
      dispatchName: null,
      supportsSdk: false,
    };
  }

  const markers = new MarkerStream();
  const claimed: {
    entry: string | null;
    dependency: string | null;
    name: string | null;
    dispatchName: string | null;
    none: string;
    abort: string | null;
  } = {
    entry: null,
    dependency: null,
    name: null,
    dispatchName: null,
    none: "",
    abort: null,
  };
  const take = (lines: readonly ParsedLine[]): string | null => {
    let abort: string | null = null;
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
          claimed.abort = marker.reason;
          abort = marker.reason;
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
    return abort;
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
        return claimed.abort === null
          ? null
          : {
              kind: "failed",
              reason:
                claimed.abort === ""
                  ? `${drivenAgent.name} stopped the LiveKit integration and did not say why.`
                  : claimed.abort,
            };
      case "aborted":
        return {
          kind: "failed",
          reason:
            claimed.abort ??
            (result.reason === ""
              ? `${drivenAgent.name} stopped the LiveKit integration and did not say why.`
              : result.reason),
        };
    }
  })();

  const worker =
    halted === null
      ? await acceptRepositoryFileClaim(
          options.cwd,
          claimed.entry ?? "",
          "the LiveKit worker",
        )
      : null;
  const dependency =
    halted === null
      ? await acceptRepositoryFileClaim(
          options.cwd,
          claimed.dependency ?? "",
          "the Python dependency manifest",
        )
      : null;
  const named = claimed.name?.trim() ?? "";
  const dispatched = claimed.dispatchName?.trim() ?? "";
  const reason = (() => {
    if (halted !== null) return null;
    if (claimed.none.trim() !== "") return claimed.none.trim();
    if (worker?.kind === "refused") return worker.reason;
    if (dependency?.kind === "refused") return dependency.reason;
    if (named === "") return "The coding agent did not report the agent name.";
    if (options.mode !== "monitoring" && dispatched === "") {
      return "The coding agent did not report the registered LiveKit worker name.";
    }
    return null;
  })();
  const files =
    reason === null && worker?.kind === "accepted" && dependency?.kind === "accepted"
      ? { worker: worker.file, dependencyManifest: dependency.file }
      : null;
  if (halted === null) {
    if (files === null) {
      if (reason !== null) ui.pushStatus(`${DETAIL_MARK} ${reason}`);
      for (const line of workerEntryInstructions(options.mode)) ui.pushStatus(line);
    } else {
      ui.pushStatus(
        `${ACTION_MARK} ${drivenAgent.name} completed the LiveKit worker integration in ${files.worker}`,
      );
    }
  }

  return {
    halted,
    files,
    reason,
    agentName: named === "" ? null : named,
    dispatchName: dispatched === "" ? null : dispatched,
    supportsSdk: true,
  };
}
