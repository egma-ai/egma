import { type IdPrefix } from "@egma/ids";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/schema/index.ts";
import { createMigratedDatabase, type MigratedDatabase } from "./support/database.ts";

/**
 * Structural rules that have to hold across the whole schema, asserted against
 * the catalog of a real migrated database rather than against the TypeScript
 * that produced it.
 */

/**
 * The tables built so far: identity and tenancy from the control-plane pass,
 * then each product table as its first caller arrives — personas came
 * with the factory.
 *
 * A table whose identity is somebody else's key pins that key's prefix, which
 * is why the junction naming who calls about a test version pins `tstv_`.
 */
const TABLE_PREFIX: Readonly<Record<string, IdPrefix>> = {
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "vrf",
  device_code: "dvc",
  organization: "org",
  project: "prj",
  membership: "mbr",
  invitation: "inv",
  api_key: "key",
  persona_definition: "prs",
  project_persona: "ppr",
  persona_definition_version: "prsv",
  agent: "agt",
  connection: "con",
  project_grader: "grd",
  // The shelf of grader definitions. The one table below the tenancy tables
  // whose organization and project are both nullable — null means egma owns
  // the entry — so its identity is its own rather than somebody's key, and the
  // nullable pair is asserted on its own below.
  grader_definition: "grl",
  // One immutable executable revision. Its identity is the definition id plus
  // a revision number, so its leading id keeps the definition prefix.
  grader_definition_version: "grl",
  test_suite: "ste",
  test: "tst",
  test_version: "tstv",
  test_persona: "tstv",
  run: "run",
  run_event: "run",
  simulation: "sim",
  grading_job: "gjb",
  // One pulled agent's machine notebook: cursor, windows, lease, retry clock.
  monitoring_state: "mst",
  // A provider call egma could not fetch or normalize: its bounded retry
  // budget, and then the identity-only marker that stops the overlap starting
  // a second one. It holds no provider document and expires by itself.
  retell_call_retry: "rcr",
  // One immutable price on the rate card. Provider usage lives in ClickHouse.
  rate_card: "rat",
  // Cloud account and money rows have their own prefixed identities.
  cloud_plan: "cpl",
  cloud_billing_account: "cba",
  cloud_ledger_entry: "cle",
};

/** Meter progress is identified by its organization, subscription, period and channel. */
const TABLES_WITH_COMPOSITE_IDENTITY = ["cloud_meter_period", "provider_key"];

const declaredTables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table));

type ColumnRow = {
  table_name: string;
  column_name: string;
  type_name: string;
  collation_name: string | null;
  has_default: boolean;
  not_null: boolean;
};

let database: MigratedDatabase;
let columns: ColumnRow[];

beforeAll(async () => {
  database = await createMigratedDatabase("shape");
  const { rows } = await database.sql<ColumnRow>(`
    select
      c.relname                 as table_name,
      a.attname                 as column_name,
      t.typname                 as type_name,
      coll.collname             as collation_name,
      a.atthasdef               as has_default,
      a.attnotnull              as not_null
    from pg_attribute a
    join pg_class c        on c.oid = a.attrelid
    join pg_namespace n    on n.oid = c.relnamespace
    join pg_type t         on t.oid = a.atttypid
    left join pg_collation coll on coll.oid = a.attcollation
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.attnum > 0
      and not a.attisdropped
    order by c.relname, a.attnum
  `);
  columns = rows;
});

afterAll(async () => {
  await database.drop();
});

/** Every table the migrations build. */
const EVERY_TABLE = [
  ...Object.keys(TABLE_PREFIX),
  ...TABLES_WITH_COMPOSITE_IDENTITY,
].sort();

describe("the migrated tables", () => {
  it("match the schema the application queries through", () => {
    const declared = declaredTables.map((table) => table.name).sort();
    expect(declared).toEqual(EVERY_TABLE);

    for (const table of declaredTables) {
      const live = columns
        .filter((column) => column.table_name === table.name)
        .map((column) => column.column_name)
        .sort();
      expect(table.columns.map((column) => column.name).sort()).toEqual(live);
    }
  });
});
