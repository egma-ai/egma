import { describe, expect, it } from "vitest";

import {
  RECOMMENDED_PERSONA_MODELS,
  personaModelsFromRow,
  validPersonaModels,
} from "../src/models/selections.ts";

describe("one complete persona model selection", () => {
  it("accepts the release selection as one whole value", () => {
    expect(validPersonaModels(RECOMMENDED_PERSONA_MODELS)).toEqual(
      RECOMMENDED_PERSONA_MODELS,
    );
  });

  it.each([0.6, 1.5])(
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

  it.each([0.5999, 1.5001])(
    "refuses speaking speed %s before a simulation can claim it",
    (speed) => {
      expect(() =>
        validPersonaModels({
          ...RECOMMENDED_PERSONA_MODELS,
          tts: { ...RECOMMENDED_PERSONA_MODELS.tts, speed },
        }),
      ).toThrow("speaking speed must be between 0.6 and 1.5");
    },
  );

  it("refuses the exact cross-adapter STT pair that failed in production", () => {
    expect(() =>
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        stt: { provider: "openai", model: "gpt-4o-transcribe" },
      }),
    ).toThrow(/supported openai stt model/i);
  });

  it("accepts OpenAI realtime transcription only as its exact adapter pair", () => {
    expect(
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        stt: { provider: "openai", model: "gpt-live-transcribe" },
      }).stt,
    ).toEqual({ provider: "openai", model: "gpt-live-transcribe" });

    expect(() =>
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        stt: { provider: "deepgram", model: "gpt-live-transcribe" },
      }),
    ).toThrow(/supported deepgram stt model/i);
  });

  it("refuses arbitrary model text even for a known provider", () => {
    expect(() =>
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        llm: { provider: "openai", model: "made-up-model" },
      }),
    ).toThrow(/supported openai llm model/i);
  });

  it("treats a missing stored models value as corrupt data, never as fallback", () => {
    expect(() => personaModelsFromRow(null, "prsv_broken")).toThrow(
      /needs repairing/i,
    );
  });
});
