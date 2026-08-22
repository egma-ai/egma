import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DATABASE_ENGINE_VERSIONS,
  readDatabaseEngineVersions,
} from "../src/engine-versions.ts";
import {
  MAINTENANCE_CLICKHOUSE_URL,
  MAINTENANCE_DATABASE_URL,
} from "./support/store-urls.ts";

const COMPOSE_FILE = fileURLToPath(
  new URL("../../../docker-compose.yml", import.meta.url),
);

function imageOf(compose: string, service: "postgres" | "clickhouse"): string {
  const match = compose.match(
    new RegExp(`^  ${service}:\\n(?: {4}.*\\n)*? {4}image: ([^\\n]+)$`, "mu"),
  );
  if (match?.[1] === undefined) throw new Error(`${service} has no Compose image`);
  return match[1].trim();
}

function escaped(value: string): string {
  return value.replaceAll(".", "\\.");
}

describe("the hosted database compatibility line", () => {
  it("is the image local development and CI start", async () => {
    const compose = await readFile(COMPOSE_FILE, "utf8");

    expect(imageOf(compose, "postgres")).toBe(
      DATABASE_ENGINE_VERSIONS.postgres.image,
    );
    expect(imageOf(compose, "clickhouse")).toBe(
      DATABASE_ENGINE_VERSIONS.clickhouse.image,
    );

    for (const engine of Object.values(DATABASE_ENGINE_VERSIONS)) {
      expect(engine.hostedVersion).toMatch(
        new RegExp(`^${escaped(engine.compatibilityLine)}(?:\\D|$)`, "u"),
      );
      expect(engine.image).toMatch(
        new RegExp(`:${escaped(engine.compatibilityLine)}(?:\\D|$)`, "u"),
      );
    }
  });

  it("is the version the migration suite actually reaches", async () => {
    const actual = await readDatabaseEngineVersions({
      postgresUrl: MAINTENANCE_DATABASE_URL,
      clickhouseUrl: MAINTENANCE_CLICKHOUSE_URL,
    });

    expect(actual.postgres).toMatch(
      new RegExp(
        `^${escaped(DATABASE_ENGINE_VERSIONS.postgres.compatibilityLine)}(?:\\D|$)`,
        "u",
      ),
    );
    expect(actual.clickhouse).toMatch(
      new RegExp(
        `^${escaped(DATABASE_ENGINE_VERSIONS.clickhouse.compatibilityLine)}(?:\\D|$)`,
        "u",
      ),
    );
  });
});
