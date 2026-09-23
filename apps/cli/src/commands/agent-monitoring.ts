/** Agent-scoped production monitoring commands for the skills-first CLI. */

import process from "node:process";

import {
  folderPathsIn,
  readConfig,
  type FolderAgent,
  type FolderConfig,
} from "../folder/egma-folder.ts";
import {
  AGENT_PLATFORM_LABELS,
  CHOOSE_PLATFORM,
  isAgentPlatform,
  type AgentPlatform,
} from "../platform/agent-platforms.ts";
import type { PlatformAccess } from "../platform/credentials.ts";
import type { Fetch } from "../platform/device-flow.ts";
import {
  listActiveProjectKeys,
  mintProjectKey,
  revokeProjectKey,
} from "../platform/api-keys.ts";
import {
  readAgentMonitoring,
  startMonitoring,
  stopMonitoring,
  type RevealableKey,
} from "../platform/monitoring.ts";
import { notSignedInRefusal, signedInAt } from "../platform/signed-in.ts";
import { oneLineFactText } from "../ui/fact-value.ts";
import {
  readApiKeyCredential,
  type CredentialStdin,
} from "./credential-stdin.ts";

export const AGENT_MONITORING_EXIT = {
  done: 0,
  failed: 1,
  interrupted: 130,
} as const;

const INSTALL_SKILL_COMMAND =
  "npx --yes skills add egma-ai/egma --skill integrate-egma";

type AgentMonitoringCommandOptions = {
  readonly access: PlatformAccess;
  readonly cwd: string;
  /** Stable Egma Agent ID from `egma/config.yaml`. */
  readonly agent: string;
  /** Process environment, injected so callers and tests never mutate globals. */
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
  readonly fetchImpl?: Fetch;
};

export type AgentMonitoringSetupCommandOptions = AgentMonitoringCommandOptions & {
  /** Required public flag. The command never guesses a platform. */
  readonly platform: string;
  /** Retell's Agent ID, needed only when the Egma Agent is not bound yet. */
  readonly retellAgentId?: string | null;
  /** Read the one-time Retell API key from stdin instead of the environment. */
  readonly credentialsStdin?: boolean;
  readonly stdin?: CredentialStdin;
};

export type AgentMonitoringStopCommandOptions = AgentMonitoringCommandOptions & {
  /** Required public flag. The command never guesses a platform. */
  readonly platform: string;
};

type LocalTarget = {
  readonly config: FolderConfig & { readonly project: NonNullable<FolderConfig["project"]> };
  readonly agent: FolderAgent & { readonly platform: AgentPlatform };
};

/** Resolve only the exact stable Egma Agent ID the caller supplied. */
async function localTarget(
  options: AgentMonitoringCommandOptions,
): Promise<LocalTarget | null> {
  const paths = folderPathsIn(options.cwd);
  let config: FolderConfig;
  try {
    config = await readConfig(paths.config);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      options.fail(
        `There is no egma/config.yaml in ${oneLineFactText(options.cwd, "this directory")}. Run egma init here first.`,
      );
    } else {
      options.fail(
        cause instanceof Error
          ? cause.message
          : "Egma could not read egma/config.yaml. Fix the file and run this again.",
      );
    }
    return null;
  }

  if (config.project === null) {
    options.fail("egma/config.yaml does not name an Egma Project. Run egma init again.");
    return null;
  }

  const agentId = options.agent.trim();
  const agent = config.agents.find((one) => one.id === agentId);
  if (agent === undefined) {
    if (config.agents.length > 0) options.out("Available Agents:");
    for (const choice of config.agents) {
      options.out(
        `- ${oneLineFactText(choice.name, "Unnamed")} (${oneLineFactText(choice.id, "unknown Agent ID")})`,
      );
    }
    options.fail(
      `${JSON.stringify(agentId)} is not an Egma Agent ID in egma/config.yaml. Nothing was changed.`,
    );
    return null;
  }
  if (!isAgentPlatform(agent.platform)) {
    options.fail(
      `Agent ${oneLineFactText(agent.id, "with an unknown ID")} has no supported platform in egma/config.yaml. Run egma pull, then try again.`,
    );
    return null;
  }

  return {
    config: { ...config, project: config.project },
    agent: { ...agent, platform: agent.platform },
  };
}

/** LiveKit and Pipecat monitoring lives in the agent's own code. */
function handOffCodeMonitoring(
  options: AgentMonitoringCommandOptions,
  agent: LocalTarget["agent"],
  action: "setup" | "removal",
): number {
  const label = AGENT_PLATFORM_LABELS[agent.platform];
  options.out(`Egma CLI does not perform ${label} monitoring ${action}.`);
  options.out("Install the public integrate-egma skill:");
  options.out(`  ${INSTALL_SKILL_COMMAND}`);
  options.out(
    `Then ask the coding agent to use it for ${label} monitoring ${action} on Agent ${oneLineFactText(agent.id, "with an unknown ID")}.`,
  );
  return AGENT_MONITORING_EXIT.failed;
}

function stoppedForFailure(
  options: AgentMonitoringCommandOptions,
  failure:
    | { readonly kind: "not-authenticated"; readonly reason: string }
    | { readonly kind: "refused" | "unreachable"; readonly reason: string },
): number {
  if (failure.kind === "not-authenticated") {
    options.fail(failure.reason);
    options.fail(notSignedInRefusal(options.access.url));
    return AGENT_MONITORING_EXIT.failed;
  }
  options.fail(failure.reason);
  return AGENT_MONITORING_EXIT.failed;
}

function interrupted(
  options: AgentMonitoringCommandOptions,
  message = "The command was interrupted before it received a complete answer. Check the Agent in Egma before you try again.",
): number {
  options.fail(message);
  return AGENT_MONITORING_EXIT.interrupted;
}

function wasInterrupted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function signedInOrSay(
  options: AgentMonitoringCommandOptions,
): Promise<Awaited<ReturnType<typeof signedInAt>>> {
  const signedIn = await signedInAt(options.access, options.env);
  if (signedIn === null) {
    options.fail(notSignedInRefusal(options.access.url));
  }
  return signedIn;
}

type OneTimeRetellKey =
  | { readonly kind: "key"; readonly key: RevealableKey }
  | { readonly kind: "failed" }
  | { readonly kind: "interrupted" };

/** Hold a one-time Retell key behind the same narrow interface as the API wrapper. */
async function oneTimeRetellKey(
  options: AgentMonitoringSetupCommandOptions,
): Promise<OneTimeRetellKey> {
  const env = options.env ?? process.env;
  let key = "";
  if (options.credentialsStdin) {
    const read = await readApiKeyCredential(options.stdin, options.signal);
    if (read.kind === "interrupted") return { kind: "interrupted" };
    if (read.kind === "invalid") {
      options.fail(
        'Retell credentials on standard input must be one JSON object shaped {"apiKey":"..."}. Nothing was changed.',
      );
      return { kind: "failed" };
    }
    if (read.kind === "missing") {
      options.fail(
        'No Retell API key arrived on standard input. Pipe one JSON object such as {"apiKey":"..."}, or remove --credentials-stdin and set EGMA_RETELL_API_KEY. Nothing was changed.',
      );
      return { kind: "failed" };
    }
    key = read.apiKey;
  } else {
    key = (env["EGMA_RETELL_API_KEY"] ?? "").trim();
  }
  if (key === "") {
    options.fail(
      'Set EGMA_RETELL_API_KEY, or pipe {"apiKey":"..."} into this command with --credentials-stdin. Nothing was changed.',
    );
    return { kind: "failed" };
  }
  return {
    kind: "key",
    key: Object.freeze({ reveal: () => key }),
  };
}

/** The prefix Egma reserves for one agent's guarded monitoring key. */
function monitoringKeyPrefix(agentId: string): string {
  return `Egma monitoring ${agentId} — `;
}

/**
 * Mint a Pipecat agent's guarded monitoring key and print, once, what the bot
 * needs where it runs. Production traces exported with this key are filed
 * under this agent; the same key serves simulation().
 */
async function setUpPipecatMonitoring(
  options: AgentMonitoringSetupCommandOptions,
  target: LocalTarget,
): Promise<number> {
  const signedIn = await signedInOrSay(options);
  if (wasInterrupted(options.signal)) return interrupted(options);
  if (signedIn === null) return AGENT_MONITORING_EXIT.failed;
  const platformOptions = {
    ...signedIn,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
  const agentId = target.agent.id;
  const shownId = oneLineFactText(agentId, "with an unknown ID");
  const read = await readAgentMonitoring(agentId, platformOptions, target.config.project.id);
  if (wasInterrupted(options.signal)) return interrupted(options);
  if (read.kind === "not-found") {
    options.fail(read.reason);
    options.fail(`Egma has no Agent ${shownId} in this Project. Run egma pull, then try again.`);
    return AGENT_MONITORING_EXIT.failed;
  }
  if (read.kind !== "monitoring") return stoppedForFailure(options, read);
  const remote = read.monitoring;
  if (remote.projectId !== target.config.project.id || remote.archived || remote.agentPlatform !== "pipecat") {
    options.fail(
      `Agent ${shownId} is not a living Pipecat Agent in this Project on Egma. Run egma pull, then try again. Nothing was changed.`,
    );
    return AGENT_MONITORING_EXIT.failed;
  }

  const prefix = monitoringKeyPrefix(agentId);
  const label = oneLineFactText(remote.agentName, "") || oneLineFactText(target.agent.name, "Pipecat agent");
  const minted = await mintProjectKey(
    { name: `${prefix}${label}`, projectId: target.config.project.id, monitoringAgentId: agentId },
    platformOptions,
  );
  switch (minted.kind) {
    case "minted": {
      options.out(`Created monitoring key ${JSON.stringify(oneLineFactText(minted.key.name ?? `${prefix}${label}`, "unnamed"))} for Pipecat Agent ${shownId}.`);
      options.out("Set these where your bot runs (its .env, your Pipecat Cloud secret set, or your server). The key is shown once; Egma CLI does not save it.");
      // The Egma SDK in the bot reads these two names.
      options.out(`  EGMA_URL=${signedIn.url}`);
      options.out(`  EGMA_API_KEY=${minted.key.secret.reveal()}`);
      options.out("Then call monitor where your bot builds its worker:");
      options.out("  from egma.pipecat import monitor");
      options.out("  await monitor(worker, runner_args)");
      options.out("Production sessions then appear under Monitoring. The same key serves simulation().");
      if (wasInterrupted(options.signal)) {
        options.fail("The command was interrupted after Egma created this key. Copy it now; Egma CLI did not save it.");
        return AGENT_MONITORING_EXIT.interrupted;
      }
      return AGENT_MONITORING_EXIT.done;
    }
    case "active-name-conflict": {
      const listed = await listActiveProjectKeys(
        { projectId: target.config.project.id, namePrefix: prefix },
        platformOptions,
      );
      const held = listed.kind === "listed" ? listed.keys[0] : undefined;
      options.fail(
        `Agent ${shownId} already has a monitoring key${held === undefined ? "" : ` ${JSON.stringify(oneLineFactText(held.name, "unnamed"))} (${oneLineFactText(held.looksLike, "hidden")})`}. Egma showed it once, when it was made. Use that key where your bot runs, or revoke it in Egma's API keys and run this again.`,
      );
      return AGENT_MONITORING_EXIT.failed;
    }
    case "minted-without-secret": {
      options.fail(minted.reason);
      const revoked = await revokeProjectKey(minted.keyId, platformOptions);
      if (revoked.kind !== "revoked") {
        options.fail(`Revoke key ${oneLineFactText(minted.keyId, "unknown")} in Egma, then run this again.`);
      }
      return AGENT_MONITORING_EXIT.failed;
    }
    case "uncertain":
      options.fail(minted.reason);
      options.fail(`Look for a key named ${JSON.stringify(prefix.trimEnd())}… in Egma's API keys before you run this again.`);
      return wasInterrupted(options.signal) ? AGENT_MONITORING_EXIT.interrupted : AGENT_MONITORING_EXIT.failed;
    default:
      return stoppedForFailure(options, minted);
  }
}

/** Start Retell monitoring, mint Pipecat's key, or hand LiveKit work to the integration skill. */
export async function runAgentMonitoringSetupCommand(
  options: AgentMonitoringSetupCommandOptions,
): Promise<number> {
  if (wasInterrupted(options.signal)) {
    return interrupted(options, "The command was interrupted before anything changed.");
  }
  const wantedPlatform = options.platform.trim().toLowerCase();
  if (!isAgentPlatform(wantedPlatform)) {
    options.fail(`${CHOOSE_PLATFORM} Nothing was changed.`);
    return AGENT_MONITORING_EXIT.failed;
  }

  const target = await localTarget(options);
  if (wasInterrupted(options.signal)) return interrupted(options);
  if (target === null) return AGENT_MONITORING_EXIT.failed;
  if (target.agent.platform !== wantedPlatform) {
    options.fail(
      `Agent ${oneLineFactText(target.agent.id, "with an unknown ID")} uses ${target.agent.platform}, not ${wantedPlatform}. Nothing was changed.`,
    );
    return AGENT_MONITORING_EXIT.failed;
  }
  if (wantedPlatform === "pipecat") return await setUpPipecatMonitoring(options, target);
  if (wantedPlatform !== "retell") {
    return handOffCodeMonitoring(options, target.agent, "setup");
  }

  const signedIn = await signedInOrSay(options);
  if (wasInterrupted(options.signal)) return interrupted(options);
  if (signedIn === null) return AGENT_MONITORING_EXIT.failed;
  const platformOptions = {
    ...signedIn,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
  const read = await readAgentMonitoring(
    target.agent.id,
    platformOptions,
    target.config.project.id,
  );
  if (wasInterrupted(options.signal)) return interrupted(options);
  if (read.kind === "not-found") {
    options.fail(read.reason);
    options.fail(
      `Egma has no Agent ${oneLineFactText(target.agent.id, "with an unknown ID")} in this Project. Run egma pull, then try again.`,
    );
    return AGENT_MONITORING_EXIT.failed;
  }
  if (read.kind !== "monitoring") return stoppedForFailure(options, read);
  const remote = read.monitoring;
  if (remote.projectId !== target.config.project.id) {
    options.fail(
      `Agent ${oneLineFactText(target.agent.id, "with an unknown ID")} belongs to a different Egma Project. Nothing was changed.`,
    );
    return AGENT_MONITORING_EXIT.failed;
  }
  if (remote.agentPlatform !== "retell") {
    options.fail(
      `Agent ${oneLineFactText(target.agent.id, "with an unknown ID")} is not registered as a Retell Agent. Nothing was changed.`,
    );
    return AGENT_MONITORING_EXIT.failed;
  }
  const storedRetellAgentId = remote.platformAgentId?.trim() ?? "";
  const suppliedRetellAgentId = options.retellAgentId?.trim() ?? "";
  if (
    storedRetellAgentId !== "" &&
    suppliedRetellAgentId !== "" &&
    suppliedRetellAgentId !== storedRetellAgentId
  ) {
    options.fail(
      `Agent ${oneLineFactText(target.agent.id, "with an unknown ID")} is already bound to Retell Agent ${oneLineFactText(storedRetellAgentId, "with an unknown ID")}, not ${oneLineFactText(suppliedRetellAgentId, "the supplied ID")}. Nothing was changed.`,
    );
    return AGENT_MONITORING_EXIT.failed;
  }
  const retellAgentId = storedRetellAgentId || suppliedRetellAgentId;
  if (retellAgentId === "") {
    options.fail(
      `Agent ${oneLineFactText(target.agent.id, "with an unknown ID")} has no Retell Agent ID. Supply --retell-agent. Nothing was changed.`,
    );
    return AGENT_MONITORING_EXIT.failed;
  }

  // A stored key wins. Ambient or piped credentials cannot silently replace it.
  const hasStoredCredential =
    storedRetellAgentId !== "" && (remote.monitoringApiKeyHint?.trim() ?? "") !== "";
  let apiKey: RevealableKey | undefined;
  if (!hasStoredCredential) {
    const supplied = await oneTimeRetellKey(options);
    if (supplied.kind === "interrupted") {
      return interrupted(
        options,
        "The command was interrupted before credentials finished reading. Nothing was changed.",
      );
    }
    if (supplied.kind === "failed") return AGENT_MONITORING_EXIT.failed;
    apiKey = supplied.key;
  }

  const started = await startMonitoring(
    {
      agentPlatform: "retell",
      projectId: target.config.project.id,
      ...(apiKey === undefined ? {} : { apiKey }),
      watch: [
        {
          agentId: target.agent.id,
          platformAgentId: retellAgentId,
        },
      ],
    },
    platformOptions,
  );
  if (started.kind !== "started") {
    if (wasInterrupted(options.signal)) return interrupted(options);
    return stoppedForFailure(options, started);
  }

  const hasOnlyRequestedAgent = [...started.watching, ...started.refused].every(
    (one) => one.platformAgentId === retellAgentId,
  );
  if (
    !hasOnlyRequestedAgent ||
    started.watching.length + started.refused.length !== 1
  ) {
    options.fail(
      `Egma answered without one matching monitoring outcome for Retell Agent ${oneLineFactText(retellAgentId, "with an unknown ID")}. Check the Agent in Egma before retrying.`,
    );
    return AGENT_MONITORING_EXIT.failed;
  }

  const refusal = started.refused[0];
  if (refusal !== undefined) {
    options.fail(refusal.message);
    return AGENT_MONITORING_EXIT.failed;
  }

  const watching = started.watching[0];
  if (
    watching === undefined ||
    watching.agentId !== target.agent.id ||
    watching.platformAgentId !== retellAgentId ||
    watching.pullProductionCalls !== true
  ) {
    const reason =
      "Egma answered without confirming that this Agent is monitored. Check the Agent in Egma before retrying.";
    options.fail(reason);
    return AGENT_MONITORING_EXIT.failed;
  }

  options.out(
    `Retell monitoring is set up for Egma Agent ${oneLineFactText(watching.agentId, "with an unknown ID")}.`,
  );
  options.out(
    `Retell Agent: ${oneLineFactText(watching.platformAgentId, "unknown Retell Agent ID")}`,
  );
  if (wasInterrupted(options.signal)) {
    return interrupted(
      options,
      `The command was interrupted after Egma started Retell monitoring for Agent ${oneLineFactText(watching.agentId, "with an unknown ID")}. Monitoring is active. Nothing needs to be retried.`,
    );
  }
  return AGENT_MONITORING_EXIT.done;
}

/** Stop Retell monitoring, or hand LiveKit removal to the integration skill. */
export async function runAgentMonitoringStopCommand(
  options: AgentMonitoringStopCommandOptions,
): Promise<number> {
  if (wasInterrupted(options.signal)) {
    return interrupted(options, "The command was interrupted before anything changed.");
  }
  const wantedPlatform = options.platform.trim().toLowerCase();
  if (!isAgentPlatform(wantedPlatform)) {
    options.fail(`${CHOOSE_PLATFORM} Nothing was changed.`);
    return AGENT_MONITORING_EXIT.failed;
  }
  const target = await localTarget(options);
  if (wasInterrupted(options.signal)) return interrupted(options);
  if (target === null) return AGENT_MONITORING_EXIT.failed;
  if (target.agent.platform !== wantedPlatform) {
    options.fail(
      `Agent ${oneLineFactText(target.agent.id, "with an unknown ID")} uses ${target.agent.platform}, not ${wantedPlatform}. Nothing was changed.`,
    );
    return AGENT_MONITORING_EXIT.failed;
  }
  if (wantedPlatform !== "retell") {
    return handOffCodeMonitoring(options, target.agent, "removal");
  }

  const signedIn = await signedInOrSay(options);
  if (wasInterrupted(options.signal)) return interrupted(options);
  if (signedIn === null) return AGENT_MONITORING_EXIT.failed;
  const stopped = await stopMonitoring(
    target.agent.id,
    {
      ...signedIn,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    },
    target.config.project.id,
  );
  if (stopped.kind !== "stopped" && wasInterrupted(options.signal)) {
    return interrupted(options);
  }
  if (stopped.kind === "not-found") {
    options.fail(stopped.reason);
    options.fail(
      `Egma has no Agent ${oneLineFactText(target.agent.id, "with an unknown ID")} in this Project. Run egma pull, then try again.`,
    );
    return AGENT_MONITORING_EXIT.failed;
  }
  if (stopped.kind !== "stopped") return stoppedForFailure(options, stopped);
  if (
    stopped.monitoring.agentId !== target.agent.id ||
    stopped.monitoring.pullProductionCalls !== false ||
    stopped.monitoring.agentPlatform !== "retell"
  ) {
    options.fail(
      `Egma did not confirm that monitoring stopped for Agent ${oneLineFactText(target.agent.id, "with an unknown ID")}. Check the Agent in Egma before you try again.`,
    );
    return AGENT_MONITORING_EXIT.failed;
  }

  options.out(
    `Stopped pulling future Retell calls for Egma Agent ${oneLineFactText(stopped.monitoring.agentId, "with an unknown ID")}. Existing traces were kept.`,
  );
  if (wasInterrupted(options.signal)) {
    return interrupted(
      options,
      `The command was interrupted after Egma stopped Retell monitoring for Agent ${oneLineFactText(stopped.monitoring.agentId, "with an unknown ID")}. Monitoring is stopped. Nothing needs to be retried.`,
    );
  }
  return AGENT_MONITORING_EXIT.done;
}
