/**
 * Phone readiness: a second fact about a platform, never a component of the
 * first.
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
    const readiness = phoneReadiness({
      trunkAddress: null,
      sourceNumber: null,
      speechProvider: null,
    });

    expect(readiness.state).toBe("setup_required");
    expect(readiness.missing).toEqual([
      "the carrier trunk",
      "the source number",
      "the speech provider",
    ]);
  });

  it("is still setup_required with a carrier and no speech, and says which half", () => {
    // Not nearly ready. A carrier with no speech provider places a call nobody
    // can talk on, and charges for it — so half a setup is a refusal, and the
    // refusal has to say which half so somebody can act on it.
    const readiness = phoneReadiness({
      trunkAddress: "egma-simulator-abc.pstn.twilio.com",
      sourceNumber: "+15550100100",
      speechProvider: null,
    });

    expect(readiness.state).toBe("setup_required");
    expect(readiness.missing).toEqual(["the speech provider"]);
    expect(phoneSetupRequiredMessage(readiness)).toContain("the speech provider");
    expect(phoneSetupRequiredMessage(readiness)).toContain("egma self-host phone setup");
    // Said plainly, because a developer reading it is not the person who runs
    // the platform on a hosted deployment and needs to know nothing was spent.
    expect(phoneSetupRequiredMessage(readiness)).toContain("nothing was charged");
  });

  it("is ready once all three are there", () => {
    const readiness = phoneReadiness({
      trunkAddress: "egma-simulator-abc.pstn.twilio.com",
      sourceNumber: "+15550100100",
      speechProvider: "openai",
    });

    expect(readiness.state).toBe("ready");
    expect(readiness.missing).toEqual([]);
  });

  it("reads the three non-secret facts from the environment, and holds no credential", () => {
    const config = loadConfig({
      ...BASE,
      EGMA_PHONE_TRUNK_ADDRESS: "egma-simulator-abc.pstn.twilio.com",
      EGMA_PHONE_SOURCE_NUMBER: "+15550100100",
      EGMA_PHONE_SPEECH_PROVIDER: "openai",
    });

    expect(phoneReadiness(config.phone).state).toBe("ready");
    // Everything the API holds about the carrier, written out, so that a field
    // carrying a credential could not be added without this line changing.
    expect(Object.keys(config.phone).sort()).toEqual([
      "sourceNumber",
      "speechProvider",
      "trunkAddress",
    ]);
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
