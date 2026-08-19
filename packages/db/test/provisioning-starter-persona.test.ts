import { newId } from "@egma/ids";
import {
  archivePersona,
  createAgent,
  createPersona,
  createTest,
  editPersona,
  forkPersona,
  getPersona,
  getPersonaVersion,
  getTest,
  getTestVersion,
  listSimulations,
  listPersonas,
  PERSONA_LIBRARY_CATALOG,
  PREDEFINED_PERSONAS,
  PredefinedPersonaError,
  provisionOrganization,
  restorePersona,
  seedPersonaLibrary,
  startRun,
  testsUsingPersona,
  type AuthContext,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createConnectedDatabase,
  errorCodeOf,
  POSTGRES_ERROR,
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
let firstPersonaSeed: Awaited<ReturnType<typeof seedPersonaLibrary>>;
let legacyTestAdoption: {
  readonly agentId: string;
  readonly connectionId: string;
  readonly testId: string;
  readonly oldTestVersionId: string;
  readonly oldTestRevision: string;
  readonly customizedTestId: string;
  readonly customizedTestVersionId: string;
  readonly priorRunId: string;
  readonly priorSimulationId: string;
  readonly legacyPersonaVersionId: string;
  readonly forkId: string;
  readonly forkVersionId: string;
};
let legacy: {
  readonly organizationId: string;
  readonly userId: string;
  readonly untouchedProject: string;
  readonly customizedProject: string;
  readonly untouchedPersonaId: string;
  readonly customizedPersonaId: string;
};

function actInLegacy(projectId: string): AuthContext {
  return {
    userId: legacy.userId,
    organizationId: legacy.organizationId,
    projectId,
    role: "admin",
    via: "session",
  };
}

beforeAll(async () => {
  database = await createConnectedDatabase("predefined_starter", {
    seedPersonas: false,
  });

  const organizationId = newId("org");
  const untouchedProject = newId("prj");
  const customizedProject = newId("prj");
  const userId = newId("usr");
  await seedOrganization(database, organizationId, [
    { id: untouchedProject, slug: "untouched" },
    { id: customizedProject, slug: "customized" },
  ]);
  await seedUser(database, userId, "legacy-personas@example.test");
  legacy = {
    organizationId,
    userId,
    untouchedProject,
    customizedProject,
    untouchedPersonaId: "",
    customizedPersonaId: "",
  };
  const legacyDescription =
    "The persona a test gets when it names none. Rename them, rewrite them, or point the project at somebody else.";
  const personality =
    "Speaks plainly, stays patient, and asks one question at a time.";
  const untouched = await createPersona(actInLegacy(untouchedProject), {
    name: "Starter",
    description: legacyDescription,
    personality,
  });
  const customized = await createPersona(actInLegacy(customizedProject), {
    name: "Starter",
    description: legacyDescription,
    personality,
  });
  await editPersona(actInLegacy(customizedProject), customized.id, {
    personality: "Interrupts when the answer is vague.",
  });
  await database.sql(
    "update project set default_persona_id = $1 where id = $2",
    [untouched.id, untouchedProject],
  );
  await database.sql(
    "update project set default_persona_id = $1 where id = $2",
    [customized.id, customizedProject],
  );
  legacy = {
    ...legacy,
    untouchedPersonaId: untouched.id,
    customizedPersonaId: customized.id,
  };

  const untouchedAgent = await createAgent(actInLegacy(untouchedProject), {
    name: "Legacy front desk",
    connection: {
      type: "retell",
      modality: "chat",
      environment: "staging",
      config: { retellAgentId: "legacy_starter_agent" },
      credentials: { apiKey: "retell-secret-LEGACY-STARTER" },
    },
  });
  const connectionId = untouchedAgent.connection?.id;
  if (connectionId === undefined) {
    throw new Error("the legacy agent connection was not written");
  }
  const untouchedTest = await createTest(actInLegacy(untouchedProject), {
    name: "Legacy appointment change",
    description: "Keeps every authored field through the adoption.",
    scenario: "The caller needs to move an appointment to Friday.",
    expectedBehaviors: ["offers an available time on Friday"],
    mockOverrides: [
      {
        toolName: "find_slots",
        answer: { answer: { available: ["10:00"] } },
        delayMilliseconds: 25,
      },
    ],
    requiredCapabilities: [],
  });
  const priorRun = await startRun(actInLegacy(untouchedProject), {
    agentId: untouchedAgent.id,
    connectionId,
    testVersionIds: [untouchedTest.versionId],
    idempotencyKey: newId("run"),
  });
  const priorSimulation = priorRun.simulations[0];
  if (priorSimulation === undefined) {
    throw new Error("the legacy run did not create its simulation");
  }
  const legacyFork = await forkPersona(
    actInLegacy(untouchedProject),
    untouched.id,
  );
  if (legacyFork === undefined) throw new Error("the legacy fork was not written");

  await createAgent(actInLegacy(customizedProject), {
    name: "Customized front desk",
  });
  const customizedTest = await createTest(actInLegacy(customizedProject), {
    name: "Customized appointment change",
    scenario: "The caller needs a different appointment.",
    expectedBehaviors: ["offers another appointment"],
  });
  legacyTestAdoption = {
    agentId: untouchedAgent.id,
    connectionId,
    testId: untouchedTest.id,
    oldTestVersionId: untouchedTest.versionId,
    oldTestRevision: untouchedTest.revision,
    customizedTestId: customizedTest.id,
    customizedTestVersionId: customizedTest.versionId,
    priorRunId: priorRun.id,
    priorSimulationId: priorSimulation.id,
    legacyPersonaVersionId: untouched.versionId,
    forkId: legacyFork.id,
    forkVersionId: legacyFork.versionId,
  };

  firstPersonaSeed = await seedPersonaLibrary();
  acme = await signUp("acme-persona-library");
  globex = await signUp("globex-persona-library");
});

afterAll(async () => {
  await database.drop();
});

describe("the predefined default persona", () => {
  it("is one Egma-owned identity shared by every new project", async () => {
    expect(await defaultOf(acme.projectId)).toBe(
      PREDEFINED_PERSONAS.defaultPersona,
    );
    expect(await defaultOf(globex.projectId)).toBe(
      PREDEFINED_PERSONAS.defaultPersona,
    );

    const { rows } = await database.sql<{
      predefined: string;
      copied_to_new_projects: string;
    }>(
      `select count(*) filter (where organization_id is null) as predefined,
              count(*) filter (where project_id = any($1)) as copied_to_new_projects
         from persona`,
      [[acme.projectId, globex.projectId]],
    );
    expect(rows[0]).toEqual({ predefined: "1", copied_to_new_projects: "0" });

    expect(
      await getPersona(acme.auth, PREDEFINED_PERSONAS.defaultPersona),
    ).toMatchObject({
      name: "Default Persona",
      description: "Regular conversationalist persona",
      owner: "egma",
      projectId: null,
      isDefault: true,
      version: 1,
      versionId: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C97",
      traits: {
        personality:
          "Speaks clear, natural english. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
      },
    });
  });

  it("ships only the reset identity and its reset v1", () => {
    expect(PERSONA_LIBRARY_CATALOG).toHaveLength(1);
    const [defaultPersona] = PERSONA_LIBRARY_CATALOG;
    expect(defaultPersona).toMatchObject({
      id: "prs_01M0E4EVJ6ECGVJEA4NSBTC0CC",
      versions: [
        {
          id: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C97",
          version: 1,
          createdAt: new Date("2026-08-19T23:09:01.674Z"),
        },
      ],
    });

    const shippedIds = [
      ...PERSONA_LIBRARY_CATALOG.map((entry) => entry.id),
      ...PERSONA_LIBRARY_CATALOG.flatMap((entry) =>
        entry.versions.map((version) => version.id),
      ),
    ];
    for (const retiredId of [
      "prs_01M01MH8KCE8ZB19B0YJ7Z7EYW",
      "prsv_01M01MH8KDE8ZB19B0YJ7Z7EYW",
      "prsv_01M01MH8KFE8ZB19B0YJ7Z7EYW",
      "prsv_01M0E4EVJ6ECGVJEA4NSBTC0CD",
    ]) {
      expect(shippedIds).not.toContain(retiredId);
    }
  });

  it("is seeded idempotently", async () => {
    const adopted = await getTest(
      actInLegacy(legacy.untouchedProject),
      legacyTestAdoption.testId,
    );
    expect(firstPersonaSeed).toEqual([
      {
        id: PREDEFINED_PERSONAS.defaultPersona,
        name: "Default Persona",
        version: 1,
        versionId: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C97",
      },
    ]);
    expect(await seedPersonaLibrary()).toEqual([]);
    expect(await seedPersonaLibrary()).toEqual([]);
    expect(
      await getTest(
        actInLegacy(legacy.untouchedProject),
        legacyTestAdoption.testId,
      ),
    ).toMatchObject({ version: adopted?.version, versionId: adopted?.versionId });
  });

  it("refuses an unknown top-level key in a fixed catalog version", async () => {
    const versionId = PERSONA_LIBRARY_CATALOG[0]?.versions[0]?.id;
    if (versionId === undefined) throw new Error("the fixed v1 is missing");
    await database.sql(
      `update persona_version
          set traits = traits || '{"unexpected":true}'::jsonb
        where id = $1`,
      [versionId],
    );
    try {
      await expect(seedPersonaLibrary()).rejects.toThrow(
        `fixed predefined persona version ${versionId} already holds different content`,
      );
    } finally {
      await database.sql(
        "update persona_version set traits = traits - 'unexpected' where id = $1",
        [versionId],
      );
    }
  });

  it("refuses an unknown voice key in a fixed catalog version", async () => {
    const versionId = PERSONA_LIBRARY_CATALOG[0]?.versions[0]?.id;
    if (versionId === undefined) throw new Error("the fixed v1 is missing");
    await database.sql(
      `update persona_version
          set traits = jsonb_set(traits, '{voice,unexpected}', 'true'::jsonb)
        where id = $1`,
      [versionId],
    );
    try {
      await expect(seedPersonaLibrary()).rejects.toThrow(
        `fixed predefined persona version ${versionId} already holds different content`,
      );
    } finally {
      await database.sql(
        "update persona_version set traits = traits #- '{voice,unexpected}' where id = $1",
        [versionId],
      );
    }
  });

  it("appears once on each project's list", async () => {
    expect((await listPersonas(acme.auth)).items.map((one) => one.id)).toEqual([
      PREDEFINED_PERSONAS.defaultPersona,
    ]);
  });

  it("cannot be edited, archived, or restored", async () => {
    await expect(
      editPersona(acme.auth, PREDEFINED_PERSONAS.defaultPersona, {
        personality: "Different",
      }),
    ).rejects.toBeInstanceOf(PredefinedPersonaError);
    await expect(
      archivePersona(acme.auth, PREDEFINED_PERSONAS.defaultPersona),
    ).rejects.toBeInstanceOf(PredefinedPersonaError);
    await expect(
      restorePersona(acme.auth, PREDEFINED_PERSONAS.defaultPersona),
    ).rejects.toBeInstanceOf(PredefinedPersonaError);
  });

  it("forks into an independent project-owned persona", async () => {
    const fork = await forkPersona(
      acme.auth,
      PREDEFINED_PERSONAS.defaultPersona,
    );
    if (fork === undefined) throw new Error("the fork was not written");
    expect(fork).toMatchObject({
      owner: "organization",
      projectId: acme.projectId,
      version: 1,
      isDefault: false,
    });
    const edited = await editPersona(acme.auth, fork.id, {
      personality: "Pushes back once when the agent is wrong.",
    });
    expect(edited?.version).toBe(2);
    expect(edited?.traits.voice).toEqual(fork.traits.voice);
    expect(
      (await getPersona(acme.auth, PREDEFINED_PERSONAS.defaultPersona))?.version,
    ).toBe(1);
  });
});

describe("project availability", () => {
  it("gives each project the shared default without mixing their usage", async () => {
    await createAgent(acme.auth, { name: "Front desk" });
    await createAgent(globex.auth, { name: "Front desk" });
    const acmeTest = await createTest(acme.auth, {
      name: "Reschedule",
      scenario: "The appointment must move to next week.",
      expectedBehaviors: ["offers a time next week"],
    });
    const globexTest = await createTest(globex.auth, {
      name: "Cancel",
      scenario: "The appointment must be canceled.",
      expectedBehaviors: ["confirms the cancellation"],
    });
    expect(acmeTest.personas.map((one) => one.id)).toEqual([
      PREDEFINED_PERSONAS.defaultPersona,
    ]);
    expect(globexTest.personas.map((one) => one.id)).toEqual([
      PREDEFINED_PERSONAS.defaultPersona,
    ]);
    expect(
      await testsUsingPersona(acme.auth, PREDEFINED_PERSONAS.defaultPersona),
    ).toEqual([{ id: acmeTest.id, name: acmeTest.name }]);
    expect(
      await testsUsingPersona(globex.auth, PREDEFINED_PERSONAS.defaultPersona),
    ).toEqual([{ id: globexTest.id, name: globexTest.name }]);
  });

  it("refuses another project's persona as a default", async () => {
    const foreign = await forkPersona(
      globex.auth,
      PREDEFINED_PERSONAS.defaultPersona,
    );
    if (foreign === undefined) throw new Error("the foreign fork was not written");
    const write = database.sql(
      "update project set default_persona_id = $1 where id = $2",
      [foreign.id, acme.projectId],
    );
    await expect(write).rejects.toSatisfy(
      (error: unknown) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });

  it("refuses another project's persona on a test version", async () => {
    const foreign = await forkPersona(
      globex.auth,
      PREDEFINED_PERSONAS.defaultPersona,
    );
    if (foreign === undefined) throw new Error("the foreign fork was not written");
    const { rows } = await database.sql<{ test_version_id: string }>(
      `select tp.test_version_id
         from test_persona tp
         join test_version tv on tv.id = tp.test_version_id
         join test t on t.id = tv.test_id
        where t.project_id = $1 limit 1`,
      [acme.projectId],
    );
    const versionId = rows[0]?.test_version_id;
    if (versionId === undefined) throw new Error("the test version was not found");
    const write = database.sql(
      "update test_persona set persona_id = $1 where test_version_id = $2",
      [foreign.id, versionId],
    );
    await expect(write).rejects.toSatisfy(
      (error: unknown) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });

  it("installs guards for defaults, tests, simulations, and ownership", async () => {
    const { rows } = await database.sql<{ tgname: string }>(
      `select tgname from pg_trigger
        where not tgisinternal and tgname like '%persona%guard'`,
    );
    expect(rows.map((row) => row.tgname)).toEqual(
      expect.arrayContaining([
        "persona_ownership_immutable_guard",
        "project_default_persona_availability_insert_guard",
        "simulation_persona_availability_insert_guard",
        "test_persona_availability_insert_guard",
      ]),
    );
  });

  it("does not let a predefined identity become project-owned", async () => {
    await expect(
      database.sql(
        `update persona set organization_id = $1, project_id = $2
          where id = $3`,
        [
          acme.auth.organizationId,
          acme.projectId,
          PREDEFINED_PERSONAS.defaultPersona,
        ],
      ),
    ).rejects.toThrow(/ownership cannot change/);
  });
});

describe("legacy project defaults", () => {
  it("adopts an untouched Starter once and preserves a customized one", async () => {
    expect(await defaultOf(legacy.untouchedProject)).toBe(
      PREDEFINED_PERSONAS.defaultPersona,
    );
    expect(await defaultOf(legacy.customizedProject)).toBe(
      legacy.customizedPersonaId,
    );
    expect(
      await getPersona(
        actInLegacy(legacy.untouchedProject),
        legacy.untouchedPersonaId,
      ),
    ).toMatchObject({ archivedAt: expect.any(Date) });
    expect(
      (
        await listPersonas(actInLegacy(legacy.untouchedProject))
      ).items.map((one) => one.id).sort(),
    ).toEqual(
      [PREDEFINED_PERSONAS.defaultPersona, legacyTestAdoption.forkId].sort(),
    );

    expect(await seedPersonaLibrary()).toEqual([]);
    expect(await defaultOf(legacy.untouchedProject)).toBe(
      PREDEFINED_PERSONAS.defaultPersona,
    );
  });

  it("rewrites current prelaunch links and leaves simulation pins intact", async () => {
    const auth = actInLegacy(legacy.untouchedProject);
    const oldVersion = await getTestVersion(
      auth,
      legacyTestAdoption.oldTestVersionId,
    );
    expect(oldVersion).toMatchObject({
      current: true,
      version: 1,
      scenario: "The caller needs to move an appointment to Friday.",
      expectedBehaviors: ["offers an available time on Friday"],
      mockOverrides: [
        {
          toolName: "find_slots",
          answer: { answer: { available: ["10:00"] } },
          delayMilliseconds: 25,
        },
      ],
      requiredCapabilities: [],
      personas: [{ id: PREDEFINED_PERSONAS.defaultPersona }],
    });

    const current = await getTest(auth, legacyTestAdoption.testId);
    expect(current).toMatchObject({
      version: 1,
      versionId: legacyTestAdoption.oldTestVersionId,
      revision: legacyTestAdoption.oldTestRevision,
      scenario: oldVersion?.scenario,
      expectedBehaviors: oldVersion?.expectedBehaviors,
      mockOverrides: oldVersion?.mockOverrides,
      requiredCapabilities: oldVersion?.requiredCapabilities,
      personas: [{ id: PREDEFINED_PERSONAS.defaultPersona }],
    });

    expect(
      await getTest(
        actInLegacy(legacy.customizedProject),
        legacyTestAdoption.customizedTestId,
      ),
    ).toMatchObject({
      version: 1,
      versionId: legacyTestAdoption.customizedTestVersionId,
      personas: [{ id: legacy.customizedPersonaId }],
    });

    const [priorSimulation] =
      (await listSimulations(auth, legacyTestAdoption.priorRunId)) ?? [];
    expect(priorSimulation).toMatchObject({
      id: legacyTestAdoption.priorSimulationId,
      testVersionId: legacyTestAdoption.oldTestVersionId,
      personaId: legacy.untouchedPersonaId,
      personaVersionId: legacyTestAdoption.legacyPersonaVersionId,
    });
    expect(await getPersona(auth, legacyTestAdoption.forkId)).toMatchObject({
      version: 1,
      versionId: legacyTestAdoption.forkVersionId,
    });
  });
});

describe("catalog updates", () => {
  it("moves the shared current version without rewriting v1 or an existing fork", async () => {
    const [defaultPersona] = PERSONA_LIBRARY_CATALOG;
    const v1 = defaultPersona?.versions[0];
    if (defaultPersona === undefined || v1 === undefined) {
      throw new Error("the default persona catalog entry is incomplete");
    }
    const fork = await forkPersona(
      acme.auth,
      PREDEFINED_PERSONAS.defaultPersona,
    );
    if (fork === undefined) throw new Error("the fork was not written");

    const v2 = {
      id: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C98",
      version: 2,
      traits: {
        ...v1.traits,
        personality: "Stays calm, asks one clear question, and checks the answer.",
      },
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    } as const;
    const updatedCatalog = [
      { ...defaultPersona, versions: [...defaultPersona.versions, v2] },
    ] as const;

    expect(await seedPersonaLibrary(updatedCatalog)).toEqual([
      {
        id: PREDEFINED_PERSONAS.defaultPersona,
        name: "Default Persona",
        version: 2,
        versionId: v2.id,
      },
    ]);
    expect(await seedPersonaLibrary(updatedCatalog)).toEqual([]);

    expect(
      await getPersona(acme.auth, PREDEFINED_PERSONAS.defaultPersona),
    ).toMatchObject({
      owner: "egma",
      version: 2,
      versionId: v2.id,
      traits: { personality: v2.traits.personality },
    });
    expect(await getPersonaVersion(acme.auth, v1.id)).toMatchObject({
      id: v1.id,
      version: 1,
      traits: v1.traits,
    });
    expect(await getPersona(acme.auth, fork.id)).toMatchObject({
      owner: "organization",
      version: 1,
      versionId: fork.versionId,
      traits: fork.traits,
    });

    const legacyAuth = actInLegacy(legacy.untouchedProject);
    const adoptedTest = await getTest(legacyAuth, legacyTestAdoption.testId);
    if (adoptedTest === undefined) throw new Error("the adopted test is missing");
    const futureRun = await startRun(legacyAuth, {
      agentId: legacyTestAdoption.agentId,
      connectionId: legacyTestAdoption.connectionId,
      testVersionIds: [adoptedTest.versionId],
      idempotencyKey: newId("run"),
    });
    expect(futureRun.simulations).toEqual([
      expect.objectContaining({
        testVersionId: adoptedTest.versionId,
        personaId: PREDEFINED_PERSONAS.defaultPersona,
        personaVersionId: v2.id,
      }),
    ]);

    const [priorSimulation] =
      (await listSimulations(legacyAuth, legacyTestAdoption.priorRunId)) ?? [];
    expect(priorSimulation).toMatchObject({
      testVersionId: legacyTestAdoption.oldTestVersionId,
      personaId: legacy.untouchedPersonaId,
      personaVersionId: legacyTestAdoption.legacyPersonaVersionId,
    });
    expect(await getPersona(legacyAuth, legacyTestAdoption.forkId)).toMatchObject({
      version: 1,
      versionId: legacyTestAdoption.forkVersionId,
    });
  });
});
