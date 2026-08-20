/** Phone readiness is the carrier-route fact beside platform health. */

import { describe, expect, it } from "vitest";

import { TEST_ENCRYPTION_KEY } from "../../../packages/db/test/support/database.ts";
import { loadConfig } from "../src/config.ts";
import { phoneReadiness, phoneSetupRequiredMessage } from "../src/phone-readiness.ts";

const BASE = {
  DATABASE_URL: "postgres://unused/unused",
  CLICKHOUSE_URL: "http://unused/unused",
  EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
  EGMA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  EGMA_SIMULATOR_SERVICE_TOKEN: "egma_st_held-by-this-test-suite-alone",
} as const;

describe("phone readiness", () => {
  it("names both missing carrier facts", () => {
    const readiness = phoneReadiness({});

    expect(readiness.state).toBe("setup_required");
    expect(readiness.missing).toEqual(["the carrier trunk", "the source number"]);
    expect(phoneSetupRequiredMessage(readiness)).toContain("nothing was charged");
    expect(phoneSetupRequiredMessage(readiness)).toContain("egma self-host setup");
  });

  it("is ready for a complete source-IP route", () => {
    const readiness = phoneReadiness({
      carrier_trunk_address: "egma-simulator-abc.pstn.twilio.com",
      carrier_trunk_number: "+15550100100",
    });

    expect(readiness).toEqual({
      state: "ready",
      missing: [],
      trunkAddress: "egma-simulator-abc.pstn.twilio.com",
      sourceNumber: "+15550100100",
    });
  });

  it("returns no SIP credential from a complete credential route", () => {
    const readiness = phoneReadiness({
      carrier_trunk_address: "egma-simulator-abc.pstn.twilio.com",
      carrier_trunk_number: "+15550100100",
      carrier_trunk_username: "egma-trunk",
      carrier_trunk_password: null,
    });

    expect(readiness.state).toBe("ready");
    expect(Object.keys(readiness).sort()).toEqual([
      "missing",
      "sourceNumber",
      "state",
      "trunkAddress",
    ]);
  });

  it("seeds exactly the carrier route from the environment", () => {
    const config = loadConfig({
      ...BASE,
      EGMA_PHONE_TRUNK_ADDRESS: "egma-simulator-abc.pstn.twilio.com",
      EGMA_PHONE_SOURCE_NUMBER: "+15550100100",
      EGMA_PHONE_TRUNK_USERNAME: "egma-trunk",
      EGMA_PHONE_TRUNK_PASSWORD: "the-carrier-issued-this-one",
    });

    expect(config.platformSettings).toEqual({
      carrier_trunk_address: "egma-simulator-abc.pstn.twilio.com",
      carrier_trunk_number: "+15550100100",
      carrier_trunk_username: "egma-trunk",
      carrier_trunk_password: "the-carrier-issued-this-one",
    });
    expect(Object.keys(config)).not.toContain("phone");
  });

  it("uses an explicit carrier settings source and refuses every other value", () => {
    expect(loadConfig({ ...BASE }).carrierSettingsSource).toBe("platform");
    expect(
      loadConfig({
        ...BASE,
        EGMA_CARRIER_SETTINGS_SOURCE: "platform",
      }).carrierSettingsSource,
    ).toBe("platform");
    expect(
      loadConfig({
        ...BASE,
        EGMA_CARRIER_SETTINGS_SOURCE: "environment",
      }).carrierSettingsSource,
    ).toBe("environment");
    expect(() =>
      loadConfig({
        ...BASE,
        EGMA_CARRIER_SETTINGS_SOURCE: "hosted",
      }),
    ).toThrow(
      "EGMA_CARRIER_SETTINGS_SOURCE must be platform or environment, not hosted",
    );
  });

  it("refuses every partial credential route", () => {
    const complete = {
      EGMA_PHONE_TRUNK_ADDRESS: "egma-simulator-abc.pstn.twilio.com",
      EGMA_PHONE_SOURCE_NUMBER: "+15550100100",
      EGMA_PHONE_TRUNK_USERNAME: "egma-trunk",
      EGMA_PHONE_TRUNK_PASSWORD: "the-carrier-issued-this-one",
    } as const;

    for (const missing of Object.keys(complete) as (keyof typeof complete)[]) {
      const partial: Record<string, string> = { ...complete };
      delete partial[missing];
      expect(() => loadConfig({ ...BASE, ...partial })).toThrow(missing);
    }
  });

  it("accepts the two-value source-IP route", () => {
    expect(
      loadConfig({
        ...BASE,
        EGMA_PHONE_TRUNK_ADDRESS: "carrier.example.com",
        EGMA_PHONE_SOURCE_NUMBER: "+15550100100",
      }).platformSettings,
    ).toEqual({
      carrier_trunk_address: "carrier.example.com",
      carrier_trunk_number: "+15550100100",
    });
  });
});
