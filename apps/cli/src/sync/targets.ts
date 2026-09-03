/** Refresh the small Agent and Connection index committed in config.yaml. */

import {
  CONFIG_FORMAT,
  readConfig,
  writeConfig,
  type FolderAgent,
  type FolderPaths,
  type IdentifiedThing,
} from "../folder/egma-folder.ts";
import {
  listAllAgents,
  type CommonFailure,
  type RegisterOptions,
} from "../platform/agents.ts";

export type TargetSyncResult =
  | { readonly kind: "synced"; readonly agents: readonly FolderAgent[] }
  | CommonFailure;

function byId<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

/** Read the complete server-owned Agent and Connection index without writing. */
export async function readProjectTargets(
  projectId: string,
  options: RegisterOptions,
): Promise<TargetSyncResult> {
  const listed = await listAllAgents(projectId, options);
  if (listed.kind !== "agents") return listed;

  const agents: FolderAgent[] = listed.agents
    .map(({ agent, connections }) => ({
      id: agent.id,
      name: agent.name,
      platform: agent.agentPlatform,
      connections: connections
        .map((connection) => ({
          id: connection.id,
          name: connection.name,
        }))
        .sort(byId),
    }))
    .sort(byId);

  return { kind: "synced", agents };
}

/**
 * The server owns every Agent and Connection fact. The repository keeps only
 * the stable selectors that later CLI commands need, plus readable names.
 */
export async function refreshProjectTargets(
  input: {
    readonly paths: FolderPaths;
    readonly project: IdentifiedThing;
  },
  options: RegisterOptions,
): Promise<TargetSyncResult> {
  const loaded = await readProjectTargets(input.project.id, options);
  if (loaded.kind !== "synced") return loaded;

  const held = await readConfig(input.paths.config);
  if (held.project !== null && held.project.id !== input.project.id) {
    throw new Error(
      `This repository is already initialized for Project ${held.project.id}.`,
    );
  }

  await writeConfig(input.paths.config, {
    format: CONFIG_FORMAT,
    platform: held.platform,
    project: input.project,
    agents: loaded.agents,
  });
  return loaded;
}
