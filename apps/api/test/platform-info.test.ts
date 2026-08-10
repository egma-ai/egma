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

/**
 * The route is public and unauthenticated, so an insert on every request is an
 * open invitation: a conflicting speculative insert still writes a tuple, an
 * index entry and a log record before discarding them, and anybody who can
 * reach the platform could grow dead rows on this table for nothing.
 *
 * Both halves of the fix are proved the same way — by making the write
 * impossible and by making the read impossible, and asking anyway.
 */
it("reads its identity rather than writing on every public request", async () => {
  const database = await createMigratedDatabase("platform_info_read_only");
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
    const minted = (
      await app.inject({ method: "GET", url: "/api/platform" })
    ).json<{ instance_id: string }>();
    expect(minted.instance_id).toMatch(/^pf_[0-9A-HJKMNP-TV-Z]{26}$/u);

    // Every later request on this process answers from what it already knows.
    // With the row gone, an answer can only have come from memory — so this
    // proves the requests after the first touch the table neither way.
    await database.sql("delete from platform_instance");
    for (let asked = 0; asked < 5; asked += 1) {
      const again = await app.inject({ method: "GET", url: "/api/platform" });
      expect(again.json()).toEqual({ instance_id: minted.instance_id, origin: config.baseUrl });
    }
    expect(
      (await database.sql<{ count: string }>("select count(*) from platform_instance")).rows,
    ).toEqual([{ count: "0" }]);

    // And a process that has to go and look reads before it writes. The guard
    // fires on a speculative insert too: a BEFORE INSERT trigger runs before
    // Postgres discovers the conflict, so an insert-first implementation would
    // fail this request instead of answering it.
    await app.close();
    await disconnect();
    await database.sql(
      "insert into platform_instance (singleton, id) values (true, $1)",
      [minted.instance_id],
    );
    await database.sql(`
      create function refuse_any_insert() returns trigger language plpgsql as $$
      begin raise exception 'platform_instance was written to on a public read'; end $$;
      create trigger no_write_on_read before insert on platform_instance
        for each row execute function refuse_any_insert();
    `);

    connect({
      databaseUrl: database.url,
      maxConnections: 4,
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    app = buildApi({ config }).app;
    await app.ready();
    const cold = await app.inject({ method: "GET", url: "/api/platform" });

    expect(cold.statusCode).toBe(200);
    expect(cold.json()).toEqual({
      instance_id: minted.instance_id,
      origin: config.baseUrl,
    });
  } finally {
    await app?.close();
    await disconnect();
    await database.drop();
  }
});
