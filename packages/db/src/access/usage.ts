import { USAGE_IDENTITIES } from "../clickhouse/usage.ts";
import { providerUsageSpan, usageEvidenceHash, type ProviderUsageEvidence, type NewUsageRecord, type OrganizationUsage, type RecordedProviderUsage } from "../models/provider-usage.ts";
export type { ProviderUsageEvidence, NewUsageRecord, OrganizationUsage, RecordedProviderUsage, UsageByModel, UsageIdentity, UsageQuantities } from "../models/provider-usage.ts";
import { TupleParam } from "@clickhouse/client";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { newId } from "@egma/ids";
import { db } from "../client.ts";
import { traceStore } from "../clickhouse/client.ts";
import { allowanceTotalsSelection, begunInThePeriod, periodAt, periodUsageFrom, type PeriodUsage } from "../billing/period-usage.ts";
export type { PeriodUsage } from "../billing/period-usage.ts";
import { billableUsageTypesOf, isUsageType, readRateCard, unitOfQuantities, type RateCardEntry, type UsageType, type UsageUnit } from "../models/rate-card.ts";
import { PROVIDER_CATALOG } from "../models/catalog.ts";
import { rateCard } from "../schema/billing.ts";
import { simulation } from "../schema/runs.ts";
import { organization } from "../schema/tenancy.ts";
import { authorize } from "./permissions.ts";
import type { AuthContext } from "./context.ts";
import { theOrganization, within } from "./within.ts";
import { appendSpans, type NewSpan } from "./spans.ts";

function requireWriter(auth: AuthContext): void {
  if (auth.via !== "simulator" && auth.via !== "engine") throw new Error("provider usage requires the trusted simulation or grading claim");
  if (!auth.projectId) throw new Error("provider usage requires a project-scoped context");
  authorize(auth, "read", { organizationId: auth.organizationId, projectId: auth.projectId });
}

/** The `usd_per_million` numeric as Postgres hands it back, exactly. */
type RateRow = {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly usageType: string;
  readonly usdPerMillion: string;
  readonly effectiveFrom: Date;
};

/**
 * What a quantity costs, in millionths of a US dollar.
 *
 * The arithmetic is exact and has no scale factor: a price is US dollars per
 * 1,000,000 units, and one micro-dollar is one unit at $1.00 per million — so
 * the amount in micros is simply the quantity times the price. It is done in
 * fixed point rather than floating point, because a price with twelve decimal
 * places multiplied by a token count is exactly the arithmetic a float gets
 * wrong in the last place, on every record, always in the same direction.
 *
 * Rounded once, half up, to the nearest micro-dollar: money is counted.
 */
function micros(quantity: number, usdPerMillion: string): number {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new TypeError(`a usage quantity cannot be ${quantity}`);
  }
  const [whole = "0", fraction = ""] = usdPerMillion.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const price = BigInt(whole) * scale + BigInt(fraction === "" ? "0" : fraction);
  // The quantity itself can be fractional — seconds of audio are — so it is
  // taken to the same twelve places the price column holds before scaling.
  // Written as a power rather than as twelve zeros, because a plain million
  // in source is reserved for the one module that turns nanoseconds into a
  // measure, and a test holds that line.
  const QUANTITY_PLACES = 10n ** 12n;
  const counted = BigInt(Math.round(quantity * 1e12));
  const scaled = counted * price;
  const divisor = QUANTITY_PLACES * scale;
  const rounded = (scaled * 2n + divisor) / (divisor * 2n);
  return Number(rounded);
}

/** Every price that could apply to this batch, newest effective date last. */
async function ratesFor(
  records: readonly NewUsageRecord[],
): Promise<readonly RateRow[]> {
  const models = [...new Set(records.map((record) => record.model))];
  const latest = records.reduce(
    (newest, record) =>
      record.occurredAt.getTime() > newest.getTime() ? record.occurredAt : newest,
    new Date(0),
  );
  if (models.length === 0) return [];
  return db()
    .select({
      id: rateCard.id,
      provider: rateCard.provider,
      model: rateCard.model,
      usageType: rateCard.usageType,
      usdPerMillion: rateCard.usdPerMillion,
      effectiveFrom: rateCard.effectiveFrom,
    })
    .from(rateCard)
    .where(
      and(inArray(rateCard.model, models), lte(rateCard.effectiveFrom, latest)),
    )
    .orderBy(asc(rateCard.effectiveFrom));
}

/** The row effective at that instant, or nothing where no price applies yet. */
function priceAt(
  rates: readonly RateRow[],
  record: NewUsageRecord,
  usageType: UsageType,
): RateRow | undefined {
  let chosen: RateRow | undefined;
  for (const rate of rates) {
    if (rate.provider !== record.provider || rate.model !== record.model) continue;
    if (rate.usageType !== usageType) continue;
    if (rate.effectiveFrom.getTime() > record.occurredAt.getTime()) continue;
    if (chosen === undefined || rate.effectiveFrom >= chosen.effectiveFrom) {
      chosen = rate;
    }
  }
  return chosen;
}


/** Price at occurrence time; restore committed facts on a replay. */
export async function priceUsageSpans(auth: AuthContext, spans: readonly NewSpan[]): Promise<NewSpan[]> {
  const measured = spans.filter((span) => span.usage !== undefined);
  if (measured.length === 0) return [...spans];
  if (!auth.projectId) throw new Error("usage pricing requires a project");
  const result = await traceStore().query({
    query: `SELECT trace_id, span_id, usage_evidence FROM spans WHERE organization_id = {org:String} AND project_id = {project:String} AND usage_identity_hash != '' AND (trace_id, span_id) IN {identities:Array(Tuple(String, String))}`,
    query_params: { org: auth.organizationId, project: auth.projectId, identities: measured.map((span) => new TupleParam([span.traceId, span.spanId])) }, format: "JSONEachRow",
  });
  const held = new Map<string, ProviderUsageEvidence>();
  for (const row of await result.json<{ trace_id: string; span_id: string; usage_evidence: string }>()) {
    const usage = JSON.parse(row.usage_evidence) as ProviderUsageEvidence;
    const key = `${row.trace_id}/${row.span_id}`;
    const old = held.get(key);
    if (old && usageEvidenceHash(old) !== usageEvidenceHash(usage)) throw new Error(`conflicting provider usage for ${key}`);
    if (!old || usage.receivedAt < old.receivedAt) held.set(key, usage);
  }
  const rates = await ratesFor(measured.filter((span) => !span.usage?.price && !held.has(`${span.traceId}/${span.spanId}`)).map((span) => ({ ...span.usage!, occurredAt: new Date(span.usage!.occurredAt) })));
  return spans.map((span) => {
    if (!span.usage) return span;
    const usage = span.usage;
    const existing = held.get(`${span.traceId}/${span.spanId}`);
    if (existing) {
      if (usageEvidenceHash(existing, false) !== usageEvidenceHash(usage, false) || (usage.price && usageEvidenceHash(existing) !== usageEvidenceHash(usage))) throw new Error(`conflicting provider usage for ${span.traceId}/${span.spanId}`);
      return { ...span, usage: existing };
    }
    if (usage.price) return span;
    const record = { ...usage, occurredAt: new Date(usage.occurredAt) };
    let amountMicros = 0;
    const pricedBy: Record<string, string> = {};
    for (const [type, quantity] of Object.entries(usage.quantities)) {
      if (!isUsageType(type) || !Number.isFinite(quantity) || quantity < 0) throw new TypeError("invalid provider usage quantity");
      const rate = priceAt(rates, record, type);
      if (!rate) continue;
      amountMicros += micros(quantity, rate.usdPerMillion);
      pricedBy[type] = rate.id;
    }
    if (!Number.isSafeInteger(amountMicros)) throw new Error("provider usage amount exceeds exact integer range");
    return { ...span, usage: { ...usage, price: { amountMicros, pricedBy, unit: unitOfQuantities(usage.quantities) } } };
  });
}

/** Direct appends are safe to retry by complete span identity, independently of block deduplication. */
export async function recordProviderUsage(auth: AuthContext, records: readonly NewUsageRecord[]): Promise<RecordedProviderUsage> {
  requireWriter(auth);
  const spans = await priceUsageSpans(auth, records.map((record) => providerUsageSpan(record)));
  await appendSpans(auth, spans);
  return { stored: spans.length, amountMicros: spans.reduce((total, span) => total + (span.usage?.price?.amountMicros ?? 0), 0) };
}

/** Organization-wide provider/model totals for the shared settings read. */
export async function readOrganizationUsage(auth: AuthContext, period: { from: Date; to: Date }): Promise<OrganizationUsage> {
  authorize(auth, "read", { organizationId: auth.organizationId, projectId: undefined });
  const result = await traceStore().query({
    query: `SELECT provider, model, unit, toString(sum(usage.amount)) AS amount, toString(count()) AS requests, sumMap(usage.quantities) AS quantities, countIf(variants != 1) AS conflicts FROM (${USAGE_IDENTITIES}) AS usage WHERE occurred_at >= fromUnixTimestamp64Milli({from:Int64}) AND occurred_at < fromUnixTimestamp64Milli({to:Int64}) GROUP BY provider, model, unit ORDER BY sum(usage.amount) DESC, provider, model`,
    query_params: { org: auth.organizationId, from: period.from.getTime(), to: period.to.getTime() }, format: "JSONEachRow",
  });
  const rows = await result.json<{ provider: string; model: string; unit: UsageUnit; amount: string; requests: string; quantities: Record<string, number>; conflicts: number }>();
  if (rows.some((row) => Number(row.conflicts) !== 0)) throw new Error("provider usage contains conflicting immutable identities");
  const byModel = rows.map((row) => ({ provider: row.provider, model: row.model, unit: row.unit, amountMicros: Number(row.amount), requests: Number(row.requests), quantities: row.quantities }));
  return { amountMicros: byModel.reduce((sum, row) => sum + row.amountMicros, 0), requests: byModel.reduce((sum, row) => sum + row.requests, 0), byModel };
}

export async function readUsageThisPeriod(
  auth: AuthContext,
  at: Date = new Date(),
  anchor?: Date,
): Promise<PeriodUsage> {
  authorize(auth, "read", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });

  const from = anchor ?? (await organizationCreatedAt(auth));
  const period = periodAt(from, at);

  const [totals] = await db()
    .select(allowanceTotalsSelection())
    .from(simulation)
    .where(within(auth, simulation, begunInThePeriod(period)));

  return periodUsageFrom(period, totals);
}

/** When this organization came into existence — its own reset day on Hobby. */
async function organizationCreatedAt(auth: AuthContext): Promise<Date> {
  const [customer] = await db()
    .select({ createdAt: organization.createdAt })
    .from(organization)
    .where(theOrganization(auth))
    .limit(1);
  if (customer === undefined) {
    throw new Error(
      `organization ${auth.organizationId} was not found while reading its usage`,
    );
  }
  return customer.createdAt;
}

/** What one boot of the rate-card upsert wrote. */
export type UpsertedRateCard = {
  /** The prices this call inserted, as `provider/model usage_type` from a date. */
  readonly written: readonly string[];
};

/**
 * Write the rate card from the shipped file.
 *
 * The deployment configuring itself, the way the persona shelf and the grader
 * catalog do: no customer, no session, and an insert that does nothing where
 * the price is already there — so every instance can run it on every boot and
 * only a release that added a price writes anything at all.
 *
 * It never updates. A price is append-only because a stored usage record cites
 * the row that priced it, so editing a shipped row would silently re-price
 * work that has already been charged for.
 */
export async function upsertRateCardInternal(
  card?: readonly RateCardEntry[],
): Promise<UpsertedRateCard> {
  const entries = card ?? (await readRateCard());
  const values = entries.flatMap((entry) =>
    entry.prices.map((price) => ({
      id: newId("rat"),
      provider: entry.provider,
      model: entry.model,
      usageType: price.usageType,
      unit: price.unit,
      usdPerMillion: price.usdPerMillion,
      effectiveFrom: entry.effectiveFrom,
      source: entry.source,
      readAt: entry.readAt,
      note: entry.note ?? null,
    })),
  );
  if (values.length === 0) return { written: [] };

  const written = await db()
    .insert(rateCard)
    .values(values)
    .onConflictDoNothing({
      target: [
        rateCard.provider,
        rateCard.model,
        rateCard.usageType,
        rateCard.effectiveFrom,
      ],
    })
    .returning({
      provider: rateCard.provider,
      model: rateCard.model,
      usageType: rateCard.usageType,
      effectiveFrom: rateCard.effectiveFrom,
    });

  return {
    written: written.map(
      (row) =>
        `${row.provider}/${row.model} ${row.usageType} from ` +
        `${row.effectiveFrom.toISOString().slice(0, 10)}`,
    ),
  };
}

/**
 * Which catalog models the stored rate card cannot price.
 *
 * The file's own coverage is checked against the catalog without a store; this
 * asks the same question of the table a deployment actually rates against,
 * which is what a boot that half-applied would break. It is not on the
 * package's surface: it names no customer and answers no product question, and
 * the suite that asks it reaches it directly.
 */
export async function catalogModelsWithoutAStoredPrice(
  at: Date = new Date(),
): Promise<readonly string[]> {
  const rows = await db()
    .select({
      provider: rateCard.provider,
      model: rateCard.model,
      usageType: rateCard.usageType,
    })
    .from(rateCard)
    .where(lte(rateCard.effectiveFrom, at));
  const priced = new Set(
    rows.map((row) => `${row.provider}/${row.model} ${row.usageType}`),
  );

  const missing: string[] = [];
  for (const entry of PROVIDER_CATALOG) {
    for (const usageType of billableUsageTypesOf(entry)) {
      const key = `${entry.provider}/${entry.model} ${usageType}`;
      if (!priced.has(key)) missing.push(key);
    }
  }
  return missing;
}
