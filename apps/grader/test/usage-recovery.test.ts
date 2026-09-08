import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newId } from "@egma/ids";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  connectClickHouse,
  disconnectClickHouse,
  readPlatformUsageTotal,
  upsertRateCard,
  type AuthContext,
  type NewUsageRecord,
} from "@egma/db";
import {
  closeAcceptance,
  openAcceptance,
  persistProviderUsage,
  type IngestionSettings,
} from "@egma/ingestion";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "../../../packages/db/test/support/database.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "../../../packages/db/test/support/clickhouse.ts";
import { seedOrganization } from "../../../packages/db/test/support/tenancy.ts";
import { startObjectStorage } from "../../api/test/support/object-storage.ts";
import {
  drainPendingEvidence,
  pendingSegments,
} from "../../api/test/support/ingestion.ts";

const storage = await startObjectStorage("judge-usage-recovery");
let database: MigratedDatabase;
let store: MigratedTraceStore;
const directory = mkdtempSync(path.join(tmpdir(), "egma-judge-usage-"));
const auth: AuthContext = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: "the-grader",
  role: "member",
  via: "engine",
};
const at = new Date("2026-09-08T12:00:00Z");
function paid(attemptId: string): NewUsageRecord {
  return {
    identity: {
      work: "grading",
      gradingJobId: newId("gjb"),
      attempts: 1,
      projectGraderId: newId("grl"),
      httpAttempt: 1,
      attemptId,
    },
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    occurredAt: at,
    provider: "openai",
    model: "gpt-4o-mini",
    operation: "openai_chat_completions",
    quantities: { input_tokens: 1000, output_tokens: 100 },
    rawUsage: { prompt_tokens: 1000, completion_tokens: 100 },
    measurement: "provider_reported",
    paymentSource: "platform",
  };
}
function settings(endpoint?: string): IngestionSettings {
  if (!storage.available) throw new Error(storage.why);
  return {
    role: "ingest",
    store: { ...storage.ingestStore, ...(endpoint ? { endpoint } : {}) },
    logDirectory: directory,
    logMaxBytes: 1_000_000,
    logMaxRecords: 100,
    flushMilliseconds: 1,
    segmentMaxBytes: 100_000,
    segmentMaxRecords: 10,
    requestTimeoutMilliseconds: 100,
    scanIntervalMilliseconds: 1000,
  };
}
const log = { error: () => undefined, warn: () => undefined };
beforeAll(async () => {
  if (!storage.available) throw new Error(storage.why);
  database = await createConnectedDatabase("judge_usage_recovery");
  store = await createMigratedTraceStore("judge_usage_recovery");
  connectClickHouse({ clickhouseUrl: store.url });
  await upsertRateCard();
  await seedOrganization(database, auth.organizationId, [
    { id: auth.projectId!, slug: "judge" },
  ]);
});
afterAll(async () => {
  await closeAcceptance();
  await disconnectClickHouse();
  await store?.drop();
  await database?.drop();
  if (storage.available) await storage.stop();
  rmSync(directory, { recursive: true, force: true });
});

it("replays the grader's own WAL to the shared object store after restart without another provider call", async () => {
  if (!storage.available) throw new Error(storage.why);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await disconnectClickHouse();
  openAcceptance({ settings: settings("http://127.0.0.1:1"), log });
  const usage = paid("paid-http-attempt-before-restart");
  await persistProviderUsage(auth, usage);
  // This stop represents the lost grader process. Do not spend the planned
  // shutdown window retrying an endpoint the test deliberately made dead.
  await closeAcceptance({ timeoutMilliseconds: 0 });
  // The same directory is the restarted grader process's recovery authority.
  openAcceptance({ settings: settings(), log });
  await expect
    .poll(async () => (await pendingSegments(storage.ingestStore)).length, {
      timeout: 5000,
    })
    .toBe(1);
  const [pending] = await pendingSegments(storage.ingestStore);
  expect(pending?.records[0]?.usage).toMatchObject({
    identity: { attemptId: "paid-http-attempt-before-restart" },
    occurredAt: at.toISOString(),
    rawUsage: { prompt_tokens: 1000 },
  });
  const firstReceipt = pending?.records[0]?.usage?.receivedAt;
  await closeAcceptance();
  connectClickHouse({ clickhouseUrl: store.url });
  expect(
    await readPlatformUsageTotal({
      organizationId: auth.organizationId,
      occurredAtOrAfter: at,
    }),
  ).toEqual({ amountMicros: 0n, requests: 0n });
  expect(await drainPendingEvidence(storage.ingestStore)).toBe(1);
  expect(
    await readPlatformUsageTotal({
      organizationId: auth.organizationId,
      occurredAtOrAfter: at,
    }),
  ).toEqual({ amountMicros: 210n, requests: 1n });
  const [row] = await store.rows<{ receipt: string }>(
    "SELECT JSONExtractString(any(usage_evidence), 'receivedAt') AS receipt FROM spans WHERE usage_identity_hash != ''",
  );
  expect(row?.receipt).toBe(firstReceipt);
  expect(await pendingSegments(storage.ingestStore)).toHaveLength(0);
  errors.mockRestore();
});

it("keeps a durable paid attempt when ClickHouse is down and counts its object replay once after recovery", async () => {
  if (!storage.available) throw new Error(storage.why);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  openAcceptance({ settings: settings(), log });
  await disconnectClickHouse();
  await persistProviderUsage(auth, paid("bucket-durable-before-worker-loss"));
  await closeAcceptance();
  const [pending] = await pendingSegments(storage.ingestStore);
  expect(pending?.records[0]?.usage?.identity).toMatchObject({
    attemptId: "bucket-durable-before-worker-loss",
  });
  connectClickHouse({ clickhouseUrl: store.url });
  await drainPendingEvidence(storage.ingestStore);
  expect(
    await readPlatformUsageTotal({
      organizationId: auth.organizationId,
      occurredAtOrAfter: at,
    }),
  ).toEqual({ amountMicros: 420n, requests: 2n });
  errors.mockRestore();
});

it("keeps conversation evidence readable when pricing fails, then recovers the retained usage", async () => {
  if (!storage.available) throw new Error(storage.why);
  const { acceptEvidence } = await import("@egma/ingestion");
  const { providerUsageSpan, priceUsageSpans, readTrace } = await import(
    "@egma/db"
  );
  openAcceptance({ settings: settings(), log });
  const usage = providerUsageSpan(paid("pricing-outage-with-conversation"));
  const { usage: _bill, ...ordinary } = usage;
  const conversation = {
    ...ordinary,
    spanId: "bbbbbbbbbbbbbbbb",
    emitter: "agent" as const,
    kind: "turn:agent",
    name: "agent_turn",
    text: "Your booking is confirmed.",
  };
  await acceptEvidence([usage, conversation], { auth });
  await closeAcceptance();
  expect(
    (await pendingSegments(storage.ingestStore))[0]?.records
      .filter((row) => row.usage)
      .map((row) => row.usage?.price),
  ).toEqual([undefined]);
  await database.sql("ALTER TABLE rate_card RENAME TO rate_card_unavailable");
  await expect(
    database.sql("SELECT id FROM rate_card LIMIT 1"),
  ).rejects.toThrow();
  try {
    await expect(priceUsageSpans(auth, [usage])).rejects.toThrow();
    await drainPendingEvidence(storage.ingestStore);
    expect(
      await readPlatformUsageTotal({
        organizationId: auth.organizationId,
        occurredAtOrAfter: at,
      }),
    ).toEqual({ amountMicros: 420n, requests: 2n });
    expect(await pendingSegments(storage.ingestStore)).toHaveLength(1);
    const trace = await readTrace(auth, usage.traceId, {
      window: {
        from: BigInt(at.getTime() - 1000) * 1000n,
        to: BigInt(at.getTime() + 1000) * 1000n,
      },
    });
    expect(trace?.spanCount).toBe(1);
  } finally {
    await database.sql("ALTER TABLE rate_card_unavailable RENAME TO rate_card");
  }
  expect(await drainPendingEvidence(storage.ingestStore)).toBe(1);
  expect(
    await readPlatformUsageTotal({
      organizationId: auth.organizationId,
      occurredAtOrAfter: at,
    }),
  ).toEqual({ amountMicros: 630n, requests: 3n });
});

it("retains a measured request until every quantity has its effective rate, then replays its complete price", async () => {
  if (!storage.available) throw new Error(storage.why);
  const { acceptEvidence } = await import("@egma/ingestion");
  const { appendSpans, providerUsageSpan, priceUsageSpans, readTrace } =
    await import("@egma/db");
  const measurement = {
    ...paid("one-quantity-rate-missing"),
    quantities: {
      input_tokens: 1000,
      cached_input_tokens: 400,
      output_tokens: 100,
    },
  };
  const usage = providerUsageSpan(measurement);
  const { usage: _bill, ...ordinary } = usage;
  const conversation = {
    ...ordinary,
    spanId: "cccccccccccccccc",
    emitter: "agent" as const,
    kind: "turn:agent",
    name: "agent_turn",
    text: "Your appointment is booked.",
  };
  openAcceptance({ settings: settings(), log });
  await acceptEvidence([usage, conversation], { auth });
  await closeAcceptance();
  await database.sql(
    "UPDATE rate_card SET model = 'temporarily-missing-rate' WHERE provider = 'openai' AND model = 'gpt-4o-mini' AND usage_type = 'output_tokens'",
  );
  try {
    await expect(priceUsageSpans(auth, [usage])).rejects.toThrow(
      "missing effective rate",
    );
    await drainPendingEvidence(storage.ingestStore);
    expect(
      await readPlatformUsageTotal({
        organizationId: auth.organizationId,
        occurredAtOrAfter: at,
      }),
    ).toEqual({ amountMicros: 630n, requests: 3n });
    const pending = await pendingSegments(storage.ingestStore);
    expect(pending).toHaveLength(1);
    expect(
      pending[0]?.records.find((record) => record.usage)?.usage,
    ).toMatchObject({
      receivedAt: usage.usage?.receivedAt,
      quantities: measurement.quantities,
    });
    expect(
      pending[0]?.records.find((record) => record.usage)?.usage?.price,
    ).toBeUndefined();
    const trace = await readTrace(auth, usage.traceId, {
      window: {
        from: BigInt(at.getTime() - 1000) * 1000n,
        to: BigInt(at.getTime() + 1000) * 1000n,
      },
    });
    expect(trace?.spanCount).toBe(2);
  } finally {
    await database.sql(
      "UPDATE rate_card SET model = 'gpt-4o-mini' WHERE provider = 'openai' AND model = 'temporarily-missing-rate'",
    );
  }
  expect(await drainPendingEvidence(storage.ingestStore)).toBe(1);
  expect(await pendingSegments(storage.ingestStore)).toHaveLength(0);
  const replay = await priceUsageSpans(auth, [usage]);
  expect(replay[0]?.usage?.price?.amountMicros).toBe(240);
  expect(Object.keys(replay[0]?.usage?.price?.pricedBy ?? {}).sort()).toEqual([
    "cached_input_tokens",
    "input_tokens",
    "output_tokens",
  ]);
  expect(
    new Set(Object.values(replay[0]?.usage?.price?.pricedBy ?? {})).size,
  ).toBe(3);
  expect(replay[0]?.usage?.receivedAt).toBe(usage.usage?.receivedAt);
  await appendSpans(auth, replay);
  await store.command("OPTIMIZE TABLE spans FINAL");
  expect(
    await readPlatformUsageTotal({
      organizationId: auth.organizationId,
      occurredAtOrAfter: at,
    }),
  ).toEqual({ amountMicros: 870n, requests: 4n });
});
