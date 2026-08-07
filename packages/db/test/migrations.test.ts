import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newId } from "@egma/ids";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MIGRATION_ADVISORY_LOCK,
  readMigrations,
  runMigrations,
} from "../src/migrate.ts";
import { createEmptyDatabase, type EmptyDatabase } from "./support/database.ts";

describe("the migration files", () => {
  it("are numbered plain SQL, applied in that order", async () => {
    const migrations = await readMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    for (const migration of migrations) {
      expect(migration.name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
    expect(migrations.map((migration) => migration.name)).toEqual(
      [...migrations.map((migration) => migration.name)].sort(),
    );
  });

  it("start by creating the citext extension, because the user table needs it", async () => {
    const [first] = await readMigrations();
    expect(first?.name).toBe("0000_extensions.sql");
    expect(first?.sql).toMatch(/create extension if not exists citext/i);
  });
});

describe("applying migrations on boot", () => {
  let database: EmptyDatabase;

  beforeAll(async () => {
    database = await createEmptyDatabase("boot");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("succeeds against an empty database", async () => {
    const expected = await readMigrations();
    const result = await runMigrations(database.url);

    expect(result.applied).toEqual(expected.map((migration) => migration.name));
    expect(result.alreadyApplied).toEqual([]);
  });

  it("leaves the citext extension in place", async () => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      const { rows } = await client.query<{ extname: string }>(
        "select extname from pg_extension where extname = 'citext'",
      );
      expect(rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it("applies nothing on the second boot, and does not error", async () => {
    const expected = await readMigrations();
    const result = await runMigrations(database.url);

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(
      expect.arrayContaining(expected.map((migration) => migration.name)),
    );
  });

  it("refuses a migration file that changed after it was applied", async () => {
    await expect(
      runMigrations(
        database.url,
        fileURLToPath(new URL("./fixtures/edited", import.meta.url)),
      ),
    ).rejects.toThrow(/has changed since it was applied/);
  });
});

describe("two instances booting at the same moment", () => {
  let database: EmptyDatabase;

  beforeAll(async () => {
    database = await createEmptyDatabase("concurrent");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("do not both apply — one waits, then finds nothing to do", async () => {
    const expected = await readMigrations();

    const [first, second] = await Promise.all([
      runMigrations(database.url),
      runMigrations(database.url),
    ]);

    const appliedCounts = [first.applied.length, second.applied.length].sort();
    expect(appliedCounts).toEqual([0, expected.length]);

    const waiter = first.applied.length === 0 ? first : second;
    expect(waiter.alreadyApplied).toEqual(
      expect.arrayContaining(expected.map((migration) => migration.name)),
    );
  });
});

describe("the boot-time advisory lock", () => {
  let database: EmptyDatabase;

  beforeAll(async () => {
    database = await createEmptyDatabase("advisory_lock");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("is what makes a second instance wait", async () => {
    const { namespace, id } = MIGRATION_ADVISORY_LOCK;
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    await holder.query(`select pg_advisory_lock(${namespace}, ${id})`);

    let finished = false;
    const booting = runMigrations(database.url).then((result) => {
      finished = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(finished).toBe(false);

    await holder.query(`select pg_advisory_unlock(${namespace}, ${id})`);
    await holder.end();

    const result = await booting;
    expect(result.applied.length).toBeGreaterThan(0);
  });
});

describe("the persona rename (0005)", () => {
  let database: EmptyDatabase;
  let beforeTheRename: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  // The bodies are minted now-format and re-prefixed old-format, so the rows
  // below are exactly what a pre-rename deployment would hold.
  const identityBody = newId("prs").slice("prs_".length);
  const versionBody = newId("prsv").slice("prsv_".length);

  beforeAll(async () => {
    database = await createEmptyDatabase("persona_rename");

    // The world as it was: every migration before the rename, in a directory
    // of its own, so a digital_human row can exist for 0005 to find.
    beforeTheRename = await mkdtemp(path.join(os.tmpdir(), "egma-before-0005-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0005") {
        await writeFile(
          path.join(beforeTheRename, migration.name),
          migration.sql,
        );
      }
    }
    await runMigrations(database.url, beforeTheRename);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query("begin");
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organizationId],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [projectId, organizationId],
    );
    await client.query(
      `insert into digital_human (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Impatient Rita', $4)`,
      [`dh_${identityBody}`, organizationId, projectId, `dhv_${versionBody}`],
    );
    await client.query(
      `insert into digital_human_version (id, digital_human_id, version, traits)
       values ($1, $2, 1, '{}'::jsonb)`,
      [`dhv_${versionBody}`, `dh_${identityBody}`],
    );
    await client.query("commit");
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheRename, { recursive: true, force: true });
    await database.drop();
  });

  it("leads what is still pending on a pre-rename database", async () => {
    const result = await runMigrations(database.url);
    // Everything before the rename is already applied and must not run twice,
    // so the rename is the first thing left. Whatever was numbered after it
    // follows, which is why this names the leader rather than the whole list.
    expect(result.applied[0]).toBe("0005_rename_digital_human_to_persona.sql");
    expect(result.applied.every((name) => name >= "0005")).toBe(true);
  });

  it("carries the rows across: dh_ becomes prs_, dhv_ becomes prsv_, same bodies", async () => {
    const personas = await client.query<{
      id: string;
      current_version_id: string;
    }>("select id, current_version_id from persona");
    expect(personas.rows).toEqual([
      {
        id: `prs_${identityBody}`,
        current_version_id: `prsv_${versionBody}`,
      },
    ]);

    const versions = await client.query<{ id: string; persona_id: string }>(
      "select id, persona_id from persona_version",
    );
    expect(versions.rows).toEqual([
      { id: `prsv_${versionBody}`, persona_id: `prs_${identityBody}` },
    ]);
  });

  it("keeps the current-version pointer deferred, which create depends on", async () => {
    // 0003 wrote DEFERRABLE INITIALLY DEFERRED by hand because the schema
    // source cannot express it; 0005 renames that constraint rather than
    // recreating it, and this is the proof the clause survived the trip.
    const { rows } = await client.query<{
      condeferrable: boolean;
      condeferred: boolean;
    }>(
      `select condeferrable, condeferred from pg_constraint
       where conname = 'persona_current_version_id_persona_version_id_fk'`,
    );
    expect(rows).toEqual([{ condeferrable: true, condeferred: true }]);
  });

  it("pins the new prefixes: a dh_ id no longer fits the check", async () => {
    await expect(
      client.query(
        `insert into persona (id, organization_id, project_id, name, current_version_id)
         values ($1, $2, $3, 'Old Format', $4)`,
        [
          `dh_${newId("prs").slice("prs_".length)}`,
          organizationId,
          projectId,
          `prsv_${versionBody}`,
        ],
      ),
    ).rejects.toThrow(/persona_id_prefix/);
  });
});

describe("the persona junction's rename (0008)", () => {
  let database: EmptyDatabase;
  let beforeTheRename: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  const personaId = newId("prs");
  const personaVersionId = newId("prsv");
  const testId = newId("tst");
  const testVersionId = newId("tstv");

  beforeAll(async () => {
    database = await createEmptyDatabase("junction_rename");

    // The world as it was: every migration before the rename, in a directory of
    // its own, so a test_version_persona row can exist for 0008 to carry.
    beforeTheRename = await mkdtemp(path.join(os.tmpdir(), "egma-before-0008-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0008") {
        await writeFile(
          path.join(beforeTheRename, migration.name),
          migration.sql,
        );
      }
    }
    await runMigrations(database.url, beforeTheRename);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query("begin");
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organizationId],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [projectId, organizationId],
    );
    await client.query(
      `insert into persona (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Impatient Rita', $4)`,
      [personaId, organizationId, projectId, personaVersionId],
    );
    await client.query(
      `insert into persona_version (id, persona_id, version, traits)
       values ($1, $2, 1, '{}'::jsonb)`,
      [personaVersionId, personaId],
    );
    await client.query(
      `insert into test (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Reschedules a booked appointment', $4)`,
      [testId, organizationId, projectId, testVersionId],
    );
    await client.query(
      `insert into test_version (id, test_id, version, content)
       values ($1, $2, 1, '{"scenario": "moves it", "expectedBehaviors": ["confirms"]}'::jsonb)`,
      [testVersionId, testId],
    );
    await client.query(
      `insert into test_version_persona (test_version_id, persona_id, position)
       values ($1, $2, 1)`,
      [testVersionId, personaId],
    );
    await client.query("commit");

    await runMigrations(database.url);
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheRename, { recursive: true, force: true });
    await database.drop();
  });

  it("carries the rows across rather than rebuilding the table under them", async () => {
    const { rows } = await client.query<{
      test_version_id: string;
      persona_id: string;
      position: number;
    }>("select test_version_id, persona_id, position from test_persona");
    expect(rows).toEqual([
      { test_version_id: testVersionId, persona_id: personaId, position: 1 },
    ]);
  });

  it("renames the constraints and the index rather than recreating them", async () => {
    const { rows: constraints } = await client.query<{ conname: string }>(
      `select con.conname
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
        where c.relname = 'test_persona' and con.contype in ('p', 'u', 'c', 'f')
        order by con.conname`,
    );
    expect(constraints.map((row) => row.conname)).toEqual([
      "test_persona_persona_id_persona_id_fk",
      "test_persona_pk",
      "test_persona_test_version_id_prefix",
      "test_persona_test_version_id_test_version_id_fk",
      "test_persona_version_id_position_unique",
    ]);

    const { rows: indexes } = await client.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = 'public' and tablename = 'test_persona'
        order by indexname`,
    );
    expect(indexes.map((row) => row.indexname)).toEqual([
      "test_persona_persona_id_idx",
      "test_persona_pk",
      "test_persona_version_id_position_unique",
    ]);
  });

  it("keeps the prefix check the junction was built with", async () => {
    await expect(
      client.query(
        `insert into test_persona (test_version_id, persona_id, position)
         values ($1, $2, 2)`,
        [newId("tst"), personaId],
      ),
    ).rejects.toThrow(/test_persona_test_version_id_prefix/);
  });

  it("gives the grader its own deferred current-version pointer, like the test's", async () => {
    const { rows } = await client.query<{
      condeferrable: boolean;
      condeferred: boolean;
    }>(
      `select condeferrable, condeferred from pg_constraint
        where conname = 'grader_current_version_id_grader_version_id_fk'`,
    );
    expect(rows).toEqual([{ condeferrable: true, condeferred: true }]);
  });
});

describe("the simulation's test pin (0009)", () => {
  let database: EmptyDatabase;
  let beforeThePin: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  const agentId = newId("agt");
  const connectionId = newId("con");
  const personaId = newId("prs");
  const personaVersionId = newId("prsv");
  const runId = newId("run");
  const simulationId = newId("sim");
  const testId = newId("tst");
  const testVersionId = newId("tstv");

  beforeAll(async () => {
    database = await createEmptyDatabase("simulation_test_pin");

    // The world as it was: every migration before the pin, in a directory of
    // its own, so a simulation row can exist for 0009 to arrive on top of.
    beforeThePin = await mkdtemp(path.join(os.tmpdir(), "egma-before-0009-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0009") {
        await writeFile(path.join(beforeThePin, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, beforeThePin);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organizationId],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [projectId, organizationId],
    );
    await client.query(
      "insert into agent (id, organization_id, project_id, name) values ($1, $2, $3, 'Front desk')",
      [agentId, organizationId, projectId],
    );
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
       values ($1, $2, $3, $4, 'Staging', 'retell', 'chat', 'hosted-broker', '{}'::jsonb)`,
      [connectionId, organizationId, projectId, agentId],
    );
    await client.query("begin");
    await client.query(
      `insert into persona (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Impatient Rita', $4)`,
      [personaId, organizationId, projectId, personaVersionId],
    );
    await client.query(
      "insert into persona_version (id, persona_id, version, traits) values ($1, $2, 1, '{}'::jsonb)",
      [personaVersionId, personaId],
    );
    await client.query(
      `insert into test (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Reschedules a booked appointment', $4)`,
      [testId, organizationId, projectId, testVersionId],
    );
    await client.query(
      `insert into test_version (id, test_id, version, content)
       values ($1, $2, 1, '{"scenario": "Moves a booking", "expectedBehaviors": ["verifies who it is speaking to"]}'::jsonb)`,
      [testVersionId, testId],
    );
    await client.query("commit");
    await client.query(
      `insert into run
         (id, organization_id, project_id, agent_id, connection_id, status, triggered_via,
          requested_personas, connection_snapshot, expected_simulation_count)
       values ($1, $2, $3, $4, $5, 'pending', 'manual', $6::jsonb, $7::jsonb, 1)`,
      [
        runId,
        organizationId,
        projectId,
        agentId,
        connectionId,
        JSON.stringify({ personaIds: [personaId] }),
        JSON.stringify({
          type: "retell",
          modality: "chat",
          topology: "hosted-broker",
          environment: null,
          config: {},
        }),
      ],
    );
    await client.query(
      `insert into simulation
         (id, run_id, organization_id, project_id, agent_id, connection_id,
          persona_id, persona_version_id, position, connection_type, modality, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'retell', 'chat', 'queued')`,
      [
        simulationId,
        runId,
        organizationId,
        projectId,
        agentId,
        connectionId,
        personaId,
        personaVersionId,
      ],
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeThePin, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds simulations", async () => {
    const result = await runMigrations(database.url);
    expect(result.applied[0]).toBe("0009_simulation_test_pin.sql");
    expect(result.applied.every((name) => name >= "0009")).toBe(true);
  });

  it("leaves the simulation that was already there exactly as it was, pinning nothing", async () => {
    const { rows } = await client.query<{
      id: string;
      persona_version_id: string;
      status: string;
      test_id: string | null;
      test_version_id: string | null;
    }>(
      "select id, persona_version_id, status, test_id, test_version_id from simulation",
    );
    expect(rows).toEqual([
      {
        id: simulationId,
        persona_version_id: personaVersionId,
        status: "queued",
        test_id: null,
        test_version_id: null,
      },
    ]);
  });

  it("lets that same row be pinned afterwards, which is what the column is for", async () => {
    await client.query(
      "update simulation set test_id = $1, test_version_id = $2 where id = $3",
      [testId, testVersionId, simulationId],
    );

    const { rows } = await client.query<{
      test_id: string;
      test_version_id: string;
    }>("select test_id, test_version_id from simulation where id = $1", [
      simulationId,
    ]);
    expect(rows).toEqual([
      { test_id: testId, test_version_id: testVersionId },
    ]);
  });
});
