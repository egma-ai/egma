import { describe, expect, it, vi } from "vitest";

import {
  discoverCartesiaVoices,
  OPENAI_STANDARD_VOICES,
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
    expect(OPENAI_STANDARD_VOICES.every((voice) => voice.presentation === "unknown")).toBe(true);
  });

  it("fixes instruction-only controls for legacy OpenAI TTS", () => {
    const result = resolvePersonaCapabilities({ ...selection, ttsModel: "tts-1" });
    expect(result.emotion).toMatchObject({ status: "fixed", value: "neutral" });
    expect(result.accent).toMatchObject({ status: "fixed", value: "voice_default" });
    expect(result.speed.range).toEqual({ minimum: 0.6, maximum: 1.5, step: 0.1 });
  });

  it("distinguishes unknown catalog metadata from unsupported models", () => {
    expect(resolvePersonaCapabilities(selection).language.status).toBe("unknown");
    expect(resolvePersonaCapabilities({ ...selection, ttsModel: "missing" }).language.status).toBe("unsupported");
  });

  it("returns Cartesia voice language and accent without locale inference", () => {
    const result = resolvePersonaCapabilities(
      { ...selection, ttsProvider: "cartesia", ttsModel: "sonic-3.5", voiceId: "voice-a" },
      [{ id: "voice-a", name: "A", source: "account", presentation: "female", languages: ["en-GB"], accents: ["GB"] }],
    );
    expect(result.language).toEqual({ status: "supported", choices: ["en-GB"] });
    expect(result.accent).toEqual({ status: "supported", choices: ["voice_default", "GB"] });
    expect(result.speed).toMatchObject({ status: "fixed", value: 1 });
  });
});

describe("Cartesia discovery", () => {
  it("reads all pages and retains owned voices", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "public", name: "Public", is_owner: false, gender: "masculine", language: "en", country: "US" }],
        has_more: true, next_page: "public",
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "private", name: "Private", is_owner: true, gender: "feminine", language: "es_ES" }],
        has_more: false, next_page: null,
      })));

    const voices = await discoverCartesiaVoices("fixture-key", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toContain("starting_after=public");
    expect(voices).toEqual([
      { id: "public", name: "Public", source: "standard", presentation: "male", languages: ["en-US"], accents: ["US"] },
      { id: "private", name: "Private", source: "account", presentation: "female", languages: ["es-ES"], accents: [] },
    ]);
  });
});
