import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase, type MigratedDatabase } from "./support/database.ts";

/**
 * The identifier format promises that a plain string sort is a sort by mint
 * time. That promise is only worth anything if Postgres agrees, which is what
 * `COLLATE "C"` buys: byte comparison, no language rules.
 */

let database: MigratedDatabase;
const minted: string[] = [];

beforeAll(async () => {
  database = await createMigratedDatabase("ordering");

  for (let index = 0; index < 200; index += 1) {
    const id = newId("org");
    minted.push(id);
    await database.sql(
      "insert into organization (id, name, slug) values ($1, $2, $3)",
      [id, `Organization ${index}`, `organization-${index}`],
    );
  }
});

afterAll(async () => {
  await database.drop();
});

describe("ordering identifiers in Postgres", () => {
  it("returns them in the order they were minted", async () => {
    const { rows } = await database.sql<{ id: string }>(
      "select id from organization order by id",
    );
    expect(rows.map((row) => row.id)).toEqual(minted);
  });
});
