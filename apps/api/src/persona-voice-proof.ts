import { createHmac, timingSafeEqual } from "node:crypto";

export type VoiceProofBinding = {
  readonly organizationId: string;
  readonly provider: string;
  readonly credentialRevision: string;
  readonly model: string;
  readonly voiceId: string;
};

const PURPOSE = "persona_voice_access";
export const VOICE_PROOF_LIFETIME_MILLISECONDS = 10 * 60 * 1_000;

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

export function createVoiceAccessProof(
  binding: VoiceProofBinding,
  secret: string,
  now = Date.now(),
): { readonly proof: string; readonly expiresAt: Date } {
  const expiresAt = new Date(now + VOICE_PROOF_LIFETIME_MILLISECONDS);
  const payload = Buffer.from(JSON.stringify({ purpose: PURPOSE, ...binding, expiresAt: expiresAt.toISOString() }), "utf8").toString("base64url");
  return { proof: `${payload}.${signature(payload, secret).toString("base64url")}`, expiresAt };
}

export function verifiesVoiceAccessProof(
  proof: string,
  binding: VoiceProofBinding,
  secret: string,
  now = Date.now(),
): boolean {
  const [payload, presentedText, extra] = proof.split(".");
  if (payload === undefined || presentedText === undefined || extra !== undefined) return false;
  const presented = Buffer.from(presentedText, "base64url");
  const expected = signature(payload, secret);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return decoded.purpose === PURPOSE &&
      decoded.organizationId === binding.organizationId && decoded.provider === binding.provider &&
      decoded.credentialRevision === binding.credentialRevision && decoded.model === binding.model &&
      decoded.voiceId === binding.voiceId && typeof decoded.expiresAt === "string" &&
      Date.parse(decoded.expiresAt) > now;
  } catch {
    return false;
  }
}
