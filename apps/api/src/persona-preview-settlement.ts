import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { recordPersonaPreviewUsage, type AuthContext, type NewUsageRecord } from "@egma/db";
import type { FastifyInstance } from "fastify";
import { acceptsServiceToken } from "./auth/service-token.ts";

type AllowedLeg = { provider: string; model: string; operation: string; paymentSource: "customer" | "platform"; credentialRef: string };
type Settlement = { userId: string; organizationId: string; projectId: string; role: AuthContext["role"]; previewId: string; expiresAt: number; legs: readonly AllowedLeg[] };

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
export function createPreviewSettlementToken(settlement: Settlement, secret: string): string {
  const payload = encode(settlement);
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
function readToken(token: string, secret: string): Settlement | undefined {
  const [payload, supplied] = token.split(".");
  if (!payload || !supplied) return undefined;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let held: Buffer;
  try { held = Buffer.from(supplied, "base64url"); } catch { return undefined; }
  if (held.length !== expected.length || !timingSafeEqual(held, expected)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Settlement;
    return value.expiresAt > Date.now() && Array.isArray(value.legs) ? value : undefined;
  } catch { return undefined; }
}

export function registerPersonaPreviewSettlement(app: FastifyInstance, options: { serviceToken: string; secret: string }): void {
  app.post("/internal/persona-preview-usage", async (request, reply) => {
    if (!acceptsServiceToken(request.headers.authorization, options.serviceToken)) return reply.code(401).send();
    const body = (request.body ?? {}) as Record<string, unknown>;
    const settlement = typeof body.token === "string" ? readToken(body.token, options.secret) : undefined;
    const index = body.usageIndex;
    const usage = body.usage as Record<string, unknown> | undefined;
    if (settlement === undefined || !Number.isInteger(index) || typeof usage !== "object" || usage === null)
      return reply.code(422).send();
    const leg = settlement.legs[index as number];
    if (leg === undefined || usage.provider !== leg.provider || usage.model !== leg.model || usage.operation !== leg.operation ||
        (usage.measurement !== "provider_reported" && usage.measurement !== "client_measured") || typeof usage.quantities !== "object" || usage.quantities === null)
      return reply.code(422).send();
    const traceId = createHash("sha256").update(`persona-preview:${settlement.previewId}`).digest("hex").slice(0, 32);
    const record: NewUsageRecord = {
      identity: { work: "persona_preview", previewId: settlement.previewId, spanId: createHash("sha256").update(`${settlement.previewId}:${index}`).digest("hex").slice(0, 16) },
      occurredAt: new Date(), traceId, provider: leg.provider, model: leg.model,
      operation: leg.operation as NewUsageRecord["operation"], quantities: usage.quantities as NewUsageRecord["quantities"],
      measurement: usage.measurement, ...(typeof usage.provider_ref === "string" ? { providerRef: usage.provider_ref } : {}),
      paymentSource: leg.paymentSource, credentialRef: leg.credentialRef,
      rawUsage: typeof usage.raw === "object" && usage.raw !== null ? usage.raw as Record<string, unknown> : {},
    };
    const auth: AuthContext = { userId: settlement.userId, organizationId: settlement.organizationId, projectId: settlement.projectId, role: settlement.role, via: "session" };
    await recordPersonaPreviewUsage(auth, [record]);
    return reply.code(204).send();
  });
}
