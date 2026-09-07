/**
 * Default store credentials in store-urls.ts must match docker-compose.yml.
 * They are authentication values, so product-copy changes must not alter them.
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
