export type VoiceTaskMode = "one-shot" | "standby";

export type AwsVoiceFleetSettings = {
  readonly kind: "aws-ecs";
  readonly cluster: string;
  readonly taskDefinition: string;
  readonly containerName: string;
  readonly subnets: readonly string[];
  readonly securityGroups: readonly string[];
};

export type VoiceFleetTask = {
  readonly id: string;
  readonly mode: VoiceTaskMode;
};

export type VoiceFleetLaunchFailure = {
  readonly reason: string;
  readonly detail?: string;
};

export type VoiceFleetLaunchResult = {
  readonly tasks: readonly VoiceFleetTask[];
  readonly failures: readonly VoiceFleetLaunchFailure[];
};

/** The cloud-specific edge. Tests and the launcher itself need no AWS package. */
export type VoiceFleet = {
  listTasks(): Promise<readonly VoiceFleetTask[]>;
  launchTasks(options: {
    readonly count: number;
    readonly mode: VoiceTaskMode;
  }): Promise<VoiceFleetLaunchResult>;
};

export type VoiceSimulationDemand = {
  readonly active: number;
  readonly admissibleQueued: number;
};

export type VoiceFleetLog = {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
};

export type VoiceFleetReconcilerOptions = {
  readonly fleet: VoiceFleet;
  readonly estimateDemand: () => Promise<VoiceSimulationDemand>;
  readonly log: VoiceFleetLog;
  readonly standbyTarget?: number;
  readonly recentLaunchMilliseconds?: number;
  readonly initialBackoffMilliseconds?: number;
  readonly maximumBackoffMilliseconds?: number;
  readonly now?: () => number;
};

export type VoiceFleetReconcileResult = {
  readonly desired: Readonly<Record<VoiceTaskMode, number>>;
  readonly present: Readonly<Record<VoiceTaskMode, number>>;
  readonly launched: Readonly<Record<VoiceTaskMode, number>>;
  readonly skipped: "overlap" | "backoff" | undefined;
};

type RecentLaunch = VoiceFleetTask & { readonly launchedAt: number };

const DEFAULT_STANDBY_TARGET = 2;
const DEFAULT_RECENT_LAUNCH_MILLISECONDS = 60_000;
const DEFAULT_INITIAL_BACKOFF_MILLISECONDS = 1_000;
const DEFAULT_MAXIMUM_BACKOFF_MILLISECONDS = 30_000;

function wholeNonnegative(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative whole number`);
  }
  return value;
}

/**
 * Reconcile voice compute to queue demand. A launch wakes a simulator; the
 * claim transaction remains the only assignment of a simulation to it.
 */
export function createVoiceFleetReconciler(
  options: VoiceFleetReconcilerOptions,
): { reconcile(): Promise<VoiceFleetReconcileResult> } {
  const standbyTarget = wholeNonnegative(
    options.standbyTarget ?? DEFAULT_STANDBY_TARGET,
    "the standby target",
  );
  const recentLaunchMilliseconds = wholeNonnegative(
    options.recentLaunchMilliseconds ?? DEFAULT_RECENT_LAUNCH_MILLISECONDS,
    "the recent-launch window",
  );
  const initialBackoffMilliseconds = wholeNonnegative(
    options.initialBackoffMilliseconds ?? DEFAULT_INITIAL_BACKOFF_MILLISECONDS,
    "the initial launch backoff",
  );
  const maximumBackoffMilliseconds = wholeNonnegative(
    options.maximumBackoffMilliseconds ?? DEFAULT_MAXIMUM_BACKOFF_MILLISECONDS,
    "the maximum launch backoff",
  );
  if (initialBackoffMilliseconds > maximumBackoffMilliseconds) {
    throw new Error("the initial launch backoff cannot exceed its maximum");
  }

  const now = options.now ?? Date.now;
  let reconciling = false;
  let recent: RecentLaunch[] = [];
  let retryAt = 0;
  let nextBackoff = initialBackoffMilliseconds;

  const empty = (
    skipped: VoiceFleetReconcileResult["skipped"],
  ): VoiceFleetReconcileResult => ({
    desired: { "one-shot": 0, standby: 0 },
    present: { "one-shot": 0, standby: 0 },
    launched: { "one-shot": 0, standby: 0 },
    skipped,
  });

  return {
    async reconcile() {
      if (reconciling) {
        options.log.info({}, "voice fleet reconciliation skipped because one is already running");
        return empty("overlap");
      }

      const startedAt = now();
      if (startedAt < retryAt) {
        options.log.info(
          { retryAt, retryInMilliseconds: retryAt - startedAt },
          "voice fleet reconciliation is waiting after a launch failure",
        );
        return empty("backoff");
      }

      reconciling = true;
      try {
        const [demand, listed] = await Promise.all([
          options.estimateDemand(),
          options.fleet.listTasks(),
        ]);
        wholeNonnegative(demand.active, "active voice demand");
        wholeNonnegative(demand.admissibleQueued, "queued voice demand");

        const observedAt = now();
        recent = recent.filter(
          (task) => observedAt - task.launchedAt < recentLaunchMilliseconds,
        );

        // ECS may begin listing a task before the local ledger expires. Its
        // stable task ARN is the identity, so the task counts once here.
        const tasks = new Map<string, VoiceFleetTask>();
        for (const task of recent) tasks.set(task.id, task);
        for (const task of listed) tasks.set(task.id, task);

        const desiredWork = demand.active + demand.admissibleQueued;
        const desiredTotal = desiredWork + standbyTarget;
        const present = { "one-shot": 0, standby: 0 };
        for (const task of tasks.values()) present[task.mode] += 1;
        const presentTotal = present["one-shot"] + present.standby;
        const missingTotal = Math.max(0, desiredTotal - presentTotal);
        // A standby keeps its launch mode after it claims. Active simulations
        // may therefore occupy the standby-labelled tasks; subtract them when
        // deciding how much waiting capacity remains. This is only launch
        // arithmetic and never binds an active row to a particular task.
        const waitingStandbys = Math.max(0, present.standby - demand.active);
        const missingStandbys = Math.max(0, standbyTarget - waitingStandbys);
        const standbyLaunches = Math.min(missingTotal, missingStandbys);
        const desired = {
          "one-shot": present["one-shot"] + missingTotal - standbyLaunches,
          standby: present.standby + standbyLaunches,
        } as const;
        const launched = { "one-shot": 0, standby: 0 };
        const failures: VoiceFleetLaunchFailure[] = [];

        for (const mode of ["one-shot", "standby"] as const) {
          const missing = desired[mode] - present[mode];
          if (missing === 0) continue;
          try {
            const result = await options.fleet.launchTasks({ count: missing, mode });
            const launchedAt = now();
            recent.push(
              ...result.tasks.map((task) => ({ ...task, launchedAt })),
            );
            launched[mode] += result.tasks.length;
            failures.push(...result.failures);
          } catch (err) {
            failures.push({
              reason: "launch_request_failed",
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (failures.length > 0) {
          retryAt = now() + nextBackoff;
          options.log.error(
            { failures, retryAt, launched, desired, present },
            "voice fleet tasks could not all be launched; queued work will retry",
          );
          nextBackoff = Math.min(
            Math.max(initialBackoffMilliseconds, nextBackoff * 2),
            maximumBackoffMilliseconds,
          );
        } else {
          retryAt = 0;
          nextBackoff = initialBackoffMilliseconds;
          if (launched["one-shot"] + launched.standby > 0) {
            options.log.info(
              { launched, desired, present },
              "voice fleet reconciled to admissible work",
            );
          }
        }

        return { desired, present, launched, skipped: undefined };
      } finally {
        reconciling = false;
      }
    },
  };
}
