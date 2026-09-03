/** Agent-scoped production monitoring commands for the skills-first CLI. */

import {
  folderPathsIn,
  readConfig,
  type FolderAgent,
  type FolderConfig,
} from "../folder/egma-folder.ts";
import type { PlatformAccess } from "../platform/credentials.ts";
import type { Fetch } from "../platform/device-flow.ts";
import {
  readAgentMonitoring,
  startMonitoring,
  stopMonitoring,
} from "../platform/monitoring.ts";
import { notSignedInRefusal, signedInAt } from "../platform/signed-in.ts";

export const AGENT_MONITORING_EXIT = {
  done: 0,
  nothing: 1,
  notSignedIn: 2,
  unreachable: 4,
  refused: 5,
  interrupted: 130,
} as const;

const INSTALL_SKILL_COMMAND =
  "npx --yes skills add egma-ai/egma --skill integrate-egma";

type AgentMonitoringCommandOptions = {
  readonly access: PlatformAccess;
  readonly cwd: string;
  /** Stable Egma Agent ID from `egma/config.yaml`. */
  readonly agent: string;
  readonly signal?: AbortSignal;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
  readonly fetchImpl?: Fetch;
};

export type AgentMonitoringSetupCommandOptions = AgentMonitoringCommandOptions & {
  /** Required public flag. The command never guesses a platform. */
  readonly platform: string;
};

export type AgentMonitoringStopCommandOptions = AgentMonitoringCommandOptions;

type LocalTarget = {
  readonly config: FolderConfig & { readonly project: NonNullable<FolderConfig["project"]> };
  readonly agent: FolderAgent & { readonly platform: "retell" | "livekit" };
};

/** Resolve only the exact stable Egma Agent ID the caller supplied. */
async function localTarget(
  options: AgentMonitoringCommandOptions,
): Promise<LocalTarget | null> {
  const paths = folderPathsIn(options.cwd);
  let config: FolderConfig;
  try {
    config = await readConfig(paths.config);
  } catch {
    options.out("status: no-folder");
    options.fail(`There is no valid egma folder in ${options.cwd}. Run egma init here first.`);
    return null;
  }

  if (config.project === null) {
    options.out("status: no-project");
    options.fail("egma/config.yaml does not name an Egma Project. Run egma init again.");
    return null;
  }

  const agentId = options.agent.trim();
  const agent = config.agents.find((one) => one.id === agentId);
  if (agent === undefined) {
    for (const choice of config.agents) {
      options.out(`agent_option: ${choice.id} ${choice.name}`);
    }
    options.out("status: unknown-agent");
    options.fail(
      `${JSON.stringify(agentId)} is not an Egma Agent ID in egma/config.yaml. Nothing was changed.`,
    );
    return null;
  }
  if (agent.platform !== "retell" && agent.platform !== "livekit") {
    options.out("status: invalid-agent");
    options.fail(
      `Agent ${agent.id} has no supported platform in egma/config.yaml. Run egma pull, then try again.`,
    );
    return null;
  }

  return {
    config: { ...config, project: config.project },
    agent: { ...agent, platform: agent.platform },
  };
}

function handOffLiveKit(
  options: AgentMonitoringCommandOptions,
  agent: LocalTarget["agent"],
  action: "setup" | "removal",
): number {
  options.out(`agent: ${agent.id}`);
  options.out("platform: livekit");
  options.out(`command: ${INSTALL_SKILL_COMMAND}`);
  options.out(
    `next: Install the integrate-egma skill with that command, then ask the coding agent to use it for LiveKit monitoring ${action}.`,
  );
  options.out("status: skill-required");
  return AGENT_MONITORING_EXIT.done;
}

function stoppedForFailure(
  options: AgentMonitoringCommandOptions,
  failure:
    | { readonly kind: "not-authenticated" }
    | { readonly kind: "refused" | "unreachable"; readonly reason: string },
): number {
  if (failure.kind === "not-authenticated") {
    options.out("status: not-signed-in");
    options.fail(notSignedInRefusal(options.access.url));
    return AGENT_MONITORING_EXIT.notSignedIn;
  }
  options.out("status: failed");
  options.out(`reason: ${failure.reason}`);
  options.fail(failure.reason);
  return failure.kind === "refused"
    ? AGENT_MONITORING_EXIT.refused
    : AGENT_MONITORING_EXIT.unreachable;
}

async function retellAccess(
  options: AgentMonitoringCommandOptions,
): Promise<Awaited<ReturnType<typeof signedInAt>>> {
  const signedIn = await signedInAt(options.access);
  if (signedIn === null) {
    options.out("status: not-signed-in");
    options.fail(notSignedInRefusal(options.access.url));
  }
  return signedIn;
}

/** Start Retell monitoring, or hand LiveKit work to the integration skill. */
export async function runAgentMonitoringSetupCommand(
  options: AgentMonitoringSetupCommandOptions,
): Promise<number> {
  if (options.signal?.aborted === true) {
    options.out("status: interrupted");
    return AGENT_MONITORING_EXIT.interrupted;
  }
  const wantedPlatform = options.platform.trim().toLowerCase();
  if (wantedPlatform !== "retell" && wantedPlatform !== "livekit") {
    options.out("status: unknown-platform");
    options.fail("Use --platform retell or --platform livekit. Nothing was changed.");
    return AGENT_MONITORING_EXIT.nothing;
  }

  const target = await localTarget(options);
  if (target === null) return AGENT_MONITORING_EXIT.nothing;
  if (target.agent.platform !== wantedPlatform) {
    options.out("status: platform-mismatch");
    options.fail(
      `Agent ${target.agent.id} uses ${target.agent.platform}, not ${wantedPlatform}. Nothing was changed.`,
    );
    return AGENT_MONITORING_EXIT.nothing;
  }
  if (wantedPlatform === "livekit") {
    return handOffLiveKit(options, target.agent, "setup");
  }

  const signedIn = await retellAccess(options);
  if (signedIn === null) return AGENT_MONITORING_EXIT.notSignedIn;
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
  if (read.kind === "not-found") {
    options.out("status: no-agent");
    options.fail(
      `Egma has no Agent ${target.agent.id} in this Project. Run egma pull, then try again.`,
    );
    return AGENT_MONITORING_EXIT.nothing;
  }
  if (read.kind !== "monitoring") return stoppedForFailure(options, read);
  const remote = read.monitoring;
  if (remote.projectId !== target.config.project.id) {
    options.out("status: project-mismatch");
    options.fail(
      `Agent ${target.agent.id} belongs to a different Egma Project. Nothing was changed.`,
    );
    return AGENT_MONITORING_EXIT.refused;
  }
  if (remote.agentPlatform !== "retell") {
    options.out("status: platform-mismatch");
    options.fail(`Agent ${target.agent.id} is not registered as a Retell Agent. Nothing was changed.`);
    return AGENT_MONITORING_EXIT.refused;
  }
  if (remote.platformAgentId === null || remote.platformAgentId === "") {
    options.out("status: no-retell-agent");
    options.fail(
      `Agent ${target.agent.id} has no Retell Agent ID. Add its Retell connection first. Nothing was changed.`,
    );
    return AGENT_MONITORING_EXIT.refused;
  }

  const started = await startMonitoring(
    {
      agentPlatform: "retell",
      projectId: target.config.project.id,
      watch: [
        {
          agentId: target.agent.id,
          platformAgentId: remote.platformAgentId,
        },
      ],
      // No apiKey: the server reuses the key sealed during registration.
    },
    platformOptions,
  );
  if (started.kind !== "started") return stoppedForFailure(options, started);

  const refusal = started.refused.find(
    (one) => one.platformAgentId === remote.platformAgentId,
  );
  if (refusal !== undefined) {
    options.out(`agent: ${target.agent.id}`);
    options.out("platform: retell");
    options.out(`retell_agent: ${remote.platformAgentId}`);
    options.out("status: refused");
    options.out(`reason: ${refusal.message}`);
    options.fail(refusal.message);
    return AGENT_MONITORING_EXIT.refused;
  }

  const watching = started.watching.find(
    (one) =>
      one.agentId === target.agent.id &&
      one.platformAgentId === remote.platformAgentId &&
      one.pullProductionCalls,
  );
  if (watching === undefined) {
    const reason =
      "Egma answered without confirming that this Agent is monitored. Check the Agent in Egma before retrying.";
    options.out("status: failed");
    options.out(`reason: ${reason}`);
    options.fail(reason);
    return AGENT_MONITORING_EXIT.refused;
  }

  options.out(`agent: ${watching.agentId}`);
  options.out("platform: retell");
  options.out(`retell_agent: ${watching.platformAgentId}`);
  options.out("status: monitoring-setup");
  return AGENT_MONITORING_EXIT.done;
}

/** Stop Retell monitoring, or hand LiveKit removal to the integration skill. */
export async function runAgentMonitoringStopCommand(
  options: AgentMonitoringStopCommandOptions,
): Promise<number> {
  if (options.signal?.aborted === true) {
    options.out("status: interrupted");
    return AGENT_MONITORING_EXIT.interrupted;
  }
  const target = await localTarget(options);
  if (target === null) return AGENT_MONITORING_EXIT.nothing;
  if (target.agent.platform === "livekit") {
    return handOffLiveKit(options, target.agent, "removal");
  }

  const signedIn = await retellAccess(options);
  if (signedIn === null) return AGENT_MONITORING_EXIT.notSignedIn;
  const stopped = await stopMonitoring(
    target.agent.id,
    {
      ...signedIn,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    },
    target.config.project.id,
  );
  if (stopped.kind === "not-found") {
    options.out("status: no-agent");
    options.fail(
      `Egma has no Agent ${target.agent.id} in this Project. Run egma pull, then try again.`,
    );
    return AGENT_MONITORING_EXIT.nothing;
  }
  if (stopped.kind !== "stopped") return stoppedForFailure(options, stopped);

  options.out(`agent: ${stopped.monitoring.agentId}`);
  options.out("platform: retell");
  options.out("status: monitoring-stopped");
  return AGENT_MONITORING_EXIT.done;
}
