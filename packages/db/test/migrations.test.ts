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

/**
 * An instance that has been running since before a migration is the case a
 * migration is actually for, and it is the one an empty database never tests:
 * every check above starts from nothing, where a column added `not null` with
 * no default lands happily and would fail the moment a single row existed.
 *
 * So this applies the schema as it stood one migration ago, puts a customer's
 * work into it, and then upgrades — which is what a self-hoster's `docker
 * compose pull` does on a Tuesday morning.
 */
describe("upgrading an instance that already holds work", () => {
  let database: EmptyDatabase;
  /** The migration files, minus the newest, as an earlier release shipped them. */
  let asItWas: string;

  beforeAll(async () => {
    database = await createEmptyDatabase("upgrade");
    asItWas = await mkdtemp(path.join(os.tmpdir(), "egma-upgrade-"));
  });

  afterAll(async () => {
    await database.drop();
    await rm(asItWas, { recursive: true, force: true });
  });

  it("applies the newest migration over rows the release before it wrote", async () => {
    const migrations = await readMigrations();
    const newest = migrations.at(-1);
    if (newest === undefined) throw new Error("there are no migrations");

    for (const migration of migrations.slice(0, -1)) {
      await writeFile(path.join(asItWas, migration.name), migration.sql);
    }
    const before = await runMigrations(database.url, asItWas);
    expect(before.applied).toEqual(
      migrations.slice(0, -1).map((migration) => migration.name),
    );

    // A customer's work, written the way the release before this one wrote it:
    // a run over a connection, and one conversation inside it.
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    const organization = newId("org");
    const project = newId("prj");
    const agent = newId("agt");
    const connection = newId("con");
    const personaId = newId("prs");
    const personaVersion = newId("prsv");
    const run = newId("run");
    const simulation = newId("sim");
    try {
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

      // The upgrade itself, with that work sitting in the tables.
      await writeFile(path.join(asItWas, newest.name), newest.sql);
      const upgraded = await runMigrations(database.url, asItWas);
      expect(upgraded.applied).toEqual([newest.name]);

      // The run is still there, and it says what is true of it: it pinned no
      // version, because no run could when it was started.
      const { rows: runs } = await client.query<{
        id: string;
        pinned_test_versions: { testVersionIds: string[] };
      }>("select id, pinned_test_versions from run where id = $1", [run]);
      expect(runs[0]?.pinned_test_versions).toEqual({ testVersionIds: [] });

      // And so does its conversation: no test, rather than one invented for it.
      const { rows: simulations } = await client.query<{
        test_id: string | null;
        test_version_id: string | null;
      }>("select test_id, test_version_id from simulation where id = $1", [
        simulation,
      ]);
      expect(simulations[0]).toEqual({ test_id: null, test_version_id: null });

      // The default is gone with the backfill, so the next run has to say what
      // it pinned rather than inheriting a blank.
      await expect(
        client.query(
          `insert into run
             (id, organization_id, project_id, agent_id, connection_id, status,
              triggered_via, requested_personas, connection_snapshot, expected_simulation_count)
           values ($1, $2, $3, $4, $5, 'pending', 'manual', '{}'::jsonb, '{}'::jsonb, 1)`,
          [newId("run"), organization, project, agent, connection],
        ),
      ).rejects.toThrow(/pinned_test_versions/u);

      // And the record the upgrade brings is a record: an event written over
      // the work that was already here cannot be rewritten afterwards.
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
    } finally {
      await client.end();
    }
  });
});
