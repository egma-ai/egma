import { newId } from "@egma/ids";
import {
  appendSpans,
  connectClickHouse,
  disconnectClickHouse,
  priceUsageSpans,
  providerUsageSpan,
  upsertRateCard,
  type AuthContext,
  type NewUsageRecord,
} from "@egma/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "../../packages/db/test/support/database.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "../../packages/db/test/support/clickhouse.ts";
import { seedOrganization } from "../../packages/db/test/support/tenancy.ts";
import { activateBilling, openBillingAccount } from "../src/access/accounts.ts";
import { readBillingLedger, settleInference } from "../src/access/ledger.ts";
import { seedCloudPlans } from "../src/access/plans.ts";

let database: MigratedDatabase;
let store: MigratedTraceStore;
let auth: AuthContext;

beforeAll(async () => {
  database = await createConnectedDatabase("inference_reconciliation");
  store = await createMigratedTraceStore("inference_reconciliation");
  connectClickHouse({ clickhouseUrl: store.url });
  await seedCloudPlans();
  await upsertRateCard();
  const organizationId = newId("org"), projectId = newId("prj");
  await seedOrganization(database, organizationId, [{ id: projectId, slug: projectId.toLowerCase() }]);
  await database.sql("update organization set created_at = $2 where id = $1", [organizationId, new Date("2026-01-01")]);
  await activateBilling(new Date("2026-09-07T12:00:00Z"));
  auth = { organizationId, projectId, userId: "billing-reconciliation", via: "engine", role: "member" };
});

afterAll(async () => {
  await disconnectClickHouse();
  await store?.drop();
  await database?.drop();
});

it("recovers stored spend with no activity delivery on reconciliation and charges it once", async () => {
  const record: NewUsageRecord = {
    identity: { work: "simulation", simulationId: newId("sim"), spanId: "aaaaaaaaaaaaaaaa" },
    traceId: "11111111111111111111111111111111",
    occurredAt: new Date("2026-09-07T12:03:00Z"),
    provider: "openai",
    model: "gpt-4o-mini",
    operation: "openai_chat_completions",
    quantities: { input_tokens: 1000, output_tokens: 100 },
    measurement: "provider_reported",
    paymentSource: "platform",
    rawUsage: { prompt_tokens: 1000, completion_tokens: 100 },
  };
  // The open sink saves no billing marker, as when a cloud delivery is lost.
  const spans = await priceUsageSpans(auth, [providerUsageSpan(record)]);
  await appendSpans(auth, spans);
  expect(await settleInference(new Date("2026-09-07T12:05:00Z"))).toEqual({ charged: 0, amountMicros: 0 });
  expect(await settleInference(new Date("2026-09-07T13:00:00Z"), { reconcile: true })).toEqual({ charged: 1, amountMicros: 210 });
  await appendSpans(auth, spans);
  expect(await settleInference(new Date("2026-09-07T13:00:00Z"), { reconcile: true })).toEqual({ charged: 0, amountMicros: 0 });
  expect(await settleInference(new Date("2026-09-07T14:00:00Z"), { reconcile: true })).toEqual({ charged: 0, amountMicros: 0 });
  expect((await openBillingAccount(auth.organizationId)).balanceMicros).toBe(4_999_790);
  expect((await readBillingLedger(auth)).entries.filter((entry) => entry.kind === "inference_charge")).toHaveLength(1);
});
