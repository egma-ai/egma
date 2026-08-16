/**
 * The two addresses the whole suite reaches its stores at, held against the
 * deployment description that creates them.
 *
 * **A password is not copy.** `docker-compose.yml` creates Postgres and
 * ClickHouse with `POSTGRES_PASSWORD` and `CLICKHOUSE_PASSWORD` defaulted in
 * that file, and a store answers to the value it was created with and to
 * nothing else. `store-urls.ts` restates those values because it is read
 * before anything in this repository has been built and so may import nothing.
 * Two copies of one fact, and until now nothing held them together.
 *
 * The branding change on `main` (`a3ab932`) rewrote both passwords to `Egma`
 * along with the product's copy. Nothing named a file: every test in the suite
 * failed at connection time with *"password is incorrect, or there is no user
 * with such name"*, which reads like a machine that needs its containers
 * recreated rather than like a line somebody edited. That is the cost this
 * file removes.
 *
 * It asks the question the other way round from a spelling rule: it does not
 * say *never capitalize this word*, it says *these two files must agree*. A
 * deployment that genuinely changes its store password changes it here too,
 * and this passes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAINTENANCE_CLICKHOUSE_URL,
  MAINTENANCE_DATABASE_URL,
} from "./support/store-urls.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * What `docker-compose.yml` defaults one variable to, read out of the
 * `${NAME:-value}` form the file states its defaults in.
 */
function composeDefault(variable: string): string {
  const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  const stated = new RegExp(`\\$\\{${variable}:-([^}]*)\\}`, "u").exec(compose);
  expect(
    stated,
    `docker-compose.yml states no default for ${variable}, so the address in ` +
      "store-urls.ts has nothing to be held against",
  ).not.toBeNull();
  return (stated as RegExpExecArray)[1] as string;
}

describe("the addresses the test suite reaches its stores at", () => {
  for (const [store, url, user, password, database] of [
    [
      "Postgres",
      MAINTENANCE_DATABASE_URL,
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "POSTGRES_DB",
    ],
    [
      "ClickHouse",
      MAINTENANCE_CLICKHOUSE_URL,
      "CLICKHOUSE_USER",
      "CLICKHOUSE_PASSWORD",
      "CLICKHOUSE_DB",
    ],
  ] as const) {
    it(`carries the credential docker-compose.yml creates ${store} with`, () => {
      const reached = new URL(url);

      // Decoded, because a URL is what carries these and a password with a
      // reserved character in it would arrive percent-encoded.
      expect(
        decodeURIComponent(reached.username),
        `${store} is created as ${composeDefault(user)} and this address ` +
          `signs in as ${decodeURIComponent(reached.username)}`,
      ).toBe(composeDefault(user));

      expect(
        decodeURIComponent(reached.password),
        `${store} is created with the password docker-compose.yml defaults ` +
          `${password} to, and this address sends a different one — every ` +
          "test in the suite refuses to connect, naming no file",
      ).toBe(composeDefault(password));

      expect(reached.pathname.replace(/^\//u, "")).toBe(
        composeDefault(database),
      );
    });
  }
});
