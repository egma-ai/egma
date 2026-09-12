import { describe, expect, it, vi } from "vitest";

import {
  discoverCartesiaVoices,
  OPENAI_STANDARD_VOICES,
  OPENAI_LIVE_VOICES,
  personaCapabilityRefusal,
  resolvePersonaCapabilities,
} from "../src/persona-capabilities.ts";

const selection = {
  ttsProvider: "openai",
  ttsModel: "gpt-4o-mini-tts",
  sttProvider: "openai",
  sttModel: "gpt-4o-mini-transcribe",
};

describe("persona capability resolution", () => {
  it("offers the complete documented OpenAI voice catalog", () => {
    const result = resolvePersonaCapabilities(selection);
    expect(result.voices.status).toBe("supported");
    expect(result.voices.choices?.map((voice) => voice.id)).toEqual([
      "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova",
      "sage", "shimmer", "verse", "marin", "cedar",
    ]);
    expect(OPENAI_STANDARD_VOICES.find((voice) => voice.id === "cedar")?.presentation).toBe("male");
    expect(OPENAI_STANDARD_VOICES.find((voice) => voice.id === "coral")?.presentation).toBe("female");
    expect(OPENAI_STANDARD_VOICES.find((voice) => voice.id === "alloy")?.presentation).toBe("unknown");
  });

  it("uses the documented GPT Live voice catalog", () => {
    expect(OPENAI_LIVE_VOICES.map((voice) => voice.id)).toEqual([
      "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta", "echo", "gleam",
      "marin", "meridian", "quartz", "ripple", "sage", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
    ]);
    expect(resolvePersonaCapabilities({
      mode: "live", liveProvider: "openai", liveModel: "gpt-live-1", language: "en-US",
    }).voices.choices).toEqual(OPENAI_LIVE_VOICES);
  });

  it("fixes instruction-only controls for legacy OpenAI TTS", () => {
    const result = resolvePersonaCapabilities({ ...selection, ttsModel: "tts-1" });
    expect(result.emotion).toMatchObject({ status: "fixed", value: "neutral" });
    expect(result.accent).toMatchObject({ status: "fixed", value: "voice_default" });
    expect(result.speed.range).toEqual({ minimum: 0.25, maximum: 4, step: 0.05 });
    expect(result.voices.choices?.map((voice) => voice.id)).toEqual(["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"]);
  });

  it("distinguishes unknown catalog metadata from unsupported models", () => {
    expect(resolvePersonaCapabilities(selection).language).toMatchObject({ status: "supported" });
    expect(resolvePersonaCapabilities({ ...selection, ttsModel: "missing" }).language.status).toBe("unsupported");
  });

  it("rejects a TTS language that the selected STT model cannot recognize", () => {
    const result = resolvePersonaCapabilities({ ...selection, sttProvider: "deepgram", sttModel: "nova-3-general", language: "mi-NZ" });
    expect(result.language).toMatchObject({ status: "unsupported" });
    expect(result.language.reason).toContain("deepgram/nova-3-general");
  });

  it("returns Cartesia voice language and accent without locale inference", () => {
    const result = resolvePersonaCapabilities(
      { ...selection, ttsProvider: "cartesia", ttsModel: "sonic-3.6", voiceId: "voice-a", language: "en-GB" },
      [{ id: "voice-a", name: "A", source: "account", presentation: "female", languages: ["en-GB"], accents: ["GB"] }],
    );
    expect(result.language).toMatchObject({ status: "supported" });
    expect(result.language.choices).toContain("en");
    expect(result.language.choices).toContain("es");
    expect(result.accent).toEqual({ status: "supported", choices: ["voice_default", "GB"] });
    expect(result.speed).toMatchObject({ status: "supported" });
  });

  it("uses voice default when Cartesia omits accent metadata", () => {
    const result = resolvePersonaCapabilities(
      { ...selection, ttsProvider: "cartesia", ttsModel: "sonic-3.6", voiceId: "voice-a", language: "en-US" },
      [{ id: "voice-a", name: "A", source: "standard", presentation: "unknown", languages: [], accents: [] }],
    );
    expect(result.accent).toEqual({
      status: "fixed",
      value: "voice_default",
      reason: "Cartesia did not return accent metadata, so named accent steering is unverified.",
    });
  });

  it("does not offer named accent steering on Cartesia models that cannot execute it", () => {
    const result = resolvePersonaCapabilities(
      { ...selection, ttsProvider: "cartesia", ttsModel: "sonic-3.5", voiceId: "voice-a", language: "en-US" },
      [{ id: "voice-a", name: "A", source: "standard", presentation: "unknown", languages: [], accents: ["general-american"] }],
    );
    expect(result.accent).toEqual({
      status: "fixed",
      value: "voice_default",
      reason: "Cartesia sonic-3.5 does not support named accent steering.",
    });
  });

  it("does not assume a professional clone supports a model when compatibility metadata is missing", () => {
    const result = resolvePersonaCapabilities(
      { ...selection, ttsProvider: "cartesia", ttsModel: "sonic-3.6", voiceId: "pro", language: "en-US" },
      [{ id: "pro", name: "Pro", source: "account", presentation: "unknown", languages: [], accents: [], isProfessional: true }],
    );
    expect(result.language).toMatchObject({ status: "unknown", reason: expect.stringContaining("Refresh") });
    expect(result.speed.status).toBe("unknown");
  });

  it("offers only Normal for a compatible professional clone and refuses Fast by category", () => {
    const result = resolvePersonaCapabilities(
      { ...selection, ttsProvider: "cartesia", ttsModel: "sonic-3.6", voiceId: "pro", language: "en-US" },
      [{ id: "pro", name: "Pro", source: "account", presentation: "unknown", languages: ["en"], accents: [], isProfessional: true, modelIds: ["sonic-3.6"] }],
    );
    expect(result.speechSpeed).toEqual({
      status: "fixed",
      value: "normal",
      reason: "Cartesia professional clones ignore native speed.",
    });
    expect(personaCapabilityRefusal(result, {
      emotion: "neutral",
      accent: "voice_default",
      speechSpeed: "fast",
      voiceId: "pro",
    })).toBe("controls.speechSpeed: Cartesia professional clones ignore native speed.");
  });
});

describe("Cartesia discovery", () => {
  it("reads all pages and retains owned voices", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "public", name: "Public", access: "public", visibility: "all", gender: "masculine", language: "en", country: "US", accents: [{ accent: "general-american", locale: "en-US", is_native: true }, { accent: "hindi", locale: "hi-IN", is_native: false }] }],
        has_more: true, next_page: "deprecated-cursor",
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "private", name: "Private", access: "private", visibility: "owner", gender: "feminine", language: "es_ES" }],
        has_more: false, next_page: null,
      })));

    const voices = await discoverCartesiaVoices("fixture-key", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toContain("starting_after=public");
    expect(voices).toEqual([
      { id: "public", name: "Public", source: "standard", presentation: "male", languages: ["en-US", "hi-IN"], accents: ["general-american", "hindi"], publiclyAccessible: true },
      { id: "private", name: "Private", source: "account", presentation: "female", languages: ["es-ES"], accents: [] },
    ]);
  });

  it("stops when a later page cannot advance its cursor", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "public", name: "Public", access: "public", visibility: "all" }],
        has_more: true,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], has_more: true })));

    await expect(discoverCartesiaVoices("fixture-key", fetcher)).rejects.toThrow("without a new cursor");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
