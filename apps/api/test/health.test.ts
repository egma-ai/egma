import { connect, disconnect, runMigrations } from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import {
  createEmptyDatabase,
  type EmptyDatabase,
} from "../../../packages/db/test/support/database.ts";

describe("configuration", () => {
  it("refuses to start without a database to talk to", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required/);
  });

  it("refuses a port that is not a port", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://x/y", PORT: "not-a-port" }),
    ).toThrow(/not a usable port/);
  });

  it("defaults to the port the compose file publishes", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x/y" }).port).toBe(3100);
  });
});

describe("the API once it has booted", () => {
  let database: EmptyDatabase;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    database = await createEmptyDatabase("api_health");
    await runMigrations(database.url);
    connect({ databaseUrl: database.url, maxConnections: 2 });
    app = buildServer();
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
