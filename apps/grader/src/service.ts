import {
  claimGradingJobs,
  finishGradingJob,
  recordGradingHeartbeat,
  releaseGradingJob,
  watchGradingWork,
  type GradingClaim,
  type Listening,
} from "@egma/db";

import type { Config } from "./config.ts";
import { gradeClaim } from "./grade.ts";
import type { JudgeMakers } from "./judge/index.ts";
import { saying, type Log } from "./log.ts";

/**
 * The service: claim, judge, finish, and wait to be woken.
 *
 * **Every arrow points out.** It listens on nothing, publishes no port and has
 * no inbound surface at all — it dials Postgres and the trace store and nothing
 * dials it. Scaling it is running more copies: they claim from one queue with
 * `SKIP LOCKED` underneath and distribute between themselves with nothing in
 * front of them. That is the dispatch shape the simulator proved, on the other
 * side of the wire.
 *
 * **Nothing here is on a timer that a verdict has to wait for.** A conversation
 * ending raises a notification inside the transaction that ends it, this wakes,
 * and it claims. The interval below is the backstop for a notification nobody
 * was listening for — a copy restarting, a connection that dropped — and no
 * verdict's latency depends on it in the ordinary case. There is no latency
 * promise anywhere in this product, and this is what makes the absence of one
 * honest rather than convenient.
 */
export type Service = {
  /** Runs until `stop` is called; resolves when the last job has landed. */
  readonly finished: Promise<void>;
  stop(): void;
};

export type ServiceOptions = {
  readonly config: Config;
  readonly log: Log;
  /**
   * Told after each pass, so a test can watch the service work instead of
   * sleeping. Never used in a deployment, and the service does not read it.
   */
  readonly onIdle?: (() => void) | undefined;
  /**
   * How each judge provider is spoken to. Absent means the real ones — which is
   * every deployment. **The judge is a seam**, and this is it: a test hands over
   * a scripted judge that answers deterministically from memory, so per-behavior
   * fan-out, the skipped denominator and one-call-failed-and-its-siblings-did-not
   * are all asserted with no key and no network anywhere under them.
   */
  readonly makers?: JudgeMakers | undefined;
};

export function startService(options: ServiceOptions): Service {
  const { config, log } = options;

  let running = true;
  let woken = false;
  let wake: (() => void) | undefined;
  let watching: Listening | undefined;

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

  const finished = (async (): Promise<void> => {
    watching = await watchGradingWork(nudge);
    log.info("listening for finished conversations", {
      capacity: config.capacity,
    });

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
        log.error("could not claim grading work", { error: saying(error) });
      }

      if (claimed.length > 0) {
        log.debug("claimed", { jobs: claimed.length });
        await Promise.all(claimed.map((claim) => holdAndGrade(claim, options)));
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
      nudge();
    },
  };
}

/**
 * One job, held and judged.
 *
 * The heartbeat runs beside the judging rather than after it, because judging
 * will one day be several model calls and a copy that only said it was alive
 * when it finished would lose every long job it started. A copy that fails
 * releases the job at once with the reason on it: the queue does not have to
 * wait out a silence that is not happening, and the attempt is already counted
 * so a conversation that breaks three copies is abandoned rather than retried
 * forever.
 */
async function holdAndGrade(
  claim: GradingClaim,
  options: ServiceOptions,
): Promise<void> {
  const { config, log } = options;

  const beating = setInterval(() => {
    void recordGradingHeartbeat(claim.auth, claim.id, config.claimant).catch(
      (error: unknown) => {
        log.warn("a heartbeat did not land", {
          job: claim.id,
          error: saying(error),
        });
      },
    );
  }, config.heartbeatSeconds * 1000);
  beating.unref();

  try {
    const graded = await gradeClaim(claim, { makers: options.makers });
    // The verdicts are written before the job is finished, in that order and
    // not the other way round. Between the two this copy could lose the job to
    // an expired lease, and another copy would judge the same conversation
    // again — which costs nothing, because the same judgment at the same grader
    // version replaces rather than doubles. Finishing first would risk the
    // opposite: a job marked judged with nothing written under it.
    await finishGradingJob(claim.auth, claim.id, config.claimant);
    log.info("judged a conversation", {
      job: claim.id,
      simulation: graded.simulationId,
      graders: graded.graders,
      verdicts: graded.verdicts,
    });
  } catch (error) {
    log.error("could not judge a conversation", {
      job: claim.id,
      attempt: claim.attempts,
      error: saying(error),
    });
    await releaseGradingJob(
      claim.auth,
      claim.id,
      config.claimant,
      saying(error),
    ).catch((releasing: unknown) => {
      // The lease is the backstop under this: a job nobody could release is
      // claimable again the moment the copy holding it stops answering.
      log.warn("could not release the job either", {
        job: claim.id,
        error: saying(releasing),
      });
      return undefined;
    });
  } finally {
    clearInterval(beating);
  }
}
