import { createServer, type Server } from "node:http";
import { newId } from "@egma/ids";
import { connectClickHouse, disconnectClickHouse, upsertRateCard, type StoredUsageRecord } from "@egma/db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "../../packages/db/test/support/database.ts";
import { seedOrganization } from "../../packages/db/test/support/tenancy.ts";
import { activateBilling, openBillingAccount } from "../src/access/accounts.ts";
import { settleInference } from "../src/access/ledger.ts";
import { seedCloudPlans } from "../src/access/plans.ts";
import { cloudUsageSink } from "../src/adapters.ts";
import { loadCloudBilling } from "../src/load.ts";

let database: MigratedDatabase;
let server: Server;
let organizationId: string;
let projectId: string;
let amount = 0;
let unavailable = false;
let requests: URL[] = [];
let onQuery: (() => Promise<void>) | undefined;
const at = new Date("2026-09-07T12:05:00Z");
const nextInterval = new Date("2026-09-07T12:10:00Z");

beforeAll(async () => {
  database = await createConnectedDatabase("inference_idle");
  server = createServer(async (request, response) => {
    requests.push(new URL(request.url ?? "/", "http://localhost"));
    const snapshot = amount;
    await onQuery?.();
    response.writeHead(unavailable ? 503 : 200, { "Content-Type": "application/json" });
    response.end(unavailable ? "unavailable" : `${JSON.stringify({ amount: String(snapshot), requests: "1", conflicts: 0 })}\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the ClickHouse HTTP boundary did not start");
  connectClickHouse({ clickhouseUrl: `http://127.0.0.1:${address.port}` });
  await seedCloudPlans();
  await upsertRateCard();
  await activateBilling(new Date("2026-09-07T12:00:00Z"));
});

beforeEach(async () => {
  requests = [];
  amount = 0;
  unavailable = false;
  onQuery = undefined;
  organizationId = newId("org");
  projectId = newId("prj");
  await seedOrganization(database, organizationId, [{ id: projectId, slug: projectId.toLowerCase() }]);
  await database.sql("update organization set created_at = $2 where id = $1", [organizationId, new Date("2026-01-01")]);
  await openBillingAccount(organizationId);
});

afterEach(async () => {
  await database?.sql("delete from project where organization_id = $1", [organizationId]);
  await database?.sql("delete from organization where id = $1", [organizationId]);
});

afterAll(async () => {
  await disconnectClickHouse();
  if (server !== undefined) await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
  await database?.drop();
});

function record(paymentSource: "platform" | "customer" = "platform", id = "one"): StoredUsageRecord {
  return {
    id,
    organizationId,
    projectId,
    occurredAt: new Date("2026-09-07T12:03:00Z"),
    provider: "openai",
    model: "gpt-4o-mini",
    paymentSource,
    amountMicros: 210,
  };
}

function signal(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {};
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return { promise, resolve };
}

it("makes no ClickHouse requests during idle settlement or loading cloud billing", async () => {
  await settleInference(at);
  await loadCloudBilling({ now: () => at });
  expect(requests).toHaveLength(0);
});

it("queries platform usage with sequential consistency and skips customer-funded usage", async () => {
  const sink = cloudUsageSink();
  await sink.receive([record("customer")]);
  await settleInference(at);
  expect(requests).toHaveLength(0);
  amount = 210;
  await sink.receive([record()]);
  await settleInference(at);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.searchParams.get("select_sequential_consistency")).toBe("1");
  await settleInference(nextInterval);
  expect(requests).toHaveLength(1);
});

it("keeps a new usage signal pending after a same-interval skip", async () => {
  const sink = cloudUsageSink();
  amount = 210;
  await sink.receive([record()]);
  await settleInference(at);
  expect((await openBillingAccount(organizationId)).settlementFailedAt).toBeNull();
  amount = 420;
  await sink.receive([record("platform", "two")]);
  await settleInference(at);
  expect(requests).toHaveLength(1);
  await settleInference(nextInterval);
  expect(requests).toHaveLength(2);
});

it("keeps a usage signal that arrives during collection pending for the next interval", async () => {
  const sink = cloudUsageSink();
  amount = 210;
  await sink.receive([record()]);
  const arrived = signal();
  const finish = signal();
  onQuery = async () => {
    arrived.resolve();
    await finish.promise;
  };
  const collecting = settleInference(at);
  await arrived.promise;
  amount = 420;
  const marking = sink.receive([record("platform", "two")]);
  finish.resolve();
  await collecting;
  await marking;
  expect((await openBillingAccount(organizationId)).settlementFailedAt).toBeNull();
  onQuery = undefined;
  expect(requests).toHaveLength(1);
  await settleInference(nextInterval);
  expect(requests).toHaveLength(2);
});

it("retries pending settlement after a ClickHouse request fails", async () => {
  await cloudUsageSink().receive([record()]);
  unavailable = true;
  await settleInference(at);
  expect((await openBillingAccount(organizationId)).settlementFailedAt).not.toBeNull();
  unavailable = false;
  amount = 210;
  await settleInference(nextInterval);
  expect(requests).toHaveLength(2);
  expect((await openBillingAccount(organizationId)).settlementFailedAt).toBeNull();
});

it("propagates a failed usage-marker update and permits notification retry", async () => {
  await database.sql("create function refuse_inference_marker() returns trigger language plpgsql as $$ begin raise exception 'marker unavailable'; end $$");
  await database.sql("create trigger refuse_inference_marker before update of inference_usage_version on cloud_billing_account for each row execute function refuse_inference_marker()");
  try {
    await expect(cloudUsageSink().receive([record()])).rejects.toThrow();
  } finally {
    await database.sql("drop trigger refuse_inference_marker on cloud_billing_account");
    await database.sql("drop function refuse_inference_marker()");
  }
  amount = 210;
  await cloudUsageSink().receive([record()]);
  await settleInference(at);
  expect(requests).toHaveLength(1);
  expect((await openBillingAccount(organizationId)).settlementFailedAt).toBeNull();
});
