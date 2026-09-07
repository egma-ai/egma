import {
  claimGradingJobs,
  finishGradingJob,
  recordGradingHeartbeat,
  releaseGradingJob,
  watchGradingWork,
  type GradingClaim,
  type Listening,
} from "@egma/db";
import type { ProviderCredentialSource } from "@egma/provider-credentials";
import { SpanStatusCode, trace } from "@opentelemetry/api";

import type { Config } from "./config.ts";
import { gradeClaim, NotGradable } from "./grade.ts";
import type { JudgeMakers } from "./judge/index.ts";
import {
  platformEvent,
  safeExceptionType,
  saying,
  type Log,
} from "./log.ts";

const tracer = trace.getTracer("@egma/grader");

/** Opaque joins shared by every event about one grading job. */
function claimAttributes(
  claim: GradingClaim,
): Readonly<Record<string, string | number>> {
  return {
    "egma.grading_job_id": claim.id,
    "egma.organization_id": claim.organizationId,
    "egma.project_id": claim.projectId,
    "egma.source": claim.source,
    "egma.attempt": claim.attempts,
    ...(claim.simulationId === null
      ? {}
      : { "egma.simulation_id": claim.simulationId }),
    "egma.trace_id": claim.traceId,
  };
}

/**
 * Claim grading jobs from Postgres, grade them, and wait for notifications.
 * SKIP LOCKED allows multiple workers; this service has no inbound port.
 * Polling recovers missed notifications. Work is requested only after
 * completion and query-visible evidence agree.
 */
export type Service = {
  /** Runs until `stop` is called; resolves when the last job has landed. */
  readonly finished: Promise<void>;
  stop(): void;
};

export type ServiceOptions = {
  readonly config: Config;
  readonly log: Log;
  /** Read fresh once when a claimed job resolves at least one model grader. */
  readonly providerCredentials: ProviderCredentialSource;
  /** Test hook after each pass; not used by deployments. */
  readonly onIdle?: (() => void) | undefined;
  /**
   * Provider implementations. Defaults to live providers; tests supply
   * deterministic judges without network access.
   */
  readonly makers?: JudgeMakers | undefined;
};

/**
 * Keep a still-arriving job claimed during backoff, then release it.
 * Immediate release could exhaust its retry budget through rapid claims
 * by other workers before the evidence becomes visible.
 */
type Pacing = {
  /** Resolve after the backoff, or at once when the service is stopping. */
  hold(): Promise<void>;
};

export function startService(options: ServiceOptions): Service {
  const { config, log } = options;

  let running = true;
  let woken = false;
  let wake: (() => void) | undefined;
  let watching: Listening | undefined;
  /** Cancels for the holds in flight, so `stop` can end every one at once. */
  const activeHolds = new Set<() => void>();

  /**
   * Wake the claim loop after a notification or fallback poll. The next claim
   * query decides which jobs are available.
   */
  const nudge = (): void => {
    woken = true;
    wake?.();
  };

  /** Sleep until nudged, and no longer than the backstop. */
  const waitForWork = async (): Promise<void> => {
    if (woken) {
      woken = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const settle = (): void => {
        clearTimeout(timer);
        wake = undefined;
        woken = false;
        resolve();
      };
      const timer = setTimeout(settle, config.sweepSeconds * 1000);
      timer.unref();
      wake = settle;
    });
  };

  // Use the validated sweep interval for still-arriving evidence backoff.
  const backoffMilliseconds = config.sweepSeconds * 1000;

  /** Sleep for the backoff, or return at once when the service is stopping. */
  const holdBeforeRetry = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!running) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        activeHolds.delete(done);
        resolve();
      };
      const timer = setTimeout(done, backoffMilliseconds);
      timer.unref();
      activeHolds.add(done);
    });

  const pacing: Pacing = { hold: holdBeforeRetry };

  const finished = (async (): Promise<void> => {
    watching = await watchGradingWork(nudge, (error: unknown) => {
      log.warn(
        platformEvent("egma.grading_listener.failed", {
          "error.type": "grading_listener_failed",
          "exception.type": safeExceptionType(error),
        }),
        "grader work listener failed; reconnecting",
      );
    });
    log.info(
      platformEvent("egma.service.started", { capacity: config.capacity }),
      "grader service started",
    );

    while (running) {
      let claimed: readonly GradingClaim[] = [];
      try {
        claimed = await claimGradingJobs({
          claimant: config.claimant,
          capacity: config.capacity,
          leaseSeconds: config.leaseSeconds,
        });
      } catch (error) {
        // The control plane is unreachable or refused. Say so once and wait;
        // there is nothing held, so there is nothing to lose by waiting.
        log.error(
          platformEvent("egma.grading_job.claim_failed", {
            "error.type": "grading_job_claim_failed",
            "exception.type": safeExceptionType(error),
          }),
          "grader could not claim work",
        );
      }

      if (claimed.length > 0) {
        await Promise.all(
          claimed.map((claim) => holdAndGrade(claim, options, pacing)),
        );
        // A full claim may leave more queued work; claim again without waiting.
        if (claimed.length === config.capacity) woken = true;
      }

      options.onIdle?.();
      if (!running) break;
      await waitForWork();
    }
  })().finally(async () => {
    await watching?.close();
  });

  return {
    finished,
    stop() {
      running = false;
      // End every hold in flight at once, so a held job is released now rather
      // than after a full backoff and shutdown never waits one out.
      for (const cancel of [...activeHolds]) cancel();
      nudge();
    },
  };
}

/**
 * Heartbeat while grading so long model requests retain the job lease.
 * On failure, release the job with its reason; the counted retry budget
 * prevents endless retries.
 */
async function holdAndGrade(
  claim: GradingClaim,
  options: ServiceOptions,
  pacing: Pacing,
): Promise<void> {
  await tracer.startActiveSpan(
    "egma.grading_job.process",
    { attributes: claimAttributes(claim) },
    async (span) => {
      try {
        await gradeHeldClaim(claim, options, pacing);
      } finally {
        span.end();
      }
    },
  );
}

/** One claimed job while its platform trace is active. */
async function gradeHeldClaim(
  claim: GradingClaim,
  options: ServiceOptions,
  pacing: Pacing,
): Promise<void> {
  const { config, log } = options;
  const about = claimAttributes(claim);

  log.info(
    platformEvent("egma.grading_job.claimed", about),
    "grading job claimed",
  );

  const beating = setInterval(() => {
    void recordGradingHeartbeat(claim.auth, claim.id, config.claimant).catch(
      (error: unknown) => {
        log.warn(
          platformEvent("egma.grading_job.heartbeat_failed", {
            ...about,
            "error.type": "grading_job_heartbeat_failed",
            "exception.type": safeExceptionType(error),
          }),
          "grading job heartbeat failed",
        );
      },
    );
  }, config.heartbeatSeconds * 1000);
  beating.unref();

  try {
    const graded = await gradeClaim(claim, {
      providerCredentials: options.providerCredentials,
      ...(options.makers === undefined ? {} : { makers: options.makers }),
    });
    // Append grades before deleting the job so a crash cannot lose both.
    // An expired lease may cause another append; reads select the latest grade
    // per project grader.
    const finished = await finishGradingJob(
      claim.auth,
      claim.id,
      config.claimant,
    );
    if (finished === undefined) {
      throw new Error(`grading job ${claim.id} was no longer held at cleanup`);
    }
    log.info(
      platformEvent("egma.grading_job.finished", {
        ...about,
        "egma.outcome": "succeeded",
        grader_count: graded.graders,
        grade_count: graded.grades,
      }),
      "grading job finished",
    );
  } catch (error) {
    const stillArriving = error instanceof NotGradable;
    if (stillArriving) {
      // Keep the job leased while evidence arrives. The claim has already consumed
      // one retry; heartbeat through backoff before releasing it.
      log.info(
        platformEvent("egma.grading_job.deferred", about),
        "grading job deferred while its evidence drains",
      );

      await pacing.hold();
    } else {
      const span = trace.getActiveSpan();
      span?.setAttribute("error.type", "grading_job_failed");
      span?.setStatus({ code: SpanStatusCode.ERROR });
      log.error(
        platformEvent("egma.grading_job.finished", {
          ...about,
          "egma.outcome": "failed",
          "error.type": "grading_job_failed",
          "exception.type": safeExceptionType(error),
        }),
        "grading job failed",
      );
    }
    await releaseGradingJob(
      claim.auth,
      claim.id,
      config.claimant,
      saying(error),
    ).catch((releasing: unknown) => {
      // The lease is the backstop under this: a job nobody could release is
      // claimable again the moment the copy holding it stops answering.
      log.warn(
        platformEvent("egma.grading_job.release_failed", {
          ...about,
          "error.type": "grading_job_release_failed",
          "exception.type": safeExceptionType(releasing),
        }),
        "grading job could not be released",
      );
      return undefined;
    });
  } finally {
    clearInterval(beating);
  }
}
