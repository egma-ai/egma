import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";

const ENOUGH = {
  DATABASE_URL: "postgres://egma:egma@localhost:5432/egma",
  CLICKHOUSE_URL: "http://default:egma@localhost:8123/egma",
  EGMA_AUTH_SECRET: "test-auth-secret",
  EGMA_ENCRYPTION_KEY: "00".repeat(32),
  EGMA_SIMULATOR_SERVICE_TOKEN: "egma_st_test-service-token",
  EGMA_INGEST_ENDPOINT: "http://minio.example:9000",
  EGMA_INGEST_ACCESS_KEY_ID: "ingestion-access-key",
  EGMA_INGEST_SECRET_ACCESS_KEY: "ingestion-secret-key",
} as const;

describe("provider credential configuration", () => {
  it("uses one explicit self-host key per provider account", async () => {
    const config = loadConfig({
      ...ENOUGH,
      EGMA_OPENAI_API_KEY: " openai-self-host ",
      EGMA_DEEPGRAM_API_KEY: "deepgram-self-host",
      EGMA_CARTESIA_API_KEY: "cartesia-self-host",
      // Used by other AWS clients on some self-hosts. It must not select the
      // cloud credential source by accident.
      AWS_REGION: "eu-west-1",
    });

    await expect(config.providerCredentials.load()).resolves.toEqual({
      openai: "openai-self-host",
      deepgram: "deepgram-self-host",
      cartesia: "cartesia-self-host",
    });
  });

  it("requires the cloud secret id and region as one configuration", () => {
    expect(() =>
      loadConfig({
        ...ENOUGH,
        EGMA_PROVIDER_CREDENTIALS_SECRET_ID: "egma/providers",
      }),
    ).toThrow("EGMA_PROVIDER_CREDENTIALS_REGION");
    expect(() =>
      loadConfig({
        ...ENOUGH,
        EGMA_PROVIDER_CREDENTIALS_REGION: "us-west-2",
      }),
    ).toThrow("EGMA_PROVIDER_CREDENTIALS_SECRET_ID");
    expect(() =>
      loadConfig({
        ...ENOUGH,
        EGMA_PROVIDER_CREDENTIALS_SECRET_ID: "egma/providers",
        EGMA_PROVIDER_CREDENTIALS_REGION: "us-west-2",
      }),
    ).not.toThrow();
  });
});
