import {
  resolveRetellWatch,
  sweepStaleProductionClaims,
  type RetellWatchTarget,
} from "@egma/db";

import { listEndedCalls, PAGE_SIZE, type RetellReach } from "./retell/api.ts";
import { endInstantOf, type RetellCall } from "./retell/normalise.ts";
import {
  replayProductionClaim,
  writeRetellCall,
  type WriteOutcome,
} from "./retell/write.ts";

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
  /** Claims this tick could not replay. Counted, and never fatal — see below. */
  readonly replayFailed: number;
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
export type PollOptions = {
  /**
   * What one conversation's write runs. The default is the real write path, and
   * the product never passes anything else; a test hands in its own to fail the
   * write of one item in the middle of a page, which no real store does on cue.
   */
  readonly write?: (
    target: RetellWatchTarget,
    call: RetellCall,
  ) => Promise<WriteOutcome>;
};

export async function pollConnection(
  target: RetellWatchTarget,
  reach: RetellReach,
  options: PollOptions = {},
): Promise<PolledConnection> {
  const write =
    options.write ?? ((into, call) => writeRetellCall(into, call, "pull"));

  let written = 0;
  let degraded = 0;

  /**
   * The window every page of this tick is asked for, read once at the start.
   *
   * **Fixed for the whole tick, on purpose.** Paging is done with the
   * provider's own pagination key, and a lower bound that moved underneath it
   * would be a page cursor and a time filter disagreeing about which page comes
   * next. The persisted cursor still only moves on a durable write; this is the
   * value it held when the tick began, and the next tick re-reads it.
   */
  const askFrom = target.cursor;

  // The local mirror of what has been written this tick. The persisted cursor
  // is moved by the write itself, inside the transaction that marks the claim.
  let since = target.cursor;

  /**
   * Where the previous page stopped, in the provider's own terms.
   *
   * **This is what replaced the no-advance break, and the difference is a
   * conversation reachable rather than lost.** The old loop stopped on a full
   * page that moved the cursor nowhere, on the theory that such a page could
   * only be one instant's worth of already-stored conversations. That theory
   * stopped being true the moment webhooks stopped moving the cursor: with a
   * healthy webhook the backlog past the cursor is *entirely* already-stored,
   * and once it grows past one page every poll fetched the same hundred
   * already-claimed calls, wrote nothing, and gave up — so a conversation the
   * webhook happened to miss beyond that backlog was unreachable for good.
   *
   * Paging by key has no such theory in it. A page of already-stored
   * conversations is simply a page, and the next one is asked for.
   */
  let paginationKey: string | undefined;

  for (let page = 0; page < MOST_PAGES_PER_TICK; page += 1) {
    const answer = await listEndedCalls(
      target.apiKey,
      {
        retellAgentId: target.retellAgentId,
        since: askFrom,
        ...(paginationKey === undefined ? {} : { paginationKey }),
      },
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
    // latest one actually written. The instant is the normalizer's own, so the
    // order a page is written in and the instant its cursor lands on are one
    // answer rather than two.
    const calls = [...answer.calls].sort(
      (a, b) => (endInstantOf(a).at ?? 0) - (endInstantOf(b).at ?? 0),
    );

    for (const call of calls) {
      const outcome = await write({ ...target, cursor: since }, call);
      if (outcome.kind !== "written") continue;

      written += 1;
      if (outcome.degraded) degraded += 1;
      // The mirror follows the persisted cursor's own rule: only an end the
      // provider actually reported moves it.
      if (
        outcome.endReported &&
        (since === null || outcome.endedAt.getTime() > since.getTime())
      ) {
        since = outcome.endedAt;
      }
    }

    // A short page is the end of the backlog, whatever was in it.
    if (calls.length < PAGE_SIZE) break;

    // Retell resumes from the last call of the page it just answered, in its
    // own order rather than in the order this loop wrote them.
    const resumeFrom = providerCallIdOf(answer.calls.at(-1));
    // A provider that answered a full page and no key to continue from, or the
    // same key twice, has stopped making progress. Asking again would ask for
    // the same page, which is the failure this whole arrangement replaced.
    if (resumeFrom === undefined || resumeFrom === paginationKey) break;
    paginationKey = resumeFrom;
  }

  return { connectionId: target.connectionId, written, degraded };
}

function providerCallIdOf(call: RetellCall | undefined): string | undefined {
  const held = call?.["call_id"];
  return typeof held === "string" && held !== "" ? held : undefined;
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
  let replayFailed = 0;
  for (const claim of stale) {
    // **Per claim, and never around the loop.** This runs before any polling,
    // so a single claim that throws on every attempt used to abort the whole
    // tick — replays and polls alike — for as long as the row existed. One
    // customer's unreplayable conversation would stop the deployment watching
    // anything at all, silently, for ever.
    try {
      const [connection] = await resolveRetellWatch({
        connectionId: claim.connectionId,
      });
      // A connection nobody can reach any more. The claim keeps its record and
      // stays out of the window — `sweepStaleProductionClaims` only offers
      // claims whose connection is still live — so this is the broken-row case
      // rather than the archived one, and there is nothing to replay it with.
      if (connection === undefined) continue;
      await replayProductionClaim(claim, {
        connectionType: connection.connectionType,
        agentId: connection.agentId,
        environment: connection.environment,
      });
      replayed += 1;
    } catch (fault) {
      replayFailed += 1;
      log.error(
        { err: fault },
        "a claimed production trace could not be replayed; it stays claimed and the sweep goes on",
      );
    }
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

  return { polled, replayed, replayFailed };
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
      if (written > 0 || result.replayed > 0 || result.replayFailed > 0) {
        options.log.info(
          {
            connectionIds: result.polled
              .filter((one) => one.written > 0)
              .map((one) => one.connectionId),
            degraded: result.polled.reduce((all, one) => all + one.degraded, 0),
            replayed: result.replayed,
            replayFailed: result.replayFailed,
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
