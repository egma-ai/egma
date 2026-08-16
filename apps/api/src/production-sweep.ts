import {
  resolveRetellWatch,
  sweepStaleProductionClaims,
  type RetellWatchTarget,
} from "@egma/db";

import { listEndedCalls, PAGE_SIZE, type RetellReach } from "./retell/api.ts";
import { replayProductionClaim, writeRetellCall } from "./retell/write.ts";

/**
 * The pull floor: what makes watching work everywhere, including on a laptop
 * behind NAT that no webhook can ever reach.
 *
 * It sits beside the orphan sweep, in the API process, on the same terms — one
 * interval, every replica runs one, nothing elects a leader, and racing sweeps
 * collide harmlessly because the ledger's unique constraint settles them.
 *
 * ## The cursor discipline, which is the whole of the correctness argument
 *
 * **Per-item checkpointing, oldest first.** Conversations are asked for in
 * end-time order and written one at a time; the persisted cursor moves to a
 * conversation only after that conversation is durably stored. The cursor is a
 * statement of fact — *everything at or before this is stored* — and never a
 * statement of intent.
 *
 * **A failure stops the sweep; the next tick is the retry.** A store that is
 * down, a Retell answering 5xx mid-page: this sweep ends where it stands for
 * that connection. The cursor still points at the last durable item, so the
 * next tick resumes exactly there. There are no retry loops inside a sweep.
 *
 * **Re-offers at the boundary are free.** The window since the cursor is
 * inclusive, so the last conversation written is offered again after a resume
 * and the ledger's claim skips it. Idempotence is what lets the cursor logic
 * stay this simple.
 *
 * **Pages are drained.** A full page means more may be waiting, so the sweep
 * asks again from the cursor it has just advanced to, and stops on a short
 * page. A burst is drained in one tick rather than one page per tick.
 *
 * **A malformed payload cannot wedge a connection.** The normalizer writes what
 * it could read, flags the trace degraded, keeps the vendor payload verbatim —
 * and the write succeeds, so the cursor moves past it. Nothing is ever ground
 * on forever.
 *
 * ## And the lease sweep, in the same tick
 *
 * A claim whose append never landed is replayed from the payload on the claim.
 * It rides this loop rather than a second one because it is the same job at a
 * different point in the same protocol, and because a second interval would be
 * a second thing to configure and forget.
 */

/**
 * How often a tick runs. The same near-thirty-second cadence the orphan sweep
 * uses, and the cadence the field has settled on for polling a managed voice
 * platform.
 */
export const PRODUCTION_SWEEP_INTERVAL_MILLISECONDS = 30_000;

/**
 * How often a connection whose webhook is delivering is polled anyway.
 *
 * **Never zero.** A webhook that silently stops must cost minutes, not the
 * conversation, so the poller drops to a safety net rather than switching off.
 */
export const SAFETY_NET_INTERVAL_MILLISECONDS = 5 * 60_000;

/**
 * How recently a delivery must have arrived for the webhook to count as
 * working. Longer than any plausible gap between conversations on a live agent
 * would be wrong in the other direction — a quiet hour is not a broken webhook
 * — so this is deliberately short and the cost of being wrong is one extra
 * poll.
 */
export const DELIVERY_FRESH_MILLISECONDS = 5 * 60_000;

/** Where a tick stops draining, so a mis-answering provider cannot loop forever. */
const MOST_PAGES_PER_TICK = 20;

/**
 * Whether this connection is polled on this tick.
 *
 * Full cadence — every tick — unless a webhook is registered *and* delivering,
 * in which case the poller is a safety net and runs on the slower interval. The
 * moment deliveries stop arriving the connection is at full cadence again,
 * with nothing to switch and nobody to notice.
 *
 * A pure function of four facts, so the rule can be exercised without a clock.
 */
export function pollsThisTick(
  target: Pick<RetellWatchTarget, "webhookRegisteredAt" | "webhookDeliveredAt">,
  lastPolledAt: number | undefined,
  now: number,
): boolean {
  const delivering =
    target.webhookRegisteredAt !== null &&
    target.webhookDeliveredAt !== null &&
    now - target.webhookDeliveredAt.getTime() < DELIVERY_FRESH_MILLISECONDS;

  if (!delivering) return true;
  return (
    lastPolledAt === undefined ||
    now - lastPolledAt >= SAFETY_NET_INTERVAL_MILLISECONDS
  );
}

/** What one connection's poll came to. */
export type PolledConnection = {
  readonly connectionId: string;
  readonly written: number;
  readonly degraded: number;
  /** Why this connection's sweep ended early, or absent when it drained. */
  readonly stoppedBecause?: string;
};

export type ProductionSweepResult = {
  readonly polled: readonly PolledConnection[];
  readonly replayed: number;
};

export type ProductionSweepLog = {
  info(details: Record<string, unknown>, message: string): void;
  error(details: { readonly err: unknown }, message: string): void;
};

export type ProductionSweepOptions = {
  readonly log: ProductionSweepLog;
  /** The cadence, for a test that cannot watch a real clock. */
  readonly intervalMilliseconds?: number;
  /** Where Retell answers. A test stands a Retell-shaped server on loopback. */
  readonly reach?: RetellReach;
  /**
   * The seam under the loop — what one tick runs. The default is the real
   * sweep, and the product never passes anything else; a test hands in its own
   * to fail a tick on cue, which no real provider does.
   */
  readonly sweep?: () => Promise<ProductionSweepResult>;
};

export type ProductionSweep = {
  /**
   * The only thing to do with the handle: the server is closing. Settles when
   * any tick already in flight has finished.
   */
  stop(): Promise<void>;
};

/**
 * Everything one connection has finished since its cursor, written and
 * checkpointed one at a time.
 *
 * Returns rather than throws, because one customer's Retell being unreachable
 * is not a reason to stop sweeping another customer's — and because the answer
 * a sweep owes its log is *what happened*, which includes stopping early.
 */
export async function pollConnection(
  target: RetellWatchTarget,
  reach: RetellReach,
): Promise<PolledConnection> {
  let written = 0;
  let degraded = 0;
  // Read from the row at the start and advanced in memory as each conversation
  // lands, so the next page asks from the last durable write. The persisted
  // cursor is moved by the write itself, inside the same transaction that marks
  // the claim; this is that same value, held so the paging does not have to
  // re-read the row.
  let since = target.cursor;

  for (let page = 0; page < MOST_PAGES_PER_TICK; page += 1) {
    const answer = await listEndedCalls(
      target.apiKey,
      { retellAgentId: target.retellAgentId, since },
      reach,
    );

    if (answer.kind !== "calls") {
      // Transient trouble ends this sweep where it stands. The cursor still
      // points at the last durable item, so the next tick resumes there.
      return {
        connectionId: target.connectionId,
        written,
        degraded,
        stoppedBecause:
          answer.kind === "invalid-key"
            ? "Retell would not take this connection's key"
            : answer.reason,
      };
    }

    // Oldest first, whatever order the provider chose to answer in: per-item
    // checkpointing is only honest if the item the cursor lands on is the
    // latest one actually written.
    const calls = [...answer.calls].sort(
      (a, b) => endTimestampOf(a) - endTimestampOf(b),
    );

    let advanced = false;
    for (const call of calls) {
      const outcome = await writeRetellCall(
        { ...target, cursor: since },
        call,
        "pull",
      );
      if (outcome.kind !== "written") continue;

      written += 1;
      if (outcome.degraded) degraded += 1;
      const ended = new Date(endTimestampOf(call));
      if (since === null || ended.getTime() > since.getTime()) {
        since = ended;
        advanced = true;
      }
    }

    // A short page is the end of the backlog. A full page that moved nothing is
    // a page entirely of conversations already stored — which happens when a
    // whole page sits on one instant — and asking again from the same cursor
    // would ask for the same page forever.
    if (calls.length < PAGE_SIZE || !advanced) break;
  }

  return { connectionId: target.connectionId, written, degraded };
}

function endTimestampOf(call: Readonly<Record<string, unknown>>): number {
  const held = call["end_timestamp"];
  return typeof held === "number" && Number.isFinite(held) ? held : 0;
}

/**
 * One tick: replay whatever was left half-written, then poll every connection
 * whose turn it is.
 *
 * `lastPolledAt` is the loop's own memory of the safety-net cadence and lives
 * in the process rather than in a row. A restart polls each watched connection
 * once more than it strictly had to, which is idempotent and costs one request.
 */
export async function runProductionSweep(
  reach: RetellReach,
  lastPolledAt: Map<string, number>,
  log: ProductionSweepLog,
  now: number = Date.now(),
): Promise<ProductionSweepResult> {
  const stale = await sweepStaleProductionClaims();
  let replayed = 0;
  for (const claim of stale) {
    const [connection] = await resolveRetellWatch({
      connectionId: claim.connectionId,
    });
    if (connection === undefined) continue;
    await replayProductionClaim(claim, {
      connectionType: connection.connectionType,
      agentId: connection.agentId,
      environment: connection.environment,
    });
  }

  const targets = await resolveRetellWatch({});
  const polled: PolledConnection[] = [];
  for (const target of targets) {
    if (!pollsThisTick(target, lastPolledAt.get(target.connectionId), now)) {
      continue;
    }
    lastPolledAt.set(target.connectionId, now);

    try {
      polled.push(await pollConnection(target, reach));
    } catch (fault) {
      // One connection's failure is one connection's failure. Stopping the
      // whole tick would let a single customer's broken row hold up everybody
      // else's monitoring.
      log.error(
        { err: fault },
        "a watched connection could not be swept; its cursor stays where it is",
      );
      polled.push({
        connectionId: target.connectionId,
        written: 0,
        degraded: 0,
        stoppedBecause: "the sweep failed",
      });
    }
  }

  // Connections nobody is watching any more should not keep a place in the
  // cadence memory of a process that runs for months.
  const watched = new Set(targets.map((target) => target.connectionId));
  for (const connectionId of lastPolledAt.keys()) {
    if (!watched.has(connectionId)) lastPolledAt.delete(connectionId);
  }

  return { polled, replayed };
}

/**
 * The standing production sweep, started with the server and stopped with it.
 *
 * The loop is the orphan sweep's, edge for edge: a tick that outlives the
 * cadence is skipped over rather than piled on, the timer is unref'd so a
 * shutdown never waits on a sweep that has not happened, and `stop` waits out
 * whatever is in flight.
 */
export function startProductionSweep(
  options: ProductionSweepOptions,
): ProductionSweep {
  const interval =
    options.intervalMilliseconds ?? PRODUCTION_SWEEP_INTERVAL_MILLISECONDS;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error("a sweep cadence is a positive whole number of milliseconds");
  }

  const lastPolledAt = new Map<string, number>();
  const sweep =
    options.sweep ??
    (() => runProductionSweep(options.reach ?? {}, lastPolledAt, options.log));

  let sweeping = false;
  const tick = async (): Promise<void> => {
    sweeping = true;
    try {
      const result = await sweep();
      const written = result.polled.reduce((all, one) => all + one.written, 0);
      // A quiet sweep is the ordinary case and is not news. What was stored is,
      // because each of those rows is a customer's conversation and this line is
      // where its arrival is first visible.
      if (written > 0 || result.replayed > 0) {
        options.log.info(
          {
            connectionIds: result.polled
              .filter((one) => one.written > 0)
              .map((one) => one.connectionId),
            degraded: result.polled.reduce((all, one) => all + one.degraded, 0),
            replayed: result.replayed,
          },
          `stored ${written} production trace(s) from watched connections`,
        );
      }
    } catch (fault) {
      options.log.error(
        { err: fault },
        "the production sweep failed; watched connections resume at the next tick",
      );
    } finally {
      sweeping = false;
    }
  };

  let inFlight: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (sweeping) return;
    inFlight = tick();
  }, interval);
  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      await inFlight;
    },
  };
}
