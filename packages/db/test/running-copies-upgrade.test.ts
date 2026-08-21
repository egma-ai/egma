import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { newId } from "@egma/ids";
import {
  connect,
  disconnect,
  PREDEFINED_GRADERS,
  seedGraderLibrary,
  seedRunningGraders,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readMigrations, runMigrations } from "../src/migrate.ts";
import {
  createEmptyDatabase,
  type EmptyDatabase,
  openSingleConnection,
  type SingleConnection,
  TEST_ENCRYPTION_KEY,
} from "./support/database.ts";

/**
 * **The upgrade a deployment that already had graders takes — and the proof it
 * does not quietly stop being judged.**
 *
 * `0026_running_copies` is destructive on purpose, and its own comment argues
 * why: it empties `test_grader`, clears every `grading_job.regrade_grader_id`,
 * and then deletes every `grader` row. It has no choice. Each of those rows
 * carries a type this release retires, and the `library_id` the table gains is
 * `NOT NULL` with no default, so there is no value the column could be filled
 * in with — a copy is a copy *of* something, and there was no shelf when those
 * rows were written.
 *
 * What puts mandatory grading back is not in the migration at all. It is
 * `seedRunningGraders`, which the API's boot runs a few lines after
 * `runMigrations`. **So the guarantee is a pair, and neither half is worth
 * anything alone** — and no other test holds both halves at once:
 *
 * - `seeded-graders` watches the backfill, but on today's schema, where the
 *   destructive migration has already run against nothing.
 * - `migrations` applies every file in order, but to an **empty** database —
 *   which is exactly the case where a migration that deletes everything looks
 *   harmless.
 *
 * This file puts realistic rows in first and then walks the whole path. Two
 * customers, because a backfill missing its scoping has to have somebody else
 * to wrongly leave out; their projects, tests, runs, finished conversations,
 * graders of all four retired types, the junction rows that attached them, and
 * a re-grade still queued and narrowed to one of them. All written by raw SQL
 * at the shape the release *before* the redesign had, because seeding through
 * the module would put today's rows in and then congratulate the migration for
 * coping with them.
 *
 * **If the pair ever breaks, the symptom is silence.** A project keeps its
 * runs, keeps its tests, and goes on reporting them green having judged
 * nothing — and grading that is missing because a release took it away reads on
 * screen exactly like grading that failed for the afternoon. Ticket 03 says it
 * plainly: dev and demo databases have projects, and none of them may silently
 * lose mandatory grading when the implicit grader is removed. This is the test
 * that fails instead of that happening.
 */

/** The four types this release retires, spread across the customers below. */
type ARetiredType =
  | "llm_rubric"
  | "metric_threshold"
  | "tool_calls"
  | "phrase_match";

/** One grader a project ran, at every version it was ever saved at. */
type ALegacyGrader = {
  readonly id: string;
  readonly type: ARetiredType;
  /** Oldest first; the last of them is what the identity row points at. */
  readonly versions: readonly string[];
};

/**
 * One project as the release before the redesign left it: an agent reached over
 * a connection, a persona, a test at one frozen version, a run whose
 * conversations have already happened, and the graders that judged them.
 */
type ALegacyProject = {
  readonly id: string;
  readonly slug: string;
  readonly agent: string;
  readonly connection: string;
  readonly personaId: string;
  readonly personaVersion: string;
  readonly test: string;
  readonly testVersion: string;
  readonly run: string;
  /** Two finished conversations and one still waiting its turn. */
  readonly judged: string;
  readonly regrading: string;
  readonly queued: string;
  /** The job that judged `judged`, and has finished. */
  readonly settledJob: string;
  /** The job for `regrading`: still pending, narrowed to `graders[0]`. */
  readonly narrowedJob: string;
  readonly graders: readonly ALegacyGrader[];
};

/** One customer, with everything of theirs underneath. */
type ALegacyTenant = {
  readonly organization: string;
  readonly slug: string;
  readonly owner: string;
  readonly projects: readonly ALegacyProject[];
};

function aLegacyProject(
  slug: string,
  graders: readonly ALegacyGrader[],
): ALegacyProject {
  return {
    id: newId("prj"),
    slug,
    agent: newId("agt"),
    connection: newId("con"),
    personaId: newId("prs"),
    personaVersion: newId("prsv"),
    test: newId("tst"),
    testVersion: newId("tstv"),
    run: newId("run"),
    judged: newId("sim"),
    regrading: newId("sim"),
    queued: newId("sim"),
    settledJob: newId("gjb"),
    narrowedJob: newId("gjb"),
    graders,
  };
}

function aLegacyGrader(type: ARetiredType, howManyVersions = 1): ALegacyGrader {
  return {
    id: newId("grd"),
    type,
    versions: Array.from({ length: howManyVersions }, () => newId("grv")),
  };
}

/**
 * Acme runs two projects, and between them three of the retired types — one of
 * their graders having been edited twice, so the versions that go with it are
 * more than a single row.
 */
const acme: ALegacyTenant = {
  organization: newId("org"),
  slug: "acme",
  owner: newId("usr"),
  projects: [
    aLegacyProject("default", [
      aLegacyGrader("llm_rubric", 2),
      aLegacyGrader("metric_threshold"),
    ]),
    aLegacyProject("outbound", [aLegacyGrader("phrase_match")]),
  ],
};

/**
 * **The second customer, and the reason there is one.** A backfill that reached
 * only the organization it happened to read first would pass every assertion
 * below with one tenant in the database. Globex is who it would leave running
 * unjudged.
 */
const globex: ALegacyTenant = {
  organization: newId("org"),
  slug: "globex",
  owner: newId("usr"),
  projects: [aLegacyProject("default", [aLegacyGrader("tool_calls")])],
};

const customers = [acme, globex];
const everyProject = customers.flatMap((tenant) => tenant.projects);
const everyLegacyGrader = everyProject.flatMap((project) => project.graders);

/** What the tables held before the upgrade, so "nothing else was lost" is a number. */
type WhatWasThere = Record<string, number>;

/**
 * The tables an upgrade must not empty on its way past. `grader`,
 * `grader_version` and `test_grader` are deliberately absent: those three are
 * what the migration is *for*, and they are counted by their own assertions.
 */
const KEPT_TABLES = [
  "organization",
  "project",
  "agent",
  "connection",
  "persona",
  "persona_version",
  "test",
  "test_version",
  "run",
  "simulation",
  "grading_job",
] as const;

/** The three the migration is *for*, counted before it runs and after. */
const EMPTIED_TABLES = ["grader", "grader_version", "test_grader"] as const;

let database: EmptyDatabase;
/** The migration files up to 0026's predecessor, as that release shipped. */
let asItWas: string;
/** The historical upgrade under test, stopping before the later suite reset. */
let through0039: string;
/**
 * One connection, held open, writing raw SQL. Both halves matter: `begin` and
 * `commit` have to land on the same session for the deferred pointers below,
 * and the rows are written at a schema no exported function can speak to — it
 * has since had two migrations applied over it.
 */
let legacy: SingleConnection;
let whatWasThere: WhatWasThere;
/**
 * What the three tables the migration empties held *before* it ran.
 *
 * Recorded and asserted rather than assumed, because it is the premise of every
 * other assertion here: a seeding that quietly wrote nothing would leave this
 * file testing that a destructive migration is harmless against an empty
 * database, which is the thing `migrations.test.ts` already covers and the
 * exact blind spot this file was written to close.
 */
let whatTheGradersWere: WhatWasThere;
/** Every grading job's identity before the upgrade — none of them may vanish. */
let jobsBefore: readonly string[];
/** What the boot after the migration wrote, recorded where the tests can read it. */
let backfilled: readonly { readonly projectId: string }[];

async function countThese(tables: readonly string[]): Promise<WhatWasThere> {
  const counted: WhatWasThere = {};
  for (const table of tables) {
    const { rows } = await legacy.sql<{ how_many: string }>(
      `select count(*) as how_many from "${table}"`,
    );
    counted[table] = Number(rows[0]?.how_many ?? -1);
  }
  return counted;
}

async function seedAProjectAsItWas(
  tenant: ALegacyTenant,
  project: ALegacyProject,
): Promise<void> {
  await legacy.sql(
    `insert into project (id, organization_id, name, slug, created_by)
     values ($1, $2, $3, $3, $4)`,
    [project.id, tenant.organization, project.slug, tenant.owner],
  );
  await legacy.sql(
    `insert into agent (id, organization_id, project_id, name)
     values ($1, $2, $3, 'Front desk')`,
    [project.agent, tenant.organization, project.id],
  );
  await legacy.sql(
    `insert into connection
       (id, organization_id, project_id, agent_id, name, type, modality,
        topology, config)
     values ($1, $2, $3, $4, 'retell-1', 'retell', 'chat', 'hosted-broker',
        '{}'::jsonb)`,
    [project.connection, tenant.organization, project.id, project.agent],
  );

  // The persona and its version name each other, so they go in together. So do
  // the test and its own; both pointers are deferred for exactly this.
  await legacy.sql("begin");
  await legacy.sql(
    `insert into persona (id, organization_id, project_id, name,
        current_version_id)
     values ($1, $2, $3, 'Impatient Rita', $4)`,
    [
      project.personaId,
      tenant.organization,
      project.id,
      project.personaVersion,
    ],
  );
  await legacy.sql(
    `insert into persona_version (id, persona_id, version, traits)
     values ($1, $2, 1,
       '{"personality":"Impatient but clear.","language":"en-US","voice":{"provider":"cartesia","voiceId":"legacy-cartesia-voice","speed":1}}'::jsonb)`,
    [project.personaVersion, project.personaId],
  );
  await legacy.sql(
    `insert into test (id, organization_id, project_id, name,
        current_version_id, created_by)
     values ($1, $2, $3, 'Reschedules a cleaning', $4, $5)`,
    [
      project.test,
      tenant.organization,
      project.id,
      project.testVersion,
      tenant.owner,
    ],
  );
  await legacy.sql(
    `insert into test_version (id, test_id, version, content, created_by)
     values ($1, $2, 1, $3::jsonb, $4)`,
    [
      project.testVersion,
      project.test,
      JSON.stringify({
        scenario: "The caller wants Thursday's cleaning moved to Tuesday.",
        expectedBehaviors: [
          "The agent offers a Tuesday slot.",
          "The agent confirms the new time before ending the call.",
        ],
        mockOverrides: [],
      }),
      tenant.owner,
    ],
  );
  await legacy.sql("commit");

  // The graders, each with every version it was ever saved at. Same shape: the
  // identity row first, naming a version row that does not exist yet.
  for (const [position, grader] of project.graders.entries()) {
    await legacy.sql("begin");
    await legacy.sql(
      `insert into grader
         (id, organization_id, project_id, name, description, type, scope,
          production_sample_rate, current_version_id, created_by)
       values ($1, $2, $3, $4, $5, $6, 'simulations', 100, $7, $8)`,
      [
        grader.id,
        tenant.organization,
        project.id,
        `${grader.type} on ${project.slug}`,
        "Written before the shelf existed.",
        grader.type,
        grader.versions.at(-1),
        tenant.owner,
      ],
    );
    for (const [index, versionId] of grader.versions.entries()) {
      await legacy.sql(
        `insert into grader_version
           (id, grader_id, version, config, created_by)
         values ($1, $2, $3, $4::jsonb, $5)`,
        [
          versionId,
          grader.id,
          index + 1,
          JSON.stringify({ rubric: "Was the caller treated well?" }),
          tenant.owner,
        ],
      );
    }
    await legacy.sql("commit");
    // And the junction row that attached it to this test's frozen version,
    // which is how a grader was chosen before scope answered the question.
    await legacy.sql(
      `insert into test_grader (test_version_id, grader_id, position)
       values ($1, $2, $3)`,
      [project.testVersion, grader.id, position + 1],
    );
  }

  await legacy.sql(
    `insert into run
       (id, organization_id, project_id, agent_id, connection_id, status,
        triggered_via, triggered_by, pinned_test_versions, requested_personas,
        connection_snapshot, mock_tool_snapshot, expected_simulation_count,
        started_at)
     values ($1, $2, $3, $4, $5, 'running', 'manual', $6, $7::jsonb, $8::jsonb,
        $9::jsonb, $10::jsonb, 3, now())`,
    [
      project.run,
      tenant.organization,
      project.id,
      project.agent,
      project.connection,
      tenant.owner,
      JSON.stringify({ testVersionIds: [project.testVersion] }),
      JSON.stringify({ personaIds: [project.personaId] }),
      JSON.stringify({
        type: "retell",
        modality: "chat",
        topology: "hosted-broker",
        environment: null,
        config: {},
      }),
      JSON.stringify({ defaults: [], overrides: {} }),
    ],
  );

  const conversations = [
    { id: project.judged, position: 1, finished: true },
    { id: project.regrading, position: 2, finished: true },
    { id: project.queued, position: 3, finished: false },
  ];
  for (const conversation of conversations) {
    await legacy.sql(
      `insert into simulation
         (id, run_id, organization_id, project_id, agent_id, connection_id,
          persona_id, persona_version_id, position, modality, status,
          test_id, test_version_id${
            conversation.finished
              ? `, ending_reason, claimed_by, claimed_at, heartbeat_at,
                 started_at, ended_at, turn_count`
              : ""
          })
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'chat', $10, $11, $12${
         conversation.finished
           ? `, 'persona_concluded', 'simulator-blue-1', now(), now(),
              now(), now(), 6`
           : ""
       })`,
      [
        conversation.id,
        project.run,
        tenant.organization,
        project.id,
        project.agent,
        project.connection,
        project.personaId,
        project.personaVersion,
        conversation.position,
        conversation.finished ? "completed" : "queued",
        project.test,
        project.testVersion,
      ],
    );
  }

  // One conversation judged and settled, and one being judged again — narrowed
  // to a grader this migration is about to delete, which is the row the
  // migration's `UPDATE` exists for. A settled job may not carry a narrowing at
  // all, so the two jobs are deliberately different shapes.
  await legacy.sql(
    `insert into grading_job
       (id, organization_id, project_id, source, simulation_id, status,
        attempts, finished_at)
     values ($1, $2, $3, 'simulation', $4, 'graded', 1, now())`,
    [project.settledJob, tenant.organization, project.id, project.judged],
  );
  await legacy.sql(
    `insert into grading_job
       (id, organization_id, project_id, source, simulation_id, status,
        attempts, regrade_grader_id)
     values ($1, $2, $3, 'simulation', $4, 'pending', 0, $5)`,
    [
      project.narrowedJob,
      tenant.organization,
      project.id,
      project.regrading,
      project.graders[0]?.id,
    ],
  );
}

async function seedATenantAsItWas(tenant: ALegacyTenant): Promise<void> {
  await legacy.sql('insert into "user" (id, email) values ($1, $2)', [
    tenant.owner,
    `owner@${tenant.slug}.example`,
  ]);
  await legacy.sql(
    "insert into organization (id, name, slug) values ($1, $2, $2)",
    [tenant.organization, tenant.slug],
  );
  for (const project of tenant.projects) {
    await seedAProjectAsItWas(tenant, project);
  }
}

/** The living copies of an entry a project holds, whatever a read would narrow to. */
async function activeCopiesIn(projectId: string): Promise<
  readonly {
    readonly id: string;
    readonly library_id: string;
    readonly required: boolean;
    readonly scope: string;
    readonly type: string;
  }[]
> {
  const { rows } = await legacy.sql<{
    id: string;
    library_id: string;
    required: boolean;
    scope: string;
    type: string;
  }>(
    `select g.id, g.library_id, g.required, g.scope, gl.type
       from grader g
       join grader_library gl on gl.id = g.library_id
      where g.project_id = $1 and g.deleted_at is null order by g.id`,
    [projectId],
  );
  return rows;
}

beforeAll(async () => {
  database = await createEmptyDatabase("running_copies_upgrade");

  // The world as it was: every migration before the running copies, in a
  // directory of its own, so two customers' work is sitting in the tables when
  // 0026 arrives on top of it.
  asItWas = await mkdtemp(path.join(os.tmpdir(), "egma-before-0026-"));
  for (const migration of await readMigrations()) {
    if (migration.name < "0026") {
      await writeFile(path.join(asItWas, migration.name), migration.sql);
    }
  }
  const before = await runMigrations(database.url, asItWas);
  expect(before.applied.at(-1)).toBe("0025_priorities_retire.sql");

  through0039 = await mkdtemp(path.join(os.tmpdir(), "egma-0026-through-0039-"));
  for (const migration of await readMigrations()) {
    if (migration.name >= "0026" && migration.name < "0040") {
      await writeFile(path.join(through0039, migration.name), migration.sql);
    }
  }

  legacy = await openSingleConnection(database.url);
  for (const tenant of customers) await seedATenantAsItWas(tenant);

  whatWasThere = await countThese(KEPT_TABLES);
  whatTheGradersWere = await countThese(EMPTIED_TABLES);
  const { rows } = await legacy.sql<{ id: string }>(
    "select id from grading_job order by id",
  );
  jobsBefore = rows.map((row) => row.id);
});

afterAll(async () => {
  await disconnect().catch(() => undefined);
  await legacy.close();
  await rm(asItWas, { recursive: true, force: true });
  await rm(through0039, { recursive: true, force: true });
  await database.drop();
});

describe("the release that turns graders into running copies (0026)", () => {
  /**
   * The premise, asserted first and separately: what follows is only worth
   * reading if the database this migration meets is a populated one.
   */
  it("meets a database that really does hold legacy graders", () => {
    expect(whatTheGradersWere).toEqual({
      grader: everyLegacyGrader.length,
      grader_version: everyLegacyGrader.reduce(
        (total, one) => total + one.versions.length,
        0,
      ),
      // One junction row per grader: every one of them was attached to its
      // project's test, which is how a grader was chosen before scope was.
      test_grader: everyLegacyGrader.length,
    });
    // All four retired types, so the delete is not being watched through one.
    expect(new Set(everyLegacyGrader.map((one) => one.type))).toEqual(
      new Set(["llm_rubric", "metric_threshold", "tool_calls", "phrase_match"]),
    );
  });

  it("applies over a database that actually holds graders", async () => {
    // Stop before 0040, whose separate proof owns the deliberate reset of
    // pre-suite simulation history. This file isolates the 0026 promise.
    const upgraded = await runMigrations(database.url, through0039);

    expect(upgraded.applied).toContain("0026_running_copies.sql");
    expect(upgraded.applied[0]).toBe("0026_running_copies.sql");
    expect(upgraded.applied.every((name) => name >= "0026")).toBe(true);
  });

  it("deletes every grader, and their versions with them", async () => {
    const { rows: graders } = await legacy.sql<{ how_many: string }>(
      "select count(*) as how_many from grader",
    );
    const { rows: versions } = await legacy.sql<{ how_many: string }>(
      "select count(*) as how_many from grader_version",
    );

    expect(graders[0]?.how_many).toBe("0");
    // By their own cascade, and worth asserting separately: a migration that
    // left these behind would leave version rows pointing at nothing.
    expect(versions[0]?.how_many).toBe("0");
  });

  it("takes the per-test junction out of the schema altogether", async () => {
    const { rows } = await legacy.sql<{ table_name: string | null }>(
      "select to_regclass('public.test_grader')::text as table_name",
    );

    expect(rows[0]?.table_name).toBeNull();
  });

  /**
   * **The jobs are not deleted — only the pointer is cleared.** A re-grade
   * narrowed to a grader that no longer exists is a job asking for a judgment
   * nothing can make, but the conversation underneath it still wants judging,
   * and it is judged by whatever applies to it now. A migration that deleted
   * the row instead would throw away work nobody asked it to throw away, and
   * silently: the queue would simply be shorter the next morning.
   */
  it("keeps every grading job, and clears the narrowing rather than the row", async () => {
    const { rows } = await legacy.sql<{
      id: string;
      status: string;
      regrade_grader_id: string | null;
    }>("select id, status, regrade_grader_id from grading_job order by id");

    expect(rows.map((row) => row.id)).toEqual(jobsBefore);
    expect(rows.every((row) => row.regrade_grader_id === null)).toBe(true);
    // The narrowed ones were pending and stay pending: clearing what a job was
    // narrowed to is not the same as deciding the job is finished.
    const narrowed = new Set(everyProject.map((project) => project.narrowedJob));
    expect(
      rows.filter((row) => narrowed.has(row.id)).map((row) => row.status),
    ).toEqual(everyProject.map(() => "pending"));
  });

  it("loses nothing else and installs the one shared persona library entry", async () => {
    expect(await countThese(KEPT_TABLES)).toEqual({
      ...whatWasThere,
      persona: (whatWasThere.persona ?? 0) + 1,
      persona_version: (whatWasThere.persona_version ?? 0) + 1,
    });
  });
});

describe("the boot that follows the upgrade", () => {
  beforeAll(async () => {
    // Exactly what `apps/api` does, in the order it does it: the migrations
    // above, then egma's own graders onto the shelf, then a copy of the
    // mandatory one into every project that has never held it.
    connect({
      databaseUrl: database.url,
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    await seedGraderLibrary();
    backfilled = await seedRunningGraders();
  });

  /**
   * **This is the assertion the whole file exists for.** The migration above
   * left every one of these projects with no grader at all; if this one fails,
   * an upgraded deployment runs its tests and reports them without judging
   * anything, and says nothing about it.
   */
  it("gives every project that existed one active copy of expected_behaviors", async () => {
    for (const project of everyProject) {
      const copies = await activeCopiesIn(project.id);

      expect(copies).toHaveLength(1);
      expect(copies[0]).toMatchObject({
        library_id: PREDEFINED_GRADERS.expectedBehaviors,
        // Required, so a test cannot pass while its own expected behaviors do
        // not — which is what mandatory grading means.
        required: true,
        // Simulations-only, structurally: a production trace has no test, so
        // there are no expected behaviors there to read.
        scope: "simulations",
        type: "llm_as_judge",
      });
    }
  });

  it("reaches both customers, not whichever one it read first", async () => {
    expect([...backfilled].map((copy) => copy.projectId).sort()).toEqual(
      everyProject.map((project) => project.id).sort(),
    );

    const { rows } = await legacy.sql<{ organization_id: string }>(
      `select distinct organization_id from grader where library_id = $1`,
      [PREDEFINED_GRADERS.expectedBehaviors],
    );
    expect(rows.map((row) => row.organization_id).sort()).toEqual(
      customers.map((tenant) => tenant.organization).sort(),
    );
  });

  /**
   * **Idempotent on the upgrade path specifically.** A restart is not a rare
   * event — it is what a rolling deploy is made of — and the second boot after
   * an upgrade is the first moment the backfill runs against projects it has
   * already written. A second copy would judge every behavior twice, bill for
   * it, and offer no surface to remove either row.
   */
  it("writes nothing at all the second time it runs", async () => {
    const again = await seedRunningGraders();

    expect(again).toEqual([]);
    for (const project of everyProject) {
      expect(await activeCopiesIn(project.id)).toHaveLength(1);
    }
  });
});
