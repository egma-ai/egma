import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MODEL_ADAPTERS,
  REASONING_EFFORTS,
  catalogEntry,
  type ModelAdapter,
  type ProviderCatalogEntry,
} from "../src/models/catalog.ts";
import {
  RECOMMENDED_PERSONA_MODELS,
  SPEED_RANGE,
  personaModelsFromRow,
  validPersonaModels,
} from "../src/models/selections.ts";

describe("one complete persona model selection", () => {
  it("keeps each catalog job on its own adapter family", () => {
    expect(MODEL_ADAPTERS).toEqual([
      "openai_chat_completions",
      "openai_realtime",
      "deepgram",
      "cartesia_manual",
      "cartesia",
      "openai",
    ]);

    expectTypeOf<ModelAdapter<"llm">>().toEqualTypeOf<
      "openai_chat_completions"
    >();
    expectTypeOf<ModelAdapter<"stt">>().toEqualTypeOf<
      "openai_realtime" | "deepgram" | "cartesia_manual"
    >();
    expectTypeOf<ModelAdapter<"tts">>().toEqualTypeOf<"cartesia" | "openai">();

    const llmEntry: ProviderCatalogEntry<"llm"> = {
      provider: "openai",
      job: "llm",
      model: "type-check-only",
      adapter: "openai_chat_completions",
      label: "OpenAI",
    };
    expect(llmEntry.adapter).toBe("openai_chat_completions");

    const invalidLlmEntry: ProviderCatalogEntry<"llm"> = {
      provider: "openai",
      job: "llm",
      model: "type-check-only",
      // @ts-expect-error TTS adapters cannot be assigned to an LLM entry.
      adapter: "openai",
      label: "OpenAI",
    };
    expect(invalidLlmEntry.adapter).toBe("openai");

    const invalidLlmVoice: ProviderCatalogEntry<"llm"> = {
      provider: "openai",
      job: "llm",
      model: "type-check-only",
      adapter: "openai_chat_completions",
      label: "OpenAI",
      // @ts-expect-error Voice defaults belong only to TTS catalog entries.
      recommendedVoiceId: "alloy",
    };
    expect(invalidLlmVoice).toHaveProperty("recommendedVoiceId", "alloy");

    const invalidSttReasoning: ProviderCatalogEntry<"stt"> = {
      provider: "openai",
      job: "stt",
      model: "type-check-only",
      adapter: "openai_realtime",
      label: "OpenAI",
      // @ts-expect-error Reasoning is an LLM catalog primitive only.
      reasoningEfforts: ["none"],
    };
    expect(invalidSttReasoning).toHaveProperty("reasoningEfforts", ["none"]);
  });

  it("accepts the release selection as one whole value", () => {
    expect(validPersonaModels(RECOMMENDED_PERSONA_MODELS)).toEqual(
      RECOMMENDED_PERSONA_MODELS,
    );
  });

  it.each([SPEED_RANGE.slowest, SPEED_RANGE.fastest])(
    "accepts the shared speaking-speed boundary %s",
    (speed) => {
      expect(
        validPersonaModels({
          ...RECOMMENDED_PERSONA_MODELS,
          tts: { ...RECOMMENDED_PERSONA_MODELS.tts, speed },
        }).tts.speed,
      ).toBe(speed);
    },
  );

  it.each([SPEED_RANGE.slowest - 0.0001, SPEED_RANGE.fastest + 0.0001])(
    "refuses speaking speed %s before a simulation can claim it",
    (speed) => {
      expect(() =>
        validPersonaModels({
          ...RECOMMENDED_PERSONA_MODELS,
          tts: { ...RECOMMENDED_PERSONA_MODELS.tts, speed },
        }),
      ).toThrow(
        `speaking speed must be between ${SPEED_RANGE.slowest} and ${SPEED_RANGE.fastest}`,
      );
    },
  );

  it.each([
    "gpt-live-transcribe",
    "gpt-realtime-whisper",
    "gpt-4o-transcribe",
    "gpt-4o-mini-transcribe",
  ])("accepts OpenAI realtime transcription model %s", (model) => {
    expect(
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        stt: { provider: "openai", model },
      }).stt,
    ).toEqual({ provider: "openai", model });

    expect(() =>
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        stt: { provider: "deepgram", model },
      }),
    ).toThrow(/supported deepgram stt model/i);
  });

  it.each([
    ["deepgram", "nova-3-general"],
    ["cartesia", "ink-2"],
  ])("accepts the %s STT model %s", (provider, model) => {
    expect(
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        stt: { provider, model },
      }).stt,
    ).toEqual({ provider, model });
  });

  it("refuses arbitrary model text even for a known provider", () => {
    expect(() =>
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        llm: { provider: "openai", model: "made-up-model" },
      }),
    ).toThrow(/supported openai llm model/i);
  });

  it("catalogs Terra, its adapter, and every reasoning effort as one capability", () => {
    expect(REASONING_EFFORTS).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(catalogEntry("llm", "openai", "gpt-5.6-terra")).toMatchObject({
      adapter: "openai_chat_completions",
      reasoningEfforts: REASONING_EFFORTS,
      recommendedReasoningEffort: "none",
    });
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-luna"])(
    "catalogs %s with the complete GPT-5.6 reasoning range",
    (model) => {
      expect(catalogEntry("llm", "openai", model)).toMatchObject({
        adapter: "openai_chat_completions",
        reasoningEfforts: REASONING_EFFORTS,
        recommendedReasoningEffort: "none",
      });
    },
  );

  it.each(["gpt-5.5", "gpt-5.4"])(
    "catalogs %s without an unsupported max effort",
    (model) => {
      expect(catalogEntry("llm", "openai", model)).toMatchObject({
        adapter: "openai_chat_completions",
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
        recommendedReasoningEffort: "none",
      });
    },
  );

  it("accepts a cataloged reasoning choice as part of the LLM selection", () => {
    const selected = validPersonaModels({
      ...RECOMMENDED_PERSONA_MODELS,
      llm: {
        provider: "openai",
        model: "gpt-5.6-terra",
        reasoningEffort: "none",
      },
    });

    expect(selected.llm).toEqual({
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoningEffort: "none",
    });
  });

  it("requires a reasoning choice for a model whose catalog entry supports it", () => {
    expect(() =>
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        llm: { provider: "openai", model: "gpt-5.6-terra" },
      }),
    ).toThrow(/reasoning effort/i);
  });

  it("refuses reasoning on a model whose catalog entry does not support it", () => {
    expect(() =>
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        llm: {
          ...RECOMMENDED_PERSONA_MODELS.llm,
          reasoningEffort: "none",
        },
      }),
    ).toThrow(/does not accept a reasoning effort/i);
  });

  it("treats a missing stored models value as corrupt data, never as fallback", () => {
    expect(() => personaModelsFromRow(null, "prsv_broken")).toThrow(
      /needs repairing/i,
    );
  });
});
