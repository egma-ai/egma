import { newId } from "@egma/ids";
import { afterAll, beforeAll, expect, it } from "vitest";
import { appendSpans, connectClickHouse, disconnectClickHouse, priceUsageSpans, providerUsageSpan, readPlatformUsageTotal, readOrganizationUsage, upsertRateCard, type AuthContext, type NewUsageRecord } from "../src/index.ts";
import { createConnectedDatabase, type MigratedDatabase } from "./support/database.ts";
import { createMigratedTraceStore, type MigratedTraceStore } from "./support/clickhouse.ts";

let database: MigratedDatabase;
let store: MigratedTraceStore;
const auth: AuthContext = { organizationId: newId("org"), projectId: newId("prj"), userId: "the-grader", via: "engine", role: "admin" };
const when = new Date("2026-09-08T12:00:00.000Z");
const floor = new Date("2026-09-08T00:00:00.000Z");
function record(spanId: string, changes: Partial<NewUsageRecord> = {}): NewUsageRecord {
  return { identity: { work: "simulation", simulationId: newId("sim"), spanId }, occurredAt: when, traceId: "11111111111111111111111111111111", provider: "openai", model: "gpt-4o-mini", operation: "openai_chat_completions", quantities: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 }, measurement: "provider_reported", paymentSource: "platform", rawUsage: { prompt_tokens: 1400, completion_tokens: 100 }, ...changes };
}
beforeAll(async () => {
  database = await createConnectedDatabase("provider_usage_spans");
  store = await createMigratedTraceStore("provider_usage_spans");
  connectClickHouse({ clickhouseUrl: store.url });
  await upsertRateCard();
});
afterAll(async () => { await disconnectClickHouse(); await store?.drop(); await database?.drop(); });

it("prices all three quantities once and preserves their separate rates through replay", async () => {
  const span = providerUsageSpan(record("0000000000000001"));
  const priced = await priceUsageSpans(auth, [span]);
  expect(priced[0]?.usage?.price?.amountMicros).toBe(240);
  expect(Object.keys(priced[0]?.usage?.price?.pricedBy ?? {})).toEqual(["input_tokens", "cached_input_tokens", "output_tokens"]);
  expect(new Set(Object.values(priced[0]?.usage?.price?.pricedBy ?? {})).size).toBe(3);
  await appendSpans(auth, priced);
  await store.command("ALTER TABLE spans MODIFY SETTING non_replicated_deduplication_window = 0");
  await appendSpans(auth, priced);
  await store.command("OPTIMIZE TABLE spans FINAL");
  expect(await readPlatformUsageTotal({ organizationId: auth.organizationId, occurredAtOrAfter: floor })).toEqual({ amountMicros: 240n, requests: 1n });
  expect(await readOrganizationUsage(auth, { from: floor, to: new Date("2026-09-09T00:00:00Z") })).toMatchObject({ amountMicros: 240, requests: 1, byModel: [{ quantities: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 } }] });
});

it("uses the complete tenant/project/trace/span identity and counts customer-funded usage only in the read surface", async () => {
  const organizationId = newId("org");
  const one = { ...auth, organizationId };
  const two = { ...one, projectId: newId("prj") };
  const other = { ...one, organizationId: newId("org") };
  const source = providerUsageSpan(record("0000000000000002"));
  for (const context of [one, two, other]) await appendSpans(context, await priceUsageSpans(context, [source]));
  await appendSpans(one, await priceUsageSpans(one, [providerUsageSpan(record("0000000000000003", { paymentSource: "customer" }))]));
  expect(await readPlatformUsageTotal({ organizationId, occurredAtOrAfter: floor })).toEqual({ amountMicros: 480n, requests: 2n });
  expect(await readPlatformUsageTotal({ organizationId: other.organizationId, occurredAtOrAfter: floor })).toEqual({ amountMicros: 240n, requests: 1n });
  expect(await readOrganizationUsage(one, { from: floor, to: new Date("2026-09-09") })).toMatchObject({ amountMicros: 720, requests: 3 });
});

it("includes delayed visible usage in the next snapshot and excludes old usage even when it arrives late", async () => {
  const context = { ...auth, organizationId: newId("org") };
  const pending = await priceUsageSpans(context, [providerUsageSpan(record("0000000000000004"))]);
  expect(await readPlatformUsageTotal({ organizationId: context.organizationId, occurredAtOrAfter: floor })).toEqual({ amountMicros: 0n, requests: 0n });
  await appendSpans(context, pending);
  await appendSpans(context, await priceUsageSpans(context, [providerUsageSpan(record("0000000000000005", { occurredAt: new Date("2026-09-07") }))]));
  expect(await readPlatformUsageTotal({ organizationId: context.organizationId, occurredAtOrAfter: floor })).toEqual({ amountMicros: 240n, requests: 1n });
  await appendSpans(context, pending);
  expect(await readPlatformUsageTotal({ organizationId: context.organizationId, occurredAtOrAfter: floor })).toEqual({ amountMicros: 240n, requests: 1n });
});

it("keeps first receipt and one price when identical acceptance races and later replay crosses an interval", async () => {
  const context = { ...auth, organizationId: newId("org") };
  const measurement = record("0000000000000006");
  const first = providerUsageSpan(measurement, new Date("2026-09-08T12:01:00Z"));
  const second = providerUsageSpan(measurement, new Date("2026-09-08T12:01:01Z"));
  const [left, right] = await Promise.all([priceUsageSpans(context, [first]), priceUsageSpans(context, [second])]);
  await Promise.all([appendSpans(context, left), appendSpans(context, right)]);
  await store.command("OPTIMIZE TABLE spans FINAL");
  const replay = await priceUsageSpans(context, [providerUsageSpan(measurement, new Date("2026-09-28"))]);
  expect(replay[0]?.usage?.receivedAt).toBe("2026-09-08T12:01:00.000Z");
  await appendSpans(context, replay);
  expect(await readPlatformUsageTotal({ organizationId: context.organizationId, occurredAtOrAfter: floor })).toEqual({ amountMicros: 240n, requests: 1n });
});

it("cannot replace a priced usage span with non-usage evidence even after storage merges", async () => {
  const context = { ...auth, organizationId: newId("org") };
  const [priced] = await priceUsageSpans(context, [providerUsageSpan(record("0000000000000007"))]);
  if (!priced) throw new Error("missing test span");
  await appendSpans(context, [priced]);
  const { usage: _usage, ...span } = priced;
  await appendSpans(context, [{ ...span, kind: "conversation", name: "conversation" }]);
  await store.command("OPTIMIZE TABLE spans FINAL");
  expect(await readPlatformUsageTotal({ organizationId: context.organizationId, occurredAtOrAfter: floor })).toEqual({ amountMicros: 240n, requests: 1n });
});

it("retains conflicting price evidence across merges and refuses to choose a charge", async () => {
  const context = { ...auth, organizationId: newId("org") };
  const [priced] = await priceUsageSpans(context, [providerUsageSpan(record("0000000000000008"))]);
  if (!priced?.usage?.price) throw new Error("missing test price");
  await appendSpans(context, [priced]);
  const conflicting = { ...priced, usage: { ...priced.usage, price: { ...priced.usage.price, amountMicros: 999 } } };
  await expect(priceUsageSpans(context, [conflicting])).rejects.toThrow("conflicting provider usage");
  // Simulate an ambiguous concurrent transport write which bypassed the preflight.
  await appendSpans(context, [conflicting]);
  await store.command("OPTIMIZE TABLE spans FINAL");
  await expect(readPlatformUsageTotal({ organizationId: context.organizationId, occurredAtOrAfter: floor })).rejects.toThrow("conflicting immutable identities");
});
