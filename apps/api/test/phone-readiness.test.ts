/** Phone readiness is the deployment carrier-route fact beside platform health. */

import { describe, expect, it } from "vitest";

import { TEST_ENCRYPTION_KEY } from "../../../packages/db/test/support/database.ts";
import {
  loadConfig,
  CARRIER_ROUTE_ENVIRONMENT,
  type CarrierRoute,
} from "../src/config.ts";
import {
  phoneReadiness,
  phoneSetupRequiredMessage,
} from "../src/phone-readiness.ts";

const BASE = {
  DATABASE_URL: "postgres://unused/unused",
  CLICKHOUSE_URL: "http://unused/unused",
  EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
  EGMA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  EGMA_SIMULATOR_SERVICE_TOKEN: "egma_st_held-by-this-test-suite-alone",
  EGMA_INGEST_ENDPOINT: "http://minio.example:9000",
  EGMA_INGEST_ACCESS_KEY_ID: "ingestion-access-key",
  EGMA_INGEST_SECRET_ACCESS_KEY: "ingestion-secret-key",
} as const;

const CARRIER_ENVIRONMENT = {
  EGMA_PHONE_TRUNK_ADDRESS: "egma-simulator-abc.pstn.twilio.com",
  EGMA_PHONE_SOURCE_NUMBER: "+15550100100",
  EGMA_PHONE_TRUNK_USERNAME: "egma-trunk",
  EGMA_PHONE_TRUNK_PASSWORD: "the-carrier-issued-this-one",
} as const;

const CARRIER: CarrierRoute = {
  trunkAddress: CARRIER_ENVIRONMENT.EGMA_PHONE_TRUNK_ADDRESS,
  sourceNumber: CARRIER_ENVIRONMENT.EGMA_PHONE_SOURCE_NUMBER,
  trunkUsername: CARRIER_ENVIRONMENT.EGMA_PHONE_TRUNK_USERNAME,
  trunkPassword: CARRIER_ENVIRONMENT.EGMA_PHONE_TRUNK_PASSWORD,
};

describe("phone readiness", () => {
  it("names all four missing carrier values", () => {
    const readiness = phoneReadiness(undefined);
    const message = phoneSetupRequiredMessage(readiness);

    expect(readiness).toEqual({
      state: "setup_required",
      missing: CARRIER_ROUTE_ENVIRONMENT.map(({ label }) => label),
      trunkAddress: null,
      sourceNumber: null,
    });
    for (const { variable } of CARRIER_ROUTE_ENVIRONMENT) {
      expect(message).toContain(variable);
    }
    expect(message).toContain("nothing was charged");
    expect(message).toContain("deployment operator");
    expect(message).toContain("restart the API");
    expect(message).not.toContain("workspace's .env file");
    expect(message).not.toContain("egma self-host up");
    expect(message).not.toContain("self-host setup");
  });

  it("reports a complete deployment carrier without returning its credential", () => {
    const readiness = phoneReadiness(CARRIER);

    expect(readiness).toEqual({
      state: "ready",
      missing: [],
      trunkAddress: "egma-simulator-abc.pstn.twilio.com",
      sourceNumber: "+15550100100",
    });
    expect(Object.keys(readiness).sort()).toEqual([
      "missing",
      "sourceNumber",
      "state",
      "trunkAddress",
    ]);
  });

  it("reads the complete carrier route from ordinary environment variables", () => {
    expect(
      loadConfig({
        ...BASE,
        ...CARRIER_ENVIRONMENT,
      }).carrierRoute,
    ).toEqual(CARRIER);
    expect(loadConfig({ ...BASE }).carrierRoute).toBeUndefined();
  });

  it("refuses every partial carrier route", () => {
    for (const missing of Object.keys(
      CARRIER_ENVIRONMENT,
    ) as (keyof typeof CARRIER_ENVIRONMENT)[]) {
      const partial: Record<string, string> = { ...CARRIER_ENVIRONMENT };
      delete partial[missing];
      expect(() => loadConfig({ ...BASE, ...partial })).toThrow(missing);
    }
  });

  it("refuses address and number without the SIP credential pair", () => {
    expect(() =>
      loadConfig({
        ...BASE,
        EGMA_PHONE_TRUNK_ADDRESS: "carrier.example.com",
        EGMA_PHONE_SOURCE_NUMBER: "+15550100100",
      }),
    ).toThrow(/EGMA_PHONE_TRUNK_USERNAME.*EGMA_PHONE_TRUNK_PASSWORD/iu);
  });

  it("refuses malformed carrier routing values", () => {
    expect(() =>
      loadConfig({
        ...BASE,
        ...CARRIER_ENVIRONMENT,
        EGMA_PHONE_TRUNK_ADDRESS: "https://carrier.example.com/a/path",
      }),
    ).toThrow(/EGMA_PHONE_TRUNK_ADDRESS.*SIP hostname/iu);

    expect(() =>
      loadConfig({
        ...BASE,
        ...CARRIER_ENVIRONMENT,
        EGMA_PHONE_SOURCE_NUMBER: "555-0100",
      }),
    ).toThrow(/EGMA_PHONE_SOURCE_NUMBER.*E\.164/iu);

  });

  it("treats the carrier-issued SIP username and password as opaque", () => {
    expect(
      loadConfig({
        ...BASE,
        ...CARRIER_ENVIRONMENT,
        EGMA_PHONE_TRUNK_USERNAME: "carrier-defined-username",
        EGMA_PHONE_TRUNK_PASSWORD: "$x",
      }).carrierRoute,
    ).toMatchObject({
      trunkUsername: "carrier-defined-username",
      trunkPassword: "$x",
    });
  });
});
