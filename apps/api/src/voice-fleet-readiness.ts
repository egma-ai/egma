import type { VoiceFleetTask } from "./voice-fleet.ts";

export type VoiceFleetIdentity = {
  readonly taskArn: string;
  readonly taskDefinition: string;
};
type Observation = VoiceFleetIdentity & { state: "ready" | "busy"; seenAt: number };
const READY_FRESH_MILLISECONDS = 40_000;
const REPLACE_AFTER_MILLISECONDS = 28 * 60_000;

/** Observations expire; ECS remains the source of task existence. */
export function createVoiceFleetReadiness(options: {
  taskDefinition: string;
  standbyTarget?: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const standbyTarget = options.standbyTarget ?? 2;
  const observations = new Map<string, Observation>();
  let listed: readonly VoiceFleetTask[] = [];
  const current = (task: VoiceFleetTask) => task.taskDefinition === options.taskDefinition;
  const aging = (task: VoiceFleetTask) =>
    task.createdAt !== undefined &&
    now() - task.createdAt >= REPLACE_AFTER_MILLISECONDS;
  const observed = (task: VoiceFleetTask) => {
    const entry = observations.get(task.id);
    return entry?.state === "busy" ||
      (entry !== undefined && now() - entry.seenAt < READY_FRESH_MILLISECONDS)
      ? entry
      : undefined;
  };
  const ready = (task: VoiceFleetTask) =>
    task.mode === "standby" &&
    current(task) &&
    !aging(task) &&
    observed(task)?.state === "ready";
  const snapshot = () => ({
    taskDefinition: options.taskDefinition,
    standbyTarget,
    readyStandbys: listed.filter(ready).length,
    starting: listed.filter(
      (task) => current(task) && !aging(task) && observed(task) === undefined,
    ).length,
  });
  return {
    snapshot,
    identity(value: unknown): VoiceFleetIdentity | undefined {
      if (value === null || typeof value !== "object") return undefined;
      const data = value as Record<string, unknown>;
      if (
        typeof data.taskArn !== "string" ||
        typeof data.taskDefinition !== "string"
      ) {
        return undefined;
      }
      // Only task identities from this configured account, region and family.
      const prefix = options.taskDefinition.split(":task-definition/")[0];
      const family = options.taskDefinition.replace(/:\d+$/u, "");
      if (
        !data.taskArn.startsWith(`${prefix}:task/`) ||
        !data.taskDefinition.startsWith(`${family}:`)
      ) {
        return undefined;
      }
      return { taskArn: data.taskArn, taskDefinition: data.taskDefinition };
    },
    waiting(identity: VoiceFleetIdentity): void {
      // A duplicate request must not make a task with granted work idle again.
      if (observations.get(identity.taskArn)?.state === "busy") return;
      observations.set(identity.taskArn, { ...identity, state: "ready", seenAt: now() });
    },
    busy(identity: VoiceFleetIdentity): void {
      observations.set(identity.taskArn, { ...identity, state: "busy", seenAt: now() });
    },
    unclaimed(identity: VoiceFleetIdentity): void {
      observations.set(identity.taskArn, { ...identity, state: "ready", seenAt: now() });
    },
    shouldRetire(identity: VoiceFleetIdentity): boolean {
      const task = listed.find((item) => item.id === identity.taskArn);
      return (
        task !== undefined &&
        observed(task)?.state !== "busy" &&
        (!current(task) || aging(task)) &&
        snapshot().readyStandbys >= standbyTarget
      );
    },
    observeTasks(tasks: readonly VoiceFleetTask[]): readonly VoiceFleetTask[] {
      listed = tasks;
      const ids = new Set(tasks.map((task) => task.id));
      for (const [id, entry] of observations) {
        if (!ids.has(id) && now() - entry.seenAt > 120_000) {
          observations.delete(id);
        }
      }
      return tasks.map((task) => {
        const observation = observed(task);
        return {
          ...task,
          retiring:
            observation?.state !== "busy" && (!current(task) || aging(task)),
          ...(observation === undefined
            ? {}
            : { readiness: observation.state }),
        };
      });
    },
  };
}
export type VoiceFleetReadiness = ReturnType<typeof createVoiceFleetReadiness>;
