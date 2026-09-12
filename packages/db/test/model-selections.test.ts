import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MODEL_ADAPTERS,
  catalogEntry,
  type ModelAdapter,
  type ProviderCatalogEntry,
} from "../src/models/catalog.ts";
import {
  RECOMMENDED_GRADER_MODEL,
  RECOMMENDED_PERSONA_MODELS,
  PERSONA_AUTHORING_SPEED_RANGE,
  personaModelsFromRow,
  providersNeededBy,
  validGraderModel,
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
      "openai_live",
    ]);

    expectTypeOf<ModelAdapter<"llm">>().toEqualTypeOf<
      "openai_chat_completions"
    >();
    expectTypeOf<ModelAdapter<"stt">>().toEqualTypeOf<
      "openai_realtime" | "deepgram" | "cartesia_manual"
    >();
    expectTypeOf<ModelAdapter<"tts">>().toEqualTypeOf<"cartesia" | "openai">();
    expectTypeOf<ModelAdapter<"live">>().toEqualTypeOf<"openai_live">();

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
      reasoningEffort: "none",
    };
    expect(invalidSttReasoning).toHaveProperty(
      "reasoningEffort",
      "none",
    );
  });

  it("accepts the release selection as one whole value", () => {
    expect(validPersonaModels(RECOMMENDED_PERSONA_MODELS)).toEqual(
      RECOMMENDED_PERSONA_MODELS,
    );
  });

  it("accepts GPT Live without inactive speech selections", () => {
    const live = validPersonaModels({
      mode: "live",
      llm: RECOMMENDED_PERSONA_MODELS.llm,
      live: {
        provider: "openai",
        model: "gpt-live-1",
        adapter: "openai_live",
        voiceId: "coral",
      },
    });

    expect(live).toEqual({
      mode: "live",
      llm: RECOMMENDED_PERSONA_MODELS.llm,
      live: {
        provider: "openai",
        model: "gpt-live-1",
        adapter: "openai_live",
        voiceId: "coral",
      },
    });
    expect(providersNeededBy(live, "chat")).toEqual(["openai"]);
    expect(providersNeededBy(live, "voice")).toEqual(["openai"]);
  });

  it("refuses inactive or invented GPT Live fields", () => {
    expect(() => validPersonaModels({
      mode: "live",
      llm: RECOMMENDED_PERSONA_MODELS.llm,
      live: { provider: "openai", model: "gpt-live-1", adapter: "openai_live", voiceId: "coral" },
      stt: RECOMMENDED_PERSONA_MODELS.stt,
    })).toThrow(/unsupported fields stt/i);
    expect(() => validPersonaModels({
      mode: "live",
      llm: RECOMMENDED_PERSONA_MODELS.llm,
      live: { provider: "openai", model: "gpt-live-1", adapter: "openai_realtime", voiceId: "coral" },
    })).toThrow(/catalog adapter/i);
  });

  it.each([
    PERSONA_AUTHORING_SPEED_RANGE.slowest,
    PERSONA_AUTHORING_SPEED_RANGE.fastest,
  ])(
    "accepts the broad authoring speed boundary %s before provider resolution",
    (speed) => {
      expect(
        validPersonaModels({
          ...RECOMMENDED_PERSONA_MODELS,
          tts: { ...RECOMMENDED_PERSONA_MODELS.tts, speed },
        }),
      ).toMatchObject({ tts: { speed } });
    },
  );

  it.each([
    PERSONA_AUTHORING_SPEED_RANGE.slowest - 0.0001,
    PERSONA_AUTHORING_SPEED_RANGE.fastest + 0.0001,
  ])(
    "refuses speaking speed %s before a simulation can claim it",
    (speed) => {
      expect(() =>
        validPersonaModels({
          ...RECOMMENDED_PERSONA_MODELS,
          tts: { ...RECOMMENDED_PERSONA_MODELS.tts, speed },
        }),
      ).toThrow(
        `speaking speed must be between ${PERSONA_AUTHORING_SPEED_RANGE.slowest} and ${PERSONA_AUTHORING_SPEED_RANGE.fastest}`,
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
      }),
    ).toMatchObject({ stt: { provider: "openai", model } });

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
      }),
    ).toMatchObject({ stt: { provider, model } });
  });

  it.each(["sonic-3.6", "sonic-3.6-2026-08-27"])(
    "accepts the stable Cartesia TTS model %s",
    (model) => {
      expect(catalogEntry("tts", "cartesia", model)).toMatchObject({
        adapter: "cartesia",
        recommendedVoiceId: "47c38ca4-5f35-497b-b1a3-415245fb35e1",
        recommendedSpeed: 1,
      });
    },
  );

  it("refuses arbitrary model text even for a known provider", () => {
    expect(() =>
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        llm: { provider: "openai", model: "made-up-model" },
      }),
    ).toThrow(/supported openai llm model/i);
  });

  it.each([
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
  ])(
    "fixes %s at no reasoning",
    (model) => {
      expect(catalogEntry("llm", "openai", model)).toMatchObject({
        adapter: "openai_chat_completions",
        reasoningEffort: "none",
      });
    },
  );

  it.each(["gpt-4o-mini", "gpt-4o"])(
    "keeps reasoning absent for non-reasoning model %s",
    (model) => {
      const entry = catalogEntry("llm", "openai", model);
      expect(entry).toMatchObject({ adapter: "openai_chat_completions" });
      expect(entry).not.toHaveProperty("reasoningEffort");
    },
  );

  it("uses Terra for new graders while old frozen grader models stay readable", () => {
    expect(RECOMMENDED_GRADER_MODEL).toEqual({
      provider: "openai",
      model: "gpt-5.6-terra",
    });
    expect(
      validGraderModel({ provider: "openai", model: "gpt-4o-mini" }),
    ).toEqual({ provider: "openai", model: "gpt-4o-mini" });
    expect(
      validGraderModel({ provider: "openai", model: "gpt-5.6-terra" }),
    ).toEqual({ provider: "openai", model: "gpt-5.6-terra" });
    expect(() =>
      validGraderModel({ provider: "openai", model: "gpt-4o" }),
    ).toThrow(/supported grader model/i);
  });

  it("stores only the model pair when an author selects a GPT-5 model", () => {
    expect(
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        llm: { provider: "openai", model: "gpt-5.6-terra" },
      }).llm,
    ).toEqual({
      provider: "openai",
      model: "gpt-5.6-terra",
    });
  });

  it.each(["none", "low", "medium", "high", "xhigh", "max"] as const)(
    "refuses the persona reasoning field value %s",
    (reasoningEffort) => {
      expect(() =>
        validPersonaModels({
          ...RECOMMENDED_PERSONA_MODELS,
          llm: {
            provider: "openai",
            model: "gpt-5.6-terra",
            reasoningEffort,
          },
        }),
      ).toThrow(/unsupported fields reasoningEffort/i);
    },
  );

  it("treats a missing stored models value as corrupt data, never as fallback", () => {
    expect(() => personaModelsFromRow(null, "prsv_broken")).toThrow(
      /needs repairing/i,
    );
  });
});
