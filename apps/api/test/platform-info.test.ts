import { connect, disconnect } from "@egma/db";
import type { FastifyInstance } from "fastify";
import { expect, it } from "vitest";

import { buildApi } from "../src/server.ts";
import {
  createMigratedDatabase,
  TEST_ENCRYPTION_KEY,
} from "../../../packages/db/test/support/database.ts";
import { testConfig } from "./support/api.ts";

/**
 * The public identity survives the API object that first read it.
 *
 * Both objects use the same real Postgres database. Closing the first object
 * before building the second makes this a restart proof, not two reads from
 * one process-local value.
 */
it("keeps one public platform identity across an API restart", async () => {
  const database = await createMigratedDatabase("platform_info_restart");
  connect({
    databaseUrl: database.url,
    maxConnections: 4,
    encryptionKey: TEST_ENCRYPTION_KEY,
  });
  const config = testConfig({ databaseUrl: database.url });
  let app: FastifyInstance | undefined;

  try {
    app = buildApi({ config }).app;
    await app.ready();
    const first = await app.inject({ method: "GET", url: "/api/platform" });
    expect(first.statusCode).toBe(200);
    const identity = first.json<Record<string, unknown>>();
    expect(Object.keys(identity).sort()).toEqual(["instance_id", "origin"]);
    expect(identity).toEqual({
      instance_id: expect.stringMatching(/^pf_[0-9A-HJKMNP-TV-Z]{26}$/u),
      origin: config.baseUrl,
    });

    await app.close();
    app = buildApi({ config }).app;
    await app.ready();
    const afterRestart = await app.inject({ method: "GET", url: "/api/platform" });

    expect(afterRestart.statusCode).toBe(200);
    expect(afterRestart.json()).toEqual(identity);
    expect(JSON.stringify(identity)).not.toMatch(/secret|token|credential|cloud/iu);
  } finally {
    await app?.close();
    await disconnect();
    await database.drop();
  }
});
