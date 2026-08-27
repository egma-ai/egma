/** Commit one successfully monitored agent through the shared CLI operation. */

import {
  bindRepositoryPlatform,
  folderPathsIn,
  recordRegisteredTarget,
} from "../folder/egma-folder.ts";
import type { Fetch } from "../platform/device-flow.ts";
import { readProject } from "../platform/projects.ts";
import type { SignedIn } from "../platform/signed-in.ts";

export type MonitoredTarget = {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
};

export type RecordMonitoringTargetOptions = {
  readonly cwd: string;
  readonly signedIn: SignedIn;
  readonly target: MonitoredTarget;
  readonly fetchImpl?: Fetch | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type MonitoringTargetRecordStage =
  | "repository-bind"
  | "project-read"
  | "config-write";

/** Identifies which post-setup operation failed without hiding its cause. */
export class MonitoringTargetRecordError extends Error {
  readonly stage: MonitoringTargetRecordStage;
  override readonly cause: unknown;

  constructor(stage: MonitoringTargetRecordStage, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const action =
      stage === "repository-bind"
        ? "bind the repository to this Egma platform"
        : stage === "project-read"
          ? "read the project from Egma"
          : "write the target into egma/config.yaml";
    super(`could not ${action}: ${detail}`);
    this.name = "MonitoringTargetRecordError";
    this.stage = stage;
    this.cause = cause;
  }
}

/**
 * Bind the repository, read the platform-owned project name, and upsert the
 * agent without replacing any target already committed beside it.
 */
export async function recordMonitoringTarget(
  options: RecordMonitoringTargetOptions,
): Promise<void> {
  try {
    await bindRepositoryPlatform(options.cwd, { origin: options.signedIn.url });
  } catch (cause) {
    throw new MonitoringTargetRecordError("repository-bind", cause);
  }

  let project: Awaited<ReturnType<typeof readProject>>;
  try {
    project = await readProject(
      options.signedIn,
      options.target.projectId,
      options.fetchImpl,
      options.signal,
    );
  } catch (cause) {
    throw new MonitoringTargetRecordError("project-read", cause);
  }

  try {
    await recordRegisteredTarget(folderPathsIn(options.cwd).config, {
      project,
      agent: { id: options.target.id, name: options.target.name },
    });
  } catch (cause) {
    throw new MonitoringTargetRecordError("config-write", cause);
  }
}
