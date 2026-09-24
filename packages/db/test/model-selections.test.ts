import { describe, expect, it } from "vitest";

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

  it("refuses arbitrary model text even for a known provider", () => {
    expect(() =>
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        llm: { provider: "openai", model: "made-up-model" },
      }),
    ).toThrow(/supported openai llm model/i);
  });

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

  it.each(["none"] as const)(
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
