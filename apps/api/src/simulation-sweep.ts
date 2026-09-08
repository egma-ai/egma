import {
  settleSimulationsPastTheAgentPovBound,
  sweepOrphanedSimulations,
  type SimulationPastTheAgentPovBound,
  type SweptSimulation,
} from "@egma/db";

/**
 * Periodically fail stale claimed simulations and settle completed simulations
 * past the agent POV wait bound. Each operation has its own error handling.
 * Guarded database updates allow replicas to run the same sweep.
 *
 * Delay the first tick by one interval to give simulators a chance to renew
 * heartbeats after an API restart. Skip ticks while a previous tick is running.
 */

/**
 * How often the sweep runs. Near thirty seconds: fast enough that an orphan
 * is named within about three minutes of its simulator dying (the staleness
 * window plus one cadence), slow enough that the queue query is nothing
 * against real traffic.
 */
export const SWEEP_INTERVAL_MILLISECONDS = 30_000;

/** The rows named when one sweep moves silent simulations to failed. */
export type SweptSimulationsLogDetails = {
  readonly simulationIds: readonly (SweptSimulation["id"])[];
  readonly runIds: readonly (SweptSimulation["runId"])[];
};

/** The fault named when one sweep cannot reach its store. */
export type OrphanSweepFailureLogDetails = {
  readonly err: unknown;
};

/** The two things the loop ever says, shaped so a test can hand in its own. */
export type OrphanSweepLog = {
  info(details: SweptSimulationsLogDetails, message: string): void;
  error(details: OrphanSweepFailureLogDetails, message: string): void;
};

export type OrphanSweepOptions = {
  readonly log: OrphanSweepLog;
  /** The cadence, for a test that cannot watch a real clock. */
  readonly intervalMilliseconds?: number;
  /**
   * The seam under the loop — what one tick runs. The default is the real
   * sweep, and the product never passes anything else; a test hands in its
   * own to hold a tick open or fail one on cue, which no real store does.
   */
  readonly sweep?: () => Promise<readonly SweptSimulation[]>;
  /**
   * The other seam, on the same terms: which completed simulations waited out
   * the bound on the agent's own POV. The default is the real one.
   */
  readonly settleAgentPovBound?: () => Promise<
    readonly SimulationPastTheAgentPovBound[]
  >;
  /** Reconcile hosted voice compute on the same cadence. */
  readonly wakeVoiceFleet?: (() => void) | undefined;
};

export type OrphanSweep = {
  /**
   * The only thing to do with the handle: the server is closing. Settles when
   * any tick already in flight has finished, so a caller that awaits it can
   * tear the store down knowing the sweep holds no connection to it.
   */
  stop(): Promise<void>;
};

export function startOrphanSweep(options: OrphanSweepOptions): OrphanSweep {
  const interval = options.intervalMilliseconds ?? SWEEP_INTERVAL_MILLISECONDS;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error("a sweep cadence is a positive whole number of milliseconds");
  }

  const sweep = options.sweep ?? sweepOrphanedSimulations;
  const settleAgentPovBound =
    options.settleAgentPovBound ?? settleSimulationsPastTheAgentPovBound;

  // True from the moment a tick is called — synchronously, before its first
  // await — until it settles, so the timer callback's read of it can never
  // interleave with the write.
  let sweeping = false;
  const tick = async (): Promise<void> => {
    sweeping = true;
    try {
      const swept = await sweep();
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
    }

    // **Its own attempt, because these are two duties.** They share a tick to
    // save a timer, not because either depends on the other — so one silence
    // failing to be read must never leave the other unread.
    try {
      // A conversation graded without the agent's own account of it is news:
      // the record says so, and an operator reading this line knows an
      // exporter or a pull is not delivering. The rest of what a tick settles
      // is a handoff the drain began and did not finish, which is worth the
      // same line and a different number.
      const bounded = await settleAgentPovBound();
      if (bounded.length > 0) {
        const without = bounded.filter(
          (simulation) => !simulation.agentPovFiled,
        ).length;
        options.log.info(
          {
            simulationIds: bounded.map((simulation) => simulation.id),
            runIds: [...new Set(bounded.map((simulation) => simulation.runId))],
          },
          `settled the agent-POV wait for ${bounded.length} simulation(s), ` +
            `${without} of them graded without one`,
        );
      }
    } catch (fault) {
      options.log.error(
        { err: fault },
        "the agent-POV bound could not be read; simulations waiting on one stay put until a sweep reaches them",
      );
    } finally {
      sweeping = false;
    }
  };

  // Kept so `stop` can wait a started tick out. `tick` settles rather than
  // throwing — every fault is caught and logged inside it — so holding the
  // latest promise is holding a completion, never an error to re-raise.
  let inFlight: Promise<void> = Promise.resolve();
  options.wakeVoiceFleet?.();
  const timer = setInterval(() => {
    // Fleet demand changes independently of orphan cleanup. Keep its cadence
    // even while a database sweep is still waiting on the store.
    options.wakeVoiceFleet?.();
    // A sweep that outlives the cadence — a stalled store, mostly — is
    // skipped over, not piled on: the next tick after it returns will see
    // everything this one would have. The skip has to happen *here*, before
    // the assignment, because it is the assignment that must not run — a
    // skipped tick's already-settled promise would overwrite the running
    // sweep's, and `stop` would resolve while the store was still being
    // swept.
    if (sweeping) return;
    inFlight = tick();
  }, interval);
  // A shutdown must never wait on a sweep that has not happened yet: the
  // timer holds nothing open, and the rows it would have swept are exactly
  // as swept by the next replica, or by this one when it returns.
  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      await inFlight;
    },
  };
}
