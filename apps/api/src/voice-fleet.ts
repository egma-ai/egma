export type DaytonaVoiceFleetSettings = {
  readonly kind: "daytona";
  readonly apiUrl?: string;
  readonly apiKey: string;
  readonly target?: string;
  readonly snapshot: string;
  readonly releaseSha: string;
  readonly ttlMinutes: number;
  readonly serviceTokenSecret: string;
  readonly providerSecrets: Readonly<Record<string, string>>;
  readonly controlPlaneUrl: string;
  readonly livekitUrl: string;
  readonly livekitApiKey: string;
  readonly livekitApiSecret: string;
  readonly s3Endpoint: string;
  readonly s3Bucket: string;
  readonly s3Region: string;
  readonly recordingRoleArn: string;
};

export type VoiceFleetSettings = DaytonaVoiceFleetSettings;

export type VoiceFleetTask = {
  readonly id: string;
};

export type VoiceFleetLaunchFailure = {
  readonly reason: string;
  readonly detail?: string;
};

export type VoiceFleetLaunchResult = {
  readonly tasks: readonly VoiceFleetTask[];
  readonly failures: readonly VoiceFleetLaunchFailure[];
};

/** The cloud-specific edge. Demand accounting does not depend on Daytona. */
export type VoiceFleet = {
  listTasks(): Promise<readonly VoiceFleetTask[]>;
  launchTasks(options: {
    readonly count: number;
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
  readonly initialBackoffMilliseconds?: number;
  readonly maximumBackoffMilliseconds?: number;
  readonly now?: () => number;
};

export type VoiceFleetReconcileResult = {
  readonly desired: number;
  readonly present: number;
  readonly launched: number;
  readonly skipped: "overlap" | "backoff" | undefined;
};

/** Coalesce wake-ups while preserving one that arrives during a failed pass. */
export function createVoiceFleetWake(options: {
  readonly reconcile: () => Promise<unknown> | undefined;
  readonly failed: (error: unknown) => void;
}): () => void {
  let running = false;
  let requested = false;
  return () => {
    requested = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        do {
          requested = false;
          try {
            await options.reconcile();
          } catch (error) {
            options.failed(error);
          }
        } while (requested);
      } finally {
        running = false;
      }
    })();
  };
}

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
  let retryAt = 0;
  let nextBackoff = initialBackoffMilliseconds;

  const empty = (
    skipped: VoiceFleetReconcileResult["skipped"],
  ): VoiceFleetReconcileResult => ({
    desired: 0,
    present: 0,
    launched: 0,
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

        const tasks = new Map<string, VoiceFleetTask>();
        for (const task of listed) tasks.set(task.id, task);
        const desired = demand.active + demand.admissibleQueued;
        const present = tasks.size;
        const missing = Math.max(0, desired - present);
        let launched = 0;
        const failures: VoiceFleetLaunchFailure[] = [];

        if (missing > 0) {
          try {
            const result = await options.fleet.launchTasks({ count: missing });
            launched += result.tasks.length;
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
          if (launched > 0) {
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
