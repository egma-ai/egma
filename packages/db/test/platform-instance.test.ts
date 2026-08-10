import { platformInstanceId } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { connect, disconnect } from "../src/client.ts";
import {
  createMigratedDatabase,
  TEST_ENCRYPTION_KEY,
  type MigratedDatabase,
} from "./support/database.ts";

/**
 * What this deployment calls itself.
 *
 * The identifier an agent repository commits, so the claims here are the ones
 * the binding rests on: one deployment has exactly one, it is the same one
 * after the process that read it has gone, and two deployments never share one.
 * The connection is opened and closed by hand rather than through the connected
 * helper, because "the same after a restart" is a claim about the data
 * surviving the process and cannot be made without stopping one.
 */

let database: MigratedDatabase | undefined;

afterEach(async () => {
  await disconnect();
  await database?.drop();
  database = undefined;
});

async function open(label: string): Promise<MigratedDatabase> {
  const made = await createMigratedDatabase(label);
  connect({ databaseUrl: made.url, maxConnections: 4, encryptionKey: TEST_ENCRYPTION_KEY });
  return made;
}

describe("a deployment's instance identifier", () => {
  it("is minted on the first ask and never changes afterwards", async () => {
    database = await open("instance_mint");

    const first = await platformInstanceId();

    expect(first).toMatch(/^ins_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(await platformInstanceId()).toBe(first);
  });

  it("outlives the process that minted it, because it lives with the data", async () => {
    database = await open("instance_restart");
    const before = await platformInstanceId();

    await disconnect();
    connect({
      databaseUrl: database.url,
      maxConnections: 4,
      encryptionKey: TEST_ENCRYPTION_KEY,
    });

    expect(await platformInstanceId()).toBe(before);
  });

  it("is one row however many callers ask at once", async () => {
    database = await open("instance_race");

    const asked = await Promise.all(
      Array.from({ length: 8 }, () => platformInstanceId()),
    );

    expect(new Set(asked).size).toBe(1);
    const counted = await database.sql<{ count: string }>(
      "select count(*)::text as count from platform_instance",
    );
    expect(counted.rows[0]?.count).toBe("1");
  });

  it("is a different identifier in a different database", async () => {
    database = await open("instance_one");
    const one = await platformInstanceId();
    await disconnect();
    await database.drop();

    database = await open("instance_two");

    expect(await platformInstanceId()).not.toBe(one);
  });
});
