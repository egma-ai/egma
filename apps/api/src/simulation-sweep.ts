import { sweepOrphanedSimulations } from "@egma/db";

/**
 * The standing orphan sweep: what notices a dead simulator.
 *
 * Everything else about a simulation's lifecycle is written by somebody's
 * request — a claim, a beat, a report. A simulator that died mid-conversation
 * sends none of those, so the one honest record it leaves is silence, and
 * silence has to be read on a clock. This loop reads it: every interval, one
 * call to the seam that marks every simulation silent past the staleness
 * window `failed` with reason `orphaned` and finalizes the runs that were
 * waiting on them.
 *
 * **Every replica runs one, and nothing elects a leader.** That is safe
 * because the seam itself makes racing sweeps collide harmlessly — the
 * guarded update ends each row exactly once and whoever arrives second finds
 * nothing to do — so a second API replica costs duplicate reads, never
 * duplicate records.
 *
 * **The first sweep waits a whole interval on purpose.** An API that was
 * unreachable for longer than the staleness window comes back to rows whose
 * heartbeats all look ancient — not because their simulators died, but
 * because every beat they sent hit a closed door. Those simulators are still
 * conducting and still beating every few seconds, so one interval of
 * accepting requests is what lets every living row be stamped fresh before
 * the first sweep reads its silence.
 */

/**
 * How often the sweep runs. Near thirty seconds: fast enough that an orphan
 * is named within about three minutes of its simulator dying (the staleness
 * window plus one cadence), slow enough that the queue query is nothing
 * against real traffic.
 */
export const SWEEP_INTERVAL_MILLISECONDS = 30_000;

/** The two things the loop ever says, shaped so a test can hand in its own. */
type SweepLog = {
  info(details: object, message: string): void;
  error(details: object, message: string): void;
};

export type OrphanSweepOptions = {
  readonly log: SweepLog;
  /** The cadence, for a test that cannot watch a real clock. */
  readonly intervalMilliseconds?: number;
};

export type OrphanSweep = {
  /** The only thing to do with the handle: the server is closing. */
  stop(): void;
};

export function startOrphanSweep(options: OrphanSweepOptions): OrphanSweep {
  const interval = options.intervalMilliseconds ?? SWEEP_INTERVAL_MILLISECONDS;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error("a sweep cadence is a positive whole number of milliseconds");
  }

  let sweeping = false;
  const tick = async (): Promise<void> => {
    // A sweep that outlives the cadence — a stalled store, mostly — must not
    // have a second one piled on top of it; the next tick after it returns
    // will see everything this one would have.
    if (sweeping) return;
    sweeping = true;
    try {
      const swept = await sweepOrphanedSimulations();
      // A quiet queue is the ordinary case and is not news; what was swept
      // is, by name, because each of these rows is a conversation somebody
      // is waiting on and this line is where its ending is first visible.
      if (swept.length > 0) {
        options.log.info(
          {
            simulationIds: swept.map((simulation) => simulation.id),
            runIds: [...new Set(swept.map((simulation) => simulation.runId))],
          },
          `swept ${swept.length} orphaned simulation(s) whose simulator went silent`,
        );
      }
    } catch (fault) {
      // A store this loop cannot reach is an ordinary Tuesday, and the rows
      // it would have swept keep waiting for the next tick. Ending the loop
      // is the one cost nothing here is worth.
      options.log.error(
        { err: fault },
        "the orphan sweep failed; silent simulations stay put until a sweep reaches them",
      );
    } finally {
      sweeping = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, interval);
  // A shutdown must never wait on a sweep that has not happened yet: the
  // timer holds nothing open, and the rows it would have swept are exactly
  // as swept by the next replica, or by this one when it returns.
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
