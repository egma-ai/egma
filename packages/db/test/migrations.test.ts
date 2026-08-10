import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newId } from "@egma/ids";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MIGRATION_ADVISORY_LOCK,
  MIGRATIONS_DIRECTORY,
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

  /**
   * **One sequence, counted from zero with no gaps.** Two efforts landing at
   * once is exactly how a repository ends up with two migrations wearing one
   * number: each takes the next free one from where it was standing, and a
   * self-hoster upgrading across both applies whichever of them sorted first
   * and never learns the other existed. So the numbers are held dense and
   * unrepeated here, where a merge that doubled one fails rather than ships.
   */
  it("are one dense sequence, each number used once", async () => {
    const numbers = (await readMigrations()).map((migration) =>
      Number(migration.name.slice(0, 4)),
    );
    expect(numbers).toEqual(numbers.map((_, index) => index));
  });

  /**
   * The journal is drizzle's own bookkeeping — nothing applies from it, the
   * plain SQL above is what boot reads — and it is what the generator diffs the
   * next migration against. A journal that disagrees with the files is a
   * generator working from a schema no instance ever had, so it is held to the
   * same story: the same tags, in the same order, one entry each.
   */
  it("are the same story the generator's journal tells", async () => {
    const journal = JSON.parse(
      await readFile(
        path.join(MIGRATIONS_DIRECTORY, "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: readonly { idx: number; tag: string }[] };
    const files = (await readMigrations()).map((migration) =>
      migration.name.replace(/\.sql$/, ""),
    );

    expect(journal.entries.map((entry) => entry.tag)).toEqual(files);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      files.map((_, index) => index),
    );
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

describe("the re-grade's narrowing (0013)", () => {
  let database: EmptyDatabase;
  let beforeTheNarrowing: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  const jobId = newId("gjb");
  const traceId = "0123456789abcdef0123456789abcdef";

  beforeAll(async () => {
    database = await createEmptyDatabase("regrade_narrowing");

    // The world as it was: every migration before the narrowing, in a directory
    // of its own, so a conversation egma has already judged is sitting in the
    // queue when 0013 arrives on top of it.
    beforeTheNarrowing = await mkdtemp(
      path.join(os.tmpdir(), "egma-before-0013-"),
    );
    for (const migration of await readMigrations()) {
      if (migration.name < "0013") {
        await writeFile(
          path.join(beforeTheNarrowing, migration.name),
          migration.sql,
        );
      }
    }
    await runMigrations(database.url, beforeTheNarrowing);

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
    // A production trace's job, because it is the source that needs no run and
    // no simulation behind it — and a *graded* one, because a settled job is
    // exactly what the check 0013 brings is about: a deployment with judged
    // conversations in it must take the constraint rather than be rejected by it.
    await client.query(
      `insert into grading_job
         (id, organization_id, project_id, source, trace_id, status,
          first_span_at, last_span_at, last_seen_at, root_closed_at,
          attempts, finished_at)
       values ($1, $2, $3, 'production', $4, 'graded',
               now(), now(), now(), now(), 1, now())`,
      [jobId, organizationId, projectId, traceId],
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheNarrowing, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds judged conversations", async () => {
    const result = await runMigrations(database.url);
    expect(result.applied[0]).toBe("0013_regrade_narrowing.sql");
    expect(result.applied.every((name) => name >= "0013")).toBe(true);
  });

  it("leaves the job that was already there narrowed to nothing, which is what every job starts as", async () => {
    const { rows } = await client.query<{
      id: string;
      status: string;
      regrade_grader_id: string | null;
    }>("select id, status, regrade_grader_id from grading_job");

    expect(rows).toEqual([
      { id: jobId, status: "graded", regrade_grader_id: null },
    ]);
  });

  it("brings the check that keeps a narrowing on work still outstanding", async () => {
    // The settled row above is why this constraint could be added at all: it
    // validates every row already in the table, and a null narrowing satisfies
    // it whatever state the job is in.
    const { rows } = await client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'grading_job_only_outstanding_work_is_narrowed'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toContain("regrade_grader_id IS NULL");
    expect(rows[0]?.definition).toContain("'pending'");
    expect(rows[0]?.definition).toContain("'claimed'");
  });

  it("points the column at the grader table, so a narrowing names a grader that exists", async () => {
    const { rows } = await client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'grading_job_regrade_grader_id_grader_id_fk'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toMatch(
      /FOREIGN KEY \(regrade_grader_id\) REFERENCES grader\(id\)/,
    );
  });
});

describe("the run-events record and the run's pin (0014)", () => {
  let database: EmptyDatabase;
  /** The schema as it stood before the record, in a directory of its own. */
  let beforeTheRecord: string;
  let client: pg.Client;

  const organization = newId("org");
  const project = newId("prj");
  const agent = newId("agt");
  const connection = newId("con");
  const personaId = newId("prs");
  const personaVersion = newId("prsv");
  const run = newId("run");
  const simulation = newId("sim");

  beforeAll(async () => {
    database = await createEmptyDatabase("run_events_upgrade");
    beforeTheRecord = await mkdtemp(path.join(os.tmpdir(), "egma-before-0014-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0014") {
        await writeFile(
          path.join(beforeTheRecord, migration.name),
          migration.sql,
        );
      }
    }
    await runMigrations(database.url, beforeTheRecord);

    // A customer's work, written the way that release wrote it: a run over a
    // connection, one conversation inside it, and no pinned-version column
    // anywhere — which is exactly what 0014 has to upgrade over.
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organization],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [project, organization],
    );
    await client.query(
      "insert into agent (id, organization_id, project_id, name) values ($1, $2, $3, 'Front desk')",
      [agent, organization, project],
    );
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
       values ($1, $2, $3, $4, 'retell-1', 'retell', 'chat', 'hosted-broker', '{}'::jsonb)`,
      [connection, organization, project, agent],
    );
    await client.query("begin");
    await client.query(
      `insert into persona (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Impatient Rita', $4)`,
      [personaId, organization, project, personaVersion],
    );
    await client.query(
      "insert into persona_version (id, persona_id, version, traits) values ($1, $2, 1, '{}'::jsonb)",
      [personaVersion, personaId],
    );
    await client.query("commit");
    await client.query(
      `insert into run
         (id, organization_id, project_id, agent_id, connection_id, status,
          triggered_via, requested_personas, connection_snapshot, expected_simulation_count)
       values ($1, $2, $3, $4, $5, 'pending', 'manual', $6::jsonb, $7::jsonb, 1)`,
      [
        run,
        organization,
        project,
        agent,
        connection,
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
        simulation,
        run,
        organization,
        project,
        agent,
        connection,
        personaId,
        personaVersion,
      ],
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheRecord, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds work", async () => {
    const result = await runMigrations(database.url);
    expect(result.applied[0]).toBe("0014_run_events.sql");
    expect(result.applied.every((name) => name >= "0014")).toBe(true);
  });

  it("says what is true of the run that was already there: it pinned no version", async () => {
    const { rows } = await client.query<{
      pinned_test_versions: { testVersionIds: string[] };
    }>("select pinned_test_versions from run where id = $1", [run]);
    expect(rows[0]?.pinned_test_versions).toEqual({ testVersionIds: [] });
  });

  it("drops the backfill's default, so the next run has to say what it pinned", async () => {
    await expect(
      client.query(
        `insert into run
           (id, organization_id, project_id, agent_id, connection_id, status,
            triggered_via, requested_personas, connection_snapshot, expected_simulation_count)
         values ($1, $2, $3, $4, $5, 'pending', 'manual', '{}'::jsonb, '{}'::jsonb, 1)`,
        [newId("run"), organization, project, agent, connection],
      ),
    ).rejects.toThrow(/pinned_test_versions/u);
  });

  it("brings a record that is a record: an event cannot be rewritten afterwards", async () => {
    await client.query(
      `insert into run_event
         (run_id, seq, organization_id, project_id, kind, status)
       values ($1, 1, $2, $3, 'run', 'pending')`,
      [run, organization, project],
    );
    await expect(
      client.query(
        "update run_event set status = 'running' where run_id = $1 and seq = 1",
        [run],
      ),
    ).rejects.toThrow(/is written once/u);
  });
});


describe("the dispatch-failure vocabulary (0015)", () => {
  let database: EmptyDatabase;
  /** The schema as it stood before the widened word, in a directory of its own. */
  let beforeTheWord: string;
  let client: pg.Client;

  const organization = newId("org");
  const project = newId("prj");
  const agent = newId("agt");
  const connection = newId("con");
  const personaId = newId("prs");
  const personaVersion = newId("prsv");
  const run = newId("run");
  const claimed = newId("sim");
  const landed = newId("sim");

  beforeAll(async () => {
    database = await createEmptyDatabase("dispatch_failure_upgrade");
    beforeTheWord = await mkdtemp(path.join(os.tmpdir(), "egma-before-0015-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0015") {
        await writeFile(path.join(beforeTheWord, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, beforeTheWord);

    // A customer's work as that release wrote it: a run over a connection,
    // one conversation still queued, and one already landed with the old
    // vocabulary — because 0015 re-validates the widened checks over every
    // row that exists, so they have to hold for what the old release wrote.
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organization],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [project, organization],
    );
    await client.query(
      "insert into agent (id, organization_id, project_id, name) values ($1, $2, $3, 'Front desk')",
      [agent, organization, project],
    );
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
       values ($1, $2, $3, $4, 'retell-1', 'retell', 'chat', 'hosted-broker', '{}'::jsonb)`,
      [connection, organization, project, agent],
    );
    await client.query("begin");
    await client.query(
      `insert into persona (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Impatient Rita', $4)`,
      [personaId, organization, project, personaVersion],
    );
    await client.query(
      "insert into persona_version (id, persona_id, version, traits) values ($1, $2, 1, '{}'::jsonb)",
      [personaVersion, personaId],
    );
    await client.query("commit");
    await client.query(
      `insert into run
         (id, organization_id, project_id, agent_id, connection_id, status,
          triggered_via, pinned_test_versions, requested_personas,
          connection_snapshot, expected_simulation_count)
       values ($1, $2, $3, $4, $5, 'pending', 'manual', $6::jsonb, $7::jsonb,
          $8::jsonb, 2)`,
      [
        run,
        organization,
        project,
        agent,
        connection,
        JSON.stringify({ testVersionIds: [] }),
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
          persona_id, persona_version_id, position, connection_type, modality,
          status, claimed_by, claimed_at, heartbeat_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'retell', 'chat', 'claimed',
          'simulator-blue-1', now(), now())`,
      [
        claimed,
        run,
        organization,
        project,
        agent,
        connection,
        personaId,
        personaVersion,
      ],
    );
    await client.query(
      `insert into simulation
         (id, run_id, organization_id, project_id, agent_id, connection_id,
          persona_id, persona_version_id, position, connection_type, modality,
          status, ending_reason, claimed_by, claimed_at, heartbeat_at, ended_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 2, 'retell', 'chat',
          'failed', 'simulator_error', 'simulator-blue-1', now(), now(), now())`,
      [
        landed,
        run,
        organization,
        project,
        agent,
        connection,
        personaId,
        personaVersion,
      ],
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheWord, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds landed work", async () => {
    const result = await runMigrations(database.url);
    expect(result.applied[0]).toBe("0015_dispatch_failure.sql");
    expect(result.applied.every((name) => name >= "0015")).toBe(true);
  });

  it("keeps what was already true: the landed conversation keeps its reason", async () => {
    const { rows } = await client.query<{ ending_reason: string }>(
      "select ending_reason from simulation where id = $1",
      [landed],
    );
    expect(rows[0]?.ending_reason).toBe("simulator_error");
  });

  it("lets a claimed row the old release wrote take the landing the upgrade brings", async () => {
    await client.query(
      `update simulation
       set status = 'failed', ending_reason = 'dispatch_failed', ended_at = now()
       where id = $1`,
      [claimed],
    );
    const { rows } = await client.query<{ ending_reason: string }>(
      "select ending_reason from simulation where id = $1",
      [claimed],
    );
    expect(rows[0]?.ending_reason).toBe("dispatch_failed");
  });

  it("holds the widened word to its class: a way to have failed, never to have ended", async () => {
    await expect(
      client.query(
        `insert into simulation
           (id, run_id, organization_id, project_id, agent_id, connection_id,
            persona_id, persona_version_id, position, modality,
            status, ending_reason, claimed_by, claimed_at, heartbeat_at,
            started_at, ended_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 3, 'chat',
            'completed', 'dispatch_failed', 'simulator-blue-1', now(), now(),
            now(), now())`,
        [
          newId("sim"),
          run,
          organization,
          project,
          agent,
          connection,
          personaId,
          personaVersion,
        ],
      ),
    ).rejects.toThrow(/simulation_ending_reason_agrees/u);
  });

  it("lets the record speak the widened word, and stay a record", async () => {
    await client.query(
      `insert into run_event
         (run_id, seq, organization_id, project_id, kind, simulation_id, status, reason)
       values ($1, 1, $2, $3, 'simulation', $4, 'failed', 'dispatch_failed')`,
      [run, organization, project, claimed],
    );
    await expect(
      client.query(
        "update run_event set reason = 'simulator_error' where run_id = $1 and seq = 1",
        [run],
      ),
    ).rejects.toThrow(/is written once/u);
  });
});

/* ------------------------------------------------------------------- *
 * Seeding a customer's work the way an older release wrote it.
 * ------------------------------------------------------------------- */

/**
 * Everything one seeded run is made of: the tenancy above it, the agent it
 * reaches over one connection, the persona at one version, and the run itself.
 *
 * Written by hand rather than through the data-access module, on purpose. The
 * point of an upgrade check is what the *older* release wrote, and the module
 * writes what today's schema takes — so seeding through it would put today's
 * rows in and then congratulate the migration for coping with them.
 */
type ACustomersWork = {
  readonly organization: string;
  readonly project: string;
  readonly agent: string;
  readonly connection: string;
  readonly personaId: string;
  readonly personaVersion: string;
  readonly run: string;
  /** How many conversations the run says it expects, which its rows must match. */
  readonly expected: number;
};

async function seedACustomersWork(
  client: pg.Client,
  work: ACustomersWork,
): Promise<void> {
  await client.query(
    "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
    [work.organization],
  );
  await client.query(
    "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
    [work.project, work.organization],
  );
  await client.query(
    "insert into agent (id, organization_id, project_id, name) values ($1, $2, $3, 'Front desk')",
    [work.agent, work.organization, work.project],
  );
  await client.query(
    `insert into connection
       (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
     values ($1, $2, $3, $4, 'retell-1', 'retell', 'chat', 'hosted-broker', '{}'::jsonb)`,
    [work.connection, work.organization, work.project, work.agent],
  );
  // The persona and the version name each other, so they go in together.
  await client.query("begin");
  await client.query(
    `insert into persona (id, organization_id, project_id, name, current_version_id)
     values ($1, $2, $3, 'Impatient Rita', $4)`,
    [work.personaId, work.organization, work.project, work.personaVersion],
  );
  await client.query(
    "insert into persona_version (id, persona_id, version, traits) values ($1, $2, 1, '{}'::jsonb)",
    [work.personaVersion, work.personaId],
  );
  await client.query("commit");
  await client.query(
    `insert into run
       (id, organization_id, project_id, agent_id, connection_id, status,
        triggered_via, pinned_test_versions, requested_personas,
        connection_snapshot, expected_simulation_count)
     values ($1, $2, $3, $4, $5, 'pending', 'manual', $6::jsonb, $7::jsonb,
        $8::jsonb, $9)`,
    [
      work.run,
      work.organization,
      work.project,
      work.agent,
      work.connection,
      JSON.stringify({ testVersionIds: [] }),
      JSON.stringify({ personaIds: [work.personaId] }),
      JSON.stringify({
        type: "retell",
        modality: "chat",
        topology: "hosted-broker",
        environment: null,
        config: {},
      }),
      work.expected,
    ],
  );
}

/**
 * Where one seeded conversation stood when the older release stopped writing
 * it: still waiting, finished, or landed by that release's own claim path as
 * work it could never hand over.
 */
type SimulationShape = "queued" | "completed" | "dispatch_failed";

async function insertSimulation(
  client: pg.Client,
  work: ACustomersWork,
  simulation: {
    readonly id: string;
    readonly position: number;
    readonly shape: SimulationShape;
    /** Chat unless a case needs the audio facts, which only voice may hold. */
    readonly modality?: "chat" | "voice" | undefined;
    /**
     * What the conversation was, for a release that kept it in the row's
     * three jsonb columns. Written in the insert rather than an update
     * afterwards, because a terminal simulation is written once and the row
     * itself enforces that.
     */
    readonly conversation?:
      | {
          readonly transcript: unknown;
          readonly events: unknown;
          readonly metrics: unknown;
        }
      | undefined;
  },
): Promise<void> {
  const landing = {
    queued: { columns: "", values: ", 'queued'" },
    completed: {
      columns: `, claimed_by, claimed_at, heartbeat_at, started_at, ended_at,
                ending_reason`,
      values: `, 'completed', 'simulator-blue-1', now(), now(), now(), now(),
               'persona_concluded'`,
    },
    dispatch_failed: {
      columns: ", claimed_by, claimed_at, heartbeat_at, ended_at, ending_reason",
      values: `, 'failed', 'simulator-blue-1', now(), now(), now(),
               'dispatch_failed'`,
    },
  }[simulation.shape];

  // The conversation's three slots come last in the parameter list, so a
  // statement that does not name them simply stops before them.
  const held = simulation.conversation;
  await client.query(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, position, connection_type, modality,
        status${landing.columns}${
          held === undefined ? "" : ", transcript, events, metrics"
        })
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'retell', $10${landing.values}${
       held === undefined ? "" : ", $11::jsonb, $12::jsonb, $13::jsonb"
     })`,
    [
      simulation.id,
      work.run,
      work.organization,
      work.project,
      work.agent,
      work.connection,
      work.personaId,
      work.personaVersion,
      simulation.position,
      simulation.modality ?? "chat",
      ...(held === undefined
        ? []
        : [
            JSON.stringify(held.transcript),
            JSON.stringify(held.events),
            JSON.stringify(held.metrics),
          ]),
    ],
  );
}

describe("the simulation's summary facts (0016)", () => {
  let database: EmptyDatabase;
  /** The schema as it stood before the two facts, in a directory of its own. */
  let beforeTheFacts: string;
  let client: pg.Client;

  const work: ACustomersWork = {
    organization: newId("org"),
    project: newId("prj"),
    agent: newId("agt"),
    connection: newId("con"),
    personaId: newId("prs"),
    personaVersion: newId("prsv"),
    run: newId("run"),
    expected: 3,
  };
  const queued = newId("sim");
  const landed = newId("sim");
  const undispatched = newId("sim");

  beforeAll(async () => {
    database = await createEmptyDatabase("summary_facts_upgrade");
    beforeTheFacts = await mkdtemp(path.join(os.tmpdir(), "egma-before-0016-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0016") {
        await writeFile(path.join(beforeTheFacts, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, beforeTheFacts);

    // A customer's work as that release wrote it: one conversation still
    // queued, one finished, and one that release's own claim path landed as
    // dispatch_failed. The last two are the rows the new columns are about,
    // and the rows their guards re-validate on the way in.
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await seedACustomersWork(client, work);
    await insertSimulation(client, work, {
      id: queued,
      position: 1,
      shape: "queued",
    });
    await insertSimulation(client, work, {
      id: landed,
      position: 2,
      shape: "completed",
    });
    await insertSimulation(client, work, {
      id: undispatched,
      position: 3,
      shape: "dispatch_failed",
    });
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheFacts, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds landed work", async () => {
    const result = await runMigrations(database.url);
    expect(result.applied[0]).toBe("0016_simulation_summary_facts.sql");
    expect(result.applied.every((name) => name >= "0016")).toBe(true);
  });

  it("says what is true of the conversations that already landed: no facts", async () => {
    // No turn count and no provider reference, because no report could carry
    // either when they landed — never a number invented for them.
    const { rows } = await client.query<{
      turn_count: number | null;
      provider_reference: string | null;
    }>(
      `select turn_count, provider_reference from simulation
        where id in ($1, $2)`,
      [landed, undispatched],
    );
    expect(rows).toEqual([
      { turn_count: null, provider_reference: null },
      { turn_count: null, provider_reference: null },
    ]);
  });

  it("brings the columns with their guard: a summary fact is a terminal fact", async () => {
    await expect(
      client.query("update simulation set turn_count = 3 where id = $1", [
        queued,
      ]),
    ).rejects.toThrow(/simulation_summary_facts_only_when_ended/u);
  });
});

/**
 * An instance that has been running since before a migration is the case a
 * migration is actually for, and it is the one an empty database never tests:
 * every check above starts from nothing, where a column added `not null` with
 * no default lands happily and would fail the moment a single row existed.
 *
 * So this applies the schema as it stood one migration ago, puts a customer's
 * work into it, and then upgrades — which is what a self-hoster's `docker
 * compose pull` does on a Tuesday morning.
 *
 * It named the *newest* migration to do that, and this is where that graduated:
 * the seed rows below write `transcript`, `events` and `metrics`, which is a
 * story only 0017 can tell, because 0017 is the migration that drops them. Read
 * through `at(-1)` it broke the moment anything landed after — the columns it
 * seeds no longer exist by then — so it names its own migration now, and the
 * newest migration's upgrade story lives in that migration's own describe, the
 * way the livekit type's does below.
 */
describe("the conversation leaving the row, over work already there (0017)", () => {
  let database: EmptyDatabase;
  /** The migration files, up to 0017's predecessor, as that release shipped. */
  let asItWas: string;

  beforeAll(async () => {
    database = await createEmptyDatabase("upgrade");
    asItWas = await mkdtemp(path.join(os.tmpdir(), "egma-upgrade-"));
  });

  afterAll(async () => {
    await database.drop();
    await rm(asItWas, { recursive: true, force: true });
  });

  it("applies 0017 over rows the release before it wrote", async () => {
    const migrations = await readMigrations();
    const subject = migrations.findIndex((migration) =>
      migration.name.startsWith("0017_"),
    );
    if (subject === -1) throw new Error("0017 is missing");
    const newest = migrations[subject];
    if (newest === undefined) throw new Error("0017 is missing");
    const before0017 = migrations.slice(0, subject);

    for (const migration of before0017) {
      await writeFile(path.join(asItWas, migration.name), migration.sql);
    }
    const before = await runMigrations(database.url, asItWas);
    expect(before.applied).toEqual(
      before0017.map((migration) => migration.name),
    );

    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    const work: ACustomersWork = {
      organization: newId("org"),
      project: newId("prj"),
      agent: newId("agt"),
      connection: newId("con"),
      personaId: newId("prs"),
      personaVersion: newId("prsv"),
      run: newId("run"),
      expected: 3,
    };
    const queued = newId("sim");
    const landed = newId("sim");
    const dialing = newId("sim");
    try {
      // A customer's work, written the way the release before this one wrote
      // it: one conversation still queued, and one finished with its
      // transcript, its tool calls and its measures in the three jsonb
      // columns — because that release had nowhere else to put them. Those
      // columns are what this migration drops, so a row that actually holds
      // a conversation is the row the upgrade has to survive.
      await seedACustomersWork(client, work);
      await insertSimulation(client, work, {
        id: queued,
        position: 1,
        shape: "queued",
      });
      await insertSimulation(client, work, {
        id: landed,
        position: 2,
        shape: "completed",
        conversation: {
          transcript: [
            { speaker: "human", text: "Can you move my cleaning to Tuesday?" },
            { speaker: "agent", text: "Booked for Tuesday at four." },
          ],
          events: [{ kind: "tool_call", name: "reschedule_appointment" }],
          metrics: { turn_response_latency: [900, 1_100] },
        },
      });
      // And one voice conversation still waiting, because the check this
      // migration shrinks guards the audio facts and only voice may hold one.
      await insertSimulation(client, work, {
        id: dialing,
        position: 3,
        shape: "queued",
        modality: "voice",
      });

      // The upgrade itself, with that work sitting in the tables.
      await writeFile(path.join(asItWas, newest.name), newest.sql);
      const upgraded = await runMigrations(database.url, asItWas);
      expect(upgraded.applied).toEqual([newest.name]);

      // The three columns are gone from the table — asked of the schema
      // rather than of a row, because a column nobody selects any more is
      // not the same fact as a column that does not exist.
      const { rows: left } = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'simulation'
            and column_name in ('transcript', 'events', 'metrics')`,
      );
      expect(left).toEqual([]);

      // And the conversations survive losing them, because what the row was
      // ever the record of is the lifecycle: both still read, unchanged.
      const { rows: kept } = await client.query<{
        id: string;
        status: string;
        ending_reason: string | null;
      }>(
        `select id, status, ending_reason from simulation
          where run_id = $1 order by position`,
        [work.run],
      );
      expect(kept).toEqual([
        { id: queued, status: "queued", ending_reason: null },
        { id: landed, status: "completed", ending_reason: "persona_concluded" },
        { id: dialing, status: "queued", ending_reason: null },
      ]);

      // The check that named the three columns shrinks to the audio facts
      // rather than being renamed, so a violation still prints the sentence
      // an operator is searching for — and it still guards them.
      await expect(
        client.query(
          "update simulation set recording_reference = 'r.wav' where id = $1",
          [dialing],
        ),
      ).rejects.toThrow(/simulation_report_only_when_ended/u);

      // And the shrunken check no longer names what is gone. A check holding
      // a dropped column could not exist, so this is what says the shrink
      // happened rather than the drop having been quietly refused.
      const { rows: guards } = await client.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition from pg_constraint
          where conname = 'simulation_report_only_when_ended'`,
      );
      expect(guards).toHaveLength(1);
      expect(guards[0]?.definition).toContain("recording_reference");
      expect(guards[0]?.definition).not.toContain("transcript");
    } finally {
      await client.end();
    }
  });
});

describe("the livekit connection type (0018)", () => {
  let database: EmptyDatabase;
  let beforeLiveKit: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  const agentId = newId("agt");
  const retellId = newId("con");

  /** A connection row, written straight past the access layer's own gates. */
  async function connectionOfType(id: string, type: string): Promise<void> {
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
       values ($1, $2, $3, $4, $5, $6, 'voice', 'agent-dials-out', '{}'::jsonb)`,
      [id, organizationId, projectId, agentId, `${type}-1`, type],
    );
  }

  beforeAll(async () => {
    database = await createEmptyDatabase("livekit_type");

    // The world as it was: a customer already reaching an agent the ways egma
    // knew, so the widening lands on a table that is not empty.
    beforeLiveKit = await mkdtemp(path.join(os.tmpdir(), "egma-before-0018-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0018") {
        await writeFile(path.join(beforeLiveKit, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, beforeLiveKit);

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
       values ($1, $2, $3, $4, 'retell-1', 'retell', 'chat', 'hosted-broker', '{}'::jsonb)`,
      [retellId, organizationId, projectId, agentId],
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeLiveKit, { recursive: true, force: true });
    await database.drop();
  });

  it("is what the database refuses until the migration arrives", async () => {
    await expect(connectionOfType(newId("con"), "livekit")).rejects.toThrow(
      /connection_type_allowed/u,
    );
  });

  it("is what is still pending on a database that already holds connections", async () => {
    // Through 0018 and no further, the way the block below it stops at 0017.
    // What this block asserts next — the two checks the one list of types
    // feeds — is true of the schema 0018 left behind and stopped being true of
    // the newest schema the moment a later migration dropped one of them. A
    // migration's own describe is about the upgrade that migration is, so it
    // names the file it is about rather than reading whatever is newest.
    const widening = (await readMigrations()).find((migration) =>
      migration.name.startsWith("0018_"),
    );
    if (widening === undefined) throw new Error("0018 is missing");
    await writeFile(path.join(beforeLiveKit, widening.name), widening.sql);

    const result = await runMigrations(database.url, beforeLiveKit);
    expect(result.applied).toEqual(["0018_livekit_connection_type.sql"]);
  });

  it("adds livekit to the two checks the one list of types feeds, and nothing else", async () => {
    const { rows } = await client.query<{ name: string; definition: string }>(
      `select conname as name, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conname in ('connection_type_allowed', 'simulation_connection_type_allowed')
        order by conname`,
    );

    expect(rows.map((row) => row.name)).toEqual([
      "connection_type_allowed",
      "simulation_connection_type_allowed",
    ]);
    for (const row of rows) {
      // The whole list rather than a search for "livekit": what a widening
      // must never do is quietly drop a type somebody is already reaching an
      // agent through.
      expect(row.definition).toContain(
        "ARRAY['retell'::text, 'phone'::text, 'livekit'::text]",
      );
    }
  });

  it("leaves the connections that were already there exactly as they were", async () => {
    const { rows } = await client.query<{ id: string; type: string }>(
      "select id, type from connection",
    );
    expect(rows).toEqual([{ id: retellId, type: "retell" }]);
  });

  it("takes a livekit connection once it has run", async () => {
    const livekitId = newId("con");
    await connectionOfType(livekitId, "livekit");

    const { rows } = await client.query<{ type: string }>(
      "select type from connection where id = $1",
      [livekitId],
    );
    expect(rows).toEqual([{ type: "livekit" }]);
  });
});

describe("the connection type leaving the simulation row (0019)", () => {
  let database: EmptyDatabase;
  /** The schema as it stood while the copy was still there, on its own. */
  let beforeTheDrop: string;
  let client: pg.Client;

  const work: ACustomersWork = {
    organization: newId("org"),
    project: newId("prj"),
    agent: newId("agt"),
    connection: newId("con"),
    personaId: newId("prs"),
    personaVersion: newId("prsv"),
    run: newId("run"),
    expected: 2,
  };
  const queued = newId("sim");
  const landed = newId("sim");

  beforeAll(async () => {
    database = await createEmptyDatabase("connection_type_drop");
    beforeTheDrop = await mkdtemp(path.join(os.tmpdir(), "egma-before-0019-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0019") {
        await writeFile(path.join(beforeTheDrop, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, beforeTheDrop);

    // A customer's work as the release before this one wrote it: every
    // simulation carrying its own copy of the connection type, which is the
    // column the upgrade takes away underneath them.
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await seedACustomersWork(client, work);
    await insertSimulation(client, work, {
      id: queued,
      position: 1,
      shape: "queued",
    });
    await insertSimulation(client, work, {
      id: landed,
      position: 2,
      shape: "completed",
    });
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheDrop, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds conversations", async () => {
    const result = await runMigrations(database.url);
    expect(result.applied[0]).toBe(
      "0019_simulation_connection_type_leaves_the_row.sql",
    );
    expect(result.applied.every((name) => name >= "0019")).toBe(true);
  });

  it("takes the check and the column, in that order and both", async () => {
    // Asked of the schema rather than of a row: a column nothing selects any
    // more is not the same fact as a column that does not exist, and a check
    // left behind on a dropped column could not exist at all — so the two
    // questions together are what say the drop happened as one piece.
    const { rows: left } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'simulation' and column_name = 'connection_type'`,
    );
    expect(left).toEqual([]);

    const { rows: guards } = await client.query<{ name: string }>(
      `select conname as name from pg_constraint
        where conname = 'simulation_connection_type_allowed'`,
    );
    expect(guards).toEqual([]);
  });

  it("leaves the conversations that were already there exactly as they were", async () => {
    const { rows } = await client.query<{
      id: string;
      status: string;
      ending_reason: string | null;
    }>(
      `select id, status, ending_reason from simulation
        where run_id = $1 order by position`,
      [work.run],
    );
    expect(rows).toEqual([
      { id: queued, status: "queued", ending_reason: null },
      { id: landed, status: "completed", ending_reason: "persona_concluded" },
    ]);
  });

  it("keeps the check that guards what a connection may be, which is the other one", async () => {
    // The type is still enumerated where it is the source of truth. Dropping
    // this one instead would leave the copy constrained and the original open,
    // which is the mistake this asks about by name.
    const { rows } = await client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'connection_type_allowed'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toContain(
      "ARRAY['retell'::text, 'phone'::text, 'livekit'::text]",
    );
  });

  it("keeps modality, which rides the row for a reason the type never had", async () => {
    // The row's own check names it, and a CHECK cannot join — which is why
    // this column stayed where the type went. A recording on a conversation
    // that was not voice is still refused by the row itself, and the write
    // that proves it names no connection type at all.
    await expect(
      client.query(
        `insert into simulation
           (id, run_id, organization_id, project_id, agent_id, connection_id,
            persona_id, persona_version_id, position, modality, status,
            ending_reason, claimed_by, claimed_at, heartbeat_at, started_at,
            ended_at, recording_reference)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 3, 'chat', 'completed',
            'persona_concluded', 'simulator-blue-1', now(), now(), now(),
            now(), 'r.wav')`,
        [
          newId("sim"),
          work.run,
          work.organization,
          work.project,
          work.agent,
          work.connection,
          work.personaId,
          work.personaVersion,
        ],
      ),
    ).rejects.toThrow(/simulation_audio_facts_are_voice_facts/u);

    const { rows } = await client.query<{ name: string }>(
      `select conname as name from pg_constraint
        where conname = 'simulation_modality_allowed'`,
    );
    expect(rows).toHaveLength(1);
  });
});
