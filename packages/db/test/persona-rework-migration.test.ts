import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connect,
  disconnect,
  getPersona,
  getPersonaVersion,
  listPersonas,
  listPersonaVersions,
  MIGRATIONS_DIRECTORY,
  runMigrations,
  type AuthContext,
} from "@egma/db";

import {
  createEmptyDatabase,
  errorCodeOf,
  POSTGRES_ERROR,
  TEST_ENCRYPTION_KEY,
  type EmptyDatabase,
} from "./support/database.ts";

/**
 * The persona rework's one destructive migration, run the way a real database
 * meets it: over rows written in the old shape.
 *
 * **This is the one storage-shaped proof that is genuinely external.** Every
 * other test in this area asserts what a caller of the module observes, and
 * should; this one exists because the migration's whole promise is about data
 * that already exists, and no read of a freshly created database can say
 * anything about it. So the baseline is applied on its own, rows are written
 * through raw SQL exactly as the old build wrote them — jsonb traits carrying
 * accent and background noise, jsonb models, a project default pointer, a
 * revision token, an archived persona — and only then does the rework land.
 *
 * What it has to show afterwards: nothing authored was lost, every persona
 * carries an identity name taken from the team name they already had, the dead
 * machinery is gone from the catalog, and the ordinary reads answer whole.
 */

const BASELINE = "0000_baseline.sql";

/** The fixed catalog version the baseline seeds, and the name it now gives. */
const CATALOG = {
  personaId: "prs_01M0E4EVJ6ECGVJEA4NSBTC0CC",
  versionId: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C97",
  identityName: "Alex Morgan",
} as const;

const OLD_MODELS = {
  llm: { provider: "openai", model: "gpt-5.6-terra" },
  stt: { provider: "deepgram", model: "nova-3-general" },
  tts: {
    provider: "cartesia",
    model: "sonic-3.5",
    voiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    speed: 0.9,
  },
} as const;

const acme = {
  organization: newId("org"),
  project: newId("prj"),
};
const rita = { id: newId("prs"), v1: newId("prsv"), v2: newId("prsv") };
const gone = { id: newId("prs"), v1: newId("prsv") };

function actingAsAcme(): AuthContext {
  return {
    userId: newId("usr"),
    organizationId: acme.organization,
    projectId: acme.project,
    role: "admin",
    via: "session",
  };
}

let database: EmptyDatabase;
let baselineOnly: string;
let sql: (text: string, values?: readonly unknown[]) => Promise<{
  rows: Record<string, unknown>[];
}>;
let closePool: () => Promise<void>;

beforeAll(async () => {
  database = await createEmptyDatabase("persona_rework_migration");

  // The baseline alone, from a directory holding nothing else. Applying the
  // real directory afterwards finds the baseline already recorded under the
  // same hash and applies only what follows it — which is the migration under
  // test, met exactly as a deployment meets it.
  baselineOnly = await mkdtemp(path.join(tmpdir(), "egma-baseline-"));
  await cp(
    path.join(MIGRATIONS_DIRECTORY, BASELINE),
    path.join(baselineOnly, BASELINE),
  );
  await runMigrations(database.url, baselineOnly);

  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: database.url, max: 4 });
  pool.on("error", () => undefined);
  sql = (text, values) =>
    pool.query(text, values as unknown[] | undefined) as Promise<{
      rows: Record<string, unknown>[];
    }>;
  closePool = () => pool.end();

  await seedOldShapeRows();
  await runMigrations(database.url);

  connect({ databaseUrl: database.url, encryptionKey: TEST_ENCRYPTION_KEY });
});

afterAll(async () => {
  await disconnect();
  await closePool?.();
  await database?.drop();
  if (baselineOnly !== undefined) {
    await rm(baselineOnly, { recursive: true, force: true });
  }
});

/** Exactly what the build before this migration wrote, and nothing newer. */
async function seedOldShapeRows(): Promise<void> {
  await sql("insert into organization (id, name, slug) values ($1, $2, $2)", [
    acme.organization,
    "acme",
  ]);
  await sql(
    "insert into project (id, organization_id, name, slug, revision) values ($1, $2, $3, $3, $4)",
    [acme.project, acme.organization, "default", newId("rev")],
  );

  const persona = async (
    id: string,
    name: string,
    description: string | null,
    currentVersionId: string,
    archived: boolean,
  ) =>
    sql(
      `insert into persona
         (id, organization_id, project_id, name, description,
          current_version_id, revision, archived_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        acme.organization,
        acme.project,
        name,
        description,
        currentVersionId,
        newId("rev"),
        archived ? new Date("2026-08-20T10:00:00.000Z") : null,
      ],
    );

  const version = async (
    id: string,
    personaId: string,
    number: number,
    personality: string,
  ) =>
    sql(
      `insert into persona_version
         (id, persona_id, version, traits, models)
       values ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        id,
        personaId,
        number,
        JSON.stringify({
          personality,
          language: "en-US",
          accent: "Neutral American English.",
          backgroundNoise: "A quiet kitchen.",
        }),
        JSON.stringify(OLD_MODELS),
      ],
    );

  // The deferred pointer constraint lets both halves land in one transaction;
  // separate statements on a pool cannot, so the versions go in first and the
  // identity names the one that will be current.
  await sql("begin");
  await persona(rita.id, "Impatient Rita", "Books by phone only", rita.v2, false);
  await version(rita.v1, rita.id, 1, "Rita, as she was first written.");
  await version(rita.v2, rita.id, 2, "Rita, after the hearing aid arrived.");
  await persona(gone.id, "Retired Ray", null, gone.v1, true);
  await version(gone.v1, gone.id, 1, "Ray, who nobody calls any more.");
  await sql("commit");

  // A project pointing at one of its own personas, which is the state the two
  // dropped triggers existed to protect.
  await sql("update project set default_persona_id = $1 where id = $2", [
    rita.id,
    acme.project,
  ]);
}

async function columnsOf(table: string): Promise<string[]> {
  const { rows } = await sql(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return rows.map((row) => String(row.column_name)).sort();
}

describe("the rows the old build wrote", () => {
  it("come back whole, with the identity name taken from the team name", async () => {
    const { rows } = await sql(
      `select version, identity_name, personality, language,
              llm_provider, llm_model, stt_provider, stt_model,
              tts_provider, tts_model, tts_voice_id, tts_speed
         from persona_version where persona_id = $1 order by version`,
      [rita.id],
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      version: 1,
      identity_name: "Impatient Rita",
      personality: "Rita, as she was first written.",
      language: "en-US",
      llm_provider: "openai",
      llm_model: "gpt-5.6-terra",
      stt_provider: "deepgram",
      stt_model: "nova-3-general",
      tts_provider: "cartesia",
      tts_model: "sonic-3.5",
      tts_voice_id: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    });
    expect(Number(rows[0]?.tts_speed)).toBe(0.9);
    expect(rows[1]).toMatchObject({
      version: 2,
      identity_name: "Impatient Rita",
      personality: "Rita, after the hearing aid arrived.",
    });
  });

  it("keep a deleted persona deleted, stamp and all", async () => {
    const { rows } = await sql(
      "select name, archived_at from persona where id = $1",
      [gone.id],
    );
    expect(rows[0]?.name).toBe("Retired Ray");
    expect(rows[0]?.archived_at).toBeInstanceOf(Date);
  });

  it("give the seeded catalog version a human identity name", async () => {
    const { rows } = await sql(
      "select identity_name from persona_version where id = $1",
      [CATALOG.versionId],
    );
    expect(rows[0]?.identity_name).toBe(CATALOG.identityName);
  });
});

describe("the machinery the rework removes", () => {
  it("leaves no jsonb bags and no revision on the persona tables", async () => {
    const versionColumns = await columnsOf("persona_version");
    expect(versionColumns).not.toContain("traits");
    expect(versionColumns).not.toContain("models");
    expect(versionColumns).toContain("identity_name");

    expect(await columnsOf("persona")).not.toContain("revision");
  });

  it("leaves no default-persona pointer on the project", async () => {
    expect(await columnsOf("project")).not.toContain("default_persona_id");
  });

  it("leaves neither pointer guard nor the archive guard behind", async () => {
    const { rows } = await sql(
      `select tgname from pg_trigger
        where not tgisinternal
          and tgname in (
            'project_default_persona_availability_insert_guard',
            'project_default_persona_availability_update_guard',
            'persona_default_archive_guard'
          )`,
    );
    expect(rows).toEqual([]);

    const { rows: functions } = await sql(
      `select proname from pg_proc
        where proname in (
          'guard_project_default_persona_availability',
          'guard_default_persona_archive',
          'persona_is_active_default_for_project'
        )`,
    );
    expect(functions).toEqual([]);
  });

  it("keeps the availability helper the test and simulation guards call", async () => {
    const { rows } = await sql(
      "select proname from pg_proc where proname = 'persona_is_available_to_project'",
    );
    expect(rows).toHaveLength(1);
  });
});

describe("the rewritten immutability guard", () => {
  it("refuses a direct rewrite of a migrated version's identity name", async () => {
    await expect(
      sql("update persona_version set identity_name = 'Someone Else' where id = $1", [
        rita.v1,
      ]),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });

  it("refuses a direct rewrite of a migrated version's speaking speed", async () => {
    await expect(
      sql("update persona_version set tts_speed = 1.2 where id = $1", [rita.v1]),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });
});

describe("the ordinary reads, over migrated rows", () => {
  it("answer the current version whole", async () => {
    const found = await getPersona(actingAsAcme(), rita.id);

    expect(found).toMatchObject({
      id: rita.id,
      name: "Impatient Rita",
      description: "Books by phone only",
      owner: "organization",
      version: 2,
      versionId: rita.v2,
      identityName: "Impatient Rita",
      personality: "Rita, after the hearing aid arrived.",
      language: "en-US",
      archivedAt: null,
    });
    expect(found?.models).toEqual(OLD_MODELS);
  });

  it("answer an old version exactly as it was written", async () => {
    const first = await getPersonaVersion(actingAsAcme(), rita.v1);

    expect(first).toMatchObject({
      version: 1,
      identityName: "Impatient Rita",
      personality: "Rita, as she was first written.",
      language: "en-US",
    });
    expect(first?.models).toEqual(OLD_MODELS);
  });

  it("keep the whole history of a migrated persona", async () => {
    const { items } = await listPersonaVersions(actingAsAcme(), rita.id);
    expect(items.map((version) => version.version)).toEqual([2, 1]);
  });

  it("list the living personas and leave the deleted one out", async () => {
    const { items } = await listPersonas(actingAsAcme());
    const names = items.map((one) => one.name);

    expect(names).toContain("Impatient Rita");
    expect(names).toContain("Default Persona");
    expect(names).not.toContain("Retired Ray");
  });

  it("still answer a deleted persona asked for by their own id", async () => {
    const found = await getPersona(actingAsAcme(), gone.id);
    expect(found?.name).toBe("Retired Ray");
    expect(found?.archivedAt).toBeInstanceOf(Date);
    expect(found?.identityName).toBe("Retired Ray");
  });

  it("hand the seeded catalog persona back under its new identity name", async () => {
    const found = await getPersona(actingAsAcme(), CATALOG.personaId);
    expect(found?.owner).toBe("egma");
    expect(found?.identityName).toBe(CATALOG.identityName);
  });
});
