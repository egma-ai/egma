import { newId } from "@egma/ids";
import {
  archivePersona,
  createPersona,
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
  restorePersona,
  seedPersonaLibrary,
  setDefaultPersona,
  type AuthContext,
  type PersonaTraits,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

let database: MigratedDatabase;

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

async function defaultOf(projectId: string): Promise<string | null> {
  const { rows } = await database.sql<{ default_persona_id: string | null }>(
    "select default_persona_id from project where id = $1",
    [projectId],
  );
  return rows[0]?.default_persona_id ?? null;
}

let acme: Provisioned;
let globex: Provisioned;
let legacy: { readonly auth: AuthContext; readonly personaId: string };

beforeAll(async () => {
  database = await createConnectedDatabase("egma_provided_personas", {
    seedPersonas: false,
  });

  const organizationId = newId("org");
  const projectId = newId("prj");
  const userId = newId("usr");
  await seedOrganization(database, organizationId, [
    { id: projectId, slug: "existing" },
  ]);
  await seedUser(database, userId, "existing@example.test");
  const auth: AuthContext = {
    userId,
    organizationId,
    projectId,
    role: "admin",
    via: "session",
  };
  const local = await createPersona(auth, {
    name: "Existing default",
    traits: {
      personality: "Already belongs to this project.",
      language: "en-US",
    },
  });
  await database.sql(
    "update project set default_persona_id = $1 where id = $2",
    [local.id, projectId],
  );
  legacy = { auth, personaId: local.id };

  await seedPersonaLibrary();
  acme = await signUp("acme-persona-library");
  globex = await signUp("globex-persona-library");
});

afterAll(async () => {
  await database.drop();
});

describe("the shared default persona", () => {
  it("is one Egma-owned identity used by every new project", async () => {
    expect(await defaultOf(acme.projectId)).toBe(
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    );
    expect(await defaultOf(globex.projectId)).toBe(
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    );

    const persona = await getPersona(
      acme.auth,
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    );
    expect(persona).toMatchObject({
      owner: "egma",
      projectId: null,
      isDefault: true,
      version: 1,
      traits: {
        personality:
          "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
        language: "en-US",
        manner: "Clear, natural, and conversational.",
        patience: "Starts patient and gives the agent time to explain.",
        accent: "Neutral American English.",
        backgroundNoise: "None.",
        underFriction:
          "Becomes firmer if the agent is confusing or repetitive, without becoming rude.",
      },
      models: RECOMMENDED_PERSONA_MODELS,
    });
  });

  it("is seeded idempotently without a boot-time legacy adoption path", async () => {
    expect(await seedPersonaLibrary()).toEqual([]);
    expect(await seedPersonaLibrary()).toEqual([]);
    expect(await defaultOf(legacy.auth.projectId ?? "")).toBe(legacy.personaId);
  });

  it("appears once in each project's library", async () => {
    expect((await listPersonas(acme.auth)).items.map((one) => one.id)).toEqual([
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    ]);
  });

  it("cannot be edited, archived, or restored", async () => {
    await expect(
      editPersona(acme.auth, EGMA_PROVIDED_PERSONAS.defaultPersona, {
        traits: {
          ...PERSONA_LIBRARY_CATALOG[0]!.versions[0]!.traits,
          personality: "Different",
        },
      }),
    ).rejects.toBeInstanceOf(EgmaProvidedPersonaError);
    await expect(
      archivePersona(acme.auth, EGMA_PROVIDED_PERSONAS.defaultPersona),
    ).rejects.toBeInstanceOf(EgmaProvidedPersonaError);
    await expect(
      restorePersona(acme.auth, EGMA_PROVIDED_PERSONAS.defaultPersona),
    ).rejects.toBeInstanceOf(EgmaProvidedPersonaError);
  });
});

describe("forking a library persona", () => {
  it("copies traits and models atomically into an independent version", async () => {
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
      isDefault: false,
      traits: source.traits,
      models: source.models,
    });
    const { rows } = await database.sql<{ traits: unknown; models: unknown }>(
      "select traits, models from persona_version where id = $1",
      [fork.versionId],
    );
    expect(rows[0]).toEqual({ traits: source.traits, models: source.models });

    const edited = await editPersona(acme.auth, fork.id, {
      traits: {
        ...source.traits,
        personality: "Pushes back once when the agent is wrong.",
      },
    });
    expect(edited?.version).toBe(2);
    expect(edited?.models).toEqual(source.models);
    expect(
      (await getPersona(acme.auth, EGMA_PROVIDED_PERSONAS.defaultPersona))?.version,
    ).toBe(1);
  });
});

describe("catalog integrity", () => {
  it("carries traits and one complete models value in every fixed version", () => {
    expect(PERSONA_LIBRARY_CATALOG).toHaveLength(1);
    const version = PERSONA_LIBRARY_CATALOG[0]?.versions[0];
    expect(version).toMatchObject({
      id: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C97",
      version: 1,
      models: RECOMMENDED_PERSONA_MODELS,
    });
  });

  it("refuses changed content under a fixed catalog version id at the database", async () => {
    const versionId = PERSONA_LIBRARY_CATALOG[0]?.versions[0]?.id;
    if (versionId === undefined) throw new Error("the fixed v1 is missing");
    await expect(
      database.sql(
        `update persona_version
            set models = jsonb_set(models, '{stt,model}', '"gpt-4o-transcribe"')
          where id = $1`,
        [versionId],
      ),
    ).rejects.toThrow(/persona version.*authored content cannot change/u);

    await expect(seedPersonaLibrary()).resolves.toEqual([]);
  });

  it("adds a new immutable catalog version without changing an existing fork", async () => {
    const entry = PERSONA_LIBRARY_CATALOG[0];
    const v1 = entry?.versions[0];
    if (entry === undefined || v1 === undefined) {
      throw new Error("the default persona catalog entry is incomplete");
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
      traits: {
        ...v1.traits,
        personality: "Stays calm and asks one clear question.",
      },
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
    expect(await getPersonaVersion(acme.auth, v1.id)).toMatchObject(v1);
    expect(await getPersona(acme.auth, fork.id)).toMatchObject({
      version: 1,
      versionId: fork.versionId,
      traits: fork.traits,
      models: fork.models,
    });
  });
});

describe("choosing a project's default persona", () => {
  const authoredTraits: PersonaTraits = {
    personality: "Stays calm and confirms the final answer.",
    language: "en-US",
  };

  it("moves the project choice between an active Custom and Egma-provided persona", async () => {
    const custom = await createPersona(acme.auth, {
      name: "Calm caller",
      traits: authoredTraits,
    });

    const selectedCustom = await setDefaultPersona(acme.auth, custom.id);
    expect(selectedCustom).toMatchObject({ id: custom.id, isDefault: true });
    expect(await defaultOf(acme.projectId)).toBe(custom.id);

    const selectedEgma = await setDefaultPersona(
      acme.auth,
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    );
    expect(selectedEgma).toMatchObject({
      id: EGMA_PROVIDED_PERSONAS.defaultPersona,
      isDefault: true,
    });
    expect(await defaultOf(acme.projectId)).toBe(
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    );
  });

  it("refuses an archived or unavailable Custom persona", async () => {
    const archived = await createPersona(acme.auth, {
      name: "Archived caller",
      traits: authoredTraits,
    });
    await archivePersona(acme.auth, archived.id);
    expect(await setDefaultPersona(acme.auth, archived.id)).toBeUndefined();

    const otherProject = await createPersona(globex.auth, {
      name: "Other customer caller",
      traits: authoredTraits,
    });
    expect(await setDefaultPersona(acme.auth, otherProject.id)).toBeUndefined();
  });
});
