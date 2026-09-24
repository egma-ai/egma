import { describe, expect, it, vi } from "vitest";

import {
  discoverCartesiaVoices,
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
  it("uses the documented GPT Live voice catalog", () => {
    expect(OPENAI_LIVE_VOICES.map((voice) => voice.id)).toEqual([
      "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta", "echo", "gleam",
      "marin", "meridian", "quartz", "ripple", "sage", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
    ]);
    expect(resolvePersonaCapabilities({
      mode: "live", liveProvider: "openai", liveModel: "gpt-live-1", language: "en-US",
    }).voices.choices).toEqual(OPENAI_LIVE_VOICES);
  });

  it("exposes only language and voices for legacy OpenAI TTS", () => {
    const result = resolvePersonaCapabilities({ ...selection, ttsModel: "tts-1" });
    expect(Object.keys(result).sort()).toEqual(["language", "voices"]);
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

  it("returns Cartesia language choices without delivery controls", () => {
    const result = resolvePersonaCapabilities(
      { ...selection, ttsProvider: "cartesia", ttsModel: "sonic-3.6", voiceId: "voice-a", language: "en-GB" },
      [{ id: "voice-a", name: "A", source: "account", presentation: "female", languages: ["en-GB"] }],
    );
    expect(result.language).toMatchObject({ status: "supported" });
    expect(result.language.choices).toContain("en");
    expect(result.language.choices).toContain("es");
    expect(Object.keys(result).sort()).toEqual(["language", "voices"]);
  });

  it("does not assume a professional clone supports a model when compatibility metadata is missing", () => {
    const result = resolvePersonaCapabilities(
      { ...selection, ttsProvider: "cartesia", ttsModel: "sonic-3.6", voiceId: "pro", language: "en-US" },
      [{ id: "pro", name: "Pro", source: "account", presentation: "unknown", languages: [], isProfessional: true }],
    );
    expect(result.language).toMatchObject({ status: "unknown", reason: expect.stringContaining("Refresh") });
    expect(Object.keys(result).sort()).toEqual(["language", "voices"]);
  });

  it("refuses a voice outside the resolved catalog", () => {
    const result = resolvePersonaCapabilities(
      { ...selection, ttsProvider: "cartesia", ttsModel: "sonic-3.6", voiceId: "pro", language: "en-US" },
      [{ id: "pro", name: "Pro", source: "account", presentation: "unknown", languages: ["en"], isProfessional: true, modelIds: ["sonic-3.6"] }],
    );
    expect(personaCapabilityRefusal(result, {
      voiceId: "missing",
    })).toBe("models.tts.voiceId: Choose one of the available voices.");
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
      { id: "public", name: "Public", source: "standard", presentation: "male", languages: ["en-US", "hi-IN"], publiclyAccessible: true },
      { id: "private", name: "Private", source: "account", presentation: "female", languages: ["es-ES"] },
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
