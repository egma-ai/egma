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

  it("refuses the exact cross-adapter STT pair that failed in production", () => {
    expect(() =>
      validPersonaModels({
        ...RECOMMENDED_PERSONA_MODELS,
        stt: { provider: "openai", model: "gpt-4o-transcribe" },
      }),
    ).toThrow(/supported openai stt model/i);
  });

  it("treats a missing stored models value as corrupt data, never as fallback", () => {
    expect(() => personaModelsFromRow(null, "prsv_broken")).toThrow(
      /needs repairing/i,
    );
  });
});
