import type {
  ProductionTraceClaim,
  MonitoringFailureReplayTarget,
  MonitoringPullTarget,
} from "@egma/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  replayRetellIngestionFailure,
  runRetellProductionIngestion,
  startRetellProductionIngestion,
  type RetellIngestionFailureReplayStore,
  type RetellProductionIngestionMetricTurn,
  type RetellProductionIngestionMetrics,
  type RetellProductionIngestionLog,
  type RetellProductionIngestionStore,
  type RetellProductionProvider,
  type RetellProductionWriter,
} from "../src/retell-production-ingestion.ts";
import {
  hydrateRetellCall,
  type RetellCallPageRequest,
} from "../src/retell/api.ts";
import type { RetellCall } from "../src/retell/normalise.ts";

const BASE = new Date("2026-08-19T12:00:00.000Z");
const AUTH = {
  userId: "production-monitoring",
  organizationId: "org_ingestion_test",
  projectId: "prj_ingestion_test",
  role: "member",
  via: "monitoring",
} as const;

const TARGET: MonitoringPullTarget = {
  agentId: "agt_ingestion_test",
  platformAgentId: "agent-secret-id-must-not-be-logged",
  platformAgentName: "Private agent name must not be logged",
  apiKey: "retell-key-must-not-be-logged",
  scanKind: "historical_import",
  scanFrom: new Date("2026-07-20T12:00:00.000Z"),
  scanThrough: BASE,
  paginationKey: null,
  seenPaginationKeys: [],
  consecutiveFailures: 0,
  leaseOwner: "lease-secret-must-not-be-logged",
  leaseExpiresAt: new Date("2026-08-19T12:01:30.000Z"),
  auth: AUTH,
};

const REPLAY_TARGET: MonitoringFailureReplayTarget = {
  agentId: TARGET.agentId,
  failureId: "mnf_explicit_replay_test",
  providerCallId: "call_older_than_import_window",
  platformAgentId: TARGET.platformAgentId,
  platformAgentName: TARGET.platformAgentName,
  apiKey: TARGET.apiKey,
  consecutiveFailures: 0,
  leaseOwner: "replay-lease-secret-must-not-be-logged",
  leaseExpiresAt: new Date("2026-08-19T12:01:30.000Z"),
  auth: AUTH,
};

afterEach(() => {
  vi.useRealTimers();
});

type StoreRecord = {
  claims: number;
  renewals: number;
  accounted: string[];
  checkpoints: { paginationKey: string; seenPaginationKeys: readonly string[] }[];
  yields: Date[];
  finishes: number[];
  failures: { kind: string; retryAt: Date }[];
  releases: string[];
  permanentFailures: string[];
};

function record(): StoreRecord {
  return {
    claims: 0,
    renewals: 0,
    accounted: [],
    checkpoints: [],
    yields: [],
    finishes: [],
    failures: [],
    releases: [],
    permanentFailures: [],
  };
}

type StoreChanges = Partial<RetellProductionIngestionStore>;

function store(
  recorded: StoreRecord,
  target: MonitoringPullTarget | undefined = TARGET,
  changes: StoreChanges = {},
): RetellProductionIngestionStore {
  let offered = false;
  return {
    async sweepStaleProductionClaims() {
      return [];
    },
    async claimDueMonitoringPull() {
      recorded.claims += 1;
      if (offered) return undefined;
      offered = true;
      return target;
    },
    async renewMonitoringLease() {
      recorded.renewals += 1;
      return true;
    },
    async checkpointMonitoringPage(_auth, _target, checkpoint) {
      recorded.checkpoints.push(checkpoint);
      return true;
    },
    async yieldMonitoringLease(_auth, _target, input) {
      recorded.yields.push(input.retryAt);
      return true;
    },
    async finishMonitoringScan(_auth, _target, options) {
      recorded.finishes.push(options?.pollMilliseconds ?? -1);
      return true;
    },
    async failMonitoringPull(_auth, _target, input) {
      recorded.failures.push({ kind: input.kind, retryAt: input.retryAt });
      return { changed: true, failures: 1 };
    },
    async releaseMonitoringLease(_auth, _target, input) {
      recorded.releases.push(input.errorKind);
    },
    async productionCallIsAccountedFor(_auth, providerCallId) {
      recorded.accounted.push(providerCallId);
      return false;
    },
    async recordMonitoringFailure(_auth, _target, input) {
      recorded.permanentFailures.push(input.providerCallId);
      return { changed: true };
    },
    ...changes,
  };
}

type ReplayRecord = {
  claimed: string[];
  released: string[];
  providerFailures: string[];
  resolved: number;
};

function replayRecord(): ReplayRecord {
  return { claimed: [], released: [], providerFailures: [], resolved: 0 };
}

function replayStore(
  recorded: ReplayRecord,
  changes: Partial<RetellIngestionFailureReplayStore> = {},
): RetellIngestionFailureReplayStore {
  return {
    async claimMonitoringFailureReplay(_auth, failureId) {
      recorded.claimed.push(failureId);
      return { kind: "claimed", target: REPLAY_TARGET };
    },
    async releaseMonitoringFailureReplay(_auth, _target, input) {
      recorded.released.push(input.errorKind);
      return true;
    },
    async failMonitoringFailureReplay(_auth, _target, input) {
      recorded.providerFailures.push(input.kind);
      return { recorded: true, changed: true, failures: 1 };
    },
    async resolveMonitoringFailureReplay() {
      recorded.resolved += 1;
      return { resolved: true, agentRecovered: true };
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
    ...changes,
  };
}

function writer(
  written: RetellCall[] = [],
  replayed: ProductionTraceClaim[] = [],
): RetellProductionWriter {
  return {
    async writeRetellCall(_target, call) {
      written.push(call);
      return {
        kind: "written",
        traceId: `trace_${String(call["call_id"])}`,
        degraded: false,
        endedAt: new Date(Number(call["end_timestamp"])),
        endReported: true,
      };
    },
    async replayProductionClaim(claim) {
      replayed.push(claim);
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
  attempts: MonitoringPullTarget["scanKind"][];
  turns: RetellProductionIngestionMetricTurn[];
  lags: number[];
  providerFailures: string[];
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
    },
  };
}

describe("Retell production ingestion", () => {
  it("keeps one fixed window while it pages, hydrates only new calls, and checkpoints durable pages", async () => {
    const recorded = record();
    const requests: RetellCallPageRequest[] = [];
    const hydratedIds: string[] = [];
    const writes: RetellCall[] = [];
    const first = summary("call_already_accounted");
    const second = summary("call_new_first_page");
    const third = summary("call_new_second_page");
    let page = 0;
    const storage = store(recorded, TARGET, {
      async productionCallIsAccountedFor(_auth, callId) {
        recorded.accounted.push(callId);
        return callId === "call_already_accounted";
      },
    });
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
      store: storage,
      provider: retell,
      writer: writer(writes),
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
    expect(writes.map((call) => call["call_id"])).toEqual(hydratedIds);
    expect(recorded.checkpoints).toEqual([
      {
        paginationKey: "opaque-next-page",
        seenPaginationKeys: ["opaque-next-page"],
      },
    ]);
    expect(recorded.finishes).toHaveLength(1);
    expect(recorded.finishes[0]).toBeGreaterThanOrEqual(27_000);
    expect(recorded.finishes[0]).toBeLessThanOrEqual(33_000);
    expect(result).toMatchObject({ written: 2, already: 1, pages: 2 });
    expect(observed.recorded).toMatchObject({
      attempts: ["historical_import"],
      turns: [
        {
          scanKind: "historical_import",
          outcome: "completed",
          written: 2,
          already: 1,
          permanentFailures: 0,
        },
      ],
      lags: [1_000, 1_000],
      providerFailures: [],
    });
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
      writer: writer(),
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
      writer: writer(),
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
      async renewMonitoringLease() {
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
      writer: writer(),
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
      async renewMonitoringLease() {
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
      writer: writer(),
      clock: () => BASE,
    });

    expect(providerRequests).toBe(1);
    expect(recorded.checkpoints).toHaveLength(1);
    expect(result.stoppedBecause).toBe("lease_lost");
  });

  it("checks its own lease before hydrating a listed call", async () => {
    const recorded = record();
    let renewals = 0;
    let listRequests = 0;
    let hydrationRequests = 0;
    const storage = store(recorded, TARGET, {
      async renewMonitoringLease() {
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
      writer: writer(),
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
        return {
          targetClaimed: false,
          pages: 0,
          written: 0,
          already: 0,
          permanentFailures: 0,
          replayed: 0,
          replayFailed: 0,
        };
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
          targetClaimed,
          pages: targetClaimed ? 1 : 0,
          written: 0,
          already: 0,
          permanentFailures: 0,
          replayed: 0,
          replayFailed: 0,
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
        return {
          targetClaimed: false,
          pages: 0,
          written: 0,
          already: 0,
          permanentFailures: 0,
          replayed: 0,
          replayFailed: 0,
        };
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
    const failingWriter: RetellProductionWriter = {
      async writeRetellCall() {
        throw new Error("a private store failure");
      },
      async replayProductionClaim() {
        return undefined;
      },
    };

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
        writer: failingWriter,
        clock: () => BASE,
      }),
    ).rejects.toThrow("a private store failure");

    expect(recorded.releases).toEqual(["internal_failure"]);
  });

  it("keeps an empty successful poll quiet", async () => {
    const recorded = record();
    const { log, events } = logger();
    const observed = metricRecorder();

    const result = await runRetellProductionIngestion({
      log,
      metrics: observed.metrics,
      store: store(recorded),
      provider: provider(),
      writer: writer(),
      clock: () => BASE,
    });

    expect(result).toMatchObject({ written: 0, permanentFailures: 0 });
    expect(events).toEqual({ info: [], warn: [], error: [] });
    expect(observed.recorded).toMatchObject({
      attempts: ["historical_import"],
      turns: [
        {
          outcome: "completed",
          written: 0,
          already: 0,
          permanentFailures: 0,
        },
      ],
    });
  });

  it("waits exactly as long as the provider asked, and says nothing", async () => {
    const recorded = record();
    const storage = store(recorded, TARGET, {
      async failMonitoringPull(_auth, _target, input) {
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
      writer: writer(),
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

  it("caps this agent's backoff and logs the failure once", async () => {
    const recorded = record();
    const { log, events } = logger();
    const failedManyTimes: MonitoringPullTarget = {
      ...TARGET,
      consecutiveFailures: 20,
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
      writer: writer(),
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

  it("logs nothing at all when a provider turn simply works", async () => {
    // There is no account-wide health to recover: the counter is a retry clock
    // on this agent's own notebook, cleared by the scan that finished. So a
    // good turn is silent (ADR-0015).
    const recorded = record();
    const { log, events } = logger();

    await runRetellProductionIngestion({
      log,
      store: store(recorded, TARGET),
      provider: provider(),
      writer: writer(),
      clock: () => BASE,
    });

    expect(events.warn).toEqual([]);
    expect(events.error).toEqual([]);
    expect(
      events.info.filter((one) =>
        String(one["otel.event.name"]).includes("health"),
      ),
    ).toEqual([]);
  });

  it("makes a refused key wait, bounded, without a health state to park it in", async () => {
    // ADR-0015 drops `blocked_until` with the rest of the health machine. A
    // refused key waits on this agent's own ladder — longer than a transient
    // refusal, never for ever — so a key the customer fixes at Retell is tried
    // again without anybody re-arming the switch here.
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
      writer: writer(),
      clock: () => BASE,
    });

    expect(recorded.failures).toHaveLength(1);
    expect(recorded.failures[0]?.kind).toBe("invalid_credential");
    const wait =
      (recorded.failures[0]?.retryAt.getTime() ?? BASE.getTime()) -
      BASE.getTime();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60 * 60_000);
    expect(events.error).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(TARGET.apiKey);
    expect(JSON.stringify(events)).not.toContain(TARGET.platformAgentId);
    expect(JSON.stringify(events)).not.toContain(TARGET.platformAgentName);
  });

  it("records a missing hydrated call, continues the page, and logs it once", async () => {
    const recorded = record();
    const writes: RetellCall[] = [];
    let missingHydrationAttempts = 0;
    const { log, events } = logger();

    const result = await runRetellProductionIngestion({
      log,
      store: store(recorded),
      provider: provider({
        async listTerminalCalls() {
          return {
            kind: "calls",
            calls: [summary("private-missing-call-id"), summary("private-good-call-id")],
            hasMore: false,
            paginationKey: null,
          };
        },
        async hydrateRetellCall(_key, listed) {
          if (listed["call_id"] === "private-missing-call-id") {
            missingHydrationAttempts += 1;
            return { kind: "not-found" };
          }
          return { kind: "call", call: hydrated("private-good-call-id") };
        },
      }),
      writer: writer(writes),
      clock: () => BASE,
    });

    expect(recorded.permanentFailures).toEqual(["private-missing-call-id"]);
    expect(missingHydrationAttempts).toBe(3);
    expect(writes.map((call) => call["call_id"])).toEqual([
      "private-good-call-id",
    ]);
    expect(result).toMatchObject({ written: 1, permanentFailures: 1 });
    expect(events.warn).toHaveLength(1);
    expect(events.info).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("private-missing-call-id");
    expect(JSON.stringify(events)).not.toContain("private-good-call-id");
  });

  it("stops a stale target when its permanent failure is not recorded", async () => {
    const recorded = record();
    const { log } = logger();
    let providerRequests = 0;

    const result = await runRetellProductionIngestion({
      log,
      store: store(recorded, TARGET, {
        async recordMonitoringFailure() {
          return { recorded: false, changed: false };
        },
      }),
      provider: provider({
        async listTerminalCalls() {
          providerRequests += 1;
          return {
            kind: "calls",
            calls: [summary("private-stale-call-id")],
            hasMore: false,
            paginationKey: null,
          };
        },
        async hydrateRetellCall() {
          return { kind: "not-found" };
        },
      }),
      writer: writer(),
      clock: () => BASE,
    });

    expect(providerRequests).toBe(1);
    expect(result).toMatchObject({
      stoppedBecause: "lease_lost",
      permanentFailures: 0,
    });
  });

  it("records a malformed full call after bounded retries and continues the page", async () => {
    const recorded = record();
    const writes: RetellCall[] = [];
    let malformedHydrationAttempts = 0;
    const { log } = logger();

    const result = await runRetellProductionIngestion({
      log,
      store: store(recorded),
      provider: provider({
        async listTerminalCalls() {
          return {
            kind: "calls",
            calls: [
              summary("private-malformed-call-id"),
              summary("private-good-call-id"),
            ],
            hasMore: false,
            paginationKey: null,
          };
        },
        hydrateRetellCall,
      }),
      writer: writer(writes),
      reach: {
        url: "https://retell.invalid",
        fetchImpl: (async (input: string | URL | Request) => {
          const callId = decodeURIComponent(String(input).split("/").at(-1) ?? "");
          if (callId === "private-malformed-call-id") {
            malformedHydrationAttempts += 1;
            return new Response(
              JSON.stringify({
                ...hydrated(callId),
                transcript_with_tool_calls: "Agent: Hello.",
              }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify(hydrated(callId)), { status: 200 });
        }) as typeof fetch,
      },
      clock: () => BASE,
    });

    expect(malformedHydrationAttempts).toBe(3);
    expect(recorded.permanentFailures).toEqual([
      "private-malformed-call-id",
    ]);
    expect(writes.map((call) => call["call_id"])).toEqual([
      "private-good-call-id",
    ]);
    expect(result).toMatchObject({ written: 1, permanentFailures: 1 });
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
      writer: writer(),
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
        writer: writer(),
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

  it("replays stale cross-store claims before it asks for another target", async () => {
    const recorded = record();
    const stale: ProductionTraceClaim = {
      id: "ptc_stale",
      traceId: "0123456789abcdef0123456789abcdef",
      providerCallId: "private-stale-call",
      platformAgentId: "private-stale-agent",
      platformAgentName: "Private stale agent",
      platformAgentVersion: "3",
      payload: JSON.stringify(hydrated("private-stale-call")),
      endedAt: BASE,
      degraded: false,
      auth: AUTH,
    };
    const replayed: ProductionTraceClaim[] = [];
    const { log, events } = logger();
    const storage = store(recorded, undefined, {
      async sweepStaleProductionClaims() {
        return [stale];
      },
    });

    const result = await runRetellProductionIngestion({
      log,
      store: storage,
      provider: provider(),
      writer: writer([], replayed),
      clock: () => BASE,
    });

    expect(replayed).toEqual([stale]);
    expect(result.replayed).toBe(1);
    expect(events.info).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(stale.providerCallId);
  });

  it("replays one exact failed call without using the 30-day list window", async () => {
    const recorded = replayRecord();
    const requested: string[] = [];
    const { log, events } = logger();

    const result = await replayRetellIngestionFailure({
      auth: AUTH,
      failureId: REPLAY_TARGET.failureId,
      log,
      store: replayStore(recorded),
      provider: {
        async getRetellCall(_key, callId) {
          requested.push(callId);
          return { kind: "call", call: hydrated(callId) };
        },
      },
      writer: {
        async writeRetellCall(_target, call) {
          return {
            kind: "already",
            traceId: `trace_${String(call["call_id"])}`,
            endedAt: BASE,
            endReported: true,
          };
        },
      },
      clock: () => BASE,
    });

    expect(requested).toEqual([REPLAY_TARGET.providerCallId]);
    expect(result).toMatchObject({
      kind: "resolved",
      failureId: REPLAY_TARGET.failureId,
      write: "already",
      agentRecovered: true,
    });
    expect(recorded.resolved).toBe(1);
    expect(events.info).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(REPLAY_TARGET.providerCallId);
    expect(JSON.stringify(events)).not.toContain(REPLAY_TARGET.failureId);
  });

  it("keeps an exact failed call open when Retell still cannot return it", async () => {
    const recorded = replayRecord();
    const { log, events } = logger();

    const result = await replayRetellIngestionFailure({
      auth: AUTH,
      failureId: REPLAY_TARGET.failureId,
      log,
      store: replayStore(recorded),
      provider: {
        async getRetellCall() {
          return { kind: "not-found" };
        },
      },
      writer: { writeRetellCall: writer().writeRetellCall },
      clock: () => BASE,
    });

    expect(result).toMatchObject({
      kind: "still_failed",
      errorKind: "provider_call_not_found",
    });
    expect(recorded.released).toEqual(["provider_call_not_found"]);
    expect(recorded.resolved).toBe(0);
    expect(events).toEqual({ info: [], warn: [], error: [] });
  });

  it("classifies provider failures during an exact replay", async () => {
    const cases = [
      {
        answer: { kind: "invalid-key" } as const,
        expected: "invalid_credential",
      },
      {
        answer: {
          kind: "refused",
          reason: "rate-limited",
          status: 429,
          retryAfterMilliseconds: 12_000,
        } as const,
        expected: "rate_limited",
      },
      {
        answer: { kind: "unreachable", reason: "private network fact" } as const,
        expected: "provider_unavailable",
      },
    ] as const;

    for (const one of cases) {
      const recorded = replayRecord();
      const { log, events } = logger();
      const result = await replayRetellIngestionFailure({
        auth: AUTH,
        failureId: REPLAY_TARGET.failureId,
        log,
        store: replayStore(recorded),
        provider: { async getRetellCall() { return one.answer; } },
        writer: { writeRetellCall: writer().writeRetellCall },
        clock: () => BASE,
      });

      expect(result.kind).toBe(one.expected);
      expect(recorded.providerFailures).toEqual([one.expected]);
      expect(events.warn.length + events.error.length).toBe(1);
      expect(JSON.stringify(events)).not.toContain("private network fact");
      expect(JSON.stringify(events)).not.toContain(REPLAY_TARGET.providerCallId);
    }
  });

  it("does not file a hydrated call under a different selected Retell agent", async () => {
    const recorded = record();
    const writes: RetellCall[] = [];
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
      writer: writer(writes),
      clock: () => BASE,
    });

    expect(result).toMatchObject({ written: 0, permanentFailures: 1 });
    expect(recorded.permanentFailures).toEqual(["call_wrong_agent"]);
    expect(writes).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain("different-private-agent-id");
  });

  it("yields inside a large page without checkpointing past unprocessed calls", async () => {
    const recorded = record();
    const hydratedIds: string[] = [];
    const writes: RetellCall[] = [];
    let advanced = 0;
    const clock = () => new Date(BASE.getTime() + advanced);
    const { log } = logger();
    const writing = writer(writes);

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
      writer: {
        ...writing,
        async writeRetellCall(target, call, receivedAt) {
          const outcome = await writing.writeRetellCall(target, call, receivedAt);
          advanced = 60;
          return outcome;
        },
      },
      clock,
      maxTurnMilliseconds: 50,
    });

    expect(hydratedIds).toEqual(["call_first"]);
    expect(writes.map((call) => call["call_id"])).toEqual(["call_first"]);
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
          targetClaimed,
          pages: targetClaimed ? 1 : 0,
          written: 0,
          already: 0,
          permanentFailures: 0,
          replayed: 0,
          replayFailed: 0,
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

  it("logs one stale-claim replay failure transition and one recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    let attempt = 0;
    const { log, events } = logger();
    const ingestion = startRetellProductionIngestion({
      log,
      intervalMilliseconds: 5,
      ingest: async () => {
        attempt += 1;
        return {
          targetClaimed: false,
          pages: 0,
          written: 0,
          already: 0,
          permanentFailures: 0,
          replayed: attempt === 4 ? 1 : 0,
          replayFailed: attempt === 1 || attempt === 3 ? 1 : 0,
        };
      },
    });

    await vi.advanceTimersByTimeAsync(25);
    await ingestion.stop();

    expect(
      events.warn.filter(
        (event) =>
          event["otel.event.name"] ===
          "egma.monitoring.retell.claims.replay.failed",
      ),
    ).toHaveLength(1);
    expect(
      events.info.filter(
        (event) =>
          event["otel.event.name"] ===
          "egma.monitoring.retell.claims.replay.recovered",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("providerCallId");
  });
});
