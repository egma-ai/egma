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
 * The migration that moves the mocked world onto the test, run the way a real
 * deployment meets it: over a database that already holds a project's mock
 * tools, a ticked connection, a finished run with a frozen world, a stamped
 * simulation, and a test version that overrode a tool.
 *
 * Two things are proved here that a fresh database cannot say anything about.
 *
 * **Everything that can be carried across is carried across.** A version's
 * overrides become that version's own mock tools, in the order they were
 * authored and in the new shape. The delay does not survive, deliberately: the
 * new shape has no room for one and the header says so.
 *
 * **Everything else is really gone**, tables, columns, checks and the three
 * JSON keys — asserted against the live catalog rather than against the file,
 * so a statement that ran and did nothing would still fail here.
 */

const UNDER_TEST = "0007_test_owned_mock_tools.sql";

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
const livekitConnectionId = newId("con");
const personaId = newId("prs");
const personaVersionId = newId("prsv");
const testId = newId("tst");
const overridingVersionId = newId("tstv");
const plainVersionId = newId("tstv");
const projectMockToolId = newId("mck");
const runId = newId("run");
const finishedSimulation = newId("sim");

/** What the old shape held: two overrides, one answering and one failing. */
const OLD_OVERRIDES = [
  {
    toolName: "get_availability",
    answer: { answer: { slots: [] } },
    delayMilliseconds: 1200,
  },
  {
    toolName: "book",
    answer: { error: "calendar down" },
    delayMilliseconds: 0,
  },
];

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
  // A connection with the switch on, which only a Retell lane could hold.
  await store.sql(
    `insert into connection
       (id, organization_id, project_id, agent_id, name, connection_type,
        access_variant, modality, topology, config, mock_tools_enabled)
     values ($1, $2, $3, $4, 'Text mode', 'retell_text_mode',
       'retell_text_mode.api_key', 'chat', 'hosted-broker',
       '{"retellAgentId": "agent_1"}'::jsonb, true)`,
    [connectionId, acme.organization, acme.project, agentId],
  );
  // A LiveKit room from the same project, holding the one dispatch metadata
  // every run over it carried. The key leaves the registry in this change, and
  // a config key the registry does not hold is refused by name at read.
  await store.sql(
    `insert into connection
       (id, organization_id, project_id, agent_id, name, connection_type,
        access_variant, modality, topology, config)
     values ($1, $2, $3, $4, 'Room', 'livekit_room',
       'livekit_room.project_credentials', 'voice', 'agent-dials-out',
       $5::jsonb)`,
    [
      livekitConnectionId,
      acme.organization,
      acme.project,
      agentId,
      JSON.stringify({
        url: "wss://acme.livekit.cloud",
        agentName: "front-desk",
        metadata: '{"tenant":"acme"}',
      }),
    ],
  );
  // The project's own answer for a tool, scoped to the one agent.
  await store.sql(
    `insert into mock_tool
       (id, organization_id, project_id, tool_name, answer, delay_milliseconds)
     values ($1, $2, $3, 'check_calendar', '{"answer": {"open": true}}'::jsonb, 250)`,
    [projectMockToolId, acme.organization, acme.project],
  );
  await store.sql(
    `insert into mock_tool_agent (mock_tool_id, agent_id, project_id, position)
     values ($1, $2, $3, 1)`,
    [projectMockToolId, agentId, acme.project],
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
      overridingVersionId,
      newId("rev"),
    ],
  );
  // The version the test stands on, which overrode two tools.
  await store.sql(
    `insert into test_version (id, test_id, version, content)
     values ($1, $2, 2, $3::jsonb)`,
    [
      overridingVersionId,
      testId,
      JSON.stringify({
        scenario: "Books",
        expectedBehaviors: ["confirms"],
        mockOverrides: OLD_OVERRIDES,
      }),
    ],
  );
  // The version before it, which overrode nothing at all.
  await store.sql(
    `insert into test_version (id, test_id, version, content)
     values ($1, $2, 1, $3::jsonb)`,
    [
      plainVersionId,
      testId,
      JSON.stringify({ scenario: "Books", expectedBehaviors: ["confirms"] }),
    ],
  );
  await store.sql("commit");

  // A finished run, frozen: its header carries the switch and the world it
  // resolved, and its simulation carries a coverage stamp.
  await store.sql(
    `insert into run
       (id, organization_id, project_id, suite_id, agent_id, connection_id,
        status, triggered_via, connection_snapshot, mock_tool_snapshot,
        expected_simulation_count, started_at, finished_at,
        completed_count, failed_count, canceled_count)
     values ($1, $2, $3, $4, $5, $6, 'completed', 'manual', $7::jsonb,
       $8::jsonb, 1, now(), now(), 1, 0, 0)`,
    [
      runId,
      acme.organization,
      acme.project,
      acme.suite,
      agentId,
      connectionId,
      JSON.stringify({
        agentPlatform: "retell",
        connectionType: "retell_text_mode",
        accessVariant: "retell_text_mode.api_key",
        modality: "chat",
        topology: "hosted-broker",
        environment: null,
        config: {},
        mockToolsEnabled: true,
      }),
      JSON.stringify({
        defaults: [
          {
            mockToolId: projectMockToolId,
            toolName: "check_calendar",
            answer: { answer: { open: true } },
            delayMilliseconds: 250,
          },
        ],
        overrides: {},
      }),
    ],
  );

  await store.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, test_id, test_version_id,
        position, modality, status, ending_reason,
        claimed_by, claimed_at, heartbeat_at, started_at, ended_at, turn_count,
        mock_tool_coverage)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, 'chat',
       'completed', 'persona_concluded', 'simulator-blue-1', now(), now(),
       now(), now(), 12,
       '{"discovered": ["check_calendar"], "covered": ["check_calendar"], "uncovered": []}'::jsonb)`,
    [
      finishedSimulation,
      runId,
      acme.organization,
      acme.project,
      agentId,
      connectionId,
      personaId,
      personaVersionId,
      testId,
      overridingVersionId,
    ],
  );
}

beforeAll(async () => {
  database = await createEmptyDatabase("test_owned_mock_tools_migration");

  // Everything up to the migration under test, from a directory holding
  // nothing else. Applying the real directory afterwards finds those already
  // recorded under the same hashes and applies only what follows.
  before = await mkdtemp(path.join(tmpdir(), "egma-before-test-owned-"));
  const earlier = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => name.endsWith(".sql") && name < UNDER_TEST)
    .sort();
  expect(earlier).toContain("0000_baseline.sql");
  expect(earlier).toContain("0003_retell_mock_tools.sql");
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

describe("the test-owned mock tools migration over a populated database", () => {
  it("applies over rows an older build already wrote", async () => {
    const { applied } = await runMigrations(database.url);
    expect(applied).toContain(UNDER_TEST);
  });

  it("carries every override across as the version's own mock tools", async () => {
    const { rows } = await store.sql<{ mock_tools: unknown; env: unknown }>(
      "select mock_tools, env from test_version where id = $1",
      [overridingVersionId],
    );
    // The order they were authored, the new keys, and no delay: a test says
    // what a tool answers, never how slowly.
    expect(rows[0]?.mock_tools).toEqual([
      { tool: "get_availability", answer: { slots: [] } },
      { tool: "book", error: "calendar down" },
    ]);
    expect(rows[0]?.env).toBeNull();
  });

  it("leaves a version that overrode nothing holding nothing", async () => {
    const { rows } = await store.sql<{ mock_tools: unknown; env: unknown }>(
      "select mock_tools, env from test_version where id = $1",
      [plainVersionId],
    );
    // Null rather than an empty list, which is what lets the claim gate ask
    // `mock_tools is not null` and never read a value.
    expect(rows[0]).toEqual({ mock_tools: null, env: null });
  });

  it("strips the overrides key from every version's content", async () => {
    const { rows } = await store.sql<{ id: string; keys: string[] }>(
      `select id, array(select jsonb_object_keys(content) order by 1) as keys
         from test_version order by version`,
    );
    for (const row of rows) {
      expect(row.keys).toEqual(["expectedBehaviors", "scenario"]);
    }
  });

  it("strips the switch from a finished run's frozen connection", async () => {
    const { rows } = await store.sql<{ keys: string[] }>(
      `select array(select jsonb_object_keys(connection_snapshot) order by 1) as keys
         from run where id = $1`,
      [runId],
    );
    // Everything the snapshot said about the lane, and nothing about a switch
    // no code reads any more.
    expect(rows[0]?.keys).toEqual([
      "accessVariant",
      "agentPlatform",
      "config",
      "connectionType",
      "environment",
      "modality",
      "topology",
    ]);
  });

  it("puts the run header's freeze back after the one statement it held it for", async () => {
    const refused = await store
      .sql("update run set name = 'renamed' where id = $1", [runId])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(refused)).toMatch(/written once/u);
  });

  it("strips the dispatch metadata from a livekit connection's config", async () => {
    const { rows } = await store.sql<{ config: Record<string, unknown> }>(
      "select config from connection where id = $1",
      [livekitConnectionId],
    );
    // The wiring the lane still needs, and nothing a reader would refuse: a
    // test carries its own `env.job_dispatch_metadata` now.
    expect(rows[0]?.config).toEqual({
      url: "wss://acme.livekit.cloud",
      agentName: "front-desk",
    });
  });

  it("leaves a connection on another lane holding every key it had", async () => {
    const { rows } = await store.sql<{ config: Record<string, unknown> }>(
      "select config from connection where id = $1",
      [connectionId],
    );
    expect(rows[0]?.config).toEqual({ retellAgentId: "agent_1" });
  });

  it("drops the project's own mocked world, tables and all", async () => {
    const { rows } = await store.sql<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('mock_tool', 'mock_tool_agent')`,
    );
    expect(rows).toEqual([]);
  });

  it("drops the switch, the frozen world and the coverage stamp", async () => {
    const { rows } = await store.sql<{
      table_name: string;
      column_name: string;
    }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and column_name in ('mock_tools_enabled', 'mock_tool_snapshot',
                              'mock_tool_coverage')`,
    );
    expect(rows).toEqual([]);
  });

  it("drops the two checks that guarded them", async () => {
    const { rows } = await store.sql<{ conname: string }>(
      `select conname from pg_constraint
        where conname in ('connection_mock_tools_lanes',
                          'simulation_mock_tool_coverage_only_when_ended')`,
    );
    expect(rows).toEqual([]);
  });

  it("keeps every column the temporary copy is tracked by", async () => {
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

    const { rows: indexes } = await store.sql<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = $1",
      ["run_mock_tools_cleanup_owed_idx"],
    );
    expect(indexes[0]?.indexdef).toMatch(
      /WHERE .*temp_mock_agent_version_cleanup/u,
    );
  });

  it("takes a mock tool and an env on a version written afterwards", async () => {
    const written = newId("tstv");
    await store.sql(
      `insert into test_version (id, test_id, version, content, mock_tools, env)
       values ($1, $2, 3, $3::jsonb, $4::jsonb, $5::jsonb)`,
      [
        written,
        testId,
        JSON.stringify({ scenario: "Books", expectedBehaviors: ["confirms"] }),
        JSON.stringify([{ tool: "get_availability", answer: { slots: [] } }]),
        JSON.stringify({
          retell_dynamic_variables: { caller_name: "Margaret" },
          job_dispatch_metadata: { tenant: "acme" },
        }),
      ],
    );
    const { rows } = await store.sql<{ mock_tools: unknown; env: unknown }>(
      "select mock_tools, env from test_version where id = $1",
      [written],
    );
    expect(rows[0]?.mock_tools).toEqual([
      { tool: "get_availability", answer: { slots: [] } },
    ]);
    expect(rows[0]?.env).toEqual({
      retell_dynamic_variables: { caller_name: "Margaret" },
      job_dispatch_metadata: { tenant: "acme" },
    });
  });
});
