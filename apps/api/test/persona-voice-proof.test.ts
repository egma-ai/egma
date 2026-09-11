import { describe, expect, it } from "vitest";
import { createVoiceAccessProof, verifiesVoiceAccessProof } from "../src/persona-voice-proof.ts";

const binding = { organizationId: "org_A", provider: "openai", credentialRevision: "rev_A", model: "gpt-4o-mini-tts", voiceId: "voice_A" };

describe("persona voice access proof", () => {
  it("binds every access dimension and expires after ten minutes", () => {
    const made = createVoiceAccessProof(binding, "test-secret", 1_000);
    expect(verifiesVoiceAccessProof(made.proof, binding, "test-secret", 1_001)).toBe(true);
    for (const [key, value] of Object.entries(binding)) {
      expect(verifiesVoiceAccessProof(made.proof, { ...binding, [key]: `${value}-other` }, "test-secret", 1_001)).toBe(false);
    }
    expect(verifiesVoiceAccessProof(made.proof, binding, "other-secret", 1_001)).toBe(false);
    expect(verifiesVoiceAccessProof(made.proof, binding, "test-secret", 601_000)).toBe(false);
  });

  it("rejects malformed proofs", () => {
    expect(verifiesVoiceAccessProof("not-a-proof", binding, "test-secret")).toBe(false);
    expect(verifiesVoiceAccessProof("bad.bad", binding, "test-secret")).toBe(false);
  });
});
