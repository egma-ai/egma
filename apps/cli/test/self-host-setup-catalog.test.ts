/**
 * The interview's list of settings, held against the platform's own catalog.
 *
 * **These two have to agree and cannot import each other.** The catalog lives
 * in the database package; this CLI is a published npm package and must not
 * carry a Postgres client into somebody's repository, so `SETUP_INPUTS` is
 * written out by hand and this file is what keeps it honest. The import here is
 * a test-time one, which is the arrangement the pull/push checks already use.
 *
 * What a drift would cost, in the order it would hurt:
 *
 * 1. **A setting the catalog requires and the interview never asks for** leaves
 *    an operator who followed the whole documented setup still reading `setup
 *    required`, with nothing sensible to type. That is this effort's own
 *    failure — a platform that looks configured and is not — wearing the
 *    opposite face, and it is the agreement ticket 03 asked to keep: readiness
 *    waits only for what setup writes.
 * 2. **A setting the interview asks for that the catalog does not hold** is a
 *    question whose answer the platform refuses by name.
 * 3. **A secret the interview thinks is not one** is a provider key echoed on
 *    somebody's screen and left in their scrollback.
 */

import { PLATFORM_SETTINGS } from "@egma/db";
import { describe, expect, it } from "vitest";

import { SETUP_INPUTS } from "../src/self-host/settings.ts";

describe("what setup asks for", () => {
  it("names every setting the platform holds, and no others", () => {
    expect(Object.keys(SETUP_INPUTS)).toEqual(
      PLATFORM_SETTINGS.map((setting) => setting.name),
    );
  });

  it("agrees with the catalog about which settings are required", () => {
    const required = (name: string): boolean =>
      SETUP_INPUTS[name as keyof typeof SETUP_INPUTS].required;

    expect(
      PLATFORM_SETTINGS.filter((setting) => setting.required).map(
        (setting) => setting.name,
      ),
    ).toEqual(
      PLATFORM_SETTINGS.filter((setting) => required(setting.name)).map(
        (setting) => setting.name,
      ),
    );
  });

  it("agrees with the catalog about which settings are secret", () => {
    for (const setting of PLATFORM_SETTINGS) {
      const input = SETUP_INPUTS[setting.name as keyof typeof SETUP_INPUTS];
      if (input.supply !== "asked") continue;
      expect(input.secret, `${setting.name} is asked for`).toBe(setting.secret);
    }
  });

  it("supplies every required setting, by asking or from the carrier", () => {
    // The whole agreement in one line. A required setting with no way in is a
    // platform that can never report ready.
    for (const setting of PLATFORM_SETTINGS) {
      if (!setting.required) continue;
      const input = SETUP_INPUTS[setting.name as keyof typeof SETUP_INPUTS];
      expect(
        input.supply === "asked" || input.supply === "carrier",
        `${setting.name} has no way in`,
      ).toBe(true);
    }
  });

  it("takes every answer from the variable the platform seeds it from", () => {
    // One word for one setting, whichever of the two ways in an operator uses.
    // The names are the API's, read off `.env.example` rather than guessed:
    // a script already exporting them drives the interview with no second
    // vocabulary to learn.
    expect(
      Object.fromEntries(
        Object.entries(SETUP_INPUTS)
          .filter(([, input]) => input.supply === "asked")
          .map(([name, input]) => [
            name,
            (input as { readonly variable: string }).variable,
          ]),
      ),
    ).toEqual({
      persona_model_provider: "EGMA_PERSONA_MODEL_PROVIDER",
      persona_model: "EGMA_PERSONA_MODEL",
      persona_model_key: "EGMA_PERSONA_MODEL_API_KEY",
      speech_to_text_provider: "EGMA_PERSONA_STT_PROVIDER",
      speech_to_text_key: "EGMA_PERSONA_STT_API_KEY",
      text_to_speech_provider: "EGMA_PERSONA_TTS_PROVIDER",
      text_to_speech_key: "EGMA_PERSONA_TTS_API_KEY",
      text_to_speech_model: "EGMA_PERSONA_TTS_MODEL",
      text_to_speech_voice: "EGMA_PERSONA_TTS_VOICE",
      voice_activity_provider: "EGMA_PERSONA_VAD_PROVIDER",
      media_backend: "EGMA_MEDIA_BACKEND",
    });
  });

  it("never suggests a value for a secret", () => {
    // A default provider name is a convenience. A default key would be a
    // credential written into a public repository, which is the exact class of
    // mistake the media-server credential was.
    for (const input of Object.values(SETUP_INPUTS)) {
      if (input.supply !== "asked" || !input.secret) continue;
      expect(input.suggested).toBeNull();
    }
  });
});
