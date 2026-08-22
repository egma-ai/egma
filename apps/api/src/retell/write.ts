import {
  appendSpans,
  claimProductionTrace,
  finishProductionTrace,
  recordProductionTraces,
  recordPulledCallReceived,
  recordPulledCallReceivedForPlatformAgent,
  type AuthContext,
  type ProductionTraceClaim,
} from "@egma/db";
import { safeRetellProviderData } from "@egma/retell";

import { normaliseRetellCall, type RetellCall } from "./normalise.ts";

/**
 * The shared production-trace write protocol used by Retell ingestion.
 *
 * Postgres first owns the provider conversation. ClickHouse then receives the
 * deterministic span block, and the grading queue receives those same spans.
 * A process that stops between the stores leaves a stale Postgres claim. The
 * production-ingestion loop replays that safe claim later.
 *
 * The claim belongs to the project and Retell provider conversation. It has no
 * simulation connection and no Egma agent identity.
 */

export type WriteOutcome =
  | {
      readonly kind: "written";
      readonly traceId: string;
      readonly degraded: boolean;
      readonly endedAt: Date;
      readonly endReported: boolean;
    }
  | {
      readonly kind: "already";
      readonly traceId: string;
      readonly endedAt: Date;
      readonly endReported: boolean;
    };

export type RetellProductionWriteTarget = {
  readonly agentId: string;
  readonly platformAgentId: string;
  readonly platformAgentName: string;
  readonly auth: AuthContext;
};

/** The durable stores at the writer seam. Tests use an in-memory adapter. */
export type RetellProductionWriteStore = {
  readonly claimProductionTrace: typeof claimProductionTrace;
  readonly appendSpans: typeof appendSpans;
  readonly recordProductionTraces: typeof recordProductionTraces;
  readonly finishProductionTrace: typeof finishProductionTrace;
  readonly recordPulledCallReceived: typeof recordPulledCallReceived;
  readonly recordPulledCallReceivedForPlatformAgent: typeof recordPulledCallReceivedForPlatformAgent;
};

const STORES: RetellProductionWriteStore = {
  claimProductionTrace,
  appendSpans,
  recordProductionTraces,
  finishProductionTrace,
  recordPulledCallReceived,
  recordPulledCallReceivedForPlatformAgent,
};

function projectIdOf(target: Pick<RetellProductionWriteTarget, "auth">): string {
  const projectId = target.auth.projectId;
  if (projectId === undefined) {
    throw new Error("Retell production ingestion requires a project context");
  }
  return projectId;
}

function providerText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function retellCallBelongsToTarget(
  target: Pick<RetellProductionWriteTarget, "platformAgentId">,
  call: RetellCall,
): boolean {
  const platformAgentId = providerText(call["agent_id"]);
  return platformAgentId === "" || platformAgentId === target.platformAgentId;
}

function platformAgentReferenceOf(
  target: Pick<
    RetellProductionWriteTarget,
    "platformAgentId" | "platformAgentName"
  >,
  call: RetellCall,
): { readonly id: string; readonly name: string; readonly version: string } {
  if (!retellCallBelongsToTarget(target, call)) {
    throw new Error("A Retell call belongs to a different platform agent");
  }
  return {
    id: providerText(call["agent_id"]) || target.platformAgentId,
    name: providerText(call["agent_name"]) || target.platformAgentName,
    version: platformAgentVersionOf(call),
  };
}

function platformAgentVersionOf(call: RetellCall): string {
  const value = call["agent_version"];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function parsedCall(payload: string): RetellCall {
  const value: unknown = JSON.parse(payload);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("A stale Retell production claim has an invalid safe payload");
  }
  return value as RetellCall;
}

/**
 * Claim and write one hydrated Retell call.
 *
 * The provider document is made safe before it enters the durable claim. The
 * normalizer also applies the same protection to every ClickHouse payload.
 */
export async function writeRetellCall(
  target: RetellProductionWriteTarget,
  call: RetellCall,
  receivedAt = new Date(),
  stores: RetellProductionWriteStore = STORES,
): Promise<WriteOutcome> {
  const safeCall = safeRetellProviderData(call);
  const platformAgentReference = platformAgentReferenceOf(target, safeCall);
  const normalised = normaliseRetellCall(
    safeCall,
    {
      projectId: projectIdOf(target),
      environment: "production",
      platformAgentId: platformAgentReference.id,
      platformAgentName: platformAgentReference.name,
      platformAgentVersion: platformAgentReference.version,
    },
    receivedAt.getTime(),
  );

  const claim = await stores.claimProductionTrace(target.auth, {
    traceId: normalised.traceId,
    providerCallId: normalised.providerCallId,
    platformAgentId: platformAgentReference.id,
    platformAgentName: platformAgentReference.name,
    ...(platformAgentReference.version === ""
      ? {}
      : { platformAgentVersion: platformAgentReference.version }),
    payload: JSON.stringify(safeCall),
    endedAt: normalised.endedAt,
  });

  if (claim === undefined) {
    return {
      kind: "already",
      traceId: normalised.traceId,
      endedAt: normalised.endedAt,
      endReported: normalised.endReported,
    };
  }

  await stores.appendSpans(target.auth, normalised.spans);
  if (
    normalised.spans.some(
      (span) => span.kind === "turn:human" || span.kind === "turn:agent",
    )
  ) {
    await stores.recordProductionTraces(target.auth, normalised.spans);
  }
  // Keep the claim replayable until every side effect of accepting this
  // provider conversation is durable. If this health update fails, the claim
  // remains stale and replay can finish it instead of leaving Monitoring in
  // "waiting" after the trace already arrived.
  await stores.recordPulledCallReceived(target.auth, target, receivedAt);
  await stores.finishProductionTrace(target.auth, {
    traceId: normalised.traceId,
    degraded: normalised.degraded,
  });

  return {
    kind: "written",
    traceId: normalised.traceId,
    degraded: normalised.degraded,
    endedAt: normalised.endedAt,
    endReported: normalised.endReported,
  };
}

/** Finish one claim that stopped between Postgres and ClickHouse. */
export async function replayProductionClaim(
  claim: ProductionTraceClaim,
  stores: RetellProductionWriteStore = STORES,
): Promise<void> {
  const call = parsedCall(claim.payload);
  const projectId = claim.auth.projectId;
  if (projectId === undefined) {
    throw new Error("A stale Retell production claim has no project context");
  }
  const normalised = normaliseRetellCall(
    call,
    {
      projectId,
      environment: "production",
      platformAgentId: claim.platformAgentId,
      platformAgentName: claim.platformAgentName ?? "",
      platformAgentVersion: claim.platformAgentVersion ?? "",
    },
    claim.endedAt.getTime(),
  );
  if (
    normalised.traceId !== claim.traceId ||
    normalised.providerCallId !== claim.providerCallId
  ) {
    throw new Error("A stale Retell production claim changed trace identity");
  }

  await stores.appendSpans(claim.auth, normalised.spans);
  if (
    normalised.spans.some(
      (span) => span.kind === "turn:human" || span.kind === "turn:agent",
    )
  ) {
    await stores.recordProductionTraces(claim.auth, normalised.spans);
  }
  await stores.recordPulledCallReceivedForPlatformAgent(claim.auth, {
    agentPlatform: "retell",
    platformAgentId: claim.platformAgentId,
  });
  await stores.finishProductionTrace(claim.auth, {
    traceId: claim.traceId,
    degraded: normalised.degraded,
  });
}
