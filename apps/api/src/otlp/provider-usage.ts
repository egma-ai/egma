import {
  MODEL_ADAPTERS,
  MODEL_PROVIDERS,
  isUsageType,
  type ModelAdapter,
  type NewUsageRecord,
  type UsageMeasurement,
  type UsageQuantities,
  type UsageType,
} from "@egma/db";

import type {
  OtlpAttribute,
  OtlpResourceSpans,
  OtlpSpan,
  OtlpValue,
} from "./decode.ts";

/**
 * The bill, read off the spans that carry it.
 *
 * The simulator authors one `provider_usage` span per provider request on the
 * same path its transcript rides, so a usage record arrives ordered, ahead of
 * the terminal report, and byte-identical on a resend. This is the ingest half
 * of that contract: the span names the provider, the model, the protocol, how
 * the numbers were learnt and what they were, and this turns it into the
 * record the data-access module prices and stores.
 *
 * **The record's tenancy is not read from the span, and neither is who pays.**
 * The organization, the project and the run come off the simulation row the
 * door already resolved, exactly as an ordinary span's attribution does; the
 * payment source is the platform's own answer, because whose key funded a
 * request is a decision the platform took and not a claim a simulator gets to
 * make.
 *
 * A span this cannot read is skipped with a reason rather than refused. The
 * evidence is already durable and is worth keeping; a malformed bill is worth
 * a line in the door's answer, not a discarded conversation.
 */

export const PROVIDER_USAGE_SPAN = "provider_usage";

/**
 * The one scope a bill is recognised on.
 *
 * Gated on the scope and never on the span name alone, for the reason the
 * ingest's own vocabulary registry is: a framework span that happens to call
 * itself `provider_usage` is not Egma's simulator saying what it spent, and a
 * door that read one as spend would let an emitter write rows into a
 * customer's cost by naming a span.
 */
const SIMULATOR_SCOPE = "egma-simulator";

const USAGE = {
  provider: "egma.usage.provider",
  model: "egma.usage.model",
  operation: "egma.usage.operation",
  measurement: "egma.usage.measurement",
  providerRef: "egma.usage.provider_ref",
  quantities: "egma.usage.quantities",
  raw: "egma.usage.raw",
} as const;

const MEASUREMENTS: readonly UsageMeasurement[] = [
  "provider_reported",
  "client_measured",
];

/** What one simulation's row already told the door about this conversation. */
export type UsageAttribution = {
  readonly simulationId: string;
  readonly runId: string;
};

/** What reading a flush's bills produced, and what it could not read. */
export type ProviderUsageInExport = {
  readonly records: readonly NewUsageRecord[];
  /** One sentence per span this could not read, for the door's own answer. */
  readonly skipped: readonly string[];
};

function textOf(value: OtlpValue | undefined): string {
  if (value === undefined) return "";
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return String(value.intValue);
  if (value.doubleValue !== undefined) return String(value.doubleValue);
  return "";
}

function attribute(
  attributes: readonly OtlpAttribute[] | undefined,
  key: string,
): string {
  const found = (attributes ?? []).find((entry) => entry.key === key);
  return found === undefined ? "" : textOf(found.value);
}

/** A JSON object off an attribute, or nothing where it is not one. */
function objectFrom(written: string): Record<string, unknown> | undefined {
  if (written === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(written);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/** OTLP nanoseconds as the instant the provider answered. */
function instantOf(span: OtlpSpan): Date | undefined {
  const nanoseconds = span.endTimeUnixNano ?? span.startTimeUnixNano ?? "";
  if (!/^\d+$/.test(nanoseconds)) return undefined;
  return new Date(Number(BigInt(nanoseconds) / 1_000_000n));
}

function oneRecord(
  span: OtlpSpan,
  attribution: UsageAttribution,
): NewUsageRecord | string {
  const named = `${PROVIDER_USAGE_SPAN} ${span.spanId ?? "with no id"}`;
  const spanId = span.spanId ?? "";
  if (!/^[0-9a-f]{16}$/i.test(spanId)) {
    return `${named} carries no span id, so it has no identity a resend could collapse onto`;
  }

  const provider = attribute(span.attributes, USAGE.provider);
  if (!MODEL_PROVIDERS.some((known) => known === provider)) {
    return `${named} names provider ${provider || "nothing"}, which Egma has no adapter for`;
  }
  const model = attribute(span.attributes, USAGE.model);
  if (model === "") return `${named} names no model, so nothing can price it`;

  const operation = attribute(span.attributes, USAGE.operation);
  if (!MODEL_ADAPTERS.some((known) => known === operation)) {
    return `${named} names operation ${operation || "nothing"}, which is not a catalog adapter`;
  }

  const measurement = attribute(span.attributes, USAGE.measurement);
  if (!MEASUREMENTS.some((known) => known === measurement)) {
    return `${named} does not say whether its numbers are the provider's own or Egma's count`;
  }

  const measured = objectFrom(attribute(span.attributes, USAGE.quantities));
  if (measured === undefined) {
    return `${named} carries no quantities object, so it measured nothing`;
  }
  const quantities: Record<UsageType, number> = {} as Record<UsageType, number>;
  for (const [type, quantity] of Object.entries(measured)) {
    if (!isUsageType(type)) {
      return `${named} measured ${type}, which is not a usage type Egma prices`;
    }
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0) {
      return `${named} measured ${String(quantity)} ${type}, which is not a quantity`;
    }
    quantities[type] = quantity;
  }
  if (Object.keys(quantities).length === 0) {
    return `${named} measured nothing`;
  }

  const occurredAt = instantOf(span);
  if (occurredAt === undefined) {
    return `${named} does not say when the provider answered`;
  }

  const providerRef = attribute(span.attributes, USAGE.providerRef);
  const traceId = (span.traceId ?? "").toLowerCase();

  return {
    identity: {
      work: "simulation",
      simulationId: attribution.simulationId,
      spanId,
    },
    occurredAt,
    runId: attribution.runId,
    ...(traceId === "" ? {} : { traceId }),
    provider,
    model,
    operation: operation as ModelAdapter,
    quantities: quantities as UsageQuantities,
    measurement: measurement as UsageMeasurement,
    ...(providerRef === "" ? {} : { providerRef }),
    // Always the platform's own key today: a self-hoster's operator key and
    // Egma Cloud's key are both the platform's, and an organization's own key
    // is a later effort this field is already shaped for.
    paymentSource: "platform",
    rawUsage: objectFrom(attribute(span.attributes, USAGE.raw)) ?? {},
  };
}

/**
 * Every bill in one customer's gathering of resources, with the simulation
 * each resource named already resolved to its row.
 */
export function providerUsageIn(
  resources: readonly OtlpResourceSpans[],
  attributionFor: (resourceSpans: OtlpResourceSpans) => UsageAttribution,
): ProviderUsageInExport {
  const records: NewUsageRecord[] = [];
  const skipped: string[] = [];

  for (const resourceSpans of resources) {
    let attribution: UsageAttribution | undefined;
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      if (scopeSpans.scope?.name !== SIMULATOR_SCOPE) continue;
      for (const span of scopeSpans.spans ?? []) {
        if (span.name !== PROVIDER_USAGE_SPAN) continue;
        attribution ??= attributionFor(resourceSpans);
        const read = oneRecord(span, attribution);
        if (typeof read === "string") skipped.push(read);
        else records.push(read);
      }
    }
  }

  return { records, skipped };
}
