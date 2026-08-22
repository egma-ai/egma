import type {
  NewSpan,
  RetellMonitoringTarget,
  TransientRetellCall,
} from "@egma/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IngestionUnavailableError } from "../src/ingestion/accept.ts";
import {
  runRetellProductionIngestion,
  startRetellProductionIngestion,
  type RetellCommittedLookup,
  type RetellEvidenceAcceptance,
  type RetellProductionIngestionMetricTurn,
  type RetellProductionIngestionMetrics,
  type RetellProductionIngestionLog,
  type RetellProductionIngestionResult,
  type RetellProductionIngestionStore,
  type RetellProductionProvider,
} from "../src/retell-production-ingestion.ts";
import { type RetellCallPageRequest } from "../src/retell/api.ts";
import { traceIdFor, type RetellCall } from "../src/retell/normalise.ts";

const BASE = new Date("2026-08-19T12:00:00.000Z");
const AUTH = {
  userId: "production-monitoring",
  organizationId: "org_ingestion_test",
  projectId: "prj_ingestion_test",
  role: "member",
  via: "monitoring",
} as const;

const TARGET: RetellMonitoringTarget = {
  setupId: "mns_ingestion_test",
  monitoredAgentId: "rma_ingestion_test",
  platformAgentId: "agent-secret-id-must-not-be-logged",
  platformAgentName: "Private agent name must not be logged",
  apiKey: "retell-key-must-not-be-logged",
  scanKind: "historical_import",
  scanFrom: new Date("2026-07-20T12:00:00.000Z"),
  scanThrough: BASE,
  paginationKey: null,
  seenPaginationKeys: [],
  importGeneration: 1,
  hasTransientCallState: false,
  setupConsecutiveFailures: 0,
  leaseOwner: "lease-secret-must-not-be-logged",
  leaseExpiresAt: new Date("2026-08-19T12:01:30.000Z"),
  auth: AUTH,
};

/** The same waits the poller schedules, so a test can move a clock past them. */
const BACKOFF = [30_000, 60_000, 120_000];
/** Three regular overlaps, which is how long a recent-drop marker applies. */
const MARKER_MILLISECONDS = 15 * 60_000;

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------- *
 * The control database, modelled rather than mocked.
 *
 * The bounded budget is only real if it survives a restart, and a restart is
 * exactly "the process forgets everything and the rows do not". So these rows
 * live outside the poller and outlive every call into it, and the assertions
 * about counts, markers and generations are assertions about them.
 * ------------------------------------------------------------------- */

type RetryRow = {
  attempts: number;
  errorKind: string;
  nextAttemptAt: Date | null;
  expiresAt: Date | null;
  importGeneration: number;
};

type StoreRecord = {
  claims: number;
  renewals: number;
  transientLookups: string[][];
  checkpoints: { paginationKey: string; seenPaginationKeys: readonly string[] }[];
  yields: Date[];
  finishes: number[];
  failures: { kind: string; retryAt: Date }[];
  releases: string[];
  rows: Map<string, RetryRow>;
  sweeps: number;
  deletes: string[];
};

function record(rows: Map<string, RetryRow> = new Map()): StoreRecord {
  return {
    claims: 0,
    renewals: 0,
    transientLookups: [],
    checkpoints: [],
    yields: [],
    finishes: [],
    failures: [],
    releases: [],
    rows,
    sweeps: 0,
    deletes: [],
  };
}

function transientOf(
  providerCallId: string,
  row: RetryRow,
): TransientRetellCall {
  return {
    providerCallId,
    attempts: row.attempts,
    errorKind: row.errorKind,
    nextAttemptAt: row.nextAttemptAt,
    expiresAt: row.expiresAt,
  };
}

type StoreChanges = Partial<RetellProductionIngestionStore>;

function store(
  recorded: StoreRecord,
  target: RetellMonitoringTarget | undefined = TARGET,
  changes: StoreChanges = {},
): RetellProductionIngestionStore {
  let offered = false;
  const applies = (row: RetryRow, generation: number, now: Date): boolean =>
    row.importGeneration === generation &&
    (row.nextAttemptAt !== null ||
      (row.expiresAt !== null && row.expiresAt > now));

  return {
    async claimDueRetellMonitoringAgent() {
      recorded.claims += 1;
      if (offered || target === undefined) return undefined;
      offered = true;
      return { ...target, hasTransientCallState: recorded.rows.size > 0 };
    },
    async renewRetellMonitoringLease() {
      recorded.renewals += 1;
      return true;
    },
    async checkpointRetellMonitoringPage(_auth, _target, checkpoint) {
      recorded.checkpoints.push(checkpoint);
      return true;
    },
    async yieldRetellMonitoringLease(_auth, _target, input) {
      recorded.yields.push(input.retryAt);
      return true;
    },
    async finishRetellMonitoringScan(_auth, _target, options) {
      recorded.finishes.push(options?.pollMilliseconds ?? -1);
      return true;
    },
    async failRetellMonitoringTarget(_auth, _target, input) {
      recorded.failures.push({ kind: input.kind, retryAt: input.retryAt });
      return { changed: true, failures: 1, startedAt: input.now ?? BASE };
    },
    async recoverRetellMonitoringSetup() {
      return { recovered: false };
    },
    async releaseRetellMonitoringLease(_auth, _target, input) {
      recorded.releases.push(input.errorKind);
    },
    async transientRetellCallState(_auth, input) {
      recorded.transientLookups.push([...input.providerCallIds]);
      const now = input.now ?? BASE;
      const found = new Map<string, TransientRetellCall>();
      for (const providerCallId of input.providerCallIds) {
        const row = recorded.rows.get(providerCallId);
        if (row === undefined) continue;
        if (!applies(row, input.importGeneration, now)) continue;
        found.set(providerCallId, transientOf(providerCallId, row));
      }
      return found;
    },
    async dueRetellCallRetries(_auth, input) {
      const now = input.now ?? BASE;
      const due: TransientRetellCall[] = [];
      for (const [providerCallId, row] of recorded.rows) {
        if (row.importGeneration !== input.importGeneration) continue;
        if (row.nextAttemptAt === null || row.nextAttemptAt > now) continue;
        due.push(transientOf(providerCallId, row));
      }
      return due;
    },
    async recordRetellCallAttempt(_auth, owner, input) {
      const now = input.now ?? BASE;
      const held = recorded.rows.get(input.providerCallId);
      const carries =
        held !== undefined && applies(held, owner.importGeneration, now);
      const attempts = carries ? held.attempts + 1 : 1;
      const dropped = attempts >= 4;
      recorded.rows.set(input.providerCallId, {
        attempts,
        errorKind: input.errorKind,
        nextAttemptAt: dropped
          ? null
          : new Date(
              now.getTime() +
                (input.retryBackoffMilliseconds[attempts - 1] ??
                  input.retryBackoffMilliseconds.at(-1) ??
                  0),
            ),
        expiresAt: dropped
          ? new Date(now.getTime() + MARKER_MILLISECONDS)
          : null,
        importGeneration: owner.importGeneration,
      });
      return { recorded: true, attempts, dropped, changed: attempts === 1 };
    },
    async deleteRetellCallRetry(_auth, _target, input) {
      recorded.deletes.push(input.providerCallId);
      recorded.rows.delete(input.providerCallId);
    },
    async sweepExpiredRetellCallMarkers(_auth, input) {
      recorded.sweeps += 1;
      const now = input.now ?? BASE;
      let swept = 0;
      for (const [providerCallId, row] of [...recorded.rows]) {
        if (row.expiresAt === null || row.expiresAt > now) continue;
        recorded.rows.delete(providerCallId);
        swept += 1;
      }
      return swept;
    },
    ...changes,
  };
}

function summary(callId: string): RetellCall {
  return {
    call_id: callId,
    agent_id: TARGET.platformAgentId,
    call_status: "ended",
    call_type: "phone_call",
    start_timestamp: BASE.getTime() - 20_000,
    end_timestamp: BASE.getTime() - 1_000,
  };
}

function hydrated(callId: string): RetellCall {
  return {
    ...summary(callId),
    transcript_with_tool_calls: [
      { role: "agent", content: "Hello" },
      { role: "user", content: "I need help" },
    ],
  };
}

function provider(
  changes: Partial<RetellProductionProvider> = {},
): RetellProductionProvider {
  return {
    async listTerminalCalls() {
      return { kind: "calls", calls: [], hasMore: false, paginationKey: null };
    },
    async hydrateRetellCall(_apiKey, listed) {
      return { kind: "call", call: listed };
    },
    async getRetellCall(_apiKey, callId) {
      return { kind: "call", call: hydrated(callId) };
    },
    ...changes,
  };
}

type AcceptanceRecord = {
  calls: readonly NewSpan[][];
  traceIds: string[];
};

function acceptance(
  recorded: AcceptanceRecord = { calls: [], traceIds: [] },
  refuse?: () => unknown,
): {
  readonly acceptance: RetellEvidenceAcceptance;
  readonly recorded: AcceptanceRecord;
} {
  const calls: NewSpan[][] = [...recorded.calls.map((one) => [...one])];
  const held: AcceptanceRecord = { calls, traceIds: recorded.traceIds };
  return {
    recorded: held,
    acceptance: {
      async acceptEvidence(spans) {
        const cause = refuse?.();
        if (cause !== undefined) throw cause;
        calls.push([...spans]);
        for (const span of spans) {
          if (!held.traceIds.includes(span.traceId)) {
            held.traceIds.push(span.traceId);
          }
        }
        return { accepted: spans.length, refused: [] };
      },
    },
  };
}

type LookupRecord = {
  windows: { from: bigint; to: bigint }[];
  asked: string[][];
};

function lookup(
  recorded: LookupRecord,
  committed: ReadonlySet<string> = new Set(),
  fail?: () => unknown,
): RetellCommittedLookup {
  return {
    async committedTraces(_auth, traceIds, options) {
      const cause = fail?.();
      if (cause !== undefined) throw cause;
      recorded.windows.push(options.window);
      recorded.asked.push([...traceIds]);
      return new Set([...traceIds].filter((id) => committed.has(id)));
    },
  };
}

type Logged = {
  info: Record<string, unknown>[];
  warn: Record<string, unknown>[];
  error: Record<string, unknown>[];
};

function logger(): {
  readonly log: RetellProductionIngestionLog;
  readonly events: Logged;
} {
  const events: Logged = { info: [], warn: [], error: [] };
  return {
    events,
    log: {
      info(event) {
        events.info.push(event);
      },
      warn(event) {
        events.warn.push(event);
      },
      error(event) {
        events.error.push(event);
      },
    },
  };
}

type MetricRecord = {
  attempts: RetellMonitoringTarget["scanKind"][];
  turns: RetellProductionIngestionMetricTurn[];
  lags: number[];
  providerFailures: string[];
  dropped: string[];
};

function metricRecorder(): {
  readonly metrics: RetellProductionIngestionMetrics;
  readonly recorded: MetricRecord;
} {
  const recorded: MetricRecord = {
    attempts: [],
    turns: [],
    lags: [],
    providerFailures: [],
    dropped: [],
  };
  return {
    recorded,
    metrics: {
      recordAttempt(scanKind) {
        recorded.attempts.push(scanKind);
      },
      recordTurn(turn) {
        recorded.turns.push(turn);
      },
      recordIngestionLag(_scanKind, lagMilliseconds) {
        recorded.lags.push(lagMilliseconds);
      },
      recordProviderFailure(kind) {
        recorded.providerFailures.push(kind);
      },
      recordDroppedCall(reason) {
        recorded.dropped.push(reason);
      },
    },
  };
}

function nothingClaimed(): RetellProductionIngestionResult {
  return {
    targetClaimed: false,
    pages: 0,
    accepted: 0,
    already: 0,
    dropped: 0,
  };
}

describe("Retell production ingestion", () => {
  it("keeps one fixed window while it pages, accepts only new calls, and checkpoints durable pages", async () => {
    const recorded = record();
    const requests: RetellCallPageRequest[] = [];
    const hydratedIds: string[] = [];
    const first = summary("call_already_committed");
    const second = summary("call_new_first_page");
    const third = summary("call_new_second_page");
    let page = 0;
    const asked: LookupRecord = { windows: [], asked: [] };
    const taken = acceptance();
    const retell = provider({
      async listTerminalCalls(_key, request) {
        requests.push(request);
        page += 1;
        return page === 1
          ? {
              kind: "calls",
              calls: [first, second],
              hasMore: true,
              paginationKey: "opaque-next-page",
            }
          : {
              kind: "calls",
              calls: [third],
              hasMore: false,
              paginationKey: null,
            };
      },
      async hydrateRetellCall(_key, listed) {
        hydratedIds.push(String(listed["call_id"]));
        return { kind: "call", call: hydrated(String(listed["call_id"])) };
      },
    });
    const { log } = logger();
    const observed = metricRecorder();

    const result = await runRetellProductionIngestion({
      log,
      metrics: observed.metrics,
      store: store(recorded),
      provider: retell,
      lookup: lookup(
        asked,
        new Set([traceIdFor(AUTH.projectId, "call_already_committed")]),
      ),
      acceptance: taken.acceptance,
      clock: () => BASE,
    });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.paginationKey)).toEqual([
      undefined,
      "opaque-next-page",
    ]);
    expect(
      requests.map((request) => [request.from.toISOString(), request.to.toISOString()]),
    ).toEqual([
      [TARGET.scanFrom.toISOString(), TARGET.scanThrough.toISOString()],
      [TARGET.scanFrom.toISOString(), TARGET.scanThrough.toISOString()],
    ]);
    expect(hydratedIds).toEqual(["call_new_first_page", "call_new_second_page"]);
    expect(taken.recorded.traceIds).toEqual(
      hydratedIds.map((id) => traceIdFor(AUTH.projectId, id)),
    );
    expect(recorded.checkpoints).toEqual([
      {
        paginationKey: "opaque-next-page",
        seenPaginationKeys: ["opaque-next-page"],
      },
    ]);
    expect(recorded.finishes).toHaveLength(1);
    expect(recorded.finishes[0]).toBeGreaterThanOrEqual(27_000);
    expect(recorded.finishes[0]).toBeLessThanOrEqual(33_000);
    expect(result).toMatchObject({ accepted: 2, already: 1, pages: 2 });
    expect(recorded.rows.size).toBe(0);
    expect(observed.recorded).toMatchObject({
      attempts: ["historical_import"],
      turns: [
        {
          scanKind: "historical_import",
          outcome: "completed",
          accepted: 2,
          already: 1,
          dropped: 0,
        },
      ],
      lags: [1_000, 1_000],
      providerFailures: [],
    });
  });

  it("asks one batched committed lookup and one batched transient lookup for each page", async () => {
    const recorded = record();
    const asked: LookupRecord = { windows: [], asked: [] };
    const listed = [summary("call_one"), summary("call_two")];
    const { log } = logger();

    await runRetellProductionIngestion({
      log,
      store: store(recorded),
      provider: provider({
        async listTerminalCalls() {
          return {
            kind: "calls",
            calls: listed,
            hasMore: false,
            paginationKey: null,
          };
        },
        async hydrateRetellCall(_key, one) {
          return { kind: "call", call: hydrated(String(one["call_id"])) };
        },
      }),
      lookup: lookup(asked),
      acceptance: acceptance().acceptance,
      clock: () => BASE,
    });

    expect(asked.asked).toEqual([
      ["call_one", "call_two"].map((id) => traceIdFor(AUTH.projectId, id)),
    ]);
    expect(recorded.transientLookups).toEqual([["call_one", "call_two"]]);
  });

  it("measures the committed window from the fixed scan bounds and never from now", async () => {
    const recorded = record();
    const asked: LookupRecord = { windows: [], asked: [] };
    const { log } = logger();
    const muchLater = new Date(BASE.getTime() + 40 * 24 * 60 * 60 * 1_000);

    await runRetellProductionIngestion({
      log,
      store: store(recorded),
      provider: provider({
        async listTerminalCalls() {
          return {
            kind: "calls",
            calls: [summary("call_one")],
            hasMore: false,
            paginationKey: null,
          };
        },
      }),
      lookup: lookup(asked),
      acceptance: acceptance().acceptance,
      clock: () => muchLater,
    });

    const window = asked.windows[0];
    expect(window).toBeDefined();
    // Below the scan's own lower bound, because the provider lists by the
    // instant a call ended and the store files it by the instant it started.
    expect(Number(window!.from / 1000n)).toBeLessThanOrEqual(
      TARGET.scanFrom.getTime(),
    );
    expect(Number(window!.to / 1000n)).toBeLessThanOrEqual(
      TARGET.scanThrough.getTime() + 1_000,
    );
  });

  it("accepts the listed calls again when the committed lookup is unavailable", async () => {
    const recorded = record();
    const asked: LookupRecord = { windows: [], asked: [] };
    const taken = acceptance();
    const { log, events } = logger();

    const result = await runRetellProductionIngestion({
      log,
      store: store(recorded),
      provider: provider({
        async listTerminalCalls() {
          return {
            kind: "calls",
            calls: [summary("call_one")],
            hasMore: false,
            paginationKey: null,
          };
        },
        async hydrateRetellCall(_key, one) {
          return { kind: "call", call: hydrated(String(one["call_id"])) };
        },
      }),
      lookup: lookup(asked, new Set(), () => new Error("private store detail")),
      acceptance: taken.acceptance,
      clock: () => BASE,
    });

    expect(result).toMatchObject({ accepted: 1 });
    expect(recorded.finishes).toHaveLength(1);
    expect(events.warn).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("private store detail");
  });

  it("stops a fixed scan when Retell repeats an opaque cursor", async () => {
    const recorded = record();
    let calls = 0;
    const retell = provider({
      async listTerminalCalls() {
        calls += 1;
        return {
          kind: "calls",
          calls: [],
          hasMore: true,
          paginationKey: "same-opaque-cursor",
        };
      },
    });
    const { log } = logger();

    const result = await runRetellProductionIngestion({
      log,
      store: store(recorded),
      provider: retell,
      clock: () => BASE,
    });

    expect(calls).toBe(2);
    expect(recorded.checkpoints).toHaveLength(1);
    expect(recorded.releases).toEqual(["provider_contract"]);
    expect(result.stoppedBecause).toBe("provider_contract");
  });

  it("preserves a provider-contract refusal from the Retell adapter", async () => {
    const recorded = record();
    const { log } = logger();

    const result = await runRetellProductionIngestion({
      log,
      store: store(recorded),
      provider: provider({
        async listTerminalCalls() {
          return { kind: "refused", reason: "provider-contract" };
        },
      }),
      clock: () => BASE,
    });

    expect(recorded.releases).toEqual(["provider_contract"]);
    expect(recorded.failures).toEqual([]);
    expect(result.stoppedBecause).toBe("provider_contract");
  });

  it("makes no provider request after it loses the target lease", async () => {
    const recorded = record();
    let providerRequests = 0;
    const storage = store(recorded, TARGET, {
      async renewRetellMonitoringLease() {
        recorded.renewals += 1;
        return false;
      },
    });
    const { log } = logger();

    const result = await runRetellProductionIngestion({
      log,
      store: storage,
      provider: provider({
        async listTerminalCalls() {
          providerRequests += 1;
          return { kind: "calls", calls: [], hasMore: false, paginationKey: null };
        },
      }),
      clock: () => BASE,
    });

    expect(providerRequests).toBe(0);
    expect(result.stoppedBecause).toBe("lease_lost");
  });

  it("does not ask for the next page when lease renewal is lost", async () => {
    const recorded = record();
    let renewals = 0;
    let providerRequests = 0;
    const storage = store(recorded, TARGET, {
      async renewRetellMonitoringLease() {
        renewals += 1;
        return renewals === 1;
      },
    });
    const { log } = logger();

    const result = await runRetellProductionIngestion({
      log,
      store: storage,
      provider: provider({
        async listTerminalCalls() {
          providerRequests += 1;
          return {
            kind: "calls",
            calls: [],
            hasMore: true,
            paginationKey: "page-after-lease-loss",
          };
        },
      }),
      clock: () => BASE,
    });

    expect(providerRequests).toBe(1);
    expect(recorded.checkpoints).toHaveLength(1);
    expect(result.stoppedBecause).toBe("lease_lost");
  });

  it("checks the setup-wide request gate before hydrating a listed call", async () => {
    const recorded = record();
    let renewals = 0;
    let listRequests = 0;
    let hydrationRequests = 0;
    const storage = store(recorded, TARGET, {
      async renewRetellMonitoringLease() {
        renewals += 1;
        return renewals === 1;
      },
    });
    const { log } = logger();

    const result = await runRetellProductionIngestion({
      log,
      store: storage,
      provider: provider({
        async listTerminalCalls() {
          listRequests += 1;
          return {
            kind: "calls",
            calls: [summary("call-blocked-before-hydration")],
            hasMore: false,
            paginationKey: null,
          };
        },
        async hydrateRetellCall() {
          hydrationRequests += 1;
          return {
            kind: "call",
            call: hydrated("call-blocked-before-hydration"),
          };
        },
      }),
      clock: () => BASE,
    });

    expect(listRequests).toBe(1);
    expect(hydrationRequests).toBe(0);
    expect(result.stoppedBecause).toBe("lease_lost");
  });

  it("does not overlap standing ticks", async () => {
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { log } = logger();
    const ingestion = startRetellProductionIngestion({
      log,
      intervalMilliseconds: 5,
      ingest: async () => {
        calls += 1;
        await held;
        return nothingClaimed();
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toBe(1);
    release();
    await ingestion.stop();
  });

  it("drains every due leased target in one standing turn", async () => {
    let calls = 0;
    let drained!: () => void;
    const allDueTargetsDrained = new Promise<void>((resolve) => {
      drained = resolve;
    });
    const { log } = logger();
    const ingestion = startRetellProductionIngestion({
      log,
      intervalMilliseconds: 5,
      ingest: async () => {
        calls += 1;
        const targetClaimed = calls <= 2;
        if (!targetClaimed) drained();
        return {
          ...nothingClaimed(),
          targetClaimed,
          pages: targetClaimed ? 1 : 0,
        };
      },
    });

    await allDueTargetsDrained;
    await ingestion.stop();

    expect(calls).toBe(3);
  });

  it("logs one unexpected runtime failure and one recovery", async () => {
    let attempts = 0;
    const { log, events } = logger();
    const ingestion = startRetellProductionIngestion({
      log,
      intervalMilliseconds: 5,
      ingest: async () => {
        attempts += 1;
        if (attempts < 3) throw new TypeError("private provider data");
        return nothingClaimed();
      },
    });

    const deadline = Date.now() + 500;
    while (attempts < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await ingestion.stop();

    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(events.error).toHaveLength(1);
    expect(events.error[0]).toMatchObject({
      "otel.event.name": "egma.monitoring.retell.runtime.failed",
      exception_type: "TypeError",
    });
    expect(events.info).toHaveLength(1);
    expect(events.info[0]).toMatchObject({
      "otel.event.name": "egma.monitoring.retell.runtime.recovered",
      failure_count: 2,
    });
    expect(JSON.stringify(events)).not.toContain("private provider data");
  });

  it("records an unexpected target failure before the standing loop logs it", async () => {
    const recorded = record();
    const { log } = logger();

    await expect(
      runRetellProductionIngestion({
        log,
        store: store(recorded),
        provider: provider({
          async listTerminalCalls() {
            return {
              kind: "calls",
              calls: [summary("private-store-failure-call")],
              hasMore: false,
              paginationKey: null,
            };
          },
          async hydrateRetellCall() {
            return {
              kind: "call",
              call: hydrated("private-store-failure-call"),
            };
          },
        }),
        lookup: lookup({ windows: [], asked: [] }),
        acceptance: {
          async acceptEvidence() {
            throw new TypeError("a private store failure");
          },
        },
        clock: () => BASE,
      }),
    ).rejects.toThrow("a private store failure");

    expect(recorded.releases).toEqual(["internal_failure"]);
  });

  it("keeps an empty successful poll quiet, and asks nothing beyond the provider", async () => {
    const recorded = record();
    const asked: LookupRecord = { windows: [], asked: [] };
    const taken = acceptance();
    let hydrationRequests = 0;
    const { log, events } = logger();
    const observed = metricRecorder();

    const result = await runRetellProductionIngestion({
      log,
      metrics: observed.metrics,
      store: store(recorded),
      provider: provider({
        async hydrateRetellCall(_key, listed) {
          hydrationRequests += 1;
          return { kind: "call", call: listed };
        },
      }),
      lookup: lookup(asked),
      acceptance: taken.acceptance,
      clock: () => BASE,
    });

    expect(result).toMatchObject({ accepted: 0, dropped: 0 });
    expect(asked.asked).toEqual([]);
    expect(recorded.transientLookups).toEqual([]);
    expect(recorded.sweeps).toBe(0);
    expect(hydrationRequests).toBe(0);
    expect(taken.recorded.calls).toEqual([]);
    expect(events).toEqual({ info: [], warn: [], error: [] });
    expect(observed.recorded).toMatchObject({
      attempts: ["historical_import"],
      turns: [{ outcome: "completed", accepted: 0, already: 0, dropped: 0 }],
    });
  });

  it("uses one setup-wide Retry-After gate without a repeated log", async () => {
    const recorded = record();
    const storage = store(recorded, TARGET, {
      async failRetellMonitoringTarget(_auth, _target, input) {
        recorded.failures.push({ kind: input.kind, retryAt: input.retryAt });
        return { changed: false, failures: 4, startedAt: BASE };
      },
    });
    const { log, events } = logger();
    const observed = metricRecorder();

    await runRetellProductionIngestion({
      log,
      metrics: observed.metrics,
      store: storage,
      provider: provider({
        async listTerminalCalls() {
          return {
            kind: "refused",
            reason: "rate-limited",
            status: 429,
            retryAfterMilliseconds: 12_000,
          };
        },
      }),
      clock: () => BASE,
    });

    expect(recorded.failures).toEqual([
      {
        kind: "rate_limited",
        retryAt: new Date(BASE.getTime() + 12_000),
      },
    ]);
    expect(events).toEqual({ info: [], warn: [], error: [] });
    expect(observed.recorded.providerFailures).toEqual(["rate_limited"]);
  });

  it("caps unavailable-provider backoff and logs only the health transition", async () => {
    const recorded = record();
    const { log, events } = logger();
    const failedManyTimes: RetellMonitoringTarget = {
      ...TARGET,
      setupConsecutiveFailures: 20,
    };

    await runRetellProductionIngestion({
      log,
      store: store(recorded, failedManyTimes),
      provider: provider({
        async listTerminalCalls() {
          return {
            kind: "refused",
            reason: "provider-unavailable",
            status: 503,
          };
        },
      }),
      clock: () => BASE,
    });

    expect(recorded.failures[0]?.kind).toBe("provider_unavailable");
    const delay =
      (recorded.failures[0]?.retryAt.getTime() ?? BASE.getTime()) -
      BASE.getTime();
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(5 * 60_000);
    expect(events.warn).toHaveLength(1);
    expect(events.error).toHaveLength(0);
  });

  it("logs one recovery after a successful provider turn", async () => {
    const recorded = record();
    const { log, events } = logger();
    const storage = store(recorded, TARGET, {
      async recoverRetellMonitoringSetup() {
        return {
          recovered: true,
          failures: 3,
          startedAt: new Date(BASE.getTime() - 60_000),
        };
      },
    });

    await runRetellProductionIngestion({
      log,
      store: storage,
      provider: provider(),
      clock: () => BASE,
    });

    expect(events.info).toHaveLength(1);
    expect(events.info[0]).toMatchObject({
      "otel.event.name": "egma.monitoring.retell.health.recovered",
      outage_duration_ms: 60_000,
      failure_count: 3,
    });
    expect(events.warn).toEqual([]);
    expect(events.error).toEqual([]);
  });

  it("blocks an invalid key until configuration changes and logs only its state change", async () => {
    const recorded = record();
    const { log, events } = logger();

    await runRetellProductionIngestion({
      log,
      store: store(recorded),
      provider: provider({
        async listTerminalCalls() {
          return { kind: "invalid-key" };
        },
      }),
      clock: () => BASE,
    });

    expect(recorded.failures).toHaveLength(1);
    expect(recorded.failures[0]?.kind).toBe("invalid_credential");
    expect(recorded.failures[0]?.retryAt.getUTCFullYear()).toBe(9999);
    expect(events.error).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(TARGET.apiKey);
    expect(JSON.stringify(events)).not.toContain(TARGET.platformAgentId);
    expect(JSON.stringify(events)).not.toContain(TARGET.platformAgentName);
  });

  it("applies a request deadline and classifies a timed-out read as unavailable", async () => {
    const recorded = record();
    const { log } = logger();

    await runRetellProductionIngestion({
      log,
      store: store(recorded),
      provider: provider({
        async listTerminalCalls(_key, _request, reach) {
          return new Promise((resolve) => {
            reach?.signal?.addEventListener(
              "abort",
              () => resolve({ kind: "unreachable", reason: "deadline" }),
              { once: true },
            );
          });
        },
      }),
      clock: () => BASE,
      requestTimeoutMilliseconds: 10,
    });

    expect(recorded.failures[0]?.kind).toBe("provider_unavailable");
  });

  it("yields the same fixed scan after its page or wall-time bound", async () => {
    for (const boundedBy of ["pages", "time"] as const) {
      const recorded = record();
      let providerRequests = 0;
      let advanced = 0;
      const clock = () => new Date(BASE.getTime() + advanced);
      const { log } = logger();

      const result = await runRetellProductionIngestion({
        log,
        store: store(recorded),
        provider: provider({
          async listTerminalCalls() {
            providerRequests += 1;
            advanced = 100;
            return {
              kind: "calls",
              calls: [],
              hasMore: true,
              paginationKey: "more-work-remains",
            };
          },
        }),
        clock,
        maxPagesPerTurn: boundedBy === "pages" ? 1 : 10,
        maxTurnMilliseconds: boundedBy === "time" ? 50 : 20_000,
      });

      expect(providerRequests, boundedBy).toBe(1);
      expect(recorded.checkpoints, boundedBy).toHaveLength(1);
      expect(recorded.yields, boundedBy).toHaveLength(1);
      expect(result.stoppedBecause, boundedBy).toBe("bounded_turn");
    }
  });

  it("does not file a hydrated call under a different selected Retell agent", async () => {
    const recorded = record();
    const taken = acceptance();
    const { log, events } = logger();
    const mismatched = {
      ...hydrated("call_wrong_agent"),
      agent_id: "different-private-agent-id",
    };
    const result = await runRetellProductionIngestion({
      log,
      store: store(recorded),
      provider: provider({
        async listTerminalCalls() {
          return {
            kind: "calls",
            calls: [summary("call_wrong_agent")],
            hasMore: false,
            paginationKey: null,
          };
        },
        async hydrateRetellCall() {
          return { kind: "call", call: mismatched };
        },
      }),
      lookup: lookup({ windows: [], asked: [] }),
      acceptance: taken.acceptance,
      clock: () => BASE,
    });

    expect(result).toMatchObject({ accepted: 0, already: 1 });
    expect(recorded.rows.get("call_wrong_agent")).toMatchObject({
      attempts: 1,
      errorKind: "platform_agent_mismatch",
    });
    expect(taken.recorded.calls).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("different-private-agent-id");
  });

  it("yields inside a large page without checkpointing past unprocessed calls", async () => {
    const recorded = record();
    const hydratedIds: string[] = [];
    let advanced = 0;
    const clock = () => new Date(BASE.getTime() + advanced);
    const { log } = logger();

    const result = await runRetellProductionIngestion({
      log,
      store: store(recorded),
      provider: provider({
        async listTerminalCalls() {
          return {
            kind: "calls",
            calls: [summary("call_first"), summary("call_second")],
            hasMore: true,
            paginationKey: "page-after-large-page",
          };
        },
        async hydrateRetellCall(_key, listed) {
          hydratedIds.push(String(listed["call_id"]));
          return { kind: "call", call: hydrated(String(listed["call_id"])) };
        },
      }),
      lookup: lookup({ windows: [], asked: [] }),
      acceptance: {
        async acceptEvidence(spans) {
          advanced = 60;
          return { accepted: spans.length, refused: [] };
        },
      },
      clock,
      maxTurnMilliseconds: 50,
    });

    expect(hydratedIds).toEqual(["call_first"]);
    expect(recorded.checkpoints).toEqual([]);
    expect(recorded.yields).toHaveLength(1);
    expect(result.stoppedBecause).toBe("bounded_turn");
  });

  it("uses cheap empty wakes so jittered 33-second targets do not wait 60 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const providerPolls: number[] = [];
    let dueAt = BASE.getTime();
    const { log, events } = logger();
    const ingestion = startRetellProductionIngestion({
      log,
      ingest: async () => {
        const now = Date.now();
        const targetClaimed = now >= dueAt;
        if (targetClaimed) {
          providerPolls.push(now);
          dueAt = now + 33_000;
        }
        return {
          ...nothingClaimed(),
          targetClaimed,
          pages: targetClaimed ? 1 : 0,
        };
      },
    });

    await vi.advanceTimersByTimeAsync(80_000);
    await ingestion.stop();

    expect(providerPolls).toHaveLength(3);
    expect(providerPolls.slice(1).map((at, index) => at - providerPolls[index]!))
      .toEqual([35_000, 35_000]);
    expect(events).toEqual({ info: [], warn: [], error: [] });
  });
});

describe("the bounded Retell retry budget", () => {
  /**
   * One page listing one call that will not hydrate, then the same call owed a
   * retry on later turns. Each `turn()` is one poll; the rows outlive them all,
   * which is what makes "restart" mean something here.
   */
  function failingWorld(options: {
    readonly rows?: Map<string, RetryRow> | undefined;
    readonly hydrates?: boolean | undefined;
  } = {}) {
    const recorded = record(options.rows ?? new Map());
    const hydrations: string[] = [];
    const directReads: string[] = [];
    const taken = acceptance();
    // The trace store, as far as this world is concerned: whatever acceptance
    // has taken is committed, so a later page recognises its own work instead
    // of importing it twice.
    const committed = new Set<string>();
    const asked: LookupRecord = { windows: [], asked: [] };
    const observed = metricRecorder();
    const heard = logger();
    let listedCalls: RetellCall[] = [summary("call_that_will_not_hydrate")];
    let hydrates = options.hydrates ?? false;

    const turn = async (
      at: Date,
      target: RetellMonitoringTarget = TARGET,
    ): Promise<RetellProductionIngestionResult> =>
      runRetellProductionIngestion({
        log: heard.log,
        metrics: observed.metrics,
        store: store(recorded, target),
        provider: provider({
          async listTerminalCalls() {
            return {
              kind: "calls",
              calls: listedCalls,
              hasMore: false,
              paginationKey: null,
            };
          },
          async hydrateRetellCall(_key, listed) {
            const callId = String(listed["call_id"]);
            hydrations.push(callId);
            return hydrates
              ? { kind: "call", call: hydrated(callId) }
              : { kind: "not-found" };
          },
          async getRetellCall(_key, callId) {
            directReads.push(callId);
            return hydrates
              ? { kind: "call", call: hydrated(callId) }
              : { kind: "not-found" };
          },
        }),
        lookup: lookup(asked, committed),
        acceptance: {
          async acceptEvidence(spans, given) {
            const answer = await taken.acceptance.acceptEvidence(spans, given);
            for (const span of spans) committed.add(span.traceId);
            return answer;
          },
        },
        clock: () => at,
      });

    return {
      recorded,
      hydrations,
      directReads,
      taken,
      asked,
      observed,
      events: heard.events,
      turn,
      list(calls: RetellCall[]) {
        listedCalls = calls;
      },
      succeed() {
        hydrates = true;
      },
    };
  }

  it("keeps its stored count across a restart, makes no fourth automatic retry, and advances the page", async () => {
    const world = failingWorld();

    // The initial attempt, on the page that listed the call.
    const first = await world.turn(BASE);
    expect(world.hydrations).toEqual(["call_that_will_not_hydrate"]);
    expect(world.recorded.rows.get("call_that_will_not_hydrate")).toMatchObject(
      { attempts: 1 },
    );
    expect(world.recorded.finishes).toHaveLength(1);
    expect(first).toMatchObject({ accepted: 0, dropped: 0 });

    // One automatic retry, then Egma stops and starts again. Nothing about the
    // budget lived in the process, so the restart resumes rather than restarts.
    const afterFirstRetry = new Date(BASE.getTime() + BACKOFF[0]!);
    await world.turn(afterFirstRetry);
    expect(world.recorded.rows.get("call_that_will_not_hydrate")).toMatchObject(
      { attempts: 2 },
    );

    const afterRestart = new Date(afterFirstRetry.getTime() + BACKOFF[1]!);
    await world.turn(afterRestart);
    expect(world.recorded.rows.get("call_that_will_not_hydrate")).toMatchObject(
      { attempts: 3 },
    );

    const lastRetry = new Date(afterRestart.getTime() + BACKOFF[2]!);
    const terminal = await world.turn(lastRetry);
    expect(terminal).toMatchObject({ dropped: 1 });

    // Four attempts in all — one initial and three automatic retries — and the
    // row is now a marker that cannot schedule a fifth.
    expect(world.directReads).toHaveLength(3);
    expect(world.hydrations).toHaveLength(1);
    const marker = world.recorded.rows.get("call_that_will_not_hydrate");
    expect(marker).toMatchObject({ attempts: 4, nextAttemptAt: null });
    expect(marker?.expiresAt).not.toBeNull();

    // A later turn finds nothing due and makes no further provider request.
    const afterTheBudget = new Date(lastRetry.getTime() + 10 * 60_000);
    await world.turn(afterTheBudget);
    expect(world.directReads).toHaveLength(3);

    // The page advanced every time: the identity always had an answer.
    expect(world.recorded.finishes).toHaveLength(5);
    expect(world.taken.recorded.calls).toEqual([]);

    // One structured terminal event, carrying every identity an operator needs.
    const dropped = world.events.error.filter(
      (event) =>
        event["otel.event.name"] === "egma.monitoring.retell.call.dropped",
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      organization_id: AUTH.organizationId,
      project_id: AUTH.projectId,
      retell_monitored_agent_id: TARGET.monitoredAgentId,
      provider_call_id: "call_that_will_not_hydrate",
      error_kind: "provider_call_not_found",
      automatic_retries: 3,
    });

    // And one counter increment whose label is the reason class alone.
    expect(world.observed.recorded.dropped).toEqual([
      "provider_call_not_found",
    ]);
  });

  it("filters a dropped call out of a later overlap page without a provider fetch, then lets its marker expire", async () => {
    const world = failingWorld();
    let at = BASE;
    for (const wait of [0, ...BACKOFF]) {
      at = new Date(at.getTime() + wait);
      await world.turn(at);
    }
    expect(world.observed.recorded.dropped).toHaveLength(1);
    const readsBefore = world.directReads.length;
    const hydrationsBefore = world.hydrations.length;

    // A later regular page lists the same provider call again, as the
    // five-minute overlap is meant to. One batched transient lookup removes it
    // before hydration, so Retell is not asked about it at all.
    const overlapping = new Date(at.getTime() + 60_000);
    const overlap = await world.turn(overlapping);
    expect(world.recorded.transientLookups.at(-1)).toEqual([
      "call_that_will_not_hydrate",
    ]);
    expect(world.hydrations).toHaveLength(hydrationsBefore);
    expect(world.directReads).toHaveLength(readsBefore);
    expect(overlap).toMatchObject({ already: 1, accepted: 0, dropped: 0 });
    expect(world.observed.recorded.dropped).toHaveLength(1);

    // Past every overlap window the provider no longer lists the call, the
    // marker has nothing left to do, and it goes without anybody deleting it.
    world.list([]);
    const wellPast = new Date(at.getTime() + MARKER_MILLISECONDS + 60_000);
    await world.turn(wellPast);
    expect(world.recorded.rows.size).toBe(0);
  });

  it("does not apply an old regular-scan marker to a new explicit import", async () => {
    const world = failingWorld();
    let at = BASE;
    for (const wait of [0, ...BACKOFF]) {
      at = new Date(at.getTime() + wait);
      await world.turn(at);
    }
    const marker = world.recorded.rows.get("call_that_will_not_hydrate");
    expect(marker).toMatchObject({ importGeneration: 1, nextAttemptAt: null });
    const readsBefore = world.directReads.length;

    // Selecting the agent again is a new observation of the provider's
    // history, so the import runs under a new generation.
    world.succeed();
    const reimport: RetellMonitoringTarget = {
      ...TARGET,
      scanKind: "historical_import",
      importGeneration: 2,
    };
    const imported = await world.turn(new Date(at.getTime() + 60_000), reimport);

    expect(imported).toMatchObject({ accepted: 1 });
    expect(world.hydrations).toHaveLength(2);
    expect(world.directReads).toHaveLength(readsBefore);
    expect(world.taken.recorded.traceIds).toEqual([
      traceIdFor(AUTH.projectId, "call_that_will_not_hydrate"),
    ]);
    expect(world.recorded.rows.size).toBe(0);
  });

  it("deletes the retry row only after the evidence is durable in the object store", async () => {
    const world = failingWorld();
    await world.turn(BASE);
    expect(world.recorded.rows.get("call_that_will_not_hydrate")).toMatchObject(
      { attempts: 1 },
    );

    // The retry recovers, but the object store refuses. Egma has the evidence
    // and nowhere durable to put it: the row stays, the count does not move,
    // and the page does not advance past the call.
    const recorded = world.recorded;
    const refusing = new Date(BASE.getTime() + BACKOFF[0]!);
    const finishesBefore = recorded.finishes.length;
    world.succeed();
    const refused = await runRetellProductionIngestion({
      log: logger().log,
      store: store(recorded, TARGET),
      provider: provider({
        async listTerminalCalls() {
          return {
            kind: "calls",
            calls: [summary("call_that_will_not_hydrate")],
            hasMore: false,
            paginationKey: null,
          };
        },
        async getRetellCall(_key, callId) {
          return { kind: "call", call: hydrated(callId) };
        },
      }),
      lookup: lookup({ windows: [], asked: [] }),
      acceptance: {
        async acceptEvidence() {
          throw new IngestionUnavailableError("the bucket did not answer");
        },
      },
      clock: () => refusing,
    });

    expect(refused.stoppedBecause).toBe("ingestion_unavailable");
    expect(recorded.finishes).toHaveLength(finishesBefore);
    expect(recorded.deletes).toEqual([]);
    expect(recorded.rows.get("call_that_will_not_hydrate")).toMatchObject({
      attempts: 1,
    });

    // With the store back, the same retry lands and only then is the row gone.
    const landed = await world.turn(new Date(refusing.getTime() + 1_000));
    expect(landed).toMatchObject({ accepted: 1 });
    expect(recorded.deletes).toEqual(["call_that_will_not_hydrate"]);
    expect(recorded.rows.size).toBe(0);
    expect(world.taken.recorded.traceIds).toEqual([
      traceIdFor(AUTH.projectId, "call_that_will_not_hydrate"),
    ]);
  });

  it("leaves a call waiting on a not-yet-due retry alone and still advances the page", async () => {
    const world = failingWorld();
    await world.turn(BASE);
    const hydrationsBefore = world.hydrations.length;
    const finishesBefore = world.recorded.finishes.length;

    const tooSoon = new Date(BASE.getTime() + 1_000);
    const result = await world.turn(tooSoon);

    expect(world.hydrations).toHaveLength(hydrationsBefore);
    expect(world.directReads).toEqual([]);
    expect(result).toMatchObject({ already: 1, accepted: 0 });
    expect(world.recorded.finishes).toHaveLength(finishesBefore + 1);
    expect(world.recorded.rows.get("call_that_will_not_hydrate")).toMatchObject(
      { attempts: 1 },
    );
  });
});
