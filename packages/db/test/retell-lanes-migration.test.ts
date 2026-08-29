import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS_DIRECTORY, runMigrations } from "@egma/db";

import {
  createEmptyDatabase,
  openSingleConnection,
  type EmptyDatabase,
  type SingleConnection,
} from "./support/database.ts";

/**
 * The mocked-world migration, run the way a real deployment meets it: over a
 * database that has already finished simulations.
 *
 * **This proof exists because the obvious version of the backfill cannot
 * work.** The stamp it widens is a terminal fact — a row cannot carry one until
 * it has ended — so every row the backfill touches is `completed`, `failed` or
 * `canceled`, and `simulation_lifecycle_guard` refuses every update to a row in
 * one of those states. On an empty development database the statement matches
 * nothing and looks fine; on any database that has ever run a mocked
 * simulation it raises, the migration rolls back, and the API cannot boot.
 *
 * A test over a freshly created database can say nothing about that, which is
 * the same reason the persona rework has a proof of its own. So this one
 * applies everything up to the migration under test, writes the rows an older
 * build wrote, and only then lets the migration land.
 */

const UNDER_TEST = "0002_retell_mocked_world.sql";

let database: EmptyDatabase;
let store: SingleConnection;
let before: string | undefined;

const acme = {
  organization: newId("org"),
  project: newId("prj"),
  suite: newId("ste"),
};
const agentId = newId("agt");
const connectionId = newId("con");
const personaId = newId("prs");
const personaVersionId = newId("prsv");
const testId = newId("tst");
const testVersionId = newId("tstv");
const runId = newId("run");

/** The finished simulation, stamped the way the older build stamped one. */
const stamped = newId("sim");
/** A finished simulation that was never asked what tools it has. */
const unstamped = newId("sim");

const OLD_STAMP = {
  discovered: ["check_calendar", "send_confirmation"],
  covered: ["check_calendar"],
  uncovered: ["send_confirmation"],
} as const;

/**
 * Rows exactly as the build before this migration wrote them.
 *
 * The terminal simulations are **inserted** terminal rather than walked through
 * their lifecycle, because that is what the migration meets: a database full of
 * conversations that ended months ago. The guard is a `BEFORE UPDATE` trigger,
 * so it has nothing to say about the insert and everything to say about the
 * backfill.
 */
async function seedFinishedWork(): Promise<void> {
  await store.sql(
    "insert into organization (id, name, slug) values ($1, $2, $2)",
    [acme.organization, "acme"],
  );
  await store.sql(
    "insert into project (id, organization_id, name, slug, revision) values ($1, $2, $3, $3, $4)",
    [acme.project, acme.organization, "default", newId("rev")],
  );
  await store.sql(
    `insert into test_suite (id, organization_id, project_id, name)
     values ($1, $2, $3, 'Regression')`,
    [acme.suite, acme.organization, acme.project],
  );
  await store.sql(
    `insert into agent (id, organization_id, project_id, name, agent_platform)
     values ($1, $2, $3, 'Front desk', 'retell')`,
    [agentId, acme.organization, acme.project],
  );
  await store.sql(
    `insert into connection
       (id, organization_id, project_id, agent_id, name, connection_type,
        access_variant, modality, topology, config)
     values ($1, $2, $3, $4, 'Chat', 'retell_chat_api',
       'retell_chat_api.api_key', 'chat', 'hosted-broker', '{}'::jsonb)`,
    [connectionId, acme.organization, acme.project, agentId],
  );

  await store.sql("begin");
  await store.sql(
    `insert into persona (id, organization_id, project_id, name, current_version_id)
     values ($1, $2, $3, 'Impatient Rita', $4)`,
    [personaId, acme.organization, acme.project, personaVersionId],
  );
  await store.sql(
    `insert into persona_version
       (id, persona_id, version, identity_name, personality, language,
        llm_provider, llm_model, stt_provider, stt_model,
        tts_provider, tts_model, tts_voice_id, tts_speed)
     values ($1, $2, 1, 'Rita Alvarez', 'Speaks plainly.', 'en-US',
       'openai', 'gpt-4.1', 'deepgram', 'nova-3', 'cartesia', 'sonic-2',
       'voice-1', 1.0)`,
    [personaVersionId, personaId],
  );
  await store.sql("commit");

  await store.sql("begin");
  await store.sql(
    `insert into test
       (id, organization_id, project_id, suite_id, name, current_version_id, revision)
     values ($1, $2, $3, $4, 'Books an appointment', $5, $6)`,
    [
      testId,
      acme.organization,
      acme.project,
      acme.suite,
      testVersionId,
      newId("rev"),
    ],
  );
  await store.sql(
    `insert into test_version (id, test_id, version, content)
     values ($1, $2, 1, '{"scenario": "Books", "expectedBehaviors": ["confirms"]}'::jsonb)`,
    [testVersionId, testId],
  );
  await store.sql("commit");

  await store.sql(
    `insert into run
       (id, organization_id, project_id, suite_id, agent_id, connection_id,
        status, triggered_via, connection_snapshot, mock_tool_snapshot,
        expected_simulation_count, started_at, finished_at,
        completed_count, failed_count, canceled_count)
     values ($1, $2, $3, $4, $5, $6, 'completed', 'manual', $7::jsonb,
       '{"defaults": [], "overrides": {}}'::jsonb, 2, now(), now(), 2, 0, 0)`,
    [
      runId,
      acme.organization,
      acme.project,
      acme.suite,
      agentId,
      connectionId,
      JSON.stringify({
        agentPlatform: "retell",
        connectionType: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
        modality: "chat",
        topology: "hosted-broker",
        environment: null,
        config: {},
      }),
    ],
  );

  const finished = async (
    id: string,
    position: number,
    coverage: string | null,
  ): Promise<void> => {
    await store.sql(
      `insert into simulation
         (id, run_id, organization_id, project_id, agent_id, connection_id,
          persona_id, persona_version_id, test_id, test_version_id,
          position, modality, status, ending_reason,
          claimed_by, claimed_at, heartbeat_at, started_at, ended_at,
          turn_count, mock_tool_coverage)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'chat',
         'completed', 'persona_concluded', 'simulator-blue-1', now(), now(),
         now(), now(), 12, $12::jsonb)`,
      [
        id,
        runId,
        acme.organization,
        acme.project,
        agentId,
        connectionId,
        personaId,
        personaVersionId,
        testId,
        testVersionId,
        position,
        coverage,
      ],
    );
  };

  await finished(stamped, 1, JSON.stringify(OLD_STAMP));
  await finished(unstamped, 2, null);
}

beforeAll(async () => {
  database = await createEmptyDatabase("retell_mocked_world_migration");

  // Everything up to the migration under test, from a directory holding
  // nothing else. Applying the real directory afterwards finds those already
  // recorded under the same hashes and applies only what follows — which is
  // this migration, met exactly as a deployment meets it.
  before = await mkdtemp(path.join(tmpdir(), "egma-before-mocked-world-"));
  const earlier = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => name.endsWith(".sql") && name < UNDER_TEST)
    .sort();
  expect(earlier).toContain("0000_baseline.sql");
  for (const name of earlier) {
    await cp(
      path.join(MIGRATIONS_DIRECTORY, name),
      path.join(before, name),
    );
  }
  await runMigrations(database.url, before);

  store = await openSingleConnection(database.url);
  await seedFinishedWork();
});

afterAll(async () => {
  await store?.close();
  await database?.drop();
  if (before !== undefined) await rm(before, { recursive: true, force: true });
});

describe("the mocked-world migration over finished work", () => {
  it("applies at all, which the lifecycle guard would otherwise refuse", async () => {
    // The whole point. Before the guard was taken off around the backfill this
    // threw `simulation … is completed, and a terminal simulation is written
    // once`, the migration rolled back, and boot stopped here.
    const { applied } = await runMigrations(database.url);
    expect(applied).toContain(UNDER_TEST);
  });

  it("widens the stamp already stored without disturbing what it said", async () => {
    const { rows } = await store.sql<{ mock_tool_coverage: unknown }>(
      "select mock_tool_coverage from simulation where id = $1",
      [stamped],
    );
    expect(rows[0]?.mock_tool_coverage).toEqual({
      ...OLD_STAMP,
      // The in-process seam's honest answer: every tool the agent declares
      // there is reachable, so nothing was un-interceptable by construction.
      notInterceptable: [],
      notInThisVersion: [],
    });
  });

  it("leaves a conversation that was never asked with nothing to say", async () => {
    const { rows } = await store.sql<{ mock_tool_coverage: unknown }>(
      "select mock_tool_coverage from simulation where id = $1",
      [unstamped],
    );
    // No stamp means nobody ever asked the agent what tools it has, and the
    // backfill must not turn that silence into a claim.
    expect(rows[0]?.mock_tool_coverage).toBeNull();
  });

  it("puts the lifecycle guard back, so terminal rows are frozen again", async () => {
    const refused = await store
      .sql("update simulation set turn_count = 99 where id = $1", [stamped])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(refused)).toMatch(/terminal simulation is written once/u);
  });

  it("leaves the finished run's header frozen too, save for its mocked world", async () => {
    const refused = await store
      .sql("update run set name = 'renamed' where id = $1", [runId])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(refused)).toMatch(/written once/u);

    // The one carve-out, which a sweep after a crash depends on.
    await store.sql(
      `update run set mocked_world = '{"servingVersion": 105, "draftVersion": null,
        "engine": {"type": "conversation-flow", "engineId": "flow_1", "version": 105},
        "numbers": [], "coverage": {"mocked": [], "notInterceptable": [],
        "notInThisVersion": []}}'::jsonb where id = $1`,
      [runId],
    );
  });
});
