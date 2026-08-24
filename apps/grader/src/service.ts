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
 * The service: claim, grade, finish, and wait to be woken.
 *
 * **Every arrow points out.** It listens on nothing, publishes no port and has
 * no inbound surface at all — it dials Postgres and the trace store and nothing
 * dials it. Scaling it is running more copies: they claim from one queue with
 * `SKIP LOCKED` underneath and distribute between themselves with nothing in
 * front of them. That is the dispatch shape the simulator proved, on the other
 * side of the wire.
 *
 * **Nothing here waits for a polling interval.** `requestGrading` raises a
 * notification only after completion and query-visible evidence agree. The
 * interval below is only a backstop for a notification nobody heard during a
 * restart or dropped connection. The durable Postgres row is still the truth.
 *
 * Production work reaches this service only after a supported platform states
 * that the conversation ended and ingestion states that its evidence is
 * query-visible. A root span or silence never creates work here.
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
  /**
   * Told after each pass, so a test can watch the service work instead of
   * sleeping. Never used in a deployment, and the service does not read it.
   */
  readonly onIdle?: (() => void) | undefined;
  /**
   * How each model-grading provider is spoken to. Absent means the real ones —
   * which is every deployment. This is the provider seam: a test hands over a
   * scripted implementation that answers deterministically from memory, so
   * per-behavior fan-out, score normalization, and one failed call beside
   * successful siblings are all asserted with no key and no network.
   */
  readonly makers?: JudgeMakers | undefined;
};

/**
 * How the loop paces a claim it had to decline because the conversation is not
 * all here yet.
 *
 * A still-arriving claim is held before it is claimable again, rather than
 * released at once: without the hold a run whose simulations all land together
 * would spend its whole retry budget in one hot burst — the capacity shortcut
 * re-claiming the instant every worker declines — and write durable error
 * grades during the exact cold start the retry exists to survive. The hold is
 * the sweep interval, so the retries fall on the clock the backstop already
 * runs on; the job is claimed throughout it, so no other worker takes it, and
 * it is released to the queue only once the hold is over.
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
   * Something may be claimable. Two things arrive here — a notification and the
   * backstop — and neither says what: the claim is a query that sees everything
   * outstanding, so a nudge is all either of them has to carry.
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

  // The sweep is a positive whole number of seconds, so this is at least the
  // second a test sets it to. A still-arriving claim waits this before it is
  // released.
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
    watching = await watchGradingWork(nudge);
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
        // A full claim means the queue may hold more, so ask again before
        // sleeping — otherwise a burst of two hundred conversations would be
        // drained one backstop interval at a time.
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
 * One job, held and graded.
 *
 * The heartbeat runs beside grading rather than after it, because grading will
 * one day be several model calls and a worker that only said it was alive when
 * it finished would lose every long job it started. A worker that fails
 * releases the job at once with the reason on it: the queue does not have to
 * wait out a silence that is not happening, and the attempt is already counted
 * so a conversation that breaks three workers is abandoned rather than retried
 * forever.
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
    // The grades are written before the temporary job is deleted, in that order and
    // not the other way round. Between the two this worker could lose the job to
    // an expired lease, and another worker could grade the same conversation
    // again. Each retry appends history; the read path picks the latest result
    // for each project grader. Deleting first would risk the opposite: no work
    // row and no durable grade.
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
      // Not a failure: the conversation is not all here yet, and asking again is
      // the whole answer. The job is held before it is claimable again — for the
      // sweep interval — so a run whose simulations all land together retries on
      // the backstop clock instead of spending its budget the instant the trace
      // store is cold. The attempt is already counted on the claim, so the
      // budget still ends; the heartbeat keeps the lease while the job is held.
      log.info(
        platformEvent("egma.grading_job.deferred", about),
        "grading job deferred while its evidence drains",
      );
      // Held for the sweep interval before it is released back to the queue.
      // The next claim comes on the backstop sweep, or at once from the capacity
      // shortcut when the batch was full — either way the retries are a sweep
      // apart rather than a hot loop.
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
