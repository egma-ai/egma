import { connect, disconnect, runMigrations } from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import { buildApi } from "../src/server.ts";
import { testConfig } from "./support/api.ts";
import {
  createEmptyDatabase,
  type EmptyDatabase,
} from "../../../packages/db/test/support/database.ts";

/** The least an environment can carry and still be startable. */
const enough = {
  DATABASE_URL: "postgres://x/y",
  EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
};

describe("configuration", () => {
  it("refuses to start without a database to talk to", () => {
    expect(() => loadConfig({ EGMA_AUTH_SECRET: "s" })).toThrow(
      /DATABASE_URL is required/,
    );
  });

  it("refuses to start without a secret to sign sessions with", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://x/y" })).toThrow(
      /EGMA_AUTH_SECRET is required/,
    );
  });

  it("refuses a port that is not a port", () => {
    expect(() => loadConfig({ ...enough, PORT: "not-a-port" })).toThrow(
      /not a usable port/,
    );
  });

  it("refuses a base URL that is not a URL", () => {
    expect(() => loadConfig({ ...enough, EGMA_BASE_URL: "not a url" })).toThrow(
      /not a URL/,
    );
  });

  it("defaults to the port the compose file publishes", () => {
    expect(loadConfig(enough).port).toBe(3100);
  });

  it("serves the pages from the instance's own origin, and no egma-run one", () => {
    expect(loadConfig(enough).baseUrl).toBe("http://localhost:3101");
    expect(
      loadConfig({ ...enough, EGMA_BASE_URL: "https://egma.acme.example/" })
        .baseUrl,
    ).toBe("https://egma.acme.example");
  });

  it("holds one organization by default, because the default deployment is somebody's own", () => {
    expect(loadConfig(enough).singleOrganization).toBe(true);
    expect(
      loadConfig({ ...enough, EGMA_SINGLE_ORGANIZATION: "false" })
        .singleOrganization,
    ).toBe(false);
  });

  it("believes no proxy until it is told there is one", () => {
    expect(loadConfig(enough).trustProxy).toBe(false);
    expect(loadConfig({ ...enough, EGMA_TRUST_PROXY: "yes" }).trustProxy).toBe(
      true,
    );
  });

  it("refuses a yes-or-no setting that is neither", () => {
    expect(() =>
      loadConfig({ ...enough, EGMA_SINGLE_ORGANIZATION: "perhaps" }),
    ).toThrow(/not a yes or a no/);
  });
});

describe("the API once it has booted", () => {
  let database: EmptyDatabase;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = await createEmptyDatabase("api_health");
    await runMigrations(database.url);
    connect({ databaseUrl: database.url, maxConnections: 2 });
    app = buildApi({ config: testConfig({ databaseUrl: database.url }) }).app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await disconnect();
    await database.drop();
  });

  it("reports healthy, having reached Postgres", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", postgres: "reachable" });
  });
});
