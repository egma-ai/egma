import {
  checkpointRetellMonitoringPage,
  claimDueRetellMonitoringAgent,
  committedTraces,
  deleteRetellCallRetry,
  dueRetellCallRetries,
  failRetellMonitoringTarget,
  finishRetellMonitoringScan,
  recordRetellCallAttempt,
  recoverRetellMonitoringSetup,
  releaseRetellMonitoringLease,
  renewRetellMonitoringLease,
  sweepExpiredRetellCallMarkers,
  transientRetellCallState,
  yieldRetellMonitoringLease,
  type AuthContext,
  type MonitoringFailureKind,
  type RetellMonitoringTarget,
} from "@egma/db";
import { safeRetellProviderData } from "@egma/retell";
import { metrics as openTelemetryMetrics } from "@opentelemetry/api";

import {
  acceptEvidence,
  IngestionUnavailableError,
} from "./ingestion/accept.ts";
import { platformEvent, safeExceptionType } from "./platform-log.ts";
import {
  getRetellCall,
  hydrateRetellCall,
  listTerminalCalls,
  type ListedCalls,
  type RetellReach,
  type RetrievedCall,
} from "./retell/api.ts";
import {
  normaliseRetellCall,
  traceIdFor,
  type RetellCall,
} from "./retell/normalise.ts";

/**
 * Retell polling: a bookmark, a bounded budget, and nothing kept.
 *
 * Retell has to be pulled, so this is the one provider-shaped loop egma runs.
 * What it is **not** is a second way to store evidence: a hydrated call is
 * normalized and handed to the same acceptance module the OTLP door uses, and a
 * call that lands leaves no Postgres row at all. What Postgres keeps is where a
 * selected agent's reading has got to, and — only for calls that did not work —
 * a short-lived retry budget.
 *
 * ## What one turn does, in the order it does it
 *
 * 1. **Owed retries first, and only when something is owed.** The claim already
 *    knows whether this agent has any transient call state, so an agent with
 *    none does no work here and no query is issued for it. That is what keeps a
 *    30-second empty poll to one claim, one provider request and one release.
 * 2. **List one fixed page.** The window and the page bounds were fixed when the
 *    scan was claimed and do not move while it is paged.
 * 3. **An empty page stops here.** No trace-store lookup, no transient lookup,
 *    no hydration, no object write, no import log — an empty poll is the normal
 *    case at low volume, and it must be quiet and nearly free.
 * 4. **A non-empty page asks two batched questions**: which of these calls the
 *    trace store already holds, and which of them egma is already retrying or
 *    has recently dropped. Two statements for a hundred calls, never two per
 *    call.
 * 5. **Fetch and accept the remainder together**, one hydration attempt each
 *    and at most `RETELL_HYDRATION_CONCURRENCY` of them open at once.
 * 6. **Advance only when every listed identity has an answer** — committed,
 *    durable in the object store, scheduled for a retry, or terminally dropped.
 *
 * ## The bounded budget, and why it is stored
 *
 * A call whose fetch or normalization fails gets one initial attempt and at
 * most three automatic retries. The count is a Postgres row, not a loop
 * variable: a restart in the middle of a budget resumes it, and the five-minute
 * overlap listing the same call again is the *same* observation rather than a
 * new one. After the last retry fails, egma emits one structured event and one
 * low-cardinality counter, drops the work, and leaves an identity-only marker
 * that stops the overlap starting the whole cycle again. There is no customer
 * repair screen and no `Retry now`: a provider call egma could not read is an
 * operational error and an honest gap in Monitoring.
 *
 * ## Object-store failure is not a hydration failure
 *
 * If acceptance cannot make evidence durable, egma has the evidence and the
 * provider did nothing wrong. That call gets **no** retry state and the page
 * does **not** advance past it. The next turn lists the same page and tries
 * again — which is the one behaviour that cannot lose a conversation.
 */

/** Retell selected agents are due about every 30 seconds. */
export const RETELL_PRODUCTION_POLL_INTERVAL_MILLISECONDS = 30_000;
/** A cheap DB wake catches a jittered due target without waiting another 30s. */
export const RETELL_PRODUCTION_INGESTION_WAKE_INTERVAL_MILLISECONDS = 5_000;

const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_MAXIMUM_PAGES_PER_TURN = 10;
const DEFAULT_MAXIMUM_TURN_MILLISECONDS = 20_000;
const INVALID_CREDENTIAL_RETRY_AT = new Date("9999-12-31T23:59:59.999Z");
const BACKOFF_BASE_MILLISECONDS = 5_000;
const BACKOFF_CAP_MILLISECONDS = 5 * 60_000;

/**
 * How long each automatic retry waits, in order.
 *
 * Three waits totalling three and a half minutes, which is deliberately inside
 * the five-minute overlap a regular scan rereads: every attempt in a budget
 * therefore falls in a window that still lists the call, so a budget started
 * during ordinary polling can actually be spent rather than stranded.
 */
const RETRY_BACKOFF_MILLISECONDS = [30_000, 60_000, 120_000] as const;

/**
 * How far before the scan's lower bound the committed-identity probe looks.
 *
 * The provider lists by the instant a call **ended**; the trace store files a
 * span by the instant it **started**. A call that ran across the scan's lower
 * bound is therefore listed by one and filed before the other, so the probe
 * reaches back far enough to cover any real conversation. Getting this wrong
 * costs a re-fetch and a replay, never a duplicate — which is why a generous
 * bounded margin is the right shape and a clever exact one is not.
 */
const CALL_START_MARGIN_MILLISECONDS = 6 * 60 * 60 * 1_000;

/** How many due retries one turn takes on, so a backlog cannot own the lease. */
const RETRIES_PER_TURN = 25;

/**
 * How many of one page's calls egma hydrates at the same time.
 *
 * The ceiling is protective, not a throughput dial. A burst wide enough to make
 * Retell refuse costs egma either way. A refusal that reads as this call's own
 * spends one attempt of that call's bounded hydration budget — one initial
 * attempt and at most three automatic retries — and a budget spent on refusals
 * egma provoked ends where any exhausted budget ends: a terminal drop, and a
 * conversation egma never imports. A refusal that reads as the account's pauses
 * the whole selected agent until the provider says it may read again. Sixteen
 * is narrow enough that a page cannot become that burst, and wide enough that a
 * full page is a few waves rather than one sequential read per conversation.
 */
export const RETELL_HYDRATION_CONCURRENCY = 16;

/**
 * How long an accepted-but-not-yet-visible identity is remembered.
 *
 * Long enough to outlast the five-minute overlap a regular scan rereads, so a
 * call this poller has already made durable is recognised on every poll that
 * could list it again — right up until the drainer makes it query-visible and
 * the committed probe takes the recognition over. Bounded so a drainer that
 * never catches up cannot grow this memory without end: past this window the
 * call is outside every overlap and nothing lists it, so forgetting it imports
 * nothing.
 */
const ACCEPTED_IDENTITY_MEMORY_MILLISECONDS = 15 * 60_000;

/**
 * A per-poller memory of identities this process has accepted but has not yet
 * seen the trace store commit.
 *
 * A call is durable in the object store the instant `acceptEvidence` returns,
 * but query-visible only once the drainer has taken its segment — a gap of at
 * least one scan interval, and longer when the drainer is behind. Across that
 * gap the five-minute overlap lists the same call again, and neither guard the
 * page keeps would recognise it: the committed probe is blind until the drain,
 * and a call that simply worked leaves no transient row. This is what does — an
 * identity is remembered when it is accepted and consulted beside the probe on
 * every later turn, so one conversation is imported once even while its drain is
 * behind.
 *
 * In memory and per process, never Postgres: a successful call leaves no row and
 * this keeps that true. The residual the design accepts is here: a monitored
 * agent whose lease moves to another process between acceptance and visibility
 * carries none of this memory, so that process can accept the same call again —
 * and the store's identity check then retains the changed pair as a conflict
 * rather than replacing the first. That outcome is operator-visible and never
 * silent, which is why one process's memory is enough and a shared one is not
 * built.
 */
export type AcceptedIdentities = {
  /** Remember one trace made durable at `now`. */
  remember(traceId: string, now: Date): void;
  /** Whether this trace was accepted here and is not yet known committed. */
  has(traceId: string): boolean;
  /**
   * Forget the traces the probe now reports committed, and any older than the
   * overlap that could still list them — so the drain reclaims the recognition
   * and the memory cannot grow past a bound.
   */
  reconcile(committed: ReadonlySet<string>, now: Date): void;
};

export function acceptedIdentities(): AcceptedIdentities {
  const acceptedAt = new Map<string, number>();
  return {
    remember(traceId, now) {
      acceptedAt.set(traceId, now.getTime());
    },
    has(traceId) {
      return acceptedAt.has(traceId);
    },
    reconcile(committed, now) {
      const floor = now.getTime() - ACCEPTED_IDENTITY_MEMORY_MILLISECONDS;
      for (const [traceId, when] of acceptedAt) {
        if (committed.has(traceId) || when <= floor) acceptedAt.delete(traceId);
      }
    },
  };
}

/** No probe answer, for the turn-start prune that only ages entries out. */
const NO_COMMITTED_IDENTITIES: ReadonlySet<string> = new Set();

type PlatformLogEvent = Record<string, unknown>;

export type RetellProductionIngestionLog = {
  info(event: PlatformLogEvent): void;
  warn(event: PlatformLogEvent): void;
  error(event: PlatformLogEvent): void;
};

export type RetellProductionIngestionMetricTurn = {
  readonly scanKind: RetellMonitoringTarget["scanKind"];
  readonly outcome: "completed" | NonNullable<
    RetellProductionIngestionResult["stoppedBecause"]
  >;
  readonly durationMilliseconds: number;
  readonly accepted: number;
  readonly settled: number;
  readonly dropped: number;
};

/** Low-cardinality process metrics. Provider and customer ids never enter it. */
export type RetellProductionIngestionMetrics = {
  recordAttempt(scanKind: RetellMonitoringTarget["scanKind"]): void;
  recordTurn(turn: RetellProductionIngestionMetricTurn): void;
  recordIngestionLag(
    scanKind: RetellMonitoringTarget["scanKind"],
    lagMilliseconds: number,
  ): void;
  recordProviderFailure(kind: MonitoringFailureKind): void;
  /**
   * One provider call given up on, by reason class **alone**.
   *
   * No organization, no project, no selected agent, no call id: the identities
   * an operator needs to find the gap are in the structured event, which is
   * bounded storage. A metric label is not, and an unbounded one takes down the
   * monitoring that was supposed to report the incident.
   */
  recordDroppedCall(reason: string): void;
};

/** Postgres operations at the production-ingestion seam. */
export type RetellProductionIngestionStore = {
  readonly claimDueRetellMonitoringAgent: typeof claimDueRetellMonitoringAgent;
  readonly renewRetellMonitoringLease: typeof renewRetellMonitoringLease;
  readonly checkpointRetellMonitoringPage: typeof checkpointRetellMonitoringPage;
  readonly yieldRetellMonitoringLease: typeof yieldRetellMonitoringLease;
  readonly finishRetellMonitoringScan: typeof finishRetellMonitoringScan;
  readonly failRetellMonitoringTarget: typeof failRetellMonitoringTarget;
  readonly recoverRetellMonitoringSetup: typeof recoverRetellMonitoringSetup;
  readonly releaseRetellMonitoringLease: typeof releaseRetellMonitoringLease;
  readonly transientRetellCallState: typeof transientRetellCallState;
  readonly dueRetellCallRetries: typeof dueRetellCallRetries;
  readonly recordRetellCallAttempt: typeof recordRetellCallAttempt;
  readonly deleteRetellCallRetry: typeof deleteRetellCallRetry;
  readonly sweepExpiredRetellCallMarkers: typeof sweepExpiredRetellCallMarkers;
};

/** Retell HTTP reads at the production-ingestion seam. */
export type RetellProductionProvider = {
  readonly listTerminalCalls: typeof listTerminalCalls;
  readonly hydrateRetellCall: typeof hydrateRetellCall;
  readonly getRetellCall: typeof getRetellCall;
};

/** The trace store's identity probe, which is an optimization and not a gate. */
export type RetellCommittedLookup = {
  readonly committedTraces: typeof committedTraces;
};

/** The one acceptance seam, shared with the OTLP door. */
export type RetellEvidenceAcceptance = {
  readonly acceptEvidence: typeof acceptEvidence;
};

const STORE: RetellProductionIngestionStore = {
  claimDueRetellMonitoringAgent,
  renewRetellMonitoringLease,
  checkpointRetellMonitoringPage,
  yieldRetellMonitoringLease,
  finishRetellMonitoringScan,
  failRetellMonitoringTarget,
  recoverRetellMonitoringSetup,
  releaseRetellMonitoringLease,
  transientRetellCallState,
  dueRetellCallRetries,
  recordRetellCallAttempt,
  deleteRetellCallRetry,
  sweepExpiredRetellCallMarkers,
};

const PROVIDER: RetellProductionProvider = {
  listTerminalCalls,
  hydrateRetellCall,
  getRetellCall,
};

const LOOKUP: RetellCommittedLookup = { committedTraces };

const ACCEPTANCE: RetellEvidenceAcceptance = { acceptEvidence };

export type RetellProductionIngestionResult = {
  readonly targetClaimed: boolean;
  readonly pages: number;
  /** Calls made durable in the ingestion object store by this turn. */
  readonly accepted: number;
  /**
   * Listed calls that needed nothing from this turn: already committed,
   * already handled by the retry pass, waiting on a retry that is not yet due,
   * or recently dropped. Each has an answer, which is what lets the page move.
   */
  readonly settled: number;
  /** Calls whose bounded budget ended in this turn. */
  readonly dropped: number;
  readonly stoppedBecause?:
    | "bounded_turn"
    | "lease_lost"
    | "provider_contract"
    | "provider_failure"
    | "ingestion_unavailable";
};

export type RunRetellProductionIngestionOptions = {
  readonly log: RetellProductionIngestionLog;
  readonly metrics?: RetellProductionIngestionMetrics | undefined;
  readonly reach?: RetellReach | undefined;
  readonly store?: RetellProductionIngestionStore | undefined;
  readonly provider?: RetellProductionProvider | undefined;
  readonly lookup?: RetellCommittedLookup | undefined;
  readonly acceptance?: RetellEvidenceAcceptance | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly requestTimeoutMilliseconds?: number | undefined;
  readonly maxPagesPerTurn?: number | undefined;
  readonly maxTurnMilliseconds?: number | undefined;
  /**
   * The per-poller accepted-identity memory, carried across turns. A single
   * turn defaults to its own, which is why a test that wants to prove one
   * standing poller does not re-import across turns passes one in and reuses it.
   */
  readonly accepted?: AcceptedIdentities | undefined;
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

type TurnCounts = {
  pages: number;
  accepted: number;
  settled: number;
  dropped: number;
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
const acceptedCalls = meter.createCounter(
  "egma.monitoring.retell.calls.accepted",
  { description: "Retell calls made durable in the ingestion object store" },
);
const settledCalls = meter.createCounter(
  "egma.monitoring.retell.calls.settled",
  { description: "Listed Retell calls that needed no work this turn" },
);
const failedCalls = meter.createCounter(
  "egma.monitoring.retell.calls.failed",
  { description: "Retell polling provider failures" },
);
const droppedCalls = meter.createCounter(
  "egma.monitoring.retell.calls.dropped",
  { description: "Retell calls dropped after their bounded retry budget" },
);
const ingestionLag = meter.createHistogram(
  "egma.monitoring.retell.ingestion.lag",
  { description: "Time from provider call end to acceptance", unit: "ms" },
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
    if (turn.accepted > 0) acceptedCalls.add(turn.accepted, attributes);
    if (turn.settled > 0) settledCalls.add(turn.settled, attributes);
  },
  recordIngestionLag(scanKind, lagMilliseconds) {
    ingestionLag.record(lagMilliseconds, { scan_kind: scanKind });
  },
  recordProviderFailure(kind) {
    failedCalls.add(1, { failure_kind: kind });
  },
  recordDroppedCall(reason) {
    droppedCalls.add(1, { reason });
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

/** A stable 27-33 second spread stops all selected agents polling together. */
function regularPollMilliseconds(target: RetellMonitoringTarget): number {
  const spread = 0.9 + stableUnit(target.monitoredAgentId) * 0.2;
  return Math.round(
    RETELL_PRODUCTION_POLL_INTERVAL_MILLISECONDS * spread,
  );
}

/**
 * When this agent is next due, from here.
 *
 * Every way a turn can end — finished, yielded, released, refused — hands the
 * lease back with the same answer, so the answer is written once. Two spellings
 * of one schedule is how one path quietly starts polling at a different cadence
 * from the rest.
 */
function nextPollAfter(target: RetellMonitoringTarget, now: Date): Date {
  return new Date(now.getTime() + regularPollMilliseconds(target));
}

function backoffMilliseconds(
  target: Pick<
    RetellMonitoringTarget,
    "setupId" | "setupConsecutiveFailures"
  >,
): number {
  const exponent = Math.min(target.setupConsecutiveFailures, 6);
  const base = Math.min(
    BACKOFF_CAP_MILLISECONDS,
    BACKOFF_BASE_MILLISECONDS * 2 ** exponent,
  );
  const jitter = 0.8 + stableUnit(target.setupId) * 0.4;
  return Math.min(BACKOFF_CAP_MILLISECONDS, Math.round(base * jitter));
}

function callIdOf(call: RetellCall): string {
  const value = call["call_id"];
  return typeof value === "string" ? value.trim() : "";
}

function providerText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The listed call really belongs to the selected agent this scan is for.
 *
 * A page is asked for by agent, so a call under another agent's id would mean
 * the provider answered a different question from the one asked — and filing it
 * anyway would put one customer's selection in front of another's evidence.
 */
function retellCallBelongsToTarget(
  target: Pick<RetellMonitoringTarget, "platformAgentId">,
  call: RetellCall,
): boolean {
  const platformAgentId = providerText(call["agent_id"]);
  return platformAgentId === "" || platformAgentId === target.platformAgentId;
}

function platformAgentVersionOf(call: RetellCall): string {
  const value = call["agent_version"];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function projectOf(target: RetellMonitoringTarget): string {
  const projectId = target.auth.projectId;
  if (projectId === undefined) {
    throw new Error("Retell production ingestion requires a project context");
  }
  return projectId;
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

function emptyResult(): RetellProductionIngestionResult {
  return {
    targetClaimed: false,
    pages: 0,
    accepted: 0,
    settled: 0,
    dropped: 0,
  };
}

function targetResult(
  counts: TurnCounts,
  stoppedBecause?: RetellProductionIngestionResult["stoppedBecause"],
): RetellProductionIngestionResult {
  return {
    targetClaimed: true,
    ...counts,
    ...(stoppedBecause === undefined ? {} : { stoppedBecause }),
  };
}

function logBatch(
  log: RetellProductionIngestionLog,
  target: RetellMonitoringTarget,
  counts: TurnCounts,
  durationMilliseconds: number,
): void {
  if (counts.accepted === 0 && counts.dropped === 0) return;
  log.info(
    platformEvent(
      "egma.monitoring.retell.import.completed",
      "Retell production conversations were imported",
      {
        scan_kind: target.scanKind,
        pages: counts.pages,
        accepted: counts.accepted,
        settled: counts.settled,
        dropped: counts.dropped,
        duration_ms: Math.max(0, durationMilliseconds),
      },
    ),
  );
}

function logHealthChange(
  log: RetellProductionIngestionLog,
  kind: MonitoringFailureKind,
  failures: number,
): void {
  const event = platformEvent(
    "egma.monitoring.retell.health.changed",
    "Retell Monitoring health changed",
    { health_state: kind, consecutive_failures: failures },
  );
  if (kind === "invalid_credential") log.error(event);
  else log.warn(event);
}

async function recover(
  store: Pick<
    RetellProductionIngestionStore,
    "recoverRetellMonitoringSetup"
  >,
  target: RetellMonitoringTarget,
  log: RetellProductionIngestionLog,
  now: Date,
): Promise<void> {
  const result = await store.recoverRetellMonitoringSetup(
    target.auth,
    target,
    now,
  );
  if (!result.recovered) return;
  log.info(
    platformEvent(
      "egma.monitoring.retell.health.recovered",
      "Retell Monitoring recovered",
      {
        outage_duration_ms: Math.max(
          0,
          now.getTime() - result.startedAt.getTime(),
        ),
        failure_count: result.failures,
      },
    ),
  );
}

type ProviderFailure = Exclude<
  ListedCalls | RetrievedCall,
  { kind: "calls" } | { kind: "call" }
>;

function providerHealth(failure: ProviderFailure): MonitoringFailureKind {
  if (failure.kind === "invalid-key") return "invalid_credential";
  if (failure.kind === "refused" && failure.reason === "rate-limited") {
    return "rate_limited";
  }
  return "provider_unavailable";
}

function retryAtFor(
  target: Pick<
    RetellMonitoringTarget,
    "setupId" | "setupConsecutiveFailures"
  >,
  failure: ProviderFailure,
  now: Date,
): Date {
  const kind = providerHealth(failure);
  if (kind === "invalid_credential") return INVALID_CREDENTIAL_RETRY_AT;
  if (
    kind === "rate_limited" &&
    failure.kind === "refused" &&
    failure.retryAfterMilliseconds !== undefined
  ) {
    return new Date(now.getTime() + failure.retryAfterMilliseconds);
  }
  return new Date(now.getTime() + backoffMilliseconds(target));
}

async function failForProvider(
  store: RetellProductionIngestionStore,
  target: RetellMonitoringTarget,
  failure: ProviderFailure,
  log: RetellProductionIngestionLog,
  metrics: RetellProductionIngestionMetrics,
  now: Date,
): Promise<void> {
  const kind = providerHealth(failure);
  const result = await store.failRetellMonitoringTarget(
    target.auth,
    target,
    { kind, retryAt: retryAtFor(target, failure, now), now },
  );
  metrics.recordProviderFailure(kind);
  if (result.changed) logHealthChange(log, kind, result.failures);
}

function providerEndMilliseconds(call: RetellCall): number | undefined {
  const raw = call["end_timestamp"];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The classes of failure that belong to one call rather than to the account.
 *
 * A missing call, a document egma cannot read, a refused single request: these
 * spend that call's budget. Everything else — an unreachable host, a rate
 * limit, a rejected key — is about the whole setup and pauses the agent instead,
 * because spending one call's retries on an outage would end the budget without
 * ever having reached the call.
 */
function callFailureKind(failure: ProviderFailure): string | undefined {
  if (failure.kind === "not-found") return "provider_call_not_found";
  if (failure.kind !== "refused") return undefined;
  if (failure.reason === "invalid-response") return "malformed_provider_call";
  if (failure.reason === "invalid-call-id") return "invalid_provider_call_id";
  if (failure.reason === "request-refused") return "provider_call_refused";
  return undefined;
}

/** The trace store's window for this page: the scan's own fixed bounds. */
function committedWindow(target: RetellMonitoringTarget): {
  readonly from: bigint;
  readonly to: bigint;
} {
  // Never `now`. A probe measured from the current clock would stop
  // recognising egma's own older evidence the moment the window slid past it,
  // and would re-import everything it had already stored.
  const from = target.scanFrom.getTime() - CALL_START_MARGIN_MILLISECONDS;
  return {
    from: BigInt(from) * 1000n,
    to: BigInt(target.scanThrough.getTime() + 1) * 1000n,
  };
}

type TurnOptions = {
  readonly log: RetellProductionIngestionLog;
  readonly metrics: RetellProductionIngestionMetrics;
  readonly store: RetellProductionIngestionStore;
  readonly provider: RetellProductionProvider;
  readonly lookup: RetellCommittedLookup;
  readonly acceptance: RetellEvidenceAcceptance;
  readonly accepted: AcceptedIdentities;
  readonly clock: () => Date;
  readonly reach: RetellReach;
  readonly requestTimeoutMilliseconds: number;
  readonly maxPagesPerTurn: number;
  readonly maxTurnMilliseconds: number;
};

/** What one call's handling did, from the page loop's point of view. */
type CallOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "scheduled" }
  | { readonly kind: "dropped" }
  /** The lease is gone, so nothing this turn writes can be trusted. */
  | { readonly kind: "lease_lost" }
  /** The setup itself is failing; the agent pauses rather than this call. */
  | { readonly kind: "provider_failure"; readonly failure: ProviderFailure }
  /** Evidence in hand, nowhere durable to put it. The page must not advance. */
  | { readonly kind: "ingestion_unavailable"; readonly cause: unknown };

/**
 * One hydrated call, normalized and handed to the shared acceptance module.
 *
 * The call is made safe before anything reads it, which is where Retell's own
 * `access_token` and named authentication headers are left out — the only
 * omissions this contract makes, and made by construction rather than by
 * looking at what evidence happens to contain.
 */
async function acceptCall(
  target: RetellMonitoringTarget,
  call: RetellCall,
  options: TurnOptions,
): Promise<{ readonly endedAt: number | undefined }> {
  const safeCall = safeRetellProviderData(call);
  const normalised = normaliseRetellCall(
    safeCall,
    {
      projectId: projectOf(target),
      environment: "production",
      platformAgentId:
        providerText(safeCall["agent_id"]) || target.platformAgentId,
      platformAgentName:
        providerText(safeCall["agent_name"]) || target.platformAgentName,
      platformAgentVersion: platformAgentVersionOf(safeCall),
    },
    options.clock().getTime(),
  );
  await options.acceptance.acceptEvidence(normalised.spans, {
    auth: target.auth,
  });
  return { endedAt: providerEndMilliseconds(safeCall) };
}

/**
 * Count one failed attempt, and report a terminal drop where the budget ends.
 *
 * The event carries every identity an operator needs to go and find the gap.
 * The counter carries the reason class and nothing else.
 */
async function countFailedAttempt(
  target: RetellMonitoringTarget,
  providerCallId: string,
  errorKind: string,
  options: TurnOptions,
): Promise<CallOutcome> {
  const recorded = await options.store.recordRetellCallAttempt(
    target.auth,
    target,
    {
      providerCallId,
      errorKind,
      retryBackoffMilliseconds: [...RETRY_BACKOFF_MILLISECONDS],
      now: options.clock(),
    },
  );
  if (!recorded.recorded) return { kind: "lease_lost" };
  if (!recorded.dropped) {
    if (recorded.changed) {
      options.log.warn(
        platformEvent(
          "egma.monitoring.retell.health.changed",
          "A Retell Monitoring target became degraded",
          { health_state: "degraded" },
        ),
      );
    }
    return { kind: "scheduled" };
  }

  options.log.error(
    platformEvent(
      "egma.monitoring.retell.call.dropped",
      "A Retell call was dropped after its automatic retries",
      {
        organization_id: target.auth.organizationId,
        project_id: projectOf(target),
        retell_monitored_agent_id: target.monitoredAgentId,
        provider_call_id: providerCallId,
        error_kind: errorKind,
        automatic_retries: recorded.attempts - 1,
      },
    ),
  );
  options.metrics.recordDroppedCall(errorKind);
  return { kind: "dropped" };
}

/**
 * Hydrate one call and account for it, exactly once.
 *
 * One attempt per call per turn, whatever happens: the budget belongs to the
 * stored count, and a loop here would spend it inside a single turn and make
 * "survives a restart" meaningless.
 */
async function handleCall(
  target: RetellMonitoringTarget,
  providerCallId: string,
  retrieve: () => Promise<RetrievedCall>,
  options: TurnOptions,
  counts: TurnCounts,
  /**
   * Whether this call already has a transient row. It decides one thing: a
   * success writes to Postgres only where there is something to remove, so a
   * page of ordinary conversations still leaves this database untouched.
   */
  held: boolean,
): Promise<CallOutcome> {
  const retrieved = await retrieve();

  if (retrieved.kind !== "call") {
    const errorKind = callFailureKind(retrieved);
    if (errorKind === undefined) {
      return { kind: "provider_failure", failure: retrieved };
    }
    return countFailedAttempt(target, providerCallId, errorKind, options);
  }

  if (!retellCallBelongsToTarget(target, retrieved.call)) {
    return countFailedAttempt(
      target,
      providerCallId,
      "platform_agent_mismatch",
      options,
    );
  }

  const acceptedAt = options.clock();
  let ended: { readonly endedAt: number | undefined };
  try {
    ended = await acceptCall(target, retrieved.call, options);
  } catch (cause) {
    // *Not yet*, and only that. Egma has the evidence and could not make it
    // durable, which is this side's problem: it spends none of the provider's
    // budget and leaves the page exactly where it is. Anything else thrown
    // here is an internal fault and belongs to the caller that can report it,
    // rather than being quietly filed as an object-store outage.
    if (!(cause instanceof IngestionUnavailableError)) throw cause;
    return { kind: "ingestion_unavailable", cause };
  }

  // After durability and never before it: a row removed while the evidence was
  // still only in this process's memory would leave a call nobody is still
  // trying and nobody has stored. And only where there is a row — a call that
  // simply worked leaves no Postgres write behind it at all.
  if (held) {
    await options.store.deleteRetellCallRetry(target.auth, target, {
      providerCallId,
      now: options.clock(),
    });
  }
  counts.accepted += 1;
  // Durable now, query-visible only once the drainer takes it: remember the
  // identity so a later overlap listing the same call recognises this poller's
  // own work rather than importing one conversation twice.
  options.accepted.remember(
    traceIdFor(projectOf(target), providerCallId),
    acceptedAt,
  );
  if (ended.endedAt !== undefined) {
    options.metrics.recordIngestionLag(
      target.scanKind,
      Math.max(0, acceptedAt.getTime() - ended.endedAt),
    );
  }
  return { kind: "accepted" };
}

/** One listed call this page has not accounted for yet. */
type OutstandingCall = {
  readonly providerCallId: string;
  readonly listedCall: RetellCall;
  /** Whether this call already has a transient row. */
  readonly held: boolean;
};

/** Whether one call's answer ends the turn rather than that call. */
function endsTurn(outcome: CallOutcome): boolean {
  return (
    outcome.kind === "lease_lost" ||
    outcome.kind === "provider_failure" ||
    outcome.kind === "ingestion_unavailable"
  );
}

/**
 * Hydrate and accept a page's outstanding calls together, answering in listed
 * order.
 *
 * At most `RETELL_HYDRATION_CONCURRENCY` hydrations are open at once, and each
 * call keeps everything one at a time gave it: its own lease check, its own
 * single attempt, and an answer that belongs to it alone — one call's failed
 * hydration writes that call's retry row and leaves its page-mates to finish.
 * Acceptances are deliberately not serialized: the door they go through already
 * takes many senders at once, and acceptances that overlap share segment seals,
 * which makes them fewer and fuller objects rather than a contended queue.
 *
 * The answer is shorter than `outstanding` where the turn bound stopped it
 * short, and every call it did reach has finished before it answers: a turn
 * about to yield its lease must have nothing of its own still writing.
 */
async function hydrateOutstanding(
  target: RetellMonitoringTarget,
  outstanding: readonly OutstandingCall[],
  options: TurnOptions,
  counts: TurnCounts,
  boundReached: () => boolean,
): Promise<readonly PromiseSettledResult<CallOutcome>[]> {
  const settled: PromiseSettledResult<CallOutcome>[] = [];
  let taken = 0;
  // An answer that ends the turn — a lost lease, a failing setup, an object
  // store that cannot take the evidence — stops this page being read further.
  // What is already open finishes; nothing new is opened.
  let stopping = false;

  const hydrateOne = async (owed: OutstandingCall): Promise<CallOutcome> => {
    const renewed = await options.store.renewRetellMonitoringLease(
      target.auth,
      target,
      { now: options.clock() },
    );
    if (!renewed) return { kind: "lease_lost" };
    return handleCall(
      target,
      owed.providerCallId,
      () =>
        withDeadline(
          options.reach,
          options.requestTimeoutMilliseconds,
          (reach) =>
            options.provider.hydrateRetellCall(
              target.apiKey,
              owed.listedCall,
              reach,
            ),
        ),
      options,
      counts,
      owed.held,
    );
  };

  /** Take the next outstanding call, until there are none or the turn stops. */
  const takeCalls = async (): Promise<void> => {
    while (!stopping && !boundReached()) {
      const index = taken;
      if (index >= outstanding.length) return;
      const owed = outstanding[index];
      if (owed === undefined) return;
      taken = index + 1;
      try {
        const outcome = await hydrateOne(owed);
        settled[index] = { status: "fulfilled", value: outcome };
        if (endsTurn(outcome)) stopping = true;
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
        stopping = true;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(RETELL_HYDRATION_CONCURRENCY, outstanding.length) },
      () => takeCalls(),
    ),
  );
  return settled.slice(0, taken);
}

async function releaseAfterInternalFailure(
  store: RetellProductionIngestionStore,
  target: RetellMonitoringTarget,
  clock: () => Date,
): Promise<void> {
  const now = clock();
  try {
    await store.releaseRetellMonitoringLease(target.auth, target, {
      retryAt: nextPollAfter(target, now),
      errorKind: "internal_failure",
      now,
    });
  } catch {
    // The lease expires. There is no second durable action available when the
    // database itself cannot release its row.
  }
}

async function runTarget(
  target: RetellMonitoringTarget,
  options: TurnOptions,
): Promise<RetellProductionIngestionResult> {
  const counts: TurnCounts = { pages: 0, accepted: 0, settled: 0, dropped: 0 };
  const startedAt = options.clock();
  options.metrics.recordAttempt(target.scanKind);
  let paginationKey = target.paginationKey ?? undefined;
  const seenPaginationKeys = new Set(target.seenPaginationKeys);
  let leaseFinished = false;
  let batchLogged = false;
  // Age out anything this poller accepted long enough ago to be past every
  // overlap that could list it again, so the memory the page consults below
  // stays bounded whether or not the drain ever catches up.
  options.accepted.reconcile(NO_COMMITTED_IDENTITIES, startedAt);

  const completed = (
    stoppedBecause?: RetellProductionIngestionResult["stoppedBecause"],
  ): RetellProductionIngestionResult => {
    if (!batchLogged) {
      const at = options.clock();
      const durationMilliseconds = Math.max(
        0,
        at.getTime() - startedAt.getTime(),
      );
      logBatch(options.log, target, counts, durationMilliseconds);
      options.metrics.recordTurn({
        scanKind: target.scanKind,
        outcome: stoppedBecause ?? "completed",
        durationMilliseconds,
        accepted: counts.accepted,
        settled: counts.settled,
        dropped: counts.dropped,
      });
      batchLogged = true;
    }
    return targetResult(counts, stoppedBecause);
  };

  const turnBoundReached = (): boolean =>
    options.clock().getTime() - startedAt.getTime() >=
    options.maxTurnMilliseconds;

  const yieldBoundedTurn = async (): Promise<RetellProductionIngestionResult> => {
    const now = options.clock();
    leaseFinished = true;
    await recover(options.store, target, options.log, now);
    await options.store.yieldRetellMonitoringLease(target.auth, target, {
      retryAt: nextPollAfter(target, now),
      now,
    });
    return completed("bounded_turn");
  };

  const releaseForContract =
    async (): Promise<RetellProductionIngestionResult> => {
      const now = options.clock();
      await options.store.releaseRetellMonitoringLease(target.auth, target, {
        retryAt: nextPollAfter(target, now),
        errorKind: "provider_contract",
        now,
      });
      leaseFinished = true;
      return completed("provider_contract");
    };

  /** Answer one call's outcome where it ends the turn rather than the call. */
  const turnEndedBy = async (
    outcome: CallOutcome,
  ): Promise<RetellProductionIngestionResult | undefined> => {
    if (outcome.kind === "lease_lost") {
      leaseFinished = true;
      return completed("lease_lost");
    }
    if (outcome.kind === "provider_failure") {
      await failForProvider(
        options.store,
        target,
        outcome.failure,
        options.log,
        options.metrics,
        options.clock(),
      );
      leaseFinished = true;
      return completed("provider_failure");
    }
    if (outcome.kind === "ingestion_unavailable") {
      options.log.warn(
        platformEvent(
          "egma.monitoring.retell.ingestion.unavailable",
          "Retell evidence could not be made durable and was not counted",
          { exception_type: safeExceptionType(outcome.cause) },
        ),
      );
      const now = options.clock();
      await options.store.yieldRetellMonitoringLease(target.auth, target, {
        retryAt: nextPollAfter(target, now),
        now,
      });
      leaseFinished = true;
      return completed("ingestion_unavailable");
    }
    return undefined;
  };

  /** One call's whole answer: what ends the turn, and what only counts. */
  const stoppedBy = async (
    outcome: CallOutcome,
  ): Promise<RetellProductionIngestionResult | undefined> => {
    const stopped = await turnEndedBy(outcome);
    if (stopped !== undefined) return stopped;
    if (outcome.kind === "dropped") counts.dropped += 1;
    if (outcome.kind === "scheduled") counts.settled += 1;
    return undefined;
  };

  try {
    // Owed retries, and only where the claim already said something is owed.
    // An agent with no transient call state issues no query here at all, which
    // is what keeps an ordinary empty poll to one claim and one provider read.
    if (target.hasTransientCallState) {
      const now = options.clock();
      await options.store.sweepExpiredRetellCallMarkers(target.auth, {
        monitoredAgentId: target.monitoredAgentId,
        now,
      });
      const due = await options.store.dueRetellCallRetries(target.auth, {
        monitoredAgentId: target.monitoredAgentId,
        importGeneration: target.importGeneration,
        now,
        limit: RETRIES_PER_TURN,
      });
      for (const owed of due) {
        if (turnBoundReached()) return yieldBoundedTurn();
        const renewed = await options.store.renewRetellMonitoringLease(
          target.auth,
          target,
          { now: options.clock() },
        );
        if (!renewed) {
          leaseFinished = true;
          return completed("lease_lost");
        }
        // Whatever this attempt becomes, the page below already has its answer:
        // a recovery is remembered in the accepted-identity memory the instant
        // it is durable, and a reschedule or a drop leaves the transient row the
        // page's batched lookup reads — so neither asks the provider again.
        const stopped = await stoppedBy(
          await handleCall(
            target,
            owed.providerCallId,
            () =>
              withDeadline(
                options.reach,
                options.requestTimeoutMilliseconds,
                (reach) =>
                  options.provider.getRetellCall(
                    target.apiKey,
                    owed.providerCallId,
                    reach,
                  ),
              ),
            options,
            counts,
            true,
          ),
        );
        if (stopped !== undefined) return stopped;
      }
    }

    while (counts.pages < options.maxPagesPerTurn) {
      if (counts.pages > 0 && turnBoundReached()) return yieldBoundedTurn();

      const renewed = await options.store.renewRetellMonitoringLease(
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
        if (
          listed.kind === "refused" &&
          listed.reason === "provider-contract"
        ) {
          return releaseForContract();
        }
        await failForProvider(
          options.store,
          target,
          listed,
          options.log,
          options.metrics,
          options.clock(),
        );
        leaseFinished = true;
        return completed("provider_failure");
      }
      counts.pages += 1;

      const identities: string[] = [];
      for (const listedCall of listed.calls) {
        const providerCallId = callIdOf(listedCall);
        // A page whose rows have no identity cannot be reasoned about at all:
        // there is nothing to look up, nothing to fetch and nothing to record.
        if (providerCallId === "") return releaseForContract();
        identities.push(providerCallId);
      }

      // Everything below is skipped for an empty page. An empty poll is the
      // normal case at low volume, and it costs one provider request.
      if (identities.length > 0) {
        const projectId = projectOf(target);
        let committed: ReadonlySet<string> = new Set();
        try {
          committed = await options.lookup.committedTraces(
            target.auth,
            identities.map((id) => traceIdFor(projectId, id)),
            { window: committedWindow(target), projectId },
          );
        } catch (cause) {
          // The probe is an optimization, never a gate. Without it egma fetches
          // and accepts the listed calls again, which stable span identity and
          // the drainer's integrity rule make a replay rather than a duplicate.
          options.log.warn(
            platformEvent(
              "egma.monitoring.retell.committed.unavailable",
              "The committed-identity lookup was unavailable; listed calls will be accepted again",
              { exception_type: safeExceptionType(cause) },
            ),
          );
        }
        // The probe has answered for this page's identities, so hand the drain's
        // catch-up back to it: a trace it now reports is one the memory can stop
        // holding, and the same call re-listed by the overlap ages out here too.
        options.accepted.reconcile(committed, options.clock());
        const transient = await options.store.transientRetellCallState(
          target.auth,
          {
            monitoredAgentId: target.monitoredAgentId,
            providerCallIds: identities,
            importGeneration: target.importGeneration,
            now: options.clock(),
          },
        );

        // What this page still owes, decided in listed order before any of it
        // is fetched. Nothing here reaches the provider or the store, so the
        // two batched answers above settle every identity that is already
        // accounted for and what is left is the page's outstanding work.
        const outstanding: OutstandingCall[] = [];
        const owing = new Set<string>();
        for (const [index, listedCall] of listed.calls.entries()) {
          const providerCallId = identities[index] ?? "";
          const traceId = traceIdFor(projectId, providerCallId);
          // Committed in the store, or accepted by this poller and not yet
          // drained: either way the page owes it nothing. The memory is what
          // covers the gap the probe cannot — a call this turn's retry pass just
          // recovered, whose row is gone, or one an earlier turn accepted across
          // the accept-to-drain overlap. Hydrating again would put a second
          // reading of one conversation under one immutable identity, and where
          // the provider reports no timestamps of its own those readings differ
          // and the drainer would rightly retain the pair as an integrity defect
          // that nothing outside this loop caused.
          if (committed.has(traceId) || options.accepted.has(traceId)) {
            counts.settled += 1;
            continue;
          }
          const held = transient.get(providerCallId);
          // A retry not yet due, and a call recently given up on, are both
          // already accounted for: this page owes them nothing today.
          if (held !== undefined && held.nextAttemptAt === null) {
            counts.settled += 1;
            continue;
          }
          if (
            held !== undefined &&
            held.nextAttemptAt !== null &&
            held.nextAttemptAt > options.clock()
          ) {
            counts.settled += 1;
            continue;
          }

          // One identity is read once a turn however often the page lists it.
          // A second reading of one conversation under one immutable identity
          // is the defect the memory above exists to keep out, and a page that
          // repeats a row must not be the way it gets in.
          if (owing.has(providerCallId)) {
            counts.settled += 1;
            continue;
          }
          owing.add(providerCallId);
          outstanding.push({
            providerCallId,
            listedCall,
            held: held !== undefined,
          });
        }

        const hydrations = await hydrateOutstanding(
          target,
          outstanding,
          options,
          counts,
          turnBoundReached,
        );
        // Page-mates finish together, so their retry rows and terminal drops
        // are durable whatever answer stands beside them in listed order. The
        // turn's own record must carry what the store already holds, which is
        // why every answer is counted before any answer is allowed to end the
        // turn.
        for (const hydration of hydrations) {
          if (hydration.status !== "fulfilled") continue;
          if (hydration.value.kind === "dropped") counts.dropped += 1;
          if (hydration.value.kind === "scheduled") counts.settled += 1;
        }
        for (const hydration of hydrations) {
          if (hydration.status === "rejected") throw hydration.reason;
          const stopped = await turnEndedBy(hydration.value);
          if (stopped !== undefined) return stopped;
        }
        // The turn ran out of time inside this page, so what follows must not
        // advance past the calls it never reached.
        if (hydrations.length < outstanding.length) return yieldBoundedTurn();
      }

      if (!listed.hasMore) {
        const now = options.clock();
        await recover(options.store, target, options.log, now);
        const finished = await options.store.finishRetellMonitoringScan(
          target.auth,
          target,
          { now, pollMilliseconds: regularPollMilliseconds(target) },
        );
        leaseFinished = true;
        return finished ? completed() : completed("lease_lost");
      }

      const nextPaginationKey = listed.paginationKey?.trim() ?? "";
      if (
        nextPaginationKey === "" ||
        nextPaginationKey === paginationKey ||
        seenPaginationKeys.has(nextPaginationKey)
      ) {
        return releaseForContract();
      }

      seenPaginationKeys.add(nextPaginationKey);
      const checkpointed = await options.store.checkpointRetellMonitoringPage(
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
    await recover(options.store, target, options.log, now);
    await options.store.yieldRetellMonitoringLease(target.auth, target, {
      retryAt: nextPollAfter(target, now),
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
        await options.store.yieldRetellMonitoringLease(target.auth, target, {
          retryAt: nextPollAfter(target, now),
          now,
        });
      } catch {
        // Lease expiry is the recovery path when the store cannot release it.
      }
    }
  }
}

/** Process one DB-leased due Retell target. */
export async function runRetellProductionIngestion(
  input: RunRetellProductionIngestionOptions,
): Promise<RetellProductionIngestionResult> {
  const store = input.store ?? STORE;
  const clock = input.clock ?? (() => new Date());
  const options: TurnOptions = {
    log: input.log,
    metrics: input.metrics ?? METRICS,
    store,
    provider: input.provider ?? PROVIDER,
    lookup: input.lookup ?? LOOKUP,
    acceptance: input.acceptance ?? ACCEPTANCE,
    // One turn on its own remembers nothing past itself; the standing loop hands
    // in a shared memory so a call accepted on one turn is recognised on the next.
    accepted: input.accepted ?? acceptedIdentities(),
    clock,
    reach: input.reach ?? {},
    requestTimeoutMilliseconds: validPositiveInteger(
      input.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
      "the Retell request timeout",
    ),
    maxPagesPerTurn: validPositiveInteger(
      input.maxPagesPerTurn ?? DEFAULT_MAXIMUM_PAGES_PER_TURN,
      "the Retell page bound",
    ),
    maxTurnMilliseconds: validPositiveInteger(
      input.maxTurnMilliseconds ?? DEFAULT_MAXIMUM_TURN_MILLISECONDS,
      "the Retell turn bound",
    ),
  };

  const target = await store.claimDueRetellMonitoringAgent({ now: clock() });
  if (target === undefined) return emptyResult();
  return runTarget(target, options);
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
  // One memory for the life of the loop, so a call accepted on one turn is not
  // imported again on the next while its drain is still behind.
  const accepted = options.accepted ?? acceptedIdentities();
  const ingest =
    options.ingest ??
    (() => runRetellProductionIngestion({ ...options, accepted }));

  let running = false;
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();
  let failureStartedAt: Date | undefined;
  let failureCount = 0;

  const tick = async (): Promise<void> => {
    running = true;
    try {
      // One due target per ingestion call keeps the module seam small. A
      // standing turn drains every due DB-leased target so selecting three
      // Retell agents does not turn a 30-second schedule into 90 seconds.
      let result: RetellProductionIngestionResult;
      do {
        result = await ingest();
      } while (result.targetClaimed && !stopping);
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
