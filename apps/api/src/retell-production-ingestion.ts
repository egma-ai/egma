import {
  checkpointMonitoringPage,
  claimDueMonitoringPull,
  claimMonitoringFailureReplay,
  failMonitoringFailureReplay,
  failMonitoringPull,
  finishMonitoringScan,
  recordMonitoringFailure,
  releaseMonitoringFailureReplay,
  releaseMonitoringLease,
  renewMonitoringLease,
  productionCallIsAccountedFor,
  resolveMonitoringFailureReplay,
  sweepStaleProductionClaims,
  yieldMonitoringLease,
  type AuthContext,
  type MonitoringFailureKind,
  type MonitoringFailureReplayTarget,
  type MonitoringPullTarget,
} from "@egma/db";
import { safeRetellProviderData } from "@egma/retell";
import { metrics as openTelemetryMetrics } from "@opentelemetry/api";

import { platformEvent, safeExceptionType } from "./platform-log.ts";
import {
  getRetellCall,
  hydrateRetellCall,
  listTerminalCalls,
  type ListedCalls,
  type RetellReach,
  type RetrievedCall,
} from "./retell/api.ts";
import type { RetellCall } from "./retell/normalise.ts";
import {
  replayProductionClaim,
  retellCallBelongsToTarget,
  writeRetellCall,
  type WriteOutcome,
} from "./retell/write.ts";

/** An agent with its pull switch on is due about every 30 seconds. */
export const RETELL_PRODUCTION_POLL_INTERVAL_MILLISECONDS = 30_000;
/** A cheap DB wake catches a jittered due target without waiting another 30s. */
export const RETELL_PRODUCTION_INGESTION_WAKE_INTERVAL_MILLISECONDS = 5_000;

const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_MAXIMUM_PAGES_PER_TURN = 10;
const DEFAULT_MAXIMUM_TURN_MILLISECONDS = 20_000;
const MAXIMUM_HYDRATION_ATTEMPTS = 3;
const BACKOFF_BASE_MILLISECONDS = 5_000;
const BACKOFF_CAP_MILLISECONDS = 5 * 60_000;
/**
 * The longest an agent may ever be made to wait — the ceiling on every wait
 * this file can produce, whoever proposed it.
 *
 * The old model parked a refused key for ever and let the account-wide health
 * row explain the stop. ADR-0015 drops `blocked_until` and the health surface
 * together, so a permanent park would now be a silent one: nothing on any
 * screen could say why calls stopped, and a key made good again on the
 * provider's side would never be tried. A refusal therefore rides the same
 * per-agent ladder with a higher ceiling — an hour, because a revoked key
 * clears when a person acts and not in seconds. Re-arming the switch still
 * wakes the agent at once.
 *
 * The provider's own `Retry-After` is held to the same hour: it is a
 * suggestion from outside, and a header of a hundred years must not be able to
 * retire an agent or hold its explicit-replay gate shut for the same span.
 */
const LONGEST_WAIT_MILLISECONDS = 60 * 60_000;
/**
 * How many doublings the ladder takes before the cap decides.
 *
 * Five seconds doubled twelve times is about six hours, past every ceiling
 * here, so the bound exists only to keep the arithmetic small — the cap is
 * what any wait beyond a few minutes actually lands on.
 */
const LONGEST_DOUBLING = 12;

type PlatformLogEvent = Record<string, unknown>;

export type RetellProductionIngestionLog = {
  info(event: PlatformLogEvent): void;
  warn(event: PlatformLogEvent): void;
  error(event: PlatformLogEvent): void;
};

export type RetellProductionIngestionMetricTurn = {
  readonly scanKind: MonitoringPullTarget["scanKind"];
  readonly outcome: "completed" | NonNullable<
    RetellProductionIngestionResult["stoppedBecause"]
  >;
  readonly durationMilliseconds: number;
  readonly written: number;
  readonly already: number;
  readonly permanentFailures: number;
};

/** Low-cardinality process metrics. Provider and customer ids never enter it. */
export type RetellProductionIngestionMetrics = {
  recordAttempt(scanKind: MonitoringPullTarget["scanKind"]): void;
  recordTurn(turn: RetellProductionIngestionMetricTurn): void;
  recordIngestionLag(
    scanKind: MonitoringPullTarget["scanKind"],
    lagMilliseconds: number,
  ): void;
  recordProviderFailure(kind: MonitoringFailureKind): void;
};

/** Postgres operations at the production-ingestion seam. */
export type RetellProductionIngestionStore = {
  readonly sweepStaleProductionClaims: typeof sweepStaleProductionClaims;
  readonly claimDueMonitoringPull: typeof claimDueMonitoringPull;
  readonly renewMonitoringLease: typeof renewMonitoringLease;
  readonly checkpointMonitoringPage: typeof checkpointMonitoringPage;
  readonly yieldMonitoringLease: typeof yieldMonitoringLease;
  readonly finishMonitoringScan: typeof finishMonitoringScan;
  readonly failMonitoringPull: typeof failMonitoringPull;
  readonly releaseMonitoringLease: typeof releaseMonitoringLease;
  readonly productionCallIsAccountedFor: typeof productionCallIsAccountedFor;
  readonly recordMonitoringFailure: typeof recordMonitoringFailure;
};

/** Retell HTTP reads at the production-ingestion seam. */
export type RetellProductionProvider = {
  readonly listTerminalCalls: typeof listTerminalCalls;
  readonly hydrateRetellCall: typeof hydrateRetellCall;
};

/** The shared trace writer at the production-ingestion seam. */
export type RetellProductionWriter = {
  readonly writeRetellCall: typeof writeRetellCall;
  readonly replayProductionClaim: typeof replayProductionClaim;
};

/** Postgres operations used by one customer-requested failed-call replay. */
export type RetellIngestionFailureReplayStore = {
  readonly claimMonitoringFailureReplay:
    typeof claimMonitoringFailureReplay;
  readonly releaseMonitoringFailureReplay:
    typeof releaseMonitoringFailureReplay;
  readonly failMonitoringFailureReplay:
    typeof failMonitoringFailureReplay;
  readonly resolveMonitoringFailureReplay:
    typeof resolveMonitoringFailureReplay;
};

export type RetellIngestionFailureReplayProvider = {
  readonly getRetellCall: typeof getRetellCall;
};

const STORE: RetellProductionIngestionStore = {
  sweepStaleProductionClaims,
  claimDueMonitoringPull,
  renewMonitoringLease,
  checkpointMonitoringPage,
  yieldMonitoringLease,
  finishMonitoringScan,
  failMonitoringPull,
  releaseMonitoringLease,
  productionCallIsAccountedFor,
  recordMonitoringFailure,
};

const PROVIDER: RetellProductionProvider = {
  listTerminalCalls,
  hydrateRetellCall,
};

const WRITER: RetellProductionWriter = {
  writeRetellCall,
  replayProductionClaim,
};

const FAILURE_REPLAY_STORE: RetellIngestionFailureReplayStore = {
  claimMonitoringFailureReplay,
  releaseMonitoringFailureReplay,
  failMonitoringFailureReplay,
  resolveMonitoringFailureReplay,
};

const FAILURE_REPLAY_PROVIDER: RetellIngestionFailureReplayProvider = {
  getRetellCall,
};

export type RetellProductionIngestionResult = {
  readonly targetClaimed: boolean;
  readonly pages: number;
  readonly written: number;
  readonly already: number;
  readonly permanentFailures: number;
  readonly replayed: number;
  readonly replayFailed: number;
  readonly stoppedBecause?:
    | "bounded_turn"
    | "lease_lost"
    | "provider_contract"
    | "provider_failure";
};

export type RunRetellProductionIngestionOptions = {
  readonly log: RetellProductionIngestionLog;
  readonly metrics?: RetellProductionIngestionMetrics | undefined;
  readonly reach?: RetellReach | undefined;
  readonly store?: RetellProductionIngestionStore | undefined;
  readonly provider?: RetellProductionProvider | undefined;
  readonly writer?: RetellProductionWriter | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly requestTimeoutMilliseconds?: number | undefined;
  readonly maxPagesPerTurn?: number | undefined;
  readonly maxTurnMilliseconds?: number | undefined;
};

export type RetellProductionIngestionOptions =
  RunRetellProductionIngestionOptions & {
    readonly intervalMilliseconds?: number | undefined;
    /** The standing-loop seam. Product code always uses the real ingestion. */
    readonly ingest?:
      | (() => Promise<RetellProductionIngestionResult>)
      | undefined;
  };

export type RetellProductionIngestion = {
  stop(): Promise<void>;
};

type TargetCounts = {
  pages: number;
  written: number;
  already: number;
  permanentFailures: number;
};

const meter = openTelemetryMetrics.getMeter(
  "@egma/api/retell-production-ingestion",
);
const pollAttempts = meter.createCounter(
  "egma.monitoring.retell.poll.attempts",
  { description: "DB-leased Retell polling turns" },
);
const pollDuration = meter.createHistogram(
  "egma.monitoring.retell.poll.duration",
  { description: "Retell polling turn duration", unit: "ms" },
);
const importedCalls = meter.createCounter(
  "egma.monitoring.retell.calls.imported",
  { description: "Retell calls written into production traces" },
);
const duplicateCalls = meter.createCounter(
  "egma.monitoring.retell.calls.duplicate",
  { description: "Retell calls already accounted for by the durable claim" },
);
const failedCalls = meter.createCounter(
  "egma.monitoring.retell.calls.failed",
  { description: "Retell polling provider and durable call failures" },
);
const ingestionLag = meter.createHistogram(
  "egma.monitoring.retell.ingestion.lag",
  { description: "Time from provider call end to first trace write", unit: "ms" },
);

const METRICS: RetellProductionIngestionMetrics = {
  recordAttempt(scanKind) {
    pollAttempts.add(1, { scan_kind: scanKind });
  },
  recordTurn(turn) {
    const attributes = {
      scan_kind: turn.scanKind,
      outcome: turn.outcome,
    };
    pollDuration.record(turn.durationMilliseconds, attributes);
    if (turn.written > 0) importedCalls.add(turn.written, attributes);
    if (turn.already > 0) duplicateCalls.add(turn.already, attributes);
    if (turn.permanentFailures > 0) {
      failedCalls.add(turn.permanentFailures, {
        ...attributes,
        failure_kind: "permanent_call",
      });
    }
  },
  recordIngestionLag(scanKind, lagMilliseconds) {
    ingestionLag.record(lagMilliseconds, { scan_kind: scanKind });
  },
  recordProviderFailure(kind) {
    failedCalls.add(1, { failure_kind: kind });
  },
};

function validPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return value;
}

/** A stable value in [0, 1), without keeping or exposing the provider id. */
function stableUnit(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

/** A stable 27-33 second spread stops every pulled agent polling together. */
function regularPollMilliseconds(target: MonitoringPullTarget): number {
  const spread = 0.9 + stableUnit(target.agentId) * 0.2;
  return Math.round(
    RETELL_PRODUCTION_POLL_INTERVAL_MILLISECONDS * spread,
  );
}

/**
 * How long this agent alone waits after a refused provider turn.
 *
 * Capped exponential on the agent's own retry clock, spread by the same stable
 * per-agent jitter as the cadence. Five agents holding sealed copies of one
 * dead key each discover the refusal separately and each wait their own
 * interval, so it costs one request per agent per interval and never a storm.
 */
function backoffMilliseconds(
  target: Pick<MonitoringPullTarget, "agentId" | "consecutiveFailures">,
  capMilliseconds: number,
): number {
  const exponent = Math.min(target.consecutiveFailures, LONGEST_DOUBLING);
  const base = Math.min(
    capMilliseconds,
    BACKOFF_BASE_MILLISECONDS * 2 ** exponent,
  );
  const jitter = 0.8 + stableUnit(target.agentId) * 0.4;
  return Math.min(capMilliseconds, Math.round(base * jitter));
}

function callIdOf(call: RetellCall): string {
  const value = call["call_id"];
  return typeof value === "string" ? value.trim() : "";
}

function safePayload(call: RetellCall): string {
  return JSON.stringify(safeRetellProviderData(call));
}

/** Give one provider request its own deadline and remove every listener after it. */
async function withDeadline<T>(
  reach: RetellReach,
  timeoutMilliseconds: number,
  request: (bounded: RetellReach) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const upstream = reach.signal;
  const abortFromUpstream = (): void => controller.abort(upstream?.reason);
  if (upstream?.aborted === true) abortFromUpstream();
  else upstream?.addEventListener("abort", abortFromUpstream, { once: true });

  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  timer.unref();
  try {
    return await request({ ...reach, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener("abort", abortFromUpstream);
  }
}

function emptyResult(
  replayed: number,
  replayFailed: number,
): RetellProductionIngestionResult {
  return {
    targetClaimed: false,
    pages: 0,
    written: 0,
    already: 0,
    permanentFailures: 0,
    replayed,
    replayFailed,
  };
}

function targetResult(
  counts: TargetCounts,
  replayed: number,
  replayFailed: number,
  stoppedBecause?: RetellProductionIngestionResult["stoppedBecause"],
): RetellProductionIngestionResult {
  return {
    targetClaimed: true,
    ...counts,
    replayed,
    replayFailed,
    ...(stoppedBecause === undefined ? {} : { stoppedBecause }),
  };
}

function logBatch(
  log: RetellProductionIngestionLog,
  target: MonitoringPullTarget,
  counts: TargetCounts,
  durationMilliseconds: number,
): void {
  if (counts.written === 0 && counts.permanentFailures === 0) return;
  log.info(
    platformEvent(
      "egma.monitoring.retell.import.completed",
      "Retell production conversations were imported",
      {
        scan_kind: target.scanKind,
        pages: counts.pages,
        written: counts.written,
        already_accounted: counts.already,
        permanent_failures: counts.permanentFailures,
        duration_ms: Math.max(0, durationMilliseconds),
      },
    ),
  );
}

/**
 * One agent started failing. There is no account-wide health to change — the
 * counter is a retry clock on this agent's own notebook — so this says what
 * happened and to whom, and nothing reads it back.
 */
function logPullFailure(
  log: RetellProductionIngestionLog,
  kind: MonitoringFailureKind,
  failures: number,
): void {
  const event = platformEvent(
    "egma.monitoring.pull.failed",
    "Pulling production calls failed",
    { failure_kind: kind, consecutive_failures: failures },
  );
  if (kind === "invalid_credential") log.error(event);
  else log.warn(event);
}

type ProviderFailure = Exclude<
  ListedCalls | RetrievedCall,
  { kind: "calls" } | { kind: "call" }
>;

function providerFailureKind(failure: ProviderFailure): MonitoringFailureKind {
  if (failure.kind === "invalid-key") return "invalid_credential";
  if (failure.kind === "refused" && failure.reason === "rate-limited") {
    return "rate_limited";
  }
  return "provider_unavailable";
}

function retryAtFor(
  target: Pick<MonitoringPullTarget, "agentId" | "consecutiveFailures">,
  failure: ProviderFailure,
  now: Date,
): Date {
  const kind = providerFailureKind(failure);
  if (
    kind === "rate_limited" &&
    failure.kind === "refused" &&
    failure.retryAfterMilliseconds !== undefined
  ) {
    // Retell's own answer is honoured, up to the same ceiling every other wait
    // has. A header of a hundred years — hostile, or a units mistake — would
    // otherwise park the agent past the heat death of the account and hold the
    // explicit-replay gate shut for the same span.
    return new Date(
      now.getTime() +
        Math.min(
          failure.retryAfterMilliseconds,
          LONGEST_WAIT_MILLISECONDS,
        ),
    );
  }
  return new Date(
    now.getTime() +
      backoffMilliseconds(
        target,
        kind === "invalid_credential"
          ? LONGEST_WAIT_MILLISECONDS
          : BACKOFF_CAP_MILLISECONDS,
      ),
  );
}

async function failForProvider(
  store: RetellProductionIngestionStore,
  target: MonitoringPullTarget,
  failure: ProviderFailure,
  log: RetellProductionIngestionLog,
  metrics: RetellProductionIngestionMetrics,
  now: Date,
): Promise<void> {
  const kind = providerFailureKind(failure);
  const result = await store.failMonitoringPull(
    target.auth,
    target,
    { kind, retryAt: retryAtFor(target, failure, now), now },
  );
  metrics.recordProviderFailure(kind);
  if (result.changed) logPullFailure(log, kind, result.failures);
}

function providerEndMilliseconds(call: RetellCall): number | undefined {
  const raw = call["end_timestamp"];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function permanentHydrationFailure(
  failure: ProviderFailure,
): string | undefined {
  if (failure.kind === "not-found") return "provider_call_not_found";
  if (failure.kind !== "refused") return undefined;
  if (failure.reason === "invalid-response") return "malformed_provider_call";
  if (failure.reason === "invalid-call-id") return "invalid_provider_call_id";
  if (failure.reason === "request-refused") return "provider_call_refused";
  return undefined;
}

export type RetellIngestionFailureReplayResult =
  | { readonly kind: "not_found" }
  | {
      readonly kind: "busy";
      readonly reason: "replay_in_progress" | "backing_off";
      readonly retryAt: Date;
    }
  | { readonly kind: "lease_lost" }
  | {
      readonly kind: "resolved";
      readonly failureId: string;
      readonly traceId: string;
      readonly write: "written" | "already";
      readonly agentRecovered: boolean;
    }
  | {
      readonly kind: "still_failed";
      readonly failureId: string;
      readonly errorKind: string;
    }
  | { readonly kind: "invalid_credential"; readonly retryAt: Date }
  | { readonly kind: "rate_limited"; readonly retryAt: Date }
  | { readonly kind: "provider_unavailable"; readonly retryAt: Date };

export type ReplayRetellIngestionFailureOptions = {
  readonly auth: AuthContext;
  readonly failureId: string;
  readonly log: RetellProductionIngestionLog;
  readonly reach?: RetellReach | undefined;
  readonly store?: RetellIngestionFailureReplayStore | undefined;
  readonly provider?: RetellIngestionFailureReplayProvider | undefined;
  readonly writer?: Pick<RetellProductionWriter, "writeRetellCall"> | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly requestTimeoutMilliseconds?: number | undefined;
};

/**
 * Retry the exact provider call named by one durable failure.
 *
 * This path never asks Retell to list a time window. The call can therefore be
 * older than the normal 30-day import range. The shared trace claim still owns
 * provider-call deduplication.
 */
export async function replayRetellIngestionFailure(
  input: ReplayRetellIngestionFailureOptions,
): Promise<RetellIngestionFailureReplayResult> {
  const store = input.store ?? FAILURE_REPLAY_STORE;
  const provider = input.provider ?? FAILURE_REPLAY_PROVIDER;
  const writer = input.writer ?? WRITER;
  const clock = input.clock ?? (() => new Date());
  const reach = input.reach ?? {};
  const timeout = validPositiveInteger(
    input.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
    "the Retell replay request timeout",
  );
  const claim = await store.claimMonitoringFailureReplay(
    input.auth,
    input.failureId,
    { now: clock() },
  );
  if (claim.kind !== "claimed") return claim;
  const target = claim.target;

  try {
    const retrieved = await withDeadline(reach, timeout, (bounded) =>
      provider.getRetellCall(
        target.apiKey,
        target.providerCallId,
        bounded,
      ),
    );
    if (retrieved.kind === "call") {
      if (!retellCallBelongsToTarget(target, retrieved.call)) {
        const errorKind = "platform_agent_mismatch";
        const released = await store.releaseMonitoringFailureReplay(
          target.auth,
          target,
          { errorKind, now: clock() },
        );
        return released
          ? {
              kind: "still_failed",
              failureId: target.failureId,
              errorKind,
            }
          : { kind: "lease_lost" };
      }
      const now = clock();
      const outcome = await writer.writeRetellCall(
        target,
        retrieved.call,
        now,
      );
      const resolved = await store.resolveMonitoringFailureReplay(
        target.auth,
        target,
        { now: clock() },
      );
      if (!resolved.resolved) return { kind: "lease_lost" };
      if (resolved.agentRecovered) {
        input.log.info(
          platformEvent(
            "egma.monitoring.pull.failures.cleared",
            "An agent's last failed production call was imported",
          ),
        );
      }
      return {
        kind: "resolved",
        failureId: target.failureId,
        traceId: outcome.traceId,
        write: outcome.kind,
        agentRecovered: resolved.agentRecovered,
      };
    }

    const permanentKind = permanentHydrationFailure(retrieved);
    if (permanentKind !== undefined) {
      const released = await store.releaseMonitoringFailureReplay(
        target.auth,
        target,
        { errorKind: permanentKind, now: clock() },
      );
      return released
        ? {
            kind: "still_failed",
            failureId: target.failureId,
            errorKind: permanentKind,
          }
        : { kind: "lease_lost" };
    }

    const now = clock();
    const kind = providerFailureKind(retrieved);
    const retryAt = retryAtFor(target, retrieved, now);
    const failed = await store.failMonitoringFailureReplay(
      target.auth,
      target,
      { kind, retryAt, now },
    );
    if (!failed.recorded) return { kind: "lease_lost" };
    if (failed.changed) logPullFailure(input.log, kind, failed.failures);
    return { kind, retryAt };
  } catch (error) {
    try {
      await store.releaseMonitoringFailureReplay(
        target.auth,
        target,
        { errorKind: "internal_failure", now: clock() },
      );
    } catch {
      // Lease expiry makes this failed call available again if Postgres cannot
      // release it now.
    }
    throw error;
  }
}

async function releaseAfterInternalFailure(
  store: RetellProductionIngestionStore,
  target: MonitoringPullTarget,
  clock: () => Date,
): Promise<void> {
  const now = clock();
  try {
    await store.releaseMonitoringLease(target.auth, target, {
      retryAt: new Date(now.getTime() + regularPollMilliseconds(target)),
      errorKind: "internal_failure",
      now,
    });
  } catch {
    // The lease expires. There is no second durable action available when the
    // database itself cannot release its row.
  }
}

async function runTarget(
  target: MonitoringPullTarget,
  options: {
    readonly log: RetellProductionIngestionLog;
    readonly metrics: RetellProductionIngestionMetrics;
    readonly store: RetellProductionIngestionStore;
    readonly provider: RetellProductionProvider;
    readonly writer: RetellProductionWriter;
    readonly clock: () => Date;
    readonly reach: RetellReach;
    readonly requestTimeoutMilliseconds: number;
    readonly maxPagesPerTurn: number;
    readonly maxTurnMilliseconds: number;
  },
  replayed: number,
  replayFailed: number,
): Promise<RetellProductionIngestionResult> {
  const counts: TargetCounts = {
    pages: 0,
    written: 0,
    already: 0,
    permanentFailures: 0,
  };
  const startedAt = options.clock();
  options.metrics.recordAttempt(target.scanKind);
  let paginationKey = target.paginationKey ?? undefined;
  const seenPaginationKeys = new Set(target.seenPaginationKeys);
  let leaseFinished = false;
  let batchLogged = false;

  const completed = (
    stoppedBecause?: RetellProductionIngestionResult["stoppedBecause"],
  ): RetellProductionIngestionResult => {
    if (!batchLogged) {
      const at = options.clock();
      const durationMilliseconds = Math.max(
        0,
        at.getTime() - startedAt.getTime(),
      );
      logBatch(
        options.log,
        target,
        counts,
        durationMilliseconds,
      );
      options.metrics.recordTurn({
        scanKind: target.scanKind,
        outcome: stoppedBecause ?? "completed",
        durationMilliseconds,
        written: counts.written,
        already: counts.already,
        permanentFailures: counts.permanentFailures,
      });
      batchLogged = true;
    }
    return targetResult(counts, replayed, replayFailed, stoppedBecause);
  };

  const turnBoundReached = (): boolean =>
    options.clock().getTime() - startedAt.getTime() >=
    options.maxTurnMilliseconds;

  const yieldBoundedTurn = async (): Promise<RetellProductionIngestionResult> => {
    const now = options.clock();
    leaseFinished = true;
    await options.store.yieldMonitoringLease(target.auth, target, {
      retryAt: new Date(now.getTime() + regularPollMilliseconds(target)),
      now,
    });
    return completed("bounded_turn");
  };

  try {
    while (counts.pages < options.maxPagesPerTurn) {
      if (counts.pages > 0 && turnBoundReached()) return yieldBoundedTurn();

      const renewed = await options.store.renewMonitoringLease(
        target.auth,
        target,
        { now: options.clock() },
      );
      if (!renewed) {
        leaseFinished = true;
        return completed("lease_lost");
      }

      const listed = await withDeadline(
        options.reach,
        options.requestTimeoutMilliseconds,
        (reach) =>
          options.provider.listTerminalCalls(
            target.apiKey,
            {
              retellAgentId: target.platformAgentId,
              from: target.scanFrom,
              to: target.scanThrough,
              ...(paginationKey === undefined ? {} : { paginationKey }),
              seenPaginationKeys,
            },
            reach,
          ),
      );
      if (listed.kind !== "calls") {
        const now = options.clock();
        if (
          listed.kind === "refused" &&
          listed.reason === "provider-contract"
        ) {
          await options.store.releaseMonitoringLease(
            target.auth,
            target,
            {
              retryAt: new Date(
                now.getTime() + regularPollMilliseconds(target),
              ),
              errorKind: "provider_contract",
              now,
            },
          );
          leaseFinished = true;
          return completed("provider_contract");
        }
        await failForProvider(
          options.store,
          target,
          listed,
          options.log,
          options.metrics,
          now,
        );
        leaseFinished = true;
        return completed("provider_failure");
      }
      counts.pages += 1;

      for (const listedCall of listed.calls) {
        if (turnBoundReached()) return yieldBoundedTurn();
        const providerCallId = callIdOf(listedCall);
        if (providerCallId === "") {
          const now = options.clock();
          await options.store.releaseMonitoringLease(target.auth, target, {
            retryAt: new Date(now.getTime() + regularPollMilliseconds(target)),
            errorKind: "provider_contract",
            now,
          });
          leaseFinished = true;
          return completed("provider_contract");
        }

        if (
          await options.store.productionCallIsAccountedFor(
            target.auth,
            providerCallId,
          )
        ) {
          counts.already += 1;
          continue;
        }

        let hydrated: RetrievedCall | undefined;
        let permanentKind: string | undefined;
        for (
          let attempt = 1;
          attempt <= MAXIMUM_HYDRATION_ATTEMPTS;
          attempt += 1
        ) {
          if (turnBoundReached()) return yieldBoundedTurn();
          const requestable = await options.store.renewMonitoringLease(
            target.auth,
            target,
            { now: options.clock() },
          );
          if (!requestable) {
            leaseFinished = true;
            return completed("lease_lost");
          }
          hydrated = await withDeadline(
            options.reach,
            options.requestTimeoutMilliseconds,
            (reach) =>
              options.provider.hydrateRetellCall(
                target.apiKey,
                listedCall,
                reach,
              ),
          );
          if (hydrated.kind === "call") break;
          permanentKind = permanentHydrationFailure(hydrated);
          if (
            permanentKind === undefined ||
            attempt === MAXIMUM_HYDRATION_ATTEMPTS
          ) {
            break;
          }
        }
        if (hydrated === undefined) {
          throw new Error("Retell hydration did not produce a result");
        }
        if (turnBoundReached()) return yieldBoundedTurn();
        if (hydrated.kind !== "call") {
          if (permanentKind !== undefined) {
            const recorded = await options.store.recordMonitoringFailure(
              target.auth,
              target,
              {
                providerCallId,
                errorKind: permanentKind,
                safePayload: safePayload(listedCall),
                now: options.clock(),
              },
            );
            if (recorded.recorded === false) {
              leaseFinished = true;
              return completed("lease_lost");
            }
            counts.permanentFailures += 1;
            if (recorded.changed) {
              options.log.warn(
                platformEvent(
                  "egma.monitoring.pull.call.failed",
                  "A production call could not be imported",
                  { error_kind: permanentKind },
                ),
              );
            }
            continue;
          }

          const now = options.clock();
          await failForProvider(
            options.store,
            target,
            hydrated,
            options.log,
            options.metrics,
            now,
          );
          leaseFinished = true;
          return completed("provider_failure");
        }

        if (!retellCallBelongsToTarget(target, hydrated.call)) {
          const recorded = await options.store.recordMonitoringFailure(
            target.auth,
            target,
            {
              providerCallId,
              errorKind: "platform_agent_mismatch",
              safePayload: safePayload(hydrated.call),
              now: options.clock(),
            },
          );
          if (recorded.recorded === false) {
            leaseFinished = true;
            return completed("lease_lost");
          }
          counts.permanentFailures += 1;
          if (recorded.changed) {
            options.log.warn(
              platformEvent(
                "egma.monitoring.pull.call.failed",
                "A production call could not be imported",
                { error_kind: "platform_agent_mismatch" },
              ),
            );
          }
          continue;
        }

        const writtenAt = options.clock();
        const outcome: WriteOutcome = await options.writer.writeRetellCall(
          target,
          hydrated.call,
          writtenAt,
        );
        if (outcome.kind === "written") {
          counts.written += 1;
          const endedAt = providerEndMilliseconds(hydrated.call);
          if (endedAt !== undefined) {
            options.metrics.recordIngestionLag(
              target.scanKind,
              Math.max(0, writtenAt.getTime() - endedAt),
            );
          }
        } else counts.already += 1;
      }

      if (!listed.hasMore) {
        const now = options.clock();
        const finished = await options.store.finishMonitoringScan(
          target.auth,
          target,
          { now, pollMilliseconds: regularPollMilliseconds(target) },
        );
        leaseFinished = true;
        if (!finished) {
          return completed("lease_lost");
        }
        return completed();
      }

      const nextPaginationKey = listed.paginationKey?.trim() ?? "";
      if (
        nextPaginationKey === "" ||
        nextPaginationKey === paginationKey ||
        seenPaginationKeys.has(nextPaginationKey)
      ) {
        const now = options.clock();
        await options.store.releaseMonitoringLease(target.auth, target, {
          retryAt: new Date(now.getTime() + regularPollMilliseconds(target)),
          errorKind: "provider_contract",
          now,
        });
        leaseFinished = true;
        return completed("provider_contract");
      }

      seenPaginationKeys.add(nextPaginationKey);
      const checkpointed = await options.store.checkpointMonitoringPage(
        target.auth,
        target,
        {
          paginationKey: nextPaginationKey,
          seenPaginationKeys: [...seenPaginationKeys],
        },
      );
      if (!checkpointed) {
        leaseFinished = true;
        return completed("lease_lost");
      }
      paginationKey = nextPaginationKey;
    }

    const now = options.clock();
    await options.store.yieldMonitoringLease(target.auth, target, {
      retryAt: new Date(now.getTime() + regularPollMilliseconds(target)),
      now,
    });
    leaseFinished = true;
    return completed("bounded_turn");
  } catch (error) {
    await releaseAfterInternalFailure(options.store, target, options.clock);
    leaseFinished = true;
    completed();
    throw error;
  } finally {
    if (!leaseFinished) {
      const now = options.clock();
      try {
        await options.store.yieldMonitoringLease(target.auth, target, {
          retryAt: new Date(now.getTime() + regularPollMilliseconds(target)),
          now,
        });
      } catch {
        // Lease expiry is the recovery path when the store cannot release it.
      }
    }
  }
}

/** Replay stale claims, then process one DB-leased due Retell target. */
export async function runRetellProductionIngestion(
  input: RunRetellProductionIngestionOptions,
): Promise<RetellProductionIngestionResult> {
  const store = input.store ?? STORE;
  const provider = input.provider ?? PROVIDER;
  const writer = input.writer ?? WRITER;
  const metrics = input.metrics ?? METRICS;
  const clock = input.clock ?? (() => new Date());
  const reach = input.reach ?? {};
  const requestTimeoutMilliseconds = validPositiveInteger(
    input.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
    "the Retell request timeout",
  );
  const maxPagesPerTurn = validPositiveInteger(
    input.maxPagesPerTurn ?? DEFAULT_MAXIMUM_PAGES_PER_TURN,
    "the Retell page bound",
  );
  const maxTurnMilliseconds = validPositiveInteger(
    input.maxTurnMilliseconds ?? DEFAULT_MAXIMUM_TURN_MILLISECONDS,
    "the Retell turn bound",
  );

  const stale = await store.sweepStaleProductionClaims({ now: clock() });
  let replayed = 0;
  let replayFailed = 0;
  for (const claim of stale) {
    try {
      await writer.replayProductionClaim(claim);
      replayed += 1;
    } catch {
      replayFailed += 1;
    }
  }
  if (replayed > 0) {
    input.log.info(
      platformEvent(
        "egma.monitoring.retell.claims.replayed",
        "Stale Retell production claims were replayed",
        { replayed, replay_failed: replayFailed },
      ),
    );
  }

  const target = await store.claimDueMonitoringPull({ now: clock() });
  if (target === undefined) return emptyResult(replayed, replayFailed);
  return runTarget(
    target,
    {
      log: input.log,
      metrics,
      store,
      provider,
      writer,
      clock,
      reach,
      requestTimeoutMilliseconds,
      maxPagesPerTurn,
      maxTurnMilliseconds,
    },
    replayed,
    replayFailed,
  );
}

/**
 * Start the standing ingestion loop. A slow turn never overlaps the next tick.
 * Unexpected runtime failures log once, then stay quiet until recovery.
 */
export function startRetellProductionIngestion(
  options: RetellProductionIngestionOptions,
): RetellProductionIngestion {
  const interval = validPositiveInteger(
    options.intervalMilliseconds ??
      RETELL_PRODUCTION_INGESTION_WAKE_INTERVAL_MILLISECONDS,
    "the Retell production-ingestion cadence",
  );
  const ingest =
    options.ingest ?? (() => runRetellProductionIngestion(options));

  let running = false;
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();
  let failureStartedAt: Date | undefined;
  let failureCount = 0;
  let claimReplayFailureStartedAt: Date | undefined;
  let claimReplayFailureCount = 0;

  const tick = async (): Promise<void> => {
    running = true;
    try {
      // One due target per ingestion call keeps the module seam small. A
      // standing turn drains every due DB-leased target so selecting three
      // Retell agents does not turn a 30-second schedule into 90 seconds.
      let result: RetellProductionIngestionResult;
      let replayedThisTick = 0;
      let replayFailedThisTick = 0;
      do {
        result = await ingest();
        replayedThisTick += result.replayed;
        replayFailedThisTick += result.replayFailed;
      } while (result.targetClaimed && !stopping);
      if (replayFailedThisTick > 0) {
        claimReplayFailureCount += replayFailedThisTick;
        if (claimReplayFailureStartedAt === undefined) {
          claimReplayFailureStartedAt = new Date();
          options.log.warn(
            platformEvent(
              "egma.monitoring.retell.claims.replay.failed",
              "A stale Retell production claim could not be replayed",
              { failure_count: claimReplayFailureCount },
            ),
          );
        }
      } else if (
        replayedThisTick > 0 &&
        claimReplayFailureStartedAt !== undefined
      ) {
        options.log.info(
          platformEvent(
            "egma.monitoring.retell.claims.replay.recovered",
            "Stale Retell production claim replay recovered",
            {
              outage_duration_ms: Math.max(
                0,
                Date.now() - claimReplayFailureStartedAt.getTime(),
              ),
              failure_count: claimReplayFailureCount,
            },
          ),
        );
        claimReplayFailureStartedAt = undefined;
        claimReplayFailureCount = 0;
      }
      if (failureStartedAt !== undefined) {
        options.log.info(
          platformEvent(
            "egma.monitoring.retell.runtime.recovered",
            "Retell production ingestion recovered",
            {
              outage_duration_ms: Math.max(
                0,
                Date.now() - failureStartedAt.getTime(),
              ),
              failure_count: failureCount,
            },
          ),
        );
        failureStartedAt = undefined;
        failureCount = 0;
      }
    } catch (error) {
      failureCount += 1;
      if (failureStartedAt === undefined) {
        failureStartedAt = new Date();
        options.log.error(
          platformEvent(
            "egma.monitoring.retell.runtime.failed",
            "Retell production ingestion failed",
            { exception_type: safeExceptionType(error) },
          ),
        );
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    if (running || stopping) return;
    inFlight = tick();
  }, interval);
  timer.unref();

  return {
    async stop() {
      stopping = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
