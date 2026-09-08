import type { GradingClaim } from "@egma/db";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  claim: vi.fn(),
  finish: vi.fn(),
  grade: vi.fn(),
  release: vi.fn(),
  heartbeat: vi.fn(),
  close: vi.fn(),
  onWork: undefined as (() => void) | undefined,
}));

vi.mock("@egma/db", () => ({
  claimGradingJobs: runtime.claim,
  finishGradingJob: runtime.finish,
  MAX_GRADING_CLAIM_CAPACITY: 50,
  recordGradingHeartbeat: runtime.heartbeat,
  releaseGradingJob: runtime.release,
  watchGradingWork: vi.fn(async (onWork: () => void) => {
    runtime.onWork = onWork;
    return { close: runtime.close };
  }),
}));

vi.mock("../src/grade.ts", () => ({
  gradeClaim: runtime.grade,
  NotGradable: class NotGradable extends Error {},
}));

import type { Config } from "../src/config.ts";
import { startService } from "../src/service.ts";

function config(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: "postgres://unused",
    ingestion: {
      role: "ingest",
      store: undefined,
      logDirectory: "/tmp/unused",
      logMaxBytes: 1,
      logMaxRecords: 1,
      flushMilliseconds: 1,
      segmentMaxBytes: 1,
      segmentMaxRecords: 1,
      requestTimeoutMilliseconds: 1,
      scanIntervalMilliseconds: 1,
    },
    clickhouseUrl: "http://unused",
    claimant: "refill-test",
    capacity: 100,
    concurrencyCap: 100,
    heartbeatSeconds: 15,
    leaseSeconds: 120,
    sweepSeconds: 30,
    stripeSecretKey: undefined,
    logLevel: "INFO",
    ...overrides,
  };
}

function claim(id: number): GradingClaim {
  return {
    id: `job-${id}`,
    organizationId: "org-test",
    projectId: "project-test",
    source: "simulation",
    simulationId: `simulation-${id}`,
    traceId: `trace-${id}`,
    attempts: 1,
    auth: {},
  } as unknown as GradingClaim;
}

function logger() {
  return {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  return { promise, resolve: () => settle?.() };
}

afterEach(() => {
  vi.clearAllMocks();
  runtime.onWork = undefined;
});

describe("grader capacity refilling", () => {
  it("replaces ten completed jobs while the other ninety remain active", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    let next = 0;
    let active = 0;
    let mostActive = 0;

    runtime.claim.mockImplementation(
      async ({ capacity }: { capacity: number }) => {
        if (next >= 110) return [];
        const count = Math.min(capacity, 110 - next);
        return Array.from({ length: count }, () => claim(++next));
      },
    );
    runtime.grade.mockImplementation(async (held: GradingClaim) => {
      active += 1;
      mostActive = Math.max(mostActive, active);
      const gate = deferred();
      gates.set(held.id, gate);
      await gate.promise;
      active -= 1;
      return { graders: 1, grades: 1 };
    });
    runtime.finish.mockImplementation(async (_auth, id: string) => ({ id }));

    const service = startService({
      config: config(),
      log: logger(),
      providerCredentials: { load: vi.fn() },
    });

    await vi.waitFor(() => expect(active).toBe(100));
    expect(
      runtime.claim.mock.calls.slice(0, 2).map(([request]) => request),
    ).toMatchObject([
        { capacity: 50, concurrencyCap: 100 },
        { capacity: 50, concurrencyCap: 100 },
      ]);

    for (let id = 1; id <= 10; id += 1) gates.get(`job-${id}`)?.resolve();

    await vi.waitFor(() => expect(runtime.claim).toHaveBeenCalledTimes(3));
    expect(active).toBe(100);
    expect(runtime.claim.mock.calls[2]?.[0]).toMatchObject({
      capacity: 10,
      concurrencyCap: 100,
    });
    expect(mostActive).toBe(100);

    service.stop();
    let stopped = false;
    void service.finished.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    for (const gate of gates.values()) gate.resolve();
    await service.finished;
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("waits when the queue is empty or the global cap is full", async () => {
    runtime.claim.mockImplementation(async () => {
      if (runtime.claim.mock.calls.length === 1) runtime.onWork?.();
      return [];
    });
    const service = startService({
      config: config(),
      log: logger(),
      providerCredentials: { load: vi.fn() },
    });

    // A notification during a globally capped claim earns one fresh query.
    await vi.waitFor(() => expect(runtime.claim).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.claim).toHaveBeenCalledTimes(2);

    runtime.onWork?.();
    await vi.waitFor(() => expect(runtime.claim).toHaveBeenCalledTimes(3));
    expect(runtime.claim.mock.calls[2]?.[0]).toMatchObject({
      concurrencyCap: 100,
    });
    await Promise.resolve();
    expect(runtime.claim).toHaveBeenCalledTimes(3);

    service.stop();
    await service.finished;
  });

  it("keeps serving after an unexpected detached process failure", async () => {
    runtime.claim
      .mockResolvedValueOnce([claim(1)])
      .mockResolvedValue([]);
    const log = logger();
    log.info.mockImplementation((_fields, message) => {
      if (message === "grading job claimed") {
        throw new Error("logger failed while starting the job");
      }
    });
    const service = startService({
      config: config({ capacity: 1 }),
      log,
      providerCredentials: { load: vi.fn() },
    });

    await vi.waitFor(() => expect(runtime.claim).toHaveBeenCalledTimes(2));
    service.stop();
    await expect(service.finished).resolves.toBeUndefined();
  });
});
