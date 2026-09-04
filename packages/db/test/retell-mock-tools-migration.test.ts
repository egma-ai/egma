import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
 * The mock-tools migration, run the way a real deployment meets it: over a
 * database that already holds connections, runs and finished simulations.
 *
 * **What 0003 added and 0007 kept**, which is the four columns a temporary copy
 * of somebody's Retell agent is tracked by. The connection switch and the
 * project's own mocked world that arrived with them are gone again — proved in
 * `test-owned-mock-tools-migration.test.ts`, which is 0007's own file — so what
 * is asserted here is what a run still remembers.
 *
 * **Nothing 0003 wrote is backfilled and it disables no trigger.** The four run
 * columns arrive null, which is their honest value on every run already
 * written: none of them conducted against a named version and none of them made
 * a temporary copy.
 *
 * **The freeze carve-out is exact.** A finished run may still be told the two
 * cleanup facts, because clearing a crashed run's litter is by definition
 * something that happens after the run is over; everything else on the header
 * stays frozen.
 */

const UNDER_TEST = "0003_retell_mock_tools.sql";

let database: EmptyDatabase;
let store: SingleConnection;
let before: string | undefined;

const acme = {
  organization: newId("org"),
  project: newId("prj"),
  suite: newId("ste"),
};
const agentId = newId("agt");
const personaId = newId("prs");
const personaVersionId = newId("prsv");
const testId = newId("tst");
const testVersionId = newId("tstv");
const runId = newId("run");
const finishedSimulation = newId("sim");

/** Every connection kind an older build could already have written. */
const EXISTING_CONNECTIONS = [
  ["retell_chat_api", "retell_chat_api.api_key", "chat", "hosted-broker"],
  ["retell_web_call", "retell_web_call.api_key", "voice", "hosted-broker"],
  ["phone_number", "phone_number.public_e164", "voice", "egma-dials-in"],
  ["livekit_room", "livekit_room.project_credentials", "voice", "agent-dials-out"],
  [
    "livekit_room",
    "livekit_room.customer_token_endpoint",
    "voice",
    "agent-dials-out",
  ],
] as const;

const connectionIds = EXISTING_CONNECTIONS.map(() => newId("con"));

/** Rows exactly as the build before this migration wrote them. */
async function seedExistingWork(): Promise<void> {
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

  for (const [index, kind] of EXISTING_CONNECTIONS.entries()) {
    const [connectionType, accessVariant, modality, topology] = kind;
    await store.sql(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, connection_type,
          access_variant, modality, topology, config)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb)`,
      [
        connectionIds[index],
        acme.organization,
        acme.project,
        agentId,
        `Connection ${index + 1}`,
        connectionType,
        accessVariant,
        modality,
        topology,
      ],
    );
  }

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
       '{"defaults": [], "overrides": {}}'::jsonb, 1, now(), now(), 1, 0, 0)`,
    [
      runId,
      acme.organization,
      acme.project,
      acme.suite,
      agentId,
      connectionIds[0],
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

  await store.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, test_id, test_version_id,
        position, modality, status, ending_reason,
        claimed_by, claimed_at, heartbeat_at, started_at, ended_at, turn_count)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, 'chat',
       'completed', 'persona_concluded', 'simulator-blue-1', now(), now(),
       now(), now(), 12)`,
    [
      finishedSimulation,
      runId,
      acme.organization,
      acme.project,
      agentId,
      connectionIds[0],
      personaId,
      personaVersionId,
      testId,
      testVersionId,
    ],
  );
}

beforeAll(async () => {
  database = await createEmptyDatabase("retell_mock_tools_migration");

  // Everything up to the migration under test, from a directory holding
  // nothing else. Applying the real directory afterwards finds those already
  // recorded under the same hashes and applies only what follows.
  before = await mkdtemp(path.join(tmpdir(), "egma-before-mock-tools-"));
  const earlier = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => name.endsWith(".sql") && name < UNDER_TEST)
    .sort();
  expect(earlier).toContain("0000_baseline.sql");
  expect(earlier).toContain("0002_retell_lanes.sql");
  for (const name of earlier) {
    await cp(path.join(MIGRATIONS_DIRECTORY, name), path.join(before, name));
  }
  await runMigrations(database.url, before);

  store = await openSingleConnection(database.url);
  await seedExistingWork();
});

afterAll(async () => {
  await store?.close();
  await database?.drop();
  if (before !== undefined) await rm(before, { recursive: true, force: true });
});

describe("the mock-tools migration over a populated database", () => {
  it("applies over rows an older build already wrote", async () => {
    const { applied } = await runMigrations(database.url);
    expect(applied).toContain(UNDER_TEST);
  });

  it("carries nothing across, because there is nothing to carry", async () => {
    // Asserted against the file rather than inferred from its effect: a
    // backfill or a disabled trigger is exactly what this migration must not
    // have, and the earlier draft of it had both. 0007, which does carry
    // something across, says so in its own header and proves it in its own
    // file.
    const sql = await readFile(
      path.join(MIGRATIONS_DIRECTORY, UNDER_TEST),
      "utf8",
    );
    expect(sql).not.toMatch(/DISABLE TRIGGER/iu);
    expect(sql).not.toMatch(/^\s*UPDATE /imu);
  });

  it("leaves every run already written with nothing to claim", async () => {
    const { rows } = await store.sql<{
      agent_version: number | null;
      temp_mock_agent_version: number | null;
      temp_mock_agent_version_cleanup: boolean | null;
      mock_metadata: unknown;
    }>(
      `select agent_version, temp_mock_agent_version,
              temp_mock_agent_version_cleanup, mock_metadata
         from run where id = $1`,
      [runId],
    );
    expect(rows[0]).toEqual({
      agent_version: null,
      temp_mock_agent_version: null,
      temp_mock_agent_version_cleanup: null,
      mock_metadata: null,
    });
  });

  it("indexes the cleanup flag the claim searches by, partially", async () => {
    const { rows } = await store.sql<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = $1",
      ["run_mock_tools_cleanup_owed_idx"],
    );
    expect(rows[0]?.indexdef).toMatch(/WHERE .*temp_mock_agent_version_cleanup/u);
  });

  it("carves exactly the two cleanup facts out of a finished run's freeze", async () => {
    // A run that crashed before its teardown leaves litter on somebody's
    // Retell account, and clearing it happens after the run is over by
    // definition — so the sweep has to be able to say it is done.
    await store.sql(
      `update run
          set temp_mock_agent_version_cleanup = true,
              mock_metadata = '{"engine": {"type": "conversation-flow",
                "engine_id": "flow_1", "version": 105}, "numbers": []}'::jsonb
        where id = $1`,
      [runId],
    );

    // And nothing else. The header is written once.
    const refusedName = await store
      .sql("update run set name = 'renamed' where id = $1", [runId])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(refusedName)).toMatch(/written once/u);

    const refusedVersion = await store
      .sql("update run set agent_version = 7 where id = $1", [runId])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(refusedVersion)).toMatch(/written once/u);
  });

  it("refuses a version that is not one, and a copy with no cleanup flag", async () => {
    // On a fresh run rather than the finished one above, whose header is
    // frozen by a different rule and would answer for that instead.
    const fresh = newId("run");
    await store.sql(
      `insert into run
         (id, organization_id, project_id, suite_id, agent_id, connection_id,
          status, triggered_via, connection_snapshot,
          expected_simulation_count)
       values ($1, $2, $3, $4, $5, $6, 'pending', 'manual', '{}'::jsonb, 1)`,
      [
        fresh,
        acme.organization,
        acme.project,
        acme.suite,
        agentId,
        connectionIds[0],
      ],
    );

    const badVersion = await store
      .sql("update run set agent_version = -1 where id = $1", [fresh])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(badVersion)).toMatch(/run_agent_version_is_a_version/u);

    // A branched copy always carries a cleanup flag — owed or settled.
    const flagless = await store
      .sql("update run set temp_mock_agent_version = 106 where id = $1", [fresh])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(flagless)).toMatch(
      /run_temp_mock_agent_version_owes_cleanup/u,
    );
  });
});
