import { createHash } from "node:crypto";
import type { UsageType, UsageUnit } from "./rate-card.ts";
import type { ModelAdapter } from "./catalog.ts";
import type {
  UsageMeasurement,
  UsagePaymentSource,
} from "../schema/billing.ts";
import type { NewSpan } from "../access/spans.ts";

export type UsageQuantities = Readonly<Partial<Record<UsageType, number>>>;
export type UsageIdentity =
  | {
      readonly work: "simulation";
      readonly simulationId: string;
      readonly spanId: string;
    }
  | {
      readonly work: "grading";
      readonly gradingJobId: string;
      readonly attempts: number;
      readonly projectGraderId: string;
      readonly httpAttempt: number;
      readonly attemptId: string;
    };
export type NewUsageRecord = {
  readonly identity: UsageIdentity;
  readonly occurredAt: Date;
  readonly runId?: string | undefined;
  readonly simulationId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly provider: string;
  readonly model: string;
  readonly operation: ModelAdapter;
  readonly quantities: UsageQuantities;
  readonly measurement: UsageMeasurement;
  readonly providerRef?: string | undefined;
  readonly paymentSource: UsagePaymentSource;
  readonly credentialRef?: string | undefined;
  readonly rawUsage: Readonly<Record<string, unknown>>;
};
export type ProviderUsageEvidence = Omit<NewUsageRecord, "occurredAt"> & {
  readonly occurredAt: string;
  /** Receipt is frozen before the first local durable append. */
  readonly receivedAt: string;
  readonly price?:
    | {
        readonly amountMicros: number;
        readonly pricedBy: Readonly<Record<string, string>>;
        readonly unit: UsageUnit;
      }
    | undefined;
};
export type RecordedProviderUsage = {
  readonly stored: number;
  readonly amountMicros: number;
};
export type UsageByModel = {
  readonly provider: string;
  readonly model: string;
  readonly unit: UsageUnit;
  readonly requests: number;
  readonly quantities: Readonly<Record<string, number>>;
  readonly amountMicros: number;
};
export type OrganizationUsage = {
  readonly amountMicros: number;
  readonly requests: number;
  readonly byModel: readonly UsageByModel[];
};

/** Nested key order cannot make identical measurements into different evidence. */
export function canonicalUsage(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalUsage).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalUsage(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function usageEvidenceHash(
  usage: ProviderUsageEvidence,
  priced = true,
): string {
  const { receivedAt: _receipt, price, ...measurement } = usage;
  return createHash("sha256")
    .update(canonicalUsage(priced ? { ...measurement, price } : measurement))
    .digest("hex");
}

/** Make one paid attempt into evidence before any price lookup or store request. */
export function providerUsageSpan(
  record: NewUsageRecord,
  receivedAt = new Date(),
): NewSpan {
  if (!record.traceId)
    throw new Error("provider usage must belong to its trace");
  const spanId =
    record.identity.work === "simulation"
      ? record.identity.spanId
      : createHash("sha256")
          .update(canonicalUsage(record.identity))
          .digest("hex")
          .slice(0, 16);
  return {
    traceId: record.traceId,
    spanId,
    parentSpanId: "",
    source: record.runId ? "simulation" : "production",
    emitter: record.identity.work === "grading" ? "grader" : "egma-runtime",
    environment: "default",
    startedAtMicroseconds: BigInt(record.occurredAt.getTime()) * 1_000n,
    durationNanoseconds: 0n,
    name: "provider_usage",
    kind: "provider_usage",
    status: "unset",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "",
    agentPlatform: "",
    platformAgentId: "",
    platformAgentName: "",
    platformAgentVersion: "",
    connectionType: "",
    runId: record.runId ?? "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
    payload: "{}",
    endsTrace: false,
    usage: {
      ...record,
      occurredAt: record.occurredAt.toISOString(),
      receivedAt: receivedAt.toISOString(),
    },
  };
}
