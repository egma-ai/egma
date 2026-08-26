import { newId } from "@egma/ids";
import {
  createPersona,
  deletePersona,
  editPersona,
  forkPersona,
  getPersona,
  getPersonaVersion,
  listPersonas,
  PERSONA_LIBRARY_CATALOG,
  EGMA_PROVIDED_PERSONAS,
  EgmaProvidedPersonaError,
  provisionOrganization,
  RECOMMENDED_PERSONA_MODELS,
  seedPersonaLibrary,
  type AuthContext,
  type PersonaModels,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createConnectedDatabase,
  openSingleConnection,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedUser } from "./support/tenancy.ts";

/**
 * Provisioning a project, and the shelf of personas Egma provides.
 *
 * **A project is now complete without naming a persona at all.** It used to be
 * born pointing at Egma's shared persona, which made creating one depend on the
 * catalog having been seeded first. That pointer is gone, so the first
 * assertion here is the one that would have been impossible before: an
 * organization provisioned against an empty catalog is a usable organization.
 *
 * The rest is the shelf itself — read-only, undeletable, forkable, and fixed
 * version by fixed version.
 */

let database: MigratedDatabase;

const DEFAULT_PERSONA_MODELS: PersonaModels = {
  ...RECOMMENDED_PERSONA_MODELS,
  llm: {
    provider: "openai",
    model: "gpt-5.6-terra",
  },
};

type Provisioned = {
  readonly auth: AuthContext;
  readonly projectId: string;
};

async function signUp(slug: string): Promise<Provisioned> {
  const userId = newId("usr");
  await seedUser(database, userId, `${slug}@example.test`);
  const made = await provisionOrganization({
    ownerUserId: userId,
    organizationName: slug,
    organizationSlug: slug,
    projectName: "Default",
    projectSlug: "default",
  });
  return {
    projectId: made.projectId,
    auth: {
      userId,
      organizationId: made.organizationId,
      projectId: made.projectId,
      role: made.membership.role,
      via: "session",
    },
  };
}

/** Wait for a real Postgres lock edge, not an elapsed-time guess. */
async function waitUntilBlockedBy(blockerPid: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { rows } = await database.sql<{ blocked: boolean }>(
      `select exists (
         select 1
           from pg_stat_activity
          where $1::integer = any(pg_blocking_pids(pid))
       ) as blocked`,
      [blockerPid],
    );
    if (rows[0]?.blocked === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the fork never waited for the source version change");
}

/** The one provisioned before the catalog existed at all. */
let earlyBird: Provisioned;
let acme: Provisioned;
let globex: Provisioned;

beforeAll(async () => {
  database = await createConnectedDatabase("provisioning_persona_catalog", {
    seedPersonas: false,
  });

  // Deliberately first, with nothing on the shelf.
  earlyBird = await signUp("early-bird");

  await seedPersonaLibrary();
  acme = await signUp("acme-persona-library");
  globex = await signUp("globex-persona-library");
});

afterAll(async () => {
  await database.drop();
});

describe("provisioning a project", () => {
  it("succeeds against an empty persona catalog", async () => {
    // Nothing to point at, and nothing that needed pointing at. The project is
    // whole: it exists, it is the caller's, and it can be authored in.
    expect(earlyBird.projectId).toMatch(/^prj_/);

    const made = await createPersona(earlyBird.auth, {
      name: "First caller",
      identityName: "Nina Okonkwo",
      personality: "Calls about a booking and stays patient.",
      language: "en-US",
    });
    expect(made.projectId).toBe(earlyBird.projectId);
  });

  it("writes no persona pointer, because the project has no column for one", async () => {
    const { rows } = await database.sql(
      `select column_name from information_schema.columns
        where table_schema = 'public'
          and table_name = 'project'
          and column_name like '%persona%'`,
    );
    expect(rows).toEqual([]);
  });

  it("gives a new project a library holding exactly what Egma provides", async () => {
    expect((await listPersonas(acme.auth)).items.map((one) => one.id)).toEqual([
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    ]);
    expect((await listPersonas(globex.auth)).items.map((one) => one.id)).toEqual(
      [EGMA_PROVIDED_PERSONAS.defaultPersona],
    );
  });
});

describe("the Predefined persona", () => {
  it("is one Egma-provided identity, carrying a human identity name", async () => {
    const persona = await getPersona(
      acme.auth,
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    );
    expect(persona).toMatchObject({
      owner: "egma",
      projectId: null,
      version: 1,
      identityName: "Alex Morgan",
      personality:
        "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
      language: "en-US",
      models: DEFAULT_PERSONA_MODELS,
    });
  });

  it("is seeded idempotently", async () => {
    expect(await seedPersonaLibrary()).toEqual([]);
    expect(await seedPersonaLibrary()).toEqual([]);
  });

  it("cannot be edited or deleted", async () => {
    await expect(
      editPersona(acme.auth, EGMA_PROVIDED_PERSONAS.defaultPersona, {
        personality: "Different",
      }),
    ).rejects.toBeInstanceOf(EgmaProvidedPersonaError);
    await expect(
      deletePersona(acme.auth, EGMA_PROVIDED_PERSONAS.defaultPersona),
    ).rejects.toBeInstanceOf(EgmaProvidedPersonaError);
  });

  it("refuses the delete stamp even to raw SQL that bypasses the module", async () => {
    await expect(
      database.sql("update persona set archived_at = now() where id = $1", [
        EGMA_PROVIDED_PERSONAS.defaultPersona,
      ]),
    ).rejects.toMatchObject({
      constraint: "persona_egma_provided_is_active",
    });
  });
});

describe("forking a persona", () => {
  it("copies the behavior atomically into an independent version", async () => {
    const source = await getPersona(
      acme.auth,
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    );
    const fork = await forkPersona(
      acme.auth,
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    );
    if (source === undefined || fork === undefined) {
      throw new Error("the source or fork is missing");
    }

    expect(fork).toMatchObject({
      owner: "organization",
      projectId: acme.projectId,
      version: 1,
      identityName: source.identityName,
      personality: source.personality,
      language: source.language,
      models: source.models,
    });
    const { rows } = await database.sql<{
      identity_name: string;
      personality: string;
      language: string;
    }>(
      `select identity_name, personality, language
         from persona_version where id = $1`,
      [fork.versionId],
    );
    expect(rows[0]).toEqual({
      identity_name: source.identityName,
      personality: source.personality,
      language: source.language,
    });

    const edited = await editPersona(acme.auth, fork.id, {
      personality: "Pushes back once when the agent is wrong.",
    });
    expect(edited?.version).toBe(2);
    expect(edited?.models).toEqual(source.models);
    expect(
      (await getPersona(acme.auth, EGMA_PROVIDED_PERSONAS.defaultPersona))?.version,
    ).toBe(1);
  });

  it("copies the source version that wins the source-row lock", async () => {
    const source = await createPersona(acme.auth, {
      name: "Concurrent source",
      identityName: "Casey Lund",
      personality: "Starts as the first version.",
      language: "en-US",
    });
    const nextVersionId = newId("prsv");
    const nextPersonality =
      "Is the committed current version and waits for a complete answer.";
    const holder = await openSingleConnection(database.url);
    let forking: ReturnType<typeof forkPersona> | undefined;

    try {
      await holder.sql("begin");
      const { rows: sessions } = await holder.sql<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const blockerPid = sessions[0]?.pid;
      if (blockerPid === undefined) throw new Error("the holder has no pid");

      await holder.sql(
        `insert into persona_version
           (id, persona_id, version, identity_name, personality, language,
            llm_provider, llm_model, stt_provider, stt_model,
            tts_provider, tts_model, tts_voice_id, tts_speed, created_by)
         values ($1, $2, 2, $3, $4, 'en-US', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          nextVersionId,
          source.id,
          source.identityName,
          nextPersonality,
          source.models.llm.provider,
          source.models.llm.model,
          source.models.stt.provider,
          source.models.stt.model,
          source.models.tts.provider,
          source.models.tts.model,
          source.models.tts.voiceId,
          source.models.tts.speed,
          acme.auth.userId,
        ],
      );
      await holder.sql(
        `update persona
            set current_version_id = $1,
                updated_at = now()
          where id = $2`,
        [nextVersionId, source.id],
      );

      // The old implementation read version 1 without a lock and created its
      // copy while this transaction was still open. Fork must instead wait on
      // this source row, then copy the version that commits.
      forking = forkPersona(acme.auth, source.id);
      await waitUntilBlockedBy(blockerPid);
      const { rows: copiesBeforeCommit } = await database.sql<{ count: number }>(
        `select count(*)::integer as count
           from persona
          where project_id = $1 and name = $2`,
        [acme.projectId, source.name],
      );
      expect(copiesBeforeCommit[0]?.count).toBe(1);
      await holder.sql("commit");

      const fork = await forking;
      expect(fork).toMatchObject({
        owner: "organization",
        projectId: acme.projectId,
        version: 1,
        personality: nextPersonality,
        models: source.models,
      });
      const { rows: copiesAfterCommit } = await database.sql<{ count: number }>(
        `select count(*)::integer as count
           from persona
          where project_id = $1 and name = $2`,
        [acme.projectId, source.name],
      );
      expect(copiesAfterCommit[0]?.count).toBe(2);
    } finally {
      await holder.sql("rollback").catch(() => undefined);
      await forking?.catch(() => undefined);
      await holder.close();
    }
  });
});

describe("catalog integrity", () => {
  it("carries an identity name and one complete models value in every fixed version", () => {
    expect(PERSONA_LIBRARY_CATALOG).toHaveLength(1);
    const version = PERSONA_LIBRARY_CATALOG[0]?.versions[0];
    expect(version).toMatchObject({
      id: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C97",
      version: 1,
      identityName: "Alex Morgan",
      models: DEFAULT_PERSONA_MODELS,
    });
    // Never the team's word for them: an agent asking who is calling has to
    // hear a person, not a shelf label.
    expect(version?.identityName).not.toBe(PERSONA_LIBRARY_CATALOG[0]?.name);
  });

  it("refuses changed content under a fixed catalog version id at the database", async () => {
    const versionId = PERSONA_LIBRARY_CATALOG[0]?.versions[0]?.id;
    if (versionId === undefined) throw new Error("the fixed v1 is missing");
    await expect(
      database.sql(
        `update persona_version set stt_model = 'gpt-4o-transcribe' where id = $1`,
        [versionId],
      ),
    ).rejects.toThrow(/persona version.*authored content cannot change/u);

    await expect(seedPersonaLibrary()).resolves.toEqual([]);
  });

  it("adds a new immutable catalog version without changing an existing fork", async () => {
    const entry = PERSONA_LIBRARY_CATALOG[0];
    const v1 = entry?.versions[0];
    if (entry === undefined || v1 === undefined) {
      throw new Error("the Predefined persona catalog entry is incomplete");
    }
    const fork = await forkPersona(
      acme.auth,
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    );
    if (fork === undefined) throw new Error("the fork is missing");

    const v2 = {
      ...v1,
      id: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C98",
      version: 2,
      personality: "Stays calm and asks one clear question.",
      models: {
        ...v1.models,
        stt: { provider: "openai", model: "gpt-live-transcribe" },
      },
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    } as const;

    expect(
      await seedPersonaLibrary([
        { ...entry, versions: [...entry.versions, v2] },
      ]),
    ).toEqual([
      {
        id: entry.id,
        name: entry.name,
        version: 2,
        versionId: v2.id,
      },
    ]);
    expect(await getPersonaVersion(acme.auth, v1.id)).toMatchObject({
      identityName: v1.identityName,
      personality: v1.personality,
      language: v1.language,
      models: v1.models,
    });
    expect(await getPersona(acme.auth, fork.id)).toMatchObject({
      version: 1,
      versionId: fork.versionId,
      identityName: fork.identityName,
      personality: fork.personality,
      models: fork.models,
    });
  });
});
