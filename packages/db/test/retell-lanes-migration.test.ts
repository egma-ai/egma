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
 * The Retell lanes migration, run the way a real deployment meets it: over a
 * database that already holds connections, runs and finished simulations.
 *
 * Two things are proved here that a fresh database cannot say anything about.
 *
 * **The cut is clean.** The migration replaces the connection row's own
 * connection-type check and the access-variant check beside it, and nothing
 * else in the schema gates a connection-type value — asserted below against the
 * live catalog rather than assumed, because a gate nobody remembered would
 * refuse the new kinds at the first write on a customer's database and nowhere
 * earlier.
 *
 * **Nothing already written moves.** Every connection type an older build could
 * have written is still admitted, and every existing row reads exactly as it
 * did.
 */

const UNDER_TEST = "0002_retell_lanes.sql";

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
        claimed_by, claimed_at, heartbeat_at, started_at, ended_at, turn_count
)
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
  database = await createEmptyDatabase("retell_lanes_migration");

  // Everything up to the migration under test, from a directory holding
  // nothing else. Applying the real directory afterwards finds those already
  // recorded under the same hashes and applies only what follows.
  before = await mkdtemp(path.join(tmpdir(), "egma-before-retell-lanes-"));
  const earlier = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => name.endsWith(".sql") && name < UNDER_TEST)
    .sort();
  expect(earlier).toContain("0000_baseline.sql");
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

describe("the Retell lanes migration over a populated database", () => {
  it("applies over rows an older build already wrote", async () => {
    const { applied } = await runMigrations(database.url);
    expect(applied).toContain(UNDER_TEST);
  });

  it("admits the two new doors and their access variants", async () => {
    for (const [connectionType, accessVariant, modality] of [
      ["retell_text_mode", "retell_text_mode.api_key", "chat"],
      ["retell_web_call", "retell_web_call.api_key", "voice"],
    ] as const) {
      const connectionId = newId("con");
      await store.sql(
        `insert into connection
           (id, organization_id, project_id, agent_id, name, connection_type,
            access_variant, modality, topology, config)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'hosted-broker',
           '{"retellAgentId": "agent_1"}'::jsonb)`,
        [
          connectionId,
          acme.organization,
          acme.project,
          agentId,
          `Door ${connectionType}`,
          connectionType,
          accessVariant,
          modality,
        ],
      );
      const { rows } = await store.sql<{ connection_type: string }>(
        "select connection_type from connection where id = $1",
        [connectionId],
      );
      expect(rows[0]?.connection_type).toBe(connectionType);
    }
  });

  it("keeps every connection type an older build could have written", async () => {
    const { rows } = await store.sql<{ connection_type: string }>(
      "select connection_type from connection where id = any($1::text[])",
      [connectionIds],
    );
    expect(rows).toHaveLength(EXISTING_CONNECTIONS.length);
    for (const [connectionType] of EXISTING_CONNECTIONS) {
      expect(rows.some((row) => row.connection_type === connectionType)).toBe(
        true,
      );
    }
  });

  it("still refuses a connection type nothing in Egma names", async () => {
    const refused = await store
      .sql(
        `insert into connection
           (id, organization_id, project_id, agent_id, name, connection_type,
            access_variant, modality, topology, config)
         values ($1, $2, $3, $4, 'Nonsense', 'retell_telepathy',
           'retell_text_mode.api_key', 'chat', 'hosted-broker', '{}'::jsonb)`,
        [newId("con"), acme.organization, acme.project, agentId],
      )
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(refused)).toMatch(/connection_type_allowed/u);
  });

  it("is a clean cut: nothing but the connection row's own check gates the value", async () => {
    // The ticket's claim, checked against the live catalog rather than taken on
    // trust. A second gate anywhere — a check on the evidence side, a column of
    // its own, an enum, a domain — would refuse the new kinds at the first
    // write on a customer's database and nowhere earlier.
    const { rows: checks } = await store.sql<{
      on_table: string;
      conname: string;
    }>(
      `select c.conrelid::regclass::text as on_table, c.conname
         from pg_constraint c
        where pg_get_constraintdef(c.oid) like '%retell_chat_api%'`,
    );
    expect(
      checks.map((row) => `${row.on_table}.${row.conname}`).sort(),
    ).toEqual([
      // The access variant is a second value on the same row, not a second
      // gate on the connection type.
      "connection.connection_access_variant_allowed",
      "connection.connection_type_allowed",
    ]);

    const { rows: columns } = await store.sql<{ table_name: string }>(
      `select table_name from information_schema.columns
        where column_name = 'connection_type'`,
    );
    expect(columns.map((row) => row.table_name)).toEqual(["connection"]);

    const { rows: enums } = await store.sql(
      "select 1 from pg_type t join pg_enum e on e.enumtypid = t.oid",
    );
    expect(enums).toHaveLength(0);

    const { rows: domains } = await store.sql(
      "select 1 from information_schema.domains where domain_schema = 'public'",
    );
    expect(domains).toHaveLength(0);

    // Every trigger function, checked for a connection type in its body. The
    // pattern is escaped so `_` is a literal underscore and not the
    // single-character wildcard it is in LIKE — an unescaped one matches
    // "Retell account" in a comment and reports a gate that is not there.
    const { rows: triggers } = await store.sql<{ proname: string }>(
      `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and (p.prosrc like '%connection\\_type%'
            or p.prosrc like '%retell\\_%')`,
    );
    expect(triggers).toHaveLength(0);
  });

  it("leaves the finished run and its simulation frozen", async () => {
    const refusedRun = await store
      .sql("update run set name = 'renamed' where id = $1", [runId])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(refusedRun)).toMatch(/written once/u);

    const refusedSimulation = await store
      .sql("update simulation set turn_count = 99 where id = $1", [
        finishedSimulation,
      ])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(refusedSimulation)).toMatch(
      /terminal simulation is written once/u,
    );
  });
});
