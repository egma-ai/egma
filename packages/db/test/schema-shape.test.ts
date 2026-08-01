import { ID_PREFIXES, idCheckPattern, type IdPrefix } from "@egma/ids";
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

const IDENTIFIER_SQL_TYPE = 'text COLLATE "C"';

/** The identity and tenancy tables. The product and execution tables arrive with their first caller. */
const TABLE_PREFIX: Readonly<Record<string, IdPrefix>> = {
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "vrf",
  device_code: "dvc",
  organization: "org",
  organization_settings: "org",
  project: "prj",
  membership: "mbr",
  invitation: "inv",
  api_key: "key",
};

const declaredTables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table));

type ColumnRow = {
  table_name: string;
  column_name: string;
  type_name: string;
  collation_name: string | null;
  has_default: boolean;
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
      a.atthasdef               as has_default
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

describe("the tables this pass builds", () => {
  it("are the identity and tenancy tables, and only those", async () => {
    const { rows } = await database.sql<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    expect(rows.map((row) => row.tablename)).toEqual(
      Object.keys(TABLE_PREFIX).sort(),
    );
  });

  it("match the schema the application queries through", () => {
    const declared = declaredTables.map((table) => table.name).sort();
    expect(declared).toEqual(Object.keys(TABLE_PREFIX).sort());

    for (const table of declaredTables) {
      const live = columns
        .filter((column) => column.table_name === table.name)
        .map((column) => column.column_name)
        .sort();
      expect(table.columns.map((column) => column.name).sort()).toEqual(live);
    }
  });
});

describe("every identifier column", () => {
  const declaredIdentifierColumns = declaredTables.flatMap((table) =>
    table.columns
      .filter((column) => column.getSQLType() === IDENTIFIER_SQL_TYPE)
      .map((column) => ({ table: table.name, column: column.name })),
  );

  it("exists on every table", () => {
    expect(declaredIdentifierColumns.length).toBeGreaterThan(0);
    for (const table of declaredTables) {
      expect(
        declaredIdentifierColumns.some((column) => column.table === table.name),
      ).toBe(true);
    }
  });

  it("is text collated C, so a byte comparison is the only comparison", () => {
    for (const { table, column } of declaredIdentifierColumns) {
      const live = columns.find(
        (candidate) =>
          candidate.table_name === table && candidate.column_name === column,
      );
      expect(live, `${table}.${column}`).toBeDefined();
      expect(live?.type_name, `${table}.${column} type`).toBe("text");
      expect(live?.collation_name, `${table}.${column} collation`).toBe("C");
    }
  });

  it("has no database default, because identifiers are minted in application code", () => {
    for (const { table, column } of declaredIdentifierColumns) {
      const live = columns.find(
        (candidate) =>
          candidate.table_name === table && candidate.column_name === column,
      );
      expect(live?.has_default, `${table}.${column} default`).toBe(false);
    }
  });
});

describe("every table", () => {
  let checks: { table_name: string; definition: string }[];

  beforeAll(async () => {
    const { rows } = await database.sql<{
      table_name: string;
      definition: string;
    }>(`
      select c.relname as table_name, pg_get_constraintdef(con.oid) as definition
      from pg_constraint con
      join pg_class c     on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and con.contype = 'c'
    `);
    checks = rows;
  });

  it("pins its own prefix with a check constraint", () => {
    for (const [table, prefix] of Object.entries(TABLE_PREFIX)) {
      const pattern = idCheckPattern(prefix);
      const pinned = checks.filter(
        (check) => check.table_name === table && check.definition.includes(pattern),
      );
      expect(pinned, `${table} pins ${prefix}_`).toHaveLength(1);
    }
  });

  it("pins a prefix that is one of the ones egma mints", () => {
    const pinned = checks
      .map((check) => /\^([a-z]+)_\[0-9A-HJKMNP-TV-Z\]\{26\}\$/.exec(check.definition))
      .filter((match) => match !== null)
      .map((match) => match[1]);

    expect(pinned.length).toBe(Object.keys(TABLE_PREFIX).length);
    for (const prefix of pinned) {
      expect(ID_PREFIXES).toContain(prefix);
    }
  });
});

describe("every timestamp", () => {
  it("is timezone-aware, because a simulation can cross midnight in two zones", () => {
    const naive = columns.filter((column) => column.type_name === "timestamp");
    expect(naive).toEqual([]);

    const aware = columns.filter((column) => column.type_name === "timestamptz");
    expect(aware.length).toBeGreaterThan(0);
  });
});

describe("every enumerated value", () => {
  it("is text plus a check, never a native Postgres enum type", async () => {
    const { rows } = await database.sql<{ typname: string }>(
      `select t.typname
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
        where t.typtype = 'e' and n.nspname not in ('pg_catalog', 'information_schema')`,
    );
    expect(rows).toEqual([]);
  });

  it("names its allowed values in a check constraint", async () => {
    const enumerated = [
      { table: "membership", column: "role" },
      { table: "invitation", column: "role" },
      { table: "api_key", column: "scope" },
      { table: "device_code", column: "status" },
    ];

    const { rows } = await database.sql<{
      table_name: string;
      definition: string;
    }>(`
      select c.relname as table_name, pg_get_constraintdef(con.oid) as definition
      from pg_constraint con
      join pg_class c     on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and con.contype = 'c'
    `);

    for (const { table, column } of enumerated) {
      const live = columns.find(
        (candidate) =>
          candidate.table_name === table && candidate.column_name === column,
      );
      expect(live?.type_name, `${table}.${column}`).toBe("text");
      expect(
        rows.some(
          (row) =>
            row.table_name === table &&
            row.definition.includes(column) &&
            /= ANY|IN \(/i.test(row.definition),
        ),
        `${table}.${column} has an allowed-value check`,
      ).toBe(true);
    }
  });
});

describe("attribution", () => {
  it("is present from this first migration on the tables that answer who made this", () => {
    for (const table of ["api_key", "membership", "project", "invitation"]) {
      const names = columns
        .filter((column) => column.table_name === table)
        .map((column) => column.column_name);

      expect(names, `${table} created_at`).toContain("created_at");
      expect(names, `${table} updated_at`).toContain("updated_at");
      expect(
        names.some((name) => name === "created_by" || name === "created_by_user_id"),
        `${table} created by`,
      ).toBe(true);
    }
  });
});
