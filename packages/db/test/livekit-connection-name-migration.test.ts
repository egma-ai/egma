import { cp, mkdtemp, rm } from "node:fs/promises";
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

const MIGRATION = "0002_livekit_connection_names.sql";

const acme = {
  organization: newId("org"),
  project: newId("prj"),
  directAgent: newId("agt"),
  collisionAgent: newId("agt"),
  archivedAgent: newId("agt"),
};

let database: EmptyDatabase;
let beforeBackfill: string;
let store: SingleConnection;

beforeAll(async () => {
  database = await createEmptyDatabase("livekit_connection_name_migration");
  beforeBackfill = await mkdtemp(path.join(tmpdir(), "egma-before-livekit-names-"));

  await cp(
    path.join(MIGRATIONS_DIRECTORY, "0000_baseline.sql"),
    path.join(beforeBackfill, "0000_baseline.sql"),
  );
  await cp(
    path.join(MIGRATIONS_DIRECTORY, "0001_persona_rework.sql"),
    path.join(beforeBackfill, "0001_persona_rework.sql"),
  );
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

  for (const [id, name] of [
    [acme.directAgent, "Direct names"],
    [acme.collisionAgent, "Occupied names"],
    [acme.archivedAgent, "Archived names"],
  ] as const) {
    await store.sql(
      `insert into agent
         (id, organization_id, project_id, name, agent_platform)
       values ($1, $2, $3, $4, 'livekit')`,
      [id, acme.organization, acme.project, name],
    );
  }

  const insertConnection = (
    agentId: string,
    name: string,
    modality: "chat" | "voice",
    options: { archived?: boolean; type?: "livekit_room" | "phone_number" } = {},
  ) =>
    store.sql(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, connection_type,
          access_variant, modality, topology, config, archived_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'hosted-broker', '{}'::jsonb, $9)`,
      [
        newId("con"),
        acme.organization,
        acme.project,
        agentId,
        name,
        options.type ?? "livekit_room",
        options.type === "phone_number"
          ? "phone_number.public_e164"
          : "livekit_room.customer_token_endpoint",
        modality,
        options.archived === true ? new Date("2026-08-20T10:00:00.000Z") : null,
      ],
    );

  await insertConnection(acme.directAgent, "livekit_room-1", "chat");
  await insertConnection(acme.directAgent, "livekit_room-2", "voice");
  await insertConnection(acme.directAgent, "livekit_room-main", "chat");
  await insertConnection(acme.directAgent, "livekit_room-3", "voice", {
    type: "phone_number",
  });
  await insertConnection(acme.directAgent, "livekit_voice-4", "voice");
  await insertConnection(acme.directAgent, "livekit_room-4", "voice", {
    archived: true,
  });

  await insertConnection(acme.collisionAgent, "livekit_chat-1", "chat");
  await insertConnection(acme.collisionAgent, "livekit_room-1", "chat");
  await insertConnection(acme.collisionAgent, "livekit_room-2", "chat");
  await insertConnection(acme.collisionAgent, "livekit_voice-7", "voice");
  await insertConnection(acme.collisionAgent, "livekit_room-7", "voice");

  await insertConnection(acme.archivedAgent, "livekit_room-1", "chat", {
    archived: true,
  });
  await insertConnection(acme.archivedAgent, "livekit_room-1", "chat", {
    archived: true,
  });
}

async function namesFor(agentId: string): Promise<string[]> {
  const { rows } = await store.sql<{ name: string }>(
    `select name from connection
      where agent_id = $1
      order by name collate "C"`,
    [agentId],
  );
  return rows.map((row) => row.name);
}

describe("the LiveKit connection name backfill", () => {
  it("uses modality-specific names and leaves unrelated names alone", async () => {
    expect(await namesFor(acme.directAgent)).toEqual([
      "livekit_chat-1",
      "livekit_room-3",
      "livekit_room-main",
      "livekit_voice-1",
      "livekit_voice-2",
      "livekit_voice-4",
    ]);

    const { rows } = await store.sql<{ name: string }>(
      `select name from connection
        where agent_id = $1 and archived_at is not null`,
      [acme.directAgent],
    );
    expect(rows).toEqual([{ name: "livekit_voice-1" }]);
  });

  it("keeps active custom names and allocates collision-safe numbers", async () => {
    expect(await namesFor(acme.collisionAgent)).toEqual([
      "livekit_chat-1",
      "livekit_chat-2",
      "livekit_chat-3",
      "livekit_voice-1",
      "livekit_voice-7",
    ]);
  });

  it("gives duplicate archived legacy names distinct restorable names", async () => {
    expect(await namesFor(acme.archivedAgent)).toEqual([
      "livekit_chat-1",
      "livekit_chat-2",
    ]);
  });

  it("records the backfill as the next migration", async () => {
    const { rows } = await store.sql<{ name: string }>(
      "select name from egma_meta.migration where name = $1",
      [MIGRATION],
    );
    expect(rows).toEqual([{ name: MIGRATION }]);
  });
});
