/**
 * Phone readiness: a second fact about a platform, never a component of the
 * first.
 *
 * Read from the platform's own store now, rather than from this container's
 * environment. That is the whole recoverability of it: the facts survive a
 * restart, a rebuild and a move to another machine, and an operator who
 * supplies a missing one is ready on the next request with nothing restarted.
 *
 * A deployment with no carrier runs text and chat simulations perfectly well.
 * Folding that into one `ready` would either call a working platform broken or
 * call a platform that cannot dial ready — and the first makes the first-run
 * story impossible to tell while the second charges somebody for a call that
 * was never going to connect.
 *
 * So the two are separate, and this file holds the separation and the honesty:
 * the state is `setup_required` until a carrier and a speech provider are both
 * there, it names what is missing rather than leaving a person to guess, and
 * nothing in the answer is a secret — this is the one door on the API that asks
 * for no credential at all.
 */

import { describe, expect, it } from "vitest";

import { phoneReadiness, phoneSetupRequiredMessage } from "../src/phone-readiness.ts";
import { loadConfig } from "../src/config.ts";
import { TEST_ENCRYPTION_KEY } from "../../../packages/db/test/support/database.ts";

const BASE = {
  DATABASE_URL: "postgres://unused/unused",
  CLICKHOUSE_URL: "http://unused/unused",
  EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
  EGMA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  EGMA_SIMULATOR_SERVICE_TOKEN: "egma_st_held-by-this-test-suite-alone",
} as const;

describe("phone readiness", () => {
  it("is setup_required on a platform nobody has given a carrier, and names all three", () => {
    const readiness = phoneReadiness({});

    expect(readiness.state).toBe("setup_required");
    expect(readiness.missing).toEqual([
      "the carrier trunk",
      "the source number",
      "the text-to-speech provider",
    ]);
  });

  it("is still setup_required with a carrier and no speech, and says which half", () => {
    // Not nearly ready. A carrier with no speech provider places a call nobody
    // can talk on, and charges for it — so half a setup is a refusal, and the
    // refusal has to say which half so somebody can act on it.
    const readiness = phoneReadiness({
      carrier_trunk_address: "egma-simulator-abc.pstn.twilio.com",
      carrier_trunk_number: "+15550100100",
    });

    expect(readiness.state).toBe("setup_required");
    expect(readiness.missing).toEqual(["the text-to-speech provider"]);
    expect(phoneSetupRequiredMessage(readiness)).toContain(
      "the text-to-speech provider",
    );
    expect(phoneSetupRequiredMessage(readiness)).toContain("egma self-host phone setup");
    // Said plainly, because a developer reading it is not the person who runs
    // the platform on a hosted deployment and needs to know nothing was spent.
    expect(phoneSetupRequiredMessage(readiness)).toContain("nothing was charged");
  });

  it("is ready once all three are there", () => {
    const readiness = phoneReadiness({
      carrier_trunk_address: "egma-simulator-abc.pstn.twilio.com",
      carrier_trunk_number: "+15550100100",
      text_to_speech_provider: "openai",
    });

    expect(readiness.state).toBe("ready");
    expect(readiness.missing).toEqual([]);
    expect(readiness.trunkAddress).toBe("egma-simulator-abc.pstn.twilio.com");
    expect(readiness.sourceNumber).toBe("+15550100100");
    expect(readiness.speechProvider).toBe("openai");
  });

  it("answers from what a secret-free view of the store can say, and no more", () => {
    // `platformFacts` is the only thing this reads, and it answers `null` for
    // every setting the catalog marks secret. So a carrier that is fully
    // configured — trunk password and all — still reports itself missing
    // nothing more than these three, and there is no argument by which a key
    // could reach this answer.
    const readiness = phoneReadiness({
      carrier_trunk_address: "egma-simulator-abc.pstn.twilio.com",
      carrier_trunk_number: "+15550100100",
      carrier_trunk_username: "egma-trunk",
      carrier_trunk_password: null,
      text_to_speech_provider: "openai",
      text_to_speech_key: null,
    });

    expect(readiness.state).toBe("ready");
    expect(JSON.stringify(readiness)).not.toContain("null,");
    expect(Object.keys(readiness).sort()).toEqual([
      "missing",
      "sourceNumber",
      "speechProvider",
      "state",
      "trunkAddress",
    ]);
  });

  it("seeds the carrier out of the environment, and never holds it after", () => {
    // The variables phone setup already wrote, read once at start as settings
    // to seed rather than as this process's own configuration. What the API
    // then holds about the carrier is nothing at all: the store holds it.
    const config = loadConfig({
      ...BASE,
      EGMA_PHONE_TRUNK_ADDRESS: "egma-simulator-abc.pstn.twilio.com",
      EGMA_PHONE_SOURCE_NUMBER: "+15550100100",
      EGMA_PHONE_TRUNK_USERNAME: "egma-trunk",
      EGMA_PHONE_TRUNK_PASSWORD: "the-carrier-issued-this-one",
      EGMA_PERSONA_TTS_PROVIDER: "openai",
    });

    expect(config.platformSettings).toEqual({
      carrier_trunk_address: "egma-simulator-abc.pstn.twilio.com",
      carrier_trunk_number: "+15550100100",
      carrier_trunk_username: "egma-trunk",
      carrier_trunk_password: "the-carrier-issued-this-one",
      text_to_speech_provider: "openai",
    });
    expect(Object.keys(config)).not.toContain("phone");
  });
});

describe("the platform's default judge", () => {
  it("is absent when nothing configured one, and grading says so rather than passing", () => {
    expect(loadConfig({ ...BASE }).defaultJudge).toBeUndefined();
  });

  it("is all three or none, and refuses to start on half", () => {
    // A model with no key is a judge that errors every verdict it is given, one
    // run at a time, and a key with no model names nothing to ask. Neither is
    // worth discovering after a suite has run.
    expect(() =>
      loadConfig({ ...BASE, EGMA_JUDGE_PROVIDER: "openai", EGMA_JUDGE_MODEL: "gpt-4o" }),
    ).toThrow(/EGMA_JUDGE_API_KEY/u);

    expect(() => loadConfig({ ...BASE, EGMA_JUDGE_API_KEY: "sk-whatever" })).toThrow(
      /EGMA_JUDGE_PROVIDER and EGMA_JUDGE_MODEL/u,
    );
  });

  it("is read whole when all three are there", () => {
    const config = loadConfig({
      ...BASE,
      EGMA_JUDGE_PROVIDER: "openai",
      EGMA_JUDGE_MODEL: "gpt-4o",
      EGMA_JUDGE_API_KEY: "sk-only-this-test-holds-this",
    });

    expect(config.defaultJudge).toEqual({
      provider: "openai",
      model: "gpt-4o",
      key: "sk-only-this-test-holds-this",
    });
  });
});
