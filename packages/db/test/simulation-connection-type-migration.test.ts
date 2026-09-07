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
 * The connection-type backfill.
 *
 * Every simulation names a connection by a foreign key, so the lane it ran
 * over is a fact the database already holds and the backfill only moves it
 * onto the row. What this proves is that it moved for every row rather than
 * for the newest ones: a month's usage read off a half-filled column would be
 * a number that is wrong and looks right.
 */

const MIGRATION = "0009_simulation_connection_type.sql";

const acme = {
  organization: newId("org"),
  project: newId("prj"),
  agent: newId("agt"),
  suite: newId("ste"),
  test: newId("tst"),
  testVersion: newId("tstv"),
  persona: newId("prs"),
  personaVersion: newId("prsv"),
  run: newId("run"),
};

/** One conversation per lane, so no lane is filled by accident. */
const LANES = [
  ["retell_chat_api", "retell_chat_api.api_key", "chat"],
  ["retell_text_mode", "retell_text_mode.api_key", "chat"],
  ["retell_web_call", "retell_web_call.api_key", "voice"],
  ["phone_number", "phone_number.public_e164", "voice"],
  ["livekit_room", "livekit_room.project_credentials", "voice"],
] as const;

let database: EmptyDatabase;
let beforeBackfill: string;
let store: SingleConnection;

beforeAll(async () => {
  database = await createEmptyDatabase("simulation_connection_type_migration");
  beforeBackfill = await mkdtemp(
    path.join(tmpdir(), "egma-before-connection-type-"),
  );

  // Every migration this one follows, and none after it — the schema exactly
  // as it stood the moment before the column existed.
  const earlier = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => name.endsWith(".sql") && name < MIGRATION)
    .sort();
  for (const name of earlier) {
    await cp(
      path.join(MIGRATIONS_DIRECTORY, name),
      path.join(beforeBackfill, name),
    );
  }
  await runMigrations(database.url, beforeBackfill);

  store = await openSingleConnection(database.url);
  await seedRowsFromBeforeTheBackfill();
  await runMigrations(database.url);
});

afterAll(async () => {
  await store?.close();
  await database?.drop();
  if (beforeBackfill !== undefined) {
    await rm(beforeBackfill, { recursive: true, force: true });
  }
});

async function seedRowsFromBeforeTheBackfill(): Promise<void> {
  await store.sql(
    "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
    [acme.organization],
  );
  await store.sql(
    `insert into project (id, organization_id, name, slug, revision)
     values ($1, $2, 'Default', 'default', $3)`,
    [acme.project, acme.organization, newId("rev")],
  );
  await store.sql(
    `insert into agent (id, organization_id, project_id, name, agent_platform)
     values ($1, $2, $3, 'Front desk', 'retell')`,
    [acme.agent, acme.organization, acme.project],
  );
  await store.sql(
    `insert into test_suite (id, organization_id, project_id, name)
     values ($1, $2, $3, 'Regression')`,
    [acme.suite, acme.organization, acme.project],
  );

  // A persona and its version name each other, so the pair goes in together.
  await store.sql("begin");
  await store.sql(
    `insert into persona (id, organization_id, project_id, name, current_version_id)
     values ($1, $2, $3, 'Impatient Rita', $4)`,
    [acme.persona, acme.organization, acme.project, acme.personaVersion],
  );
  await store.sql(
    `insert into persona_version
       (id, persona_id, version, identity_name, personality, language,
        llm_provider, llm_model, stt_provider, stt_model,
        tts_provider, tts_model, tts_voice_id, tts_speed)
     values ($1, $2, 1, 'Rita Alvarez', 'Speaks plainly.', 'en-US',
       'openai', 'gpt-4.1', 'deepgram', 'nova-3', 'cartesia', 'sonic-2',
       'voice-1', 1.0)`,
    [acme.personaVersion, acme.persona],
  );
  await store.sql("commit");

  await store.sql("begin");
  await store.sql(
    `insert into test
       (id, organization_id, project_id, suite_id, name, current_version_id, revision)
     values ($1, $2, $3, $4, 'Reschedules', $5, $6)`,
    [
      acme.test,
      acme.organization,
      acme.project,
      acme.suite,
      acme.testVersion,
      newId("rev"),
    ],
  );
  await store.sql(
    `insert into test_version (id, test_id, version, content)
     values ($1, $2, 1, '{"scenario": "Moves the cleaning", "expectedBehaviors": ["confirms"]}'::jsonb)`,
    [acme.testVersion, acme.test],
  );
  await store.sql("commit");

  await store.sql(
    `insert into run
       (id, organization_id, project_id, suite_id, agent_id, connection_id,
        status, triggered_via, connection_snapshot, expected_simulation_count)
     values ($1, $2, $3, $4, $5, $6, 'pending', 'manual', $7::jsonb, $8)`,
    [
      acme.run,
      acme.organization,
      acme.project,
      acme.suite,
      acme.agent,
      await connectionFor(LANES[0]),
      JSON.stringify({
        agentPlatform: "retell",
        connectionType: LANES[0][0],
        accessVariant: LANES[0][1],
        modality: LANES[0][2],
        topology: "hosted-broker",
        environment: null,
        config: {},
      }),
      LANES.length,
    ],
  );

  // One conversation per lane, still on the schema before the column.
  for (const [position, lane] of LANES.entries()) {
    await store.sql(
      `insert into simulation
         (id, run_id, organization_id, project_id, agent_id, connection_id,
          persona_id, persona_version_id, test_id, test_version_id,
          position, modality, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'queued')`,
      [
        newId("sim"),
        acme.run,
        acme.organization,
        acme.project,
        acme.agent,
        await connectionFor(lane),
        acme.persona,
        acme.personaVersion,
        acme.test,
        acme.testVersion,
        position + 1,
        lane[2],
      ],
    );
  }
}

const connections = new Map<string, string>();

/** One connection per lane, made once and remembered. */
async function connectionFor(
  lane: (typeof LANES)[number],
): Promise<string> {
  const [connectionType, accessVariant, modality] = lane;
  const held = connections.get(connectionType);
  if (held !== undefined) return held;
  const id = newId("con");
  await store.sql(
    `insert into connection
       (id, organization_id, project_id, agent_id, name, connection_type,
        access_variant, modality, topology, config)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'hosted-broker', '{}'::jsonb)`,
    [
      id,
      acme.organization,
      acme.project,
      acme.agent,
      `${connectionType}-1`,
      connectionType,
      accessVariant,
      modality,
    ],
  );
  connections.set(connectionType, id);
  return id;
}

describe("the simulation connection-type backfill", () => {
  it("fills every row from the connection it already names", async () => {
    const { rows } = await store.sql<{
      connection_type: string;
      from_connection: string;
    }>(
      `select simulation.connection_type,
              connection.connection_type as from_connection
         from simulation
         join connection on connection.id = simulation.connection_id
        order by simulation.position`,
    );

    expect(rows).toHaveLength(LANES.length);
    expect(rows.map((row) => row.connection_type)).toEqual(
      LANES.map((lane) => lane[0]),
    );
    for (const row of rows) {
      expect(row.connection_type).toBe(row.from_connection);
    }
  });

  it("leaves no row unfilled, and refuses one written without it", async () => {
    const { rows } = await store.sql<{ unfilled: string }>(
      "select count(*)::text as unfilled from simulation where connection_type is null",
    );
    expect(rows[0]?.unfilled).toBe("0");

    await expect(
      store.sql(
        `insert into simulation
           (id, run_id, organization_id, project_id, agent_id, connection_id,
            persona_id, persona_version_id, test_id, test_version_id,
            position, modality, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 99, 'chat', 'queued')`,
        [
          newId("sim"),
          acme.run,
          acme.organization,
          acme.project,
          acme.agent,
          await connectionFor(LANES[0]),
          acme.persona,
          acme.personaVersion,
          acme.test,
          acme.testVersion,
        ],
      ),
    ).rejects.toThrow();
  });

  it("refuses a lane Egma's simulator has no name for", async () => {
    await expect(
      store.sql(
        `insert into simulation
           (id, run_id, organization_id, project_id, agent_id, connection_id,
            persona_id, persona_version_id, test_id, test_version_id,
            position, modality, connection_type, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 98, 'chat', 'carrier_pigeon', 'queued')`,
        [
          newId("sim"),
          acme.run,
          acme.organization,
          acme.project,
          acme.agent,
          await connectionFor(LANES[0]),
          acme.persona,
          acme.personaVersion,
          acme.test,
          acme.testVersion,
        ],
      ),
    ).rejects.toThrow(/simulation_connection_type_allowed/u);
  });
});
