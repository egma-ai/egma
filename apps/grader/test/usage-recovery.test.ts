import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newId } from "@egma/ids";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { connectClickHouse, disconnectClickHouse, readPlatformUsageTotal, upsertRateCard, type AuthContext, type NewUsageRecord } from "@egma/db";
import { closeAcceptance, openAcceptance, persistProviderUsage, type IngestionSettings } from "@egma/ingestion";
import { createConnectedDatabase, type MigratedDatabase } from "../../../packages/db/test/support/database.ts";
import { createMigratedTraceStore, type MigratedTraceStore } from "../../../packages/db/test/support/clickhouse.ts";
import { seedOrganization } from "../../../packages/db/test/support/tenancy.ts";
import { startObjectStorage } from "../../api/test/support/object-storage.ts";
import { drainPendingEvidence, pendingSegments } from "../../api/test/support/ingestion.ts";

const storage = await startObjectStorage("judge-usage-recovery");
let database: MigratedDatabase;
let store: MigratedTraceStore;
const directory = mkdtempSync(path.join(tmpdir(), "egma-judge-usage-"));
const auth: AuthContext = { organizationId: newId("org"), projectId: newId("prj"), userId: "the-grader", role: "member", via: "engine" };
const at = new Date("2026-09-08T12:00:00Z");
function paid(attemptId: string): NewUsageRecord {
  return { identity: { work: "grading", gradingJobId: newId("gjb"), attempts: 1, projectGraderId: newId("grl"), httpAttempt: 1, attemptId }, traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", occurredAt: at, provider: "openai", model: "gpt-4o-mini", operation: "openai_chat_completions", quantities: { input_tokens: 1000, output_tokens: 100 }, rawUsage: { prompt_tokens: 1000, completion_tokens: 100 }, measurement: "provider_reported", paymentSource: "platform" };
}
function settings(endpoint?: string): IngestionSettings {
  if (!storage.available) throw new Error(storage.why);
  return { role: "ingest", store: { ...storage.ingestStore, ...(endpoint ? { endpoint } : {}) }, logDirectory: directory, logMaxBytes: 1_000_000, logMaxRecords: 100, flushMilliseconds: 1, segmentMaxBytes: 100_000, segmentMaxRecords: 10, requestTimeoutMilliseconds: 100, scanIntervalMilliseconds: 1000 };
}
const log = { error: () => undefined, warn: () => undefined };
beforeAll(async () => {
  if (!storage.available) throw new Error(storage.why);
  database = await createConnectedDatabase("judge_usage_recovery");
  store = await createMigratedTraceStore("judge_usage_recovery");
  connectClickHouse({ clickhouseUrl: store.url });
  await upsertRateCard();
  await seedOrganization(database, auth.organizationId, [{ id: auth.projectId!, slug: "judge" }]);
});
afterAll(async () => { await closeAcceptance(); await disconnectClickHouse(); await store?.drop(); await database?.drop(); if (storage.available) await storage.stop(); rmSync(directory, { recursive: true, force: true }); });

it("replays the grader's own WAL to the shared object store after restart without another provider call", async () => {
  if (!storage.available) throw new Error(storage.why);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await disconnectClickHouse();
  openAcceptance({ settings: settings("http://127.0.0.1:1"), log });
  const usage = paid("paid-http-attempt-before-restart");
  await persistProviderUsage(auth, usage);
  await closeAcceptance();
  // The same directory is the restarted grader process's recovery authority.
  openAcceptance({ settings: settings(), log });
  await expect.poll(async () => (await pendingSegments(storage.ingestStore)).length, { timeout: 5000 }).toBe(1);
  const [pending] = await pendingSegments(storage.ingestStore);
  expect(pending?.records[0]?.usage).toMatchObject({ identity: { attemptId: "paid-http-attempt-before-restart" }, occurredAt: at.toISOString(), rawUsage: { prompt_tokens: 1000 } });
  const firstReceipt = pending?.records[0]?.usage?.receivedAt;
  await closeAcceptance();
  connectClickHouse({ clickhouseUrl: store.url });
  expect(await readPlatformUsageTotal({ organizationId: auth.organizationId, occurredAtOrAfter: at })).toEqual({ amountMicros: 0n, requests: 0n });
  expect(await drainPendingEvidence(storage.ingestStore)).toBe(1);
  expect(await readPlatformUsageTotal({ organizationId: auth.organizationId, occurredAtOrAfter: at })).toEqual({ amountMicros: 210n, requests: 1n });
  const [row] = await store.rows<{ receipt: string }>("SELECT JSONExtractString(any(usage_evidence), 'receivedAt') AS receipt FROM spans WHERE usage_identity_hash != ''");
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
  expect(pending?.records[0]?.usage?.identity).toMatchObject({ attemptId: "bucket-durable-before-worker-loss" });
  connectClickHouse({ clickhouseUrl: store.url });
  await drainPendingEvidence(storage.ingestStore);
  expect(await readPlatformUsageTotal({ organizationId: auth.organizationId, occurredAtOrAfter: at })).toEqual({ amountMicros: 420n, requests: 2n });
  errors.mockRestore();
});
