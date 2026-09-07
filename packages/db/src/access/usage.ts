import { createHash } from "node:crypto";

import { newId } from "@egma/ids";
import { and, asc, eq, inArray, lte } from "drizzle-orm";

import { db } from "../client.ts";
import {
  billableUsageTypesOf,
  isUsageType,
  readRateCard,
  unitOfQuantities,
  type RateCardEntry,
  type UsageType,
  type UsageUnit,
} from "../models/rate-card.ts";
import { PROVIDER_CATALOG, type ModelAdapter } from "../models/catalog.ts";
import { rateCard, usageRecord } from "../schema/billing.ts";
import type {
  UsageMeasurement,
  UsagePaymentSource,
} from "../schema/billing.ts";
import { authorize } from "./permissions.ts";
import type { AuthContext } from "./context.ts";
import { inActingProject, within } from "./within.ts";

/**
 * Usage records: one row per provider request, priced where it is stored.
 *
 * **Rating happens here and never in a worker.** The simulator and the grader
 * both measure and both hand over quantities; the price is applied at the
 * write, against the rate card as it stood when the provider answered. A price
 * change is therefore a row in one table and never a release of a simulator.
 *
 * **A record is written once however many times it arrives.** The identity is
 * derived from facts that do not change on a resend — for a simulation, the
 * span id the write-ahead log froze into its bytes; for grading, the job, its
 * attempt, the grader, the assertion, the HTTP attempt and the provider's own
 * response id — and the insert is `on conflict do nothing` on that identity. A
 * re-executed simulation mints new span ids and is new spend, which is the
 * right answer rather than a gap in the rule.
 */

/** The quantities one request consumed, by usage type. */
export type UsageQuantities = Readonly<Partial<Record<UsageType, number>>>;

/**
 * What makes a record the same record on a resend.
 *
 * Handed over in parts rather than as a key, so that no caller can compute the
 * identity — and therefore no caller can compute it differently. The one
 * derivation is `dedupeKeyOf` below.
 */
export type UsageIdentity =
  | {
      readonly work: "simulation";
      readonly simulationId: string;
      /** The Egma span that carried the record. Frozen in the WAL's bytes. */
      readonly spanId: string;
    }
  | {
      readonly work: "grading";
      readonly gradingJobId: string;
      /** The grading job's own attempt counter when the request was made. */
      readonly attempts: number;
      readonly projectGraderId: string;
      /** Which assertion of that grader this call decided. */
      readonly assertion: string;
      /** Which HTTP attempt inside that call answered. Counted from one. */
      readonly httpAttempt: number;
    };

/** One measured provider request, before it is priced. */
export type NewUsageRecord = {
  readonly identity: UsageIdentity;
  /** When the provider answered. */
  readonly occurredAt: Date;
  readonly runId?: string | undefined;
  /** The simulation this request belongs to, where it belongs to one. */
  readonly simulationId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly provider: string;
  readonly model: string;
  /** The catalog adapter that spoke to the provider. */
  readonly operation: ModelAdapter;
  readonly quantities: UsageQuantities;
  readonly measurement: UsageMeasurement;
  /** The provider's own reference for the request, where it gave one. */
  readonly providerRef?: string | undefined;
  readonly paymentSource: UsagePaymentSource;
  readonly credentialRef?: string | undefined;
  /** The provider's usage object verbatim, or `{}` where Egma counted. */
  readonly rawUsage: Readonly<Record<string, unknown>>;
};

/** What one write of a batch actually stored. */
export type RecordedProviderUsage = {
  /** How many of the batch were new. A resend stores none and is not an error. */
  readonly stored: number;
  /** What those new rows came to, in millionths of a US dollar. */
  readonly amountMicros: number;
};

/** One model's spend on one simulation, as the simulation page reads it. */
export type UsageByModel = {
  readonly provider: string;
  readonly model: string;
  readonly unit: UsageUnit;
  readonly requests: number;
  readonly quantities: Readonly<Record<string, number>>;
  readonly amountMicros: number;
};

/** A simulation's whole spend, by provider and model. */
export type SimulationUsage = {
  readonly amountMicros: number;
  readonly requests: number;
  readonly byModel: readonly UsageByModel[];
};

function projectOf(auth: AuthContext): string {
  if (auth.projectId === undefined || auth.projectId === "") {
    throw new TypeError("usage records require a project-scoped context");
  }
  return auth.projectId;
}

/**
 * The deterministic identity, as the one string a hash is taken of.
 *
 * A hash rather than the parts joined: the parts include a provider reference
 * Egma does not choose the length of, and a unique btree index has a bound.
 * Each part is written with its own length in front of it rather than with a
 * separator between parts, so there is no character a value could contain that
 * would let two different identities spell the same string.
 */
function dedupeKeyOf(record: NewUsageRecord): string {
  const identity = record.identity;
  const parts =
    identity.work === "simulation"
      ? [
          "simulation",
          identity.simulationId,
          record.provider,
          record.operation,
          record.providerRef ?? "",
          identity.spanId,
        ]
      : [
          "grading",
          identity.gradingJobId,
          String(identity.attempts),
          identity.projectGraderId,
          identity.assertion,
          String(identity.httpAttempt),
          record.providerRef ?? "",
        ];
  const canonical = parts.map((part) => `${part.length}:${part}`).join("");
  return createHash("sha256").update(canonical).digest("hex");
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
  const QUANTITY_PLACES = 1_000_000_000_000n;
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

/**
 * Store a batch of measured provider requests, priced against the rate card.
 *
 * The context is the one the work already runs under — a simulation's claim, or
 * a grading claim — so the organization and the project are stamped from it and
 * never from anything the measurement said.
 *
 * A quantity with no price effective at its instant is stored at nothing and
 * says so through `priced_by`, which then names no row for it. That is the
 * honest answer for the one case it can happen in: a model priced from a later
 * date than a record that arrived late. The coverage test is what stops it
 * happening for a model with no price at all.
 */
export async function recordProviderUsage(
  auth: AuthContext,
  records: readonly NewUsageRecord[],
): Promise<RecordedProviderUsage> {
  if (records.length === 0) return { stored: 0, amountMicros: 0 };
  /*
   * **The guard is the context's provenance, and there is no permission for
   * this.** A usage record is not an action a person takes: it is Egma writing
   * down what it has just spent on somebody else's behalf, and the only honest
   * authority for one is the claim that authorised the work — a simulation's,
   * or a grading job's. No role should be able to do this and none can, so
   * adding a permission row for it would be a row nothing could ever refuse,
   * which is the kind of permission this codebase already refuses to write.
   */
  if (auth.via !== "simulator" && auth.via !== "engine") {
    throw new Error(
      "a usage record is written by Egma's own simulator or its grading " +
        "engine, from the claim that authorised the work — never under a " +
        "credential, because nobody asks Egma to spend money on their behalf " +
        "except by starting work Egma then claims",
    );
  }
  /*
   * The floor underneath it, and it is a floor rather than this call's own
   * permission: every function on this surface asks, and `read` is what both
   * claim contexts hold. It cannot refuse one the module itself built — which
   * is the point of asking, and the same reason the ingest door asks: a change
   * that made a claim context refusable would surface here rather than as a
   * customer's missing rows.
   */
  authorize(auth, "read", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  const projectId = projectOf(auth);
  const rates = await ratesFor(records);

  const values = records.map((record) => {
    const quantities: Record<string, number> = {};
    for (const [type, quantity] of Object.entries(record.quantities)) {
      if (quantity === undefined) continue;
      if (!isUsageType(type)) {
        throw new TypeError(`${type} is not a usage type Egma measures`);
      }
      quantities[type] = quantity;
    }
    const unit = unitOfQuantities(quantities);

    let amountMicros = 0;
    const pricedBy: Record<string, string> = {};
    for (const [type, quantity] of Object.entries(quantities)) {
      const rate = priceAt(rates, record, type as UsageType);
      if (rate === undefined) continue;
      amountMicros += micros(quantity, rate.usdPerMillion);
      pricedBy[type] = rate.id;
    }

    return {
      id: newId("usg"),
      organizationId: auth.organizationId,
      projectId,
      occurredAt: record.occurredAt,
      runId: record.runId ?? null,
      workKind: record.identity.work,
      simulationId:
        record.identity.work === "simulation"
          ? record.identity.simulationId
          : (record.simulationId ?? null),
      gradingJobId:
        record.identity.work === "grading" ? record.identity.gradingJobId : null,
      attempt:
        record.identity.work === "grading" ? record.identity.attempts : 0,
      traceId: record.traceId ?? null,
      spanId:
        record.identity.work === "simulation" ? record.identity.spanId : null,
      provider: record.provider,
      model: record.model,
      operation: record.operation,
      unit,
      quantities,
      measurement: record.measurement,
      providerRef: record.providerRef ?? null,
      paymentSource: record.paymentSource,
      credentialRef: record.credentialRef ?? null,
      rawUsage: record.rawUsage,
      amountMicros,
      pricedBy,
      dedupeKey: dedupeKeyOf(record),
    };
  });

  const stored = await db()
    .insert(usageRecord)
    .values(values)
    .onConflictDoNothing({ target: usageRecord.dedupeKey })
    .returning({ amountMicros: usageRecord.amountMicros });

  return {
    stored: stored.length,
    amountMicros: stored.reduce((all, row) => all + row.amountMicros, 0),
  };
}

/**
 * One simulation's spend, by provider and model.
 *
 * The page shows a cost per model rather than a row per request: forty turns of
 * a voice conversation are a hundred and twenty provider requests, and a list
 * of them answers no question anybody has. The quantities are summed in the
 * unit the provider bills, beside the money.
 */
export async function readSimulationUsage(
  auth: AuthContext,
  simulationId: string,
): Promise<SimulationUsage> {
  authorize(auth, "read", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  const rows = await db()
    .select({
      provider: usageRecord.provider,
      model: usageRecord.model,
      unit: usageRecord.unit,
      quantities: usageRecord.quantities,
      amountMicros: usageRecord.amountMicros,
    })
    .from(usageRecord)
    .where(
      within(
        auth,
        usageRecord,
        and(
          eq(usageRecord.simulationId, simulationId),
          inActingProject(auth, usageRecord),
        ),
      ),
    );

  const byModel = new Map<string, UsageByModel>();
  let amountMicros = 0;
  for (const row of rows) {
    amountMicros += row.amountMicros;
    const key = `${row.provider}/${row.model}`;
    const held = byModel.get(key);
    const quantities: Record<string, number> = { ...(held?.quantities ?? {}) };
    for (const [type, quantity] of Object.entries(row.quantities)) {
      quantities[type] = (quantities[type] ?? 0) + quantity;
    }
    byModel.set(key, {
      provider: row.provider,
      model: row.model,
      unit: row.unit as UsageUnit,
      requests: (held?.requests ?? 0) + 1,
      quantities,
      amountMicros: (held?.amountMicros ?? 0) + row.amountMicros,
    });
  }

  return {
    amountMicros,
    requests: rows.length,
    byModel: [...byModel.values()].sort((left, right) =>
      right.amountMicros - left.amountMicros ||
      `${left.provider}/${left.model}`.localeCompare(
        `${right.provider}/${right.model}`,
      ),
    ),
  };
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
