import { newId } from "@egma/ids";
import {
  createPersona,
  usePersona,
  legacyPersonaParameterContract,
  personaParameterContract,
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
 * Provisioning works without a seeded persona catalog. Egma-provided
 * personas are read-only and can be forked into Custom personas.
 */

let database: MigratedDatabase;

const DEFAULT_PERSONA_MODELS: PersonaModels = {
  ...RECOMMENDED_PERSONA_MODELS,
  llm: {
    provider: "openai",
    model: "gpt-5.6-terra",
  },
};

const EVERYDAY_CALLER_V1_MODELS: PersonaModels = {
  ...DEFAULT_PERSONA_MODELS,
  tts: {
    provider: "cartesia",
    model: "sonic-3.5",
    voiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    speed: 1,
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
      EGMA_PROVIDED_PERSONAS.spanishCaller,
      EGMA_PROVIDED_PERSONAS.angryCaller,
      EGMA_PROVIDED_PERSONAS.everydayFemale,
    ]);
    expect((await listPersonas(globex.auth)).items.map((one) => one.id)).toEqual(
      [
        EGMA_PROVIDED_PERSONAS.defaultPersona,
        EGMA_PROVIDED_PERSONAS.spanishCaller,
        EGMA_PROVIDED_PERSONAS.angryCaller,
        EGMA_PROVIDED_PERSONAS.everydayFemale,
      ],
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
      version: 3,
      identityName: "Alex Morgan",
      personality:
        "Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
      language: "en-US",
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
      database.sql("update persona_definition set archived_at = now() where id = $1", [
        EGMA_PROVIDED_PERSONAS.defaultPersona,
      ]),
    ).rejects.toMatchObject({
      constraint: "persona_egma_provided_is_active",
    });
  });
});

describe("forking a persona", () => {
  it("copies the behavior atomically into an independent version", async () => {
    const source = await usePersona(
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
      settings: { models: source.settings?.models },
    });
    const { rows } = await database.sql<{
      identity_name: string;
      personality: string;
      language: string;
    }>(
      `select identity_name, personality, language
         from persona_definition_version where id = $1`,
      [fork.versionId],
    );
    expect(rows[0]).toEqual({
      identity_name: source.identityName,
      personality: source.personality,
      language: source.language,
    });

    const edited = await editPersona(acme.auth, fork.id, {
      expectedVersionId: fork.versionId,
      personality: "Pushes back once when the agent is wrong.",
    });
    expect(edited?.version).toBe(2);
    expect(edited?.settings?.models).toEqual(source.settings!.models);
    expect(
      (await getPersona(acme.auth, EGMA_PROVIDED_PERSONAS.defaultPersona))?.version,
    ).toBe(3);
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
        `insert into persona_definition_version (id, persona_id, version, identity_name, personality, language, parameter_contract, created_by) values ($1,$2,2,$3,$4,'en-US',$5,$6)`,
        [nextVersionId, source.id, source.identityName, nextPersonality, JSON.stringify(source.parameterContract), acme.auth.userId],
      );
      await holder.sql(
        `update persona_definition
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
           from persona_definition
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
        settings: { models: source.settings?.models },
      });
      const { rows: copiesAfterCommit } = await database.sql<{ count: number }>(
        `select count(*)::integer as count
           from persona_definition
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
  it("expands saved legacy settings without resetting their choices", async () => {
    const source = PERSONA_LIBRARY_CATALOG[0];
    if (source === undefined) throw new Error("the source persona is missing");
    const legacyVersionIds = [newId("prsv"), newId("prsv")] as const;
    const legacy = {
      ...source,
      id: "prs_01K4R000000000000000000008",
      name: "Migration proof caller",
      versions: source.versions.slice(0, 2).map((version, index) => ({
        ...version,
        id: legacyVersionIds[index]!,
      })),
    } as const;
    await seedPersonaLibrary([legacy]);
    const before = await usePersona(acme.auth, legacy.id);
    if (before?.settings === null || before?.settings === undefined) {
      throw new Error("legacy settings were not created");
    }
    const chosen = { ...before.settings.parameterValues, tts_speed: 0.8 };
    await database.sql(
      "update project_persona set parameter_values = $1 where id = $2",
      [JSON.stringify(chosen), before.settings.id],
    );

    const current = source.versions[2];
    if (current === undefined) throw new Error("the current persona is missing");
    await seedPersonaLibrary([
      {
        ...legacy,
        versions: [
          ...legacy.versions,
          { ...current, id: newId("prsv") },
        ],
      },
    ]);

    const after = await getPersona(acme.auth, legacy.id);
    expect(after?.settings?.parameterValues).toMatchObject({
      ...chosen,
      language: "en-US",
      emotion: "neutral",
      accent: "voice_default",
      speech_volume: 1,
      execution_policy_version: 1,
    });
    expect(after?.language).toBe("en-US");
  });

  it("carries an identity name and one complete models value in every fixed version", () => {
    expect(PERSONA_LIBRARY_CATALOG).toHaveLength(4);
    const versions = PERSONA_LIBRARY_CATALOG[0]?.versions;
    expect(versions).toHaveLength(3);
    expect(versions?.[0]).toMatchObject({
      id: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C97",
      version: 1,
      identityName: "Alex Morgan",
      parameterContract: legacyPersonaParameterContract(EVERYDAY_CALLER_V1_MODELS),
    });
    expect(versions?.[1]).toMatchObject({
      id: "prsv_01M2B0K7W8N9Q3R4T5V6X7Y8Z9",
      version: 2,
      identityName: "Alex Morgan",
      parameterContract: legacyPersonaParameterContract(DEFAULT_PERSONA_MODELS),
    });
    // Never the team's word for them: an agent asking who is calling has to
    // hear a person, not a shelf label.
    expect(versions?.[2]).toMatchObject({
      version: 3,
      language: null,
    });
    expect(versions?.[2]?.identityName).not.toBe(PERSONA_LIBRARY_CATALOG[0]?.name);
  });

  it("refuses changed content under a fixed catalog version id at the database", async () => {
    const versionId = PERSONA_LIBRARY_CATALOG[0]?.versions[0]?.id;
    if (versionId === undefined) throw new Error("the fixed v1 is missing");
    await expect(
      database.sql(
        `update persona_definition_version set parameter_contract = '[]'::jsonb where id = $1`,
        [versionId],
      ),
    ).rejects.toThrow(/persona (?:core )?version.*cannot change/u);

    await expect(seedPersonaLibrary()).resolves.toEqual([]);
  });

  it("adds a new immutable catalog version without changing an existing fork", async () => {
    const entry = PERSONA_LIBRARY_CATALOG[0];
    const v1 = entry?.versions[0];
    const v3 = entry?.versions[2];
    if (entry === undefined || v1 === undefined || v3 === undefined) {
      throw new Error("the Predefined persona catalog entry is incomplete");
    }
    const fork = await forkPersona(
      acme.auth,
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    );
    if (fork === undefined) throw new Error("the fork is missing");

    const v4 = {
      ...v3,
      id: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C98",
      version: 4,
      personality: "Stays calm and asks one clear question.",
      parameterContract: v3.parameterContract,
      createdAt: new Date("2026-09-09T00:00:00.000Z"),
    } as const;

    expect(
      await seedPersonaLibrary([
        { ...entry, versions: [...entry.versions, v4] },
      ]),
    ).toEqual([
      {
        id: entry.id,
        name: entry.name,
        version: 4,
        versionId: v4.id,
      },
    ]);
    expect(await getPersonaVersion(acme.auth, v1.id)).toMatchObject({
      identityName: v1.identityName,
      personality: v1.personality,
      language: v1.language,
      parameterContract: v1.parameterContract,
    });
    expect(await getPersona(acme.auth, fork.id)).toMatchObject({
      version: 1,
      versionId: fork.versionId,
      identityName: fork.identityName,
      personality: fork.personality,
      settings: { models: fork.settings?.models },
    });
  });
});
