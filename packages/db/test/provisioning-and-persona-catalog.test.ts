import { newId } from "@egma/ids";
import {
  createPersona,
  usePersona,
  legacyPersonaParameterContract,
  personaParameterContract,
  personaModelsOfParameters,
  personaParametersOfModels,
  defaultPersonaParameterValues,
  forkPersona,
  getPersona,
  getPersonaVersion,
  PERSONA_LIBRARY_CATALOG,
  EGMA_PROVIDED_PERSONAS,
  provisionOrganization,
  RECOMMENDED_PERSONA_MODELS,
  seedPersonaLibrary,
  type AuthContext,
  type PersonaModels,
} from "@egma/db";
import {
  currentPersonaParameterDefaults,
  preCategoricalPersonaParameterContract,
  ticket01PersonaParameterContract,
  ticket02PersonaParameterContract,
} from "../src/persona-library/parameters.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createConnectedDatabase,
  openSingleConnection,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedUser } from "./support/tenancy.ts";

/**
 * Egma-provided personas are read-only, can be forked into Custom personas,
 * and upgrade saved project settings when the catalog changes.
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

let acme: Provisioned;
let globex: Provisioned;

beforeAll(async () => {
  database = await createConnectedDatabase("provisioning_persona_catalog", {
    seedPersonas: false,
  });

  await seedPersonaLibrary();
  acme = await signUp("acme-persona-library");
  globex = await signUp("globex-persona-library");
});

afterAll(async () => {
  await database.drop();
});

describe("the Predefined persona", () => {
  it("migrates project settings without changing built-in core history", async () => {
    const before = await getPersona(globex.auth, EGMA_PROVIDED_PERSONAS.defaultPersona);
    expect(before).toMatchObject({
      version: 7,
      versionId: "prsv_01M2NRBH9AEF9RVXBQCAP6RXBX",
      settings: null,
    });

    const used = await usePersona(globex.auth, EGMA_PROVIDED_PERSONAS.defaultPersona);
    expect(used).toMatchObject({
      version: 7,
      versionId: "prsv_01M2NRBH9AEF9RVXBQCAP6RXBX",
      settings: { parameterValues: {
        speech_mode: "separate",
        interruption_level: "none",
        execution_policy_version: 2,
      } },
    });

    const historicalContract = PERSONA_LIBRARY_CATALOG[0]!.versions[0]!.parameterContract;
    await database.sql(
      `update project_persona
          set parameter_contract = $1::jsonb, parameter_values = $2::jsonb
        where project_id = $3 and persona_definition_id = $4`,
      [
        JSON.stringify(historicalContract),
        JSON.stringify(defaultPersonaParameterValues(historicalContract)),
        globex.projectId,
        EGMA_PROVIDED_PERSONAS.defaultPersona,
      ],
    );

    expect(await seedPersonaLibrary()).toEqual([]);
    expect(await seedPersonaLibrary()).toEqual([]);
    expect(await getPersona(globex.auth, EGMA_PROVIDED_PERSONAS.defaultPersona)).toMatchObject({
      version: 7,
      versionId: "prsv_01M2NRBH9AEF9RVXBQCAP6RXBX",
      settings: { parameterValues: { language: "en-US", speech_mode: "separate", interruption_level: "none" } },
    });
    const { rows } = await database.sql<{ id: string; version: number }>(
      "select id, version from persona_definition_version where persona_id = $1 order by version",
      [EGMA_PROVIDED_PERSONAS.defaultPersona],
    );
    expect(rows).toHaveLength(7);
    expect(rows.at(-1)).toEqual({ id: "prsv_01M2NRBH9AEF9RVXBQCAP6RXBX", version: 7 });
    expect(rows.map((row) => row.id)).toContain("prsv_01K4R000000000000000000016");
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
        `insert into persona_definition_version (id, persona_id, version, identity_name, personality, language, parameter_contract, created_by) values ($1,$2,2,$3,$4,null,$5,$6)`,
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
  it("completes every historical settings shape without changing its models", () => {
    const contracts = [
      legacyPersonaParameterContract(),
      ticket01PersonaParameterContract(),
      ticket02PersonaParameterContract(),
      preCategoricalPersonaParameterContract(),
    ];

    expect(contracts.map((contract) => contract.length)).toEqual([8, 13, 15, 16]);
    for (const contract of contracts) {
      const historical = defaultPersonaParameterValues(contract);
      const expectedModels = personaModelsOfParameters(historical);
      const completed = currentPersonaParameterDefaults(contract, { language: "es-ES" });
      expect(completed.contract).toHaveLength(12);
      expect(personaModelsOfParameters(completed.values)).toEqual({
        ...expectedModels,
        ...(expectedModels.mode === "separate"
          ? { tts: { ...expectedModels.tts, speed: expectedModels.tts.speed } }
          : {}),
      });
      expect(completed.values).toMatchObject({
        language: contract.some((field) => field.key === "language") ? "en-US" : "es-ES",
        interruption_level: "none",
        execution_policy_version: 2,
      });
    }
  });

  it("upgrades untouched custom persona settings once without changing their old version", async () => {
    const made = await createPersona(acme.auth, {
      name: "Untouched legacy caller",
      identityName: "Morgan Lee",
      personality: "Calls about an existing order and answers directly.",
      language: "en-US",
    });
    if (made.settings === null) throw new Error("custom settings were not created");
    if (made.settings.models.mode !== "separate") throw new Error("default persona settings must use separate speech models");
    const oldContract = legacyPersonaParameterContract(
      { ...made.settings.models, tts: { ...made.settings.models.tts, speed: 0.9 } },
    );
    const frozenOldValues = {
      ...defaultPersonaParameterValues(oldContract),
      tts_speed: 0.9,
    };
    const legacyVersionId = newId("prsv");
    await database.sql(
      `insert into persona_definition_version
         (id, persona_id, version, identity_name, personality, language, parameter_contract, created_by)
       values ($1, $2, 2, $3, $4, 'es-ES', $5, $6)`,
      [legacyVersionId, made.id, made.identityName, made.personality, JSON.stringify(oldContract), acme.auth.userId],
    );
    await database.sql(
      "update persona_definition set current_version_id = $1 where id = $2",
      [legacyVersionId, made.id],
    );
    await database.sql(
      "update project_persona set parameter_values = $1, parameter_contract = $2 where persona_definition_id = $3",
      [JSON.stringify(frozenOldValues), JSON.stringify(oldContract), made.id],
    );

    await seedPersonaLibrary();
    const upgraded = await getPersona(acme.auth, made.id);
    expect(upgraded).toMatchObject({
      id: made.id,
      version: 3,
      identityName: made.identityName,
      personality: made.personality,
      language: "es-ES",
      settings: {
        parameterValues: {
          language: "es-ES",
          interruption_level: "none",
          execution_policy_version: 2,
        },
      },
    });
    expect((await getPersonaVersion(acme.auth, legacyVersionId))?.parameterContract).toEqual(oldContract);

    await seedPersonaLibrary();
    expect(await getPersona(acme.auth, made.id)).toMatchObject({
      version: 3,
      language: "es-ES",
      settings: { parameterValues: { language: "es-ES", interruption_level: "none" } },
    });
  });

  it("adds background defaults without resetting ticket 01 choices", async () => {
    const source = PERSONA_LIBRARY_CATALOG[0];
    if (source === undefined) throw new Error("the source persona is missing");
    const legacyVersionIds = [newId("prsv"), newId("prsv"), newId("prsv")] as const;
    const legacy = {
      ...source,
      id: "prs_01K4R000000000000000000008",
      name: "Migration proof caller",
      versions: source.versions.slice(0, 3).map((version, index) => ({
        ...version,
        id: legacyVersionIds[index]!,
      })),
    } as const;
    await seedPersonaLibrary([legacy]);
    const before = await usePersona(acme.auth, legacy.id);
    if (before?.settings === null || before?.settings === undefined) {
      throw new Error("legacy settings were not created");
    }
    const oldContract = legacy.versions.at(-1)!.parameterContract;
    const chosen = {
      ...defaultPersonaParameterValues(oldContract),
      tts_speed: 0.8,
      emotion: "happy",
      speech_volume: 1.2,
    };
    await database.sql(
      "update project_persona set parameter_values = $1, parameter_contract = $2 where id = $3",
      [JSON.stringify(chosen), JSON.stringify(oldContract), before.settings.id],
    );

    const current = source.versions[3];
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
      language: "en-US",
      execution_policy_version: 2,
      background_sound_id: "none",
      interruption_level: "none",
    });
    expect(after?.settings?.parameterValues).not.toHaveProperty("emotion");
    expect(after?.settings?.parameterValues).not.toHaveProperty("tts_speed");
    expect(after?.language).toBe("en-US");
  });

  it("adds Off interruptions without resetting ticket 02 choices", async () => {
    const source = PERSONA_LIBRARY_CATALOG[0];
    if (source === undefined) throw new Error("the source persona is missing");
    const priorVersionIds = [newId("prsv"), newId("prsv"), newId("prsv"), newId("prsv")] as const;
    const prior = {
      ...source,
      id: "prs_01K4R000000000000000000009",
      name: "Interruption migration proof caller",
      versions: source.versions.slice(0, 4).map((version, index) => ({
        ...version,
        id: priorVersionIds[index]!,
      })),
    } as const;
    await seedPersonaLibrary([prior]);
    const before = await usePersona(acme.auth, prior.id);
    if (before?.settings === null || before?.settings === undefined) {
      throw new Error("ticket 02 settings were not created");
    }
    const oldContract = prior.versions.at(-1)!.parameterContract;
    const chosen = {
      ...defaultPersonaParameterValues(oldContract),
      tts_speed: 0.8,
      emotion: "happy",
      speech_volume: 1.2,
      background_sound_id: "rain-v1",
      background_volume: 0.1,
    };
    await database.sql(
      "update project_persona set parameter_values = $1, parameter_contract = $2 where id = $3",
      [JSON.stringify(chosen), JSON.stringify(oldContract), before.settings.id],
    );

    const current = source.versions[4];
    if (current === undefined) throw new Error("the interruption version is missing");
    await seedPersonaLibrary([{
      ...prior,
      versions: [...prior.versions, { ...current, id: newId("prsv") }],
    }]);

    expect((await getPersona(acme.auth, prior.id))?.settings?.parameterValues).toMatchObject({
      speech_mode: "separate",
      language: "en-US",
      background_sound_id: "rain-v1",
      execution_policy_version: 2,
      interruption_level: "none",
    });
  });

  it.each(["live", "cartesia"] as const)("replaces saved %s built-in models without changing controls, history, or forks", async (mode) => {
    const tenant = await signUp(`catalog-models-${mode}`);
    const models: PersonaModels = mode === "live" ? {
      mode: "live",
      llm: { provider: "openai", model: "gpt-4o-mini" },
      live: { provider: "openai", model: "gpt-live-1", adapter: "openai_live", voiceId: "alloy" },
    } : EVERYDAY_CALLER_V1_MODELS;
    const contract = personaParameterContract(models, {
      language: "es-ES",
      backgroundSoundId: "rain-v1",
      executionPolicyVersion: 2,
      ...(mode === "live" ? {} : { interruptionLevel: "frequent" }),
    });
    const used = await usePersona(tenant.auth, EGMA_PROVIDED_PERSONAS.defaultPersona);
    if (used?.settings === null || used?.settings === undefined) throw new Error("built-in settings missing");
    const history = await getPersonaVersion(tenant.auth, used.versionId);
    await database.sql(
      "update project_persona set parameter_values = $1, parameter_contract = $2 where id = $3",
      [JSON.stringify(defaultPersonaParameterValues(contract)), JSON.stringify(contract), used.settings.id],
    );
    const fork = await forkPersona(tenant.auth, used.id);
    if (fork === undefined) throw new Error("custom fork missing");

    await seedPersonaLibrary();
    const migrated = await getPersona(tenant.auth, used.id);
    expect(migrated?.settings?.parameterValues).toEqual({
      speech_mode: "separate",
      llm_provider: "openai", llm_model: "gpt-5.6-terra",
      stt_provider: "openai", stt_model: "gpt-live-transcribe",
      tts_provider: "openai", tts_model: "gpt-4o-mini-tts", tts_voice_id: "cedar",
      language: "es-ES", background_sound_id: "rain-v1", execution_policy_version: 2,
      interruption_level: mode === "live" ? "none" : "frequent",
    });
    expect(await getPersonaVersion(tenant.auth, used.versionId)).toEqual(history);
    expect((await getPersona(tenant.auth, fork.id))?.settings).toEqual(fork.settings);

    expect(await seedPersonaLibrary()).toEqual([]);
    expect((await getPersona(tenant.auth, used.id))?.settings).toEqual(migrated?.settings);
  });

  it("ships exactly five presets with distinct caller names and complete starting controls", async () => {
    const tenant = await signUp("new-built-in-defaults");
    const identityNames = new Map([
      ["Everyday Caller [Male]", "Alex Morgan"],
      ["Everyday Caller [Female]", "Emma Carter"],
      ["Angry caller", "Jordan Lee"],
      ["Spanish caller", "Mateo García"],
      ["Interruptive caller", "Taylor Brooks"],
    ]);
    expect(new Set(PERSONA_LIBRARY_CATALOG.map((entry) => entry.versions.at(-1)?.identityName)).size).toBe(5);
    const defaults = new Map(PERSONA_LIBRARY_CATALOG.map((entry) => [
      entry.name,
      currentPersonaParameterDefaults(entry.versions.at(-1)?.parameterContract).values,
    ]));
    expect([...defaults.keys()]).toEqual([
      "Everyday Caller [Male]",
      "Everyday Caller [Female]",
      "Angry caller",
      "Spanish caller",
      "Interruptive caller",
    ]);
    for (const [name, values] of defaults) {
      expect(values).toMatchObject({
        speech_mode: "separate",
        llm_provider: "openai",
        llm_model: "gpt-5.6-terra",
        stt_provider: "openai",
        stt_model: "gpt-live-transcribe",
        tts_provider: "openai",
        tts_model: "gpt-4o-mini-tts",
        tts_voice_id: name === "Everyday Caller [Female]" ? "coral" : "cedar",
        language: name === "Spanish caller" ? "es-ES" : "en-US",
        background_sound_id: "none",
        interruption_level: name === "Interruptive caller" ? "frequent" : "none",
        execution_policy_version: 2,
      });
      const definition = PERSONA_LIBRARY_CATALOG.find((entry) => entry.name === name)!;
      const used = await usePersona(tenant.auth, definition.id);
      expect(used?.identityName).toBe(identityNames.get(name));
      expect(used?.settings?.parameterValues).toEqual(values);
    }
  });

  it("keeps frozen model contracts readable after a model leaves the current catalog", () => {
    const historicalModels = {
      ...DEFAULT_PERSONA_MODELS,
      llm: { provider: "openai", model: "retired-model-from-history" },
    } as const;
    const contract = legacyPersonaParameterContract(historicalModels);
    expect(personaModelsOfParameters(defaultPersonaParameterValues(contract))).toEqual(
      historicalModels,
    );
    expect(() => personaParametersOfModels(historicalModels)).toThrow(
      /not a supported openai llm model/u,
    );
    expect(() => personaParameterContract(historicalModels)).toThrow(
      /not a supported openai llm model/u,
    );
  });

  it("adds a new immutable catalog version without changing an existing fork", async () => {
    const entry = PERSONA_LIBRARY_CATALOG[0];
    const v1 = entry?.versions[0];
    const current = entry?.versions.at(-1);
    if (entry === undefined || v1 === undefined || current === undefined) {
      throw new Error("the Predefined persona catalog entry is incomplete");
    }
    const fork = await forkPersona(
      acme.auth,
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    );
    if (fork === undefined) throw new Error("the fork is missing");

    const next = {
      ...current,
      id: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C98",
      version: current.version + 1,
      personality: "Stays calm and asks one clear question.",
      parameterContract: current.parameterContract,
      createdAt: new Date("2026-09-09T00:00:00.000Z"),
    } as const;

    expect(
      await seedPersonaLibrary([
        { ...entry, versions: [...entry.versions, next] },
      ]),
    ).toEqual([
      {
        id: entry.id,
        name: entry.name,
        version: next.version,
        versionId: next.id,
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
