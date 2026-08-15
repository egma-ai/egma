import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readMigrations } from "../src/migrate.ts";
import { repeatedMigrationNumbers } from "./support/migration-numbers.ts";

/**
 * The guard both migration directories are held to, proved against a directory
 * that breaks it.
 *
 * **It is here because the check it replaces could not fail.** Both migration
 * test files carried
 * `expect(names).toEqual([...names].sort())`, which compares a sorted list
 * against itself and holds for every directory ever written — including one
 * holding `0003_first.sql` and `0003_second.sql`, which is exactly how this
 * repository ended up with two files numbered 0003, one from each of two
 * efforts that merged. A guard aimed at the real directory alone can only ever
 * say "still fine"; this one is aimed at a directory that is not.
 */
describe("two migrations wearing one number", () => {
  const fixture = fileURLToPath(
    new URL("./fixtures/duplicated-number", import.meta.url),
  );

  it("is reported, by the number they share", async () => {
    expect(repeatedMigrationNumbers(await readMigrations(fixture))).toEqual([
      "0003",
    ]);
  });

  it("is what the sortedness check misses, which is why this one exists", async () => {
    const names = (await readMigrations(fixture)).map(
      (migration) => migration.name,
    );

    // The old guard, verbatim, against the directory it should have caught.
    expect(names).toEqual([...names].sort());
  });
});
