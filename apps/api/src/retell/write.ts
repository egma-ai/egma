import {
  appendSpans,
  claimProductionTrace,
  finishProductionTrace,
  recordProductionTraces,
  type ProductionTransport,
  type RetellWatchTarget,
} from "@egma/db";

import { normaliseRetellCall, type RetellCall } from "./normalise.ts";

/**
 * The one write path, and both transports go through it.
 *
 * The protocol across the two stores, in order, and it is the whole of what
 * makes a conversation land exactly once:
 *
 *  1. **Claim** in Postgres, carrying the verbatim payload. An insert on a
 *     unique identity, never a check — the loser conflicts and walks away.
 *  2. **Append** the spans to ClickHouse.
 *  3. **Mark written**, and move the connection's cursor to the conversation
 *     that was just stored.
 *
 * A crash between 1 and 2 leaves a claimed-but-unwritten row that the lease
 * sweep replays from the payload on the claim. A crash between 2 and 3 replays
 * the identical append, which ClickHouse's block-level insert dedup absorbs,
 * because the normalizer is a pure function of the payload and the ids are
 * derived rather than random. Neither store needs a transaction spanning the
 * other.
 *
 * **Grading gets nothing new.** `recordProductionTraces` is the door's own
 * bookkeeping, called here with the very spans that were just appended: the
 * root span arrives closed, so the job is written with `root_closed_at` set and
 * the notification wakes the grader service. Every production-scoped grader
 * judges Retell traffic from the first conversation, with no grading code
 * written for it.
 */

export type WriteOutcome =
  /** This call stored it. */
  | {
      readonly kind: "written";
      readonly traceId: string;
      readonly degraded: boolean;
      /** The normalizer's answer, so a caller never re-reads the payload. */
      readonly endedAt: Date;
      /** Whether the provider reported that end, or egma stood in for one. */
      readonly endReported: boolean;
    }
  /**
   * Somebody else holds the claim — the other transport, or an earlier tick.
   *
   * It carries the same two instants a write does, because **an already-claimed
   * conversation is an accounted-for conversation**: the claim is the write
   * duty, and whoever holds it writes the spans or the lease sweep replays them
   * from the payload on the claim. So a poller may move its cursor past this
   * exactly as it moves past its own writes, and the two answers have to look
   * the same for it to be able to.
   */
  | {
      readonly kind: "already";
      readonly traceId: string;
      readonly endedAt: Date;
      readonly endReported: boolean;
    };

/**
 * Store one Retell conversation under one connection, or find out it is
 * already stored.
 *
 * `now` is injected so that a payload missing its timestamps normalises the
 * same way twice, which is what a replay after a crash depends on.
 */
export async function writeRetellCall(
  target: RetellWatchTarget,
  call: RetellCall,
  transport: ProductionTransport,
  now: number = Date.now(),
): Promise<WriteOutcome> {
  const normalised = normaliseRetellCall(
    call,
    {
      connectionId: target.connectionId,
      connectionType: target.connectionType,
      agentId: target.agentId,
      environment: target.environment,
    },
    now,
  );

  const claim = await claimProductionTrace(target.auth, {
    connectionId: target.connectionId,
    traceId: normalised.traceId,
    providerCallId: normalised.providerCallId,
    transport,
    payload: JSON.stringify(call),
    endedAt: normalised.endedAt,
  });

  // The loser of the race, and the ordinary answer at the boundary of every
  // resumed sweep. Nothing is written and nothing is wrong.
  if (claim === undefined) {
    return {
      kind: "already",
      traceId: normalised.traceId,
      endedAt: normalised.endedAt,
      endReported: normalised.endReported,
    };
  }

  await appendSpans(target.auth, normalised.spans);
  await recordProductionTraces(target.auth, normalised.spans);
  await finishProductionTrace(target.auth, {
    traceId: normalised.traceId,
    connectionId: target.connectionId,
    endedAt: normalised.endedAt,
    degraded: normalised.degraded,
    // Two conditions, and each is load-bearing. Only the poller's own cursor is
    // the poller's to move; and a cursor may only move to an instant the
    // provider actually reported, never to egma's stand-in for one — which is
    // the wall clock, and would jump the cursor past everything not yet drained.
    advanceCursor: transport === "pull" && normalised.endReported,
  });

  return {
    kind: "written",
    traceId: normalised.traceId,
    degraded: normalised.degraded,
    endedAt: normalised.endedAt,
    endReported: normalised.endReported,
  };
}

/**
 * Finish a claim somebody else started and did not get to the end of.
 *
 * The payload is the one stored on the claim, so this normalises the identical
 * input into the identical batch: an append that had already landed is dropped
 * by the store as the duplicate block it is, and an append that never happened
 * lands now. Either way exactly one copy exists when this returns.
 *
 * **The claim's own `ended_at` stands in for the clock**, and that is what makes
 * "identical" true rather than nearly true. A payload carrying no timestamps
 * normalises against the moment it was read, and the moment it was read is
 * exactly what the first pass wrote into `ended_at` — so a replay hours later
 * reproduces the first pass's spans instead of stamping them with today.
 */
export async function replayProductionClaim(
  claim: {
    readonly auth: RetellWatchTarget["auth"];
    readonly connectionId: string;
    readonly traceId: string;
    readonly payload: string;
    readonly endedAt: Date;
    /** Which transport claimed it, because only the poller's cursor moves. */
    readonly transport: ProductionTransport;
  },
  into: {
    readonly connectionType: string;
    readonly agentId: string;
    readonly environment: string | null;
  },
): Promise<void> {
  let call: RetellCall;
  try {
    const held: unknown = JSON.parse(claim.payload);
    call =
      typeof held === "object" && held !== null && !Array.isArray(held)
        ? (held as RetellCall)
        : {};
  } catch {
    call = {};
  }

  const normalised = normaliseRetellCall(
    call,
    { connectionId: claim.connectionId, ...into },
    claim.endedAt.getTime(),
  );

  await appendSpans(claim.auth, normalised.spans);
  await recordProductionTraces(claim.auth, normalised.spans);
  await finishProductionTrace(claim.auth, {
    traceId: normalised.traceId,
    connectionId: claim.connectionId,
    endedAt: normalised.endedAt,
    degraded: normalised.degraded,
    advanceCursor: claim.transport === "pull" && normalised.endReported,
  });
}
