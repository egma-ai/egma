/**
 * The database feature versions the hosted platform currently runs.
 *
 * Local development and CI run these versions too. They may stay behind after
 * a hosted vendor upgrades, but they must never move ahead: every Postgres and
 * ClickHouse migration has to prove itself on the oldest engine we still run.
 *
 * ClickHouse Cloud and the public ClickHouse image use different build numbers.
 * They share the `26.2.1` feature release, which is the SQL compatibility line
 * this contract pins. The exact public image stays fixed so a pull cannot change
 * the test engine underneath an unchanged commit.
 */
export const DATABASE_ENGINE_VERSIONS = {
  postgres: {
    hostedVersion: "17.6",
    compatibilityLine: "17.6",
    image: "postgres:17.6-alpine",
  },
  clickhouse: {
    hostedVersion: "26.2.1.558",
    compatibilityLine: "26.2.1",
    image: "clickhouse/clickhouse-server:26.2.1.1139",
  },
} as const;

export type DatabaseEngineVersions = {
  readonly postgres: string;
  readonly clickhouse: string;
};

/**
 * Read engine metadata from the two maintenance endpoints used by tests.
 *
 * This is intentionally inside the database package's driver boundary. It
 * reads no customer row and takes no AuthContext because server versions are
 * store metadata, not tenant data.
 */
export async function readDatabaseEngineVersions(input: {
  readonly postgresUrl: string;
  readonly clickhouseUrl: string;
}): Promise<DatabaseEngineVersions> {
  const postgres = new pg.Client({ connectionString: input.postgresUrl });
  await postgres.connect();
  try {
    const postgresResult = await postgres.query<{ server_version: string }>(
      "show server_version",
    );
    const postgresVersion = postgresResult.rows[0]?.server_version;
    if (postgresVersion === undefined) {
      throw new Error("Postgres did not report its server version");
    }

    const clickhouse = createClient({ url: input.clickhouseUrl });
    try {
      const clickhouseResult = await clickhouse.query({
        query: "select version() as version",
        format: "JSONEachRow",
      });
      const clickhouseRows = await clickhouseResult.json<{ version: string }>();
      const clickhouseVersion = clickhouseRows[0]?.version;
      if (clickhouseVersion === undefined) {
        throw new Error("ClickHouse did not report its server version");
      }

      return {
        postgres: postgresVersion,
        clickhouse: clickhouseVersion,
      };
    } finally {
      await clickhouse.close();
    }
  } finally {
    await postgres.end();
  }
}
import { createClient } from "@clickhouse/client";
import pg from "pg";
