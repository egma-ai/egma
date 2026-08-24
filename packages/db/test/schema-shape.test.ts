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

/**
 * The tables built so far: identity and tenancy from the control-plane pass,
 * then each product table as its first caller arrives — personas came
 * with the factory.
 *
 * A table whose identity is somebody else's key pins that key's prefix, which
 * is why `organization_settings` pins `org_` and the junction naming who calls
 * about a test version pins `tstv_`.
 */
const TABLE_PREFIX: Readonly<Record<string, IdPrefix>> = {
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "vrf",
  device_code: "dvc",
  organization: "org",
  organization_settings: "org",
  // One row for each setting the deployment holds. Its identity is its own
  // rather than somebody's key, because it belongs to the platform and to no
  // customer — the one table below the tenancy tables that names neither an
  // organization nor a project.
  platform_setting: "pfs",
  project: "prj",
  membership: "mbr",
  invitation: "inv",
  api_key: "key",
  persona: "prs",
  persona_version: "prsv",
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
  mock_tool: "mck",
  // The scope's junction, pinning the mock tool it narrows — the shape the
  // persona junction has, for the same reason.
  mock_tool_agent: "mck",
  test_suite: "ste",
  test: "tst",
  test_version: "tstv",
  test_persona: "tstv",
  run: "run",
  run_event: "run",
  simulation: "sim",
  // One run's frozen grading plan: which versions and non-secret models grade
  // each pinned test version.
  grading_plan: "gpl",
  // The operations a client may safely send twice. Its identity is the whole
  // five-column key rather than an id of its own, so it pins its leading
  // column — the shape both junction tables have, for the same reason.
  idempotent_operation: "org",
  grading_job: "gjb",
  // One pulled agent's machine notebook: cursor, windows, lease, retry clock.
  monitoring_state: "mst",
  // A provider call egma could not fetch or normalize: its bounded retry
  // budget, and then the identity-only marker that stops the overlap starting
  // a second one. It holds no provider document and expires by itself.
  retell_call_retry: "rcr",
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

  it("has no database default except the required shared persona pointer", () => {
    for (const { table, column } of declaredIdentifierColumns) {
      const live = columns.find(
        (candidate) =>
          candidate.table_name === table && candidate.column_name === column,
      );
      const isRequiredPersonaPointer =
        table === "project" && column === "default_persona_id";
      expect(live?.has_default, `${table}.${column} default`).toBe(
        isRequiredPersonaPointer,
      );
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

  /**
   * A prefixed column that is **not** the row's identity.
   *
   * An opaque live revision is minted in egma's own identifier format and
   * pinned the same way, so a hand-written row cannot carry a revision nothing
   * would ever have issued. It is named here rather than folded into
   * `TABLE_PREFIX` because that map answers "what is this table's identity",
   * and a revision is not one — it says which *state* was read, and a row goes
   * through many.
   */
  const REVISION_COLUMNS: Readonly<Record<string, number>> = {
    // A project grader has no live revision column. Updating project policy does
    // not create a grader-definition version, and the current product exposes no
    // project-grader archive or delete flow for a revision to guard.
    project: 1,
    test: 1,
  };

  it("pins a prefix that is one of the ones egma mints", () => {
    const pinned = checks
      .map((check) => /\^([a-z]+)_\[0-9A-HJKMNP-TV-Z\]\{26\}\$/.exec(check.definition))
      .filter((match) => match !== null)
      .map((match) => match[1]);

    expect(pinned.length).toBe(
      Object.keys(TABLE_PREFIX).length +
        Object.values(REVISION_COLUMNS).reduce((all, one) => all + one, 0),
    );
    for (const prefix of pinned) {
      expect(ID_PREFIXES).toContain(prefix);
    }
  });

  it("pins the revision format wherever a row carries one", () => {
    for (const [table, how_many] of Object.entries(REVISION_COLUMNS)) {
      const pinned = checks.filter(
        (check) =>
          check.table_name === table &&
          check.definition.includes(idCheckPattern("rev")),
      );
      expect(pinned, `${table} pins rev_`).toHaveLength(how_many);
    }
  });
});

/**
 * The pin the runs schema was shaped for. It is asserted here rather than only
 * in the runs tests because it is a structural claim: two required columns
 * and paired keys that make a cross-project
 * pin unrepresentable — the persona pin's shape, edge for edge.
 */
describe("the simulation's test pin", () => {
  const pinned = (name: string): ColumnRow | undefined =>
    columns.find(
      (column) =>
        column.table_name === "simulation" && column.column_name === name,
    );

  it("is two required identifier columns after the clean suite cutover", () => {
    for (const name of ["test_id", "test_version_id"]) {
      const live = pinned(name);
      expect(live, `simulation.${name}`).toBeDefined();
      expect(live?.type_name, `simulation.${name} type`).toBe("text");
      expect(live?.collation_name, `simulation.${name} collation`).toBe("C");
      expect(live?.not_null, `simulation.${name} required`).toBe(true);
    }
  });

  it("closes the tenancy triangle at both edges, so no raw write can pin across projects", async () => {
    const { rows } = await database.sql<{
      conname: string;
      definition: string;
    }>(`
      select con.conname, pg_get_constraintdef(con.oid) as definition
      from pg_constraint con
      join pg_class c     on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and con.contype = 'f' and c.relname = 'simulation'
    `);
    const byName = new Map(rows.map((row) => [row.conname, row.definition]));

    // The version is the named test's…
    expect(byName.get("simulation_test_version_test_fk")).toMatch(
      /FOREIGN KEY \(test_version_id, test_id\) REFERENCES test_version\(id, test_id\)/,
    );
    // …and the test is this project's.
    expect(byName.get("simulation_test_project_fk")).toMatch(
      /FOREIGN KEY \(test_id, project_id\) REFERENCES test\(id, project_id\)/,
    );
  });

  it("rests on the dormant uniques those keys target, exactly as the persona pin does", async () => {
    const { rows } = await database.sql<{ conname: string }>(
      `select conname from pg_constraint
        where contype = 'u'
          and conname in ('test_id_project_id_unique', 'test_version_id_test_id_unique')`,
    );
    expect(rows.map((row) => row.conname).sort()).toEqual([
      "test_id_project_id_unique",
      "test_version_id_test_id_unique",
    ]);
  });
});

describe("test suite ownership", () => {
  it("keeps one required immutable home on every test and one suite on every run", async () => {
    for (const { table, column } of [
      { table: "test", column: "suite_id" },
      { table: "run", column: "suite_id" },
    ]) {
      const live = columns.find(
        (candidate) =>
          candidate.table_name === table && candidate.column_name === column,
      );
      expect(live?.not_null, `${table}.${column}`).toBe(true);
    }

    const { rows } = await database.sql<{ tgname: string }>(
      `select tgname from pg_trigger
        where not tgisinternal and tgname = 'test_suite_membership_immutable'`,
    );
    expect(rows).toEqual([{ tgname: "test_suite_membership_immutable" }]);
  });

  it("removes the retired applicability, capability-skip, retry, and archive shapes", () => {
    for (const { table, column } of [
      // Agents own platform monitoring now. These values moved to the agent or
      // were retired by the pre-launch cutover in 0042.
      { table: "agent", column: "description" },
      { table: "agent", column: "revision" },
      { table: "connection", column: "revision" },
      { table: "connection", column: "agent_platform" },
      { table: "connection", column: "connection_kind" },
      { table: "test", column: "applicability_revision" },
      { table: "test", column: "archived_at" },
      { table: "test", column: "archive_reason" },
      { table: "connection", column: "capability_state" },
      { table: "run", column: "pinned_test_versions" },
      { table: "run", column: "retry_of_run_id" },
      { table: "run", column: "skipped_count" },
      { table: "simulation", column: "skip_reason" },
      { table: "simulation", column: "skipped_capabilities" },
    ]) {
      expect(
        columns.some(
          (candidate) =>
            candidate.table_name === table &&
            candidate.column_name === column,
        ),
        `${table}.${column}`,
      ).toBe(false);
    }
  });

  it("removes skipped from the installed simulation lifecycle and event status checks", async () => {
    const { rows: functions } = await database.sql<{ definition: string }>(
      `select pg_get_functiondef(p.oid) as definition
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'guard_simulation_lifecycle'`,
    );
    expect(functions).toHaveLength(1);
    expect(functions[0]?.definition).not.toContain("'skipped'");

    const { rows: constraints } = await database.sql<{
      conname: string;
      definition: string;
    }>(
      `select conname, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname = 'run_event_simulation_shape'
        order by conname`,
    );
    expect(constraints).toHaveLength(1);
    for (const constraint of constraints) {
      expect(constraint.definition).not.toContain("status = 'skipped'");
    }
  });
});

/**
 * The schema's deliberate exceptions to hard-required tenancy.
 *
 * Every other table below the tenancy tables carries a `not null`
 * `organization_id`, because a row belonging to nobody is a row no permission
 * can describe. On the grader definition and persona shelves, belonging to nobody
 * is a real state: **null tenancy means egma owns the definition**, which is
 * where the Owner label is derived from. It is asserted here
 * rather than only in that table's own tests because it is a structural claim
 * about the whole schema — and because an exception nothing watches is an
 * exception that spreads.
 */
describe("the grader definition's nullable tenancy", () => {
  const tenancy = (name: string): ColumnRow | undefined =>
    columns.find(
      (column) =>
        column.table_name === "grader_definition" && column.column_name === name,
    );

  it("uses one nullable organization owner and no project owner", () => {
    const organization = tenancy("organization_id");
    expect(organization).toBeDefined();
    expect(organization?.type_name).toBe("text");
    expect(organization?.collation_name).toBe("C");
    expect(organization?.not_null).toBe(false);
    expect(tenancy("project_id")).toBeUndefined();
  });

  /**
   * Three tables leave the customer null, with two meanings.
   *
   * A device code's null is **not yet**: a terminal that has not been aimed at
   * anything, filled in the moment somebody approves it. The library's is
   * **never**, and permanently — the grader or persona belongs to egma, and
   * that is the state the Owner column reads. Another table appearing here is
   * somebody choosing one of those two meanings, which is a decision worth
   * making on purpose rather than by leaving a `notNull` off.
   */
  it("joins the persona shelf and the one pending-authorization table", () => {
    const nullable = columns.filter(
      (column) =>
        column.column_name === "organization_id" && !column.not_null,
    );
    expect(nullable.map((column) => column.table_name).sort()).toEqual([
      "device_code",
      "grader_definition",
      "persona",
    ]);
  });

  it("keeps organization-owned definitions inside their organization", async () => {
    const { rows } = await database.sql<{
      conname: string;
      definition: string;
    }>(`
      select con.conname, pg_get_constraintdef(con.oid) as definition
      from pg_constraint con
      join pg_class c     on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and con.contype = 'f' and c.relname = 'grader_definition'
    `);
    const byName = new Map(rows.map((row) => [row.conname, row.definition]));

    expect(byName.get("grader_definition_organization_id_organization_id_fk")).toMatch(
      /FOREIGN KEY \(organization_id\) REFERENCES organization\(id\)/,
    );
  });
});

describe("the persona library's nullable tenancy", () => {
  it("keeps the owner pair whole and Egma-provided rows active", async () => {
    const { rows } = await database.sql<{ conname: string; definition: string }>(
      `select conname, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conname in ('persona_tenancy_is_whole_or_egmas', 'persona_egma_provided_is_active')
        order by conname`,
    );
    expect(rows.map((row) => row.conname)).toEqual([
      "persona_egma_provided_is_active",
      "persona_tenancy_is_whole_or_egmas",
    ]);
    expect(rows.map((row) => row.definition).join(" ")).toContain(
      "organization_id IS NULL",
    );
  });

  it("gives each Egma-provided name one identity", async () => {
    const { rows } = await database.sql<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where indexname = 'persona_egma_provided_name_unique'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("UNIQUE INDEX");
    expect(rows[0]?.indexdef).toContain("WHERE (organization_id IS NULL)");
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

describe("a persona version is executable by itself", () => {
  it("requires one complete models value and has no database default", () => {
    const models = columns.find(
      (column) =>
        column.table_name === "persona_version" &&
        column.column_name === "models",
    );

    expect(models, "persona_version.models").toBeDefined();
    expect(models?.type_name).toBe("jsonb");
    expect(models?.not_null).toBe(true);
    expect(models?.has_default).toBe(false);
  });

  it("holds human traits and model selections to closed database checks", async () => {
    const { rows } = await database.sql<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'persona_version'::regclass
          and conname in ('persona_version_traits_valid', 'persona_version_models_valid')
        order by conname`,
    );
    expect(rows.map((row) => row.conname)).toEqual([
      "persona_version_models_valid",
      "persona_version_traits_valid",
    ]);
  });
});

describe("grader execution ownership", () => {
  it("stores type and the non-secret model only on the immutable grader version", () => {
    const model = columns.find(
      (column) =>
        column.table_name === "grader_definition_version" &&
        column.column_name === "judge_model",
    );
    expect(model?.type_name).toBe("jsonb");
    expect(model?.has_default).toBe(false);
    expect(columns.some(
      (column) =>
        column.table_name === "grader_definition_version" &&
        column.column_name === "type",
    )).toBe(true);
    expect(columns.some(
      (column) =>
        column.table_name === "grader_definition" &&
        column.column_name === "type",
    )).toBe(false);
    expect(columns.some(
      (column) =>
        column.table_name === "grader_definition_version" &&
        ["source_code", "source_code_language"].includes(column.column_name),
    )).toBe(false);
    expect(columns.some((column) => column.table_name === "judge_configuration")).toBe(false);
    expect(columns.some((column) => column.table_name === "judge_credential")).toBe(false);
  });

  it("stores complete project settings on the project grader with no default", () => {
    const values = columns.find(
      (column) =>
        column.table_name === "project_grader" &&
        column.column_name === "parameter_values",
    );
    expect(values?.type_name).toBe("jsonb");
    expect(values?.not_null).toBe(true);
    expect(values?.has_default).toBe(false);
  });

  it("keeps no credential reference on a grading plan", () => {
    expect(
      columns.some(
        (column) =>
          column.table_name === "grading_plan" &&
          column.column_name === "judge_credential_ids",
      ),
    ).toBe(false);
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
      { table: "platform_setting", column: "name" },
      { table: "membership", column: "role" },
      { table: "invitation", column: "role" },
      { table: "api_key", column: "scope" },
      { table: "device_code", column: "status" },
      { table: "agent", column: "agent_platform" },
      { table: "connection", column: "connection_type" },
      { table: "connection", column: "access_variant" },
      { table: "connection", column: "modality" },
      { table: "connection", column: "topology" },
      { table: "grader_definition_version", column: "type" },
      { table: "run", column: "status" },
      { table: "run", column: "triggered_via" },
      { table: "simulation", column: "status" },
      { table: "simulation", column: "ending_reason" },
      { table: "simulation", column: "modality" },
      { table: "run_event", column: "kind" },
      { table: "monitoring_state", column: "scan_kind" },
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
            // Postgres folds a one-value list to plain equality in the
            // catalog, so `in ('manual')` reads back as `= 'manual'`.
            new RegExp(`= ANY|IN \\(|${column} = '`, "i").test(row.definition),
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
