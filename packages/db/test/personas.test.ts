import { isId, newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPersona,
  getPersona,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  RECOMMENDED_PERSONA_MODELS,
  type AuthContext,
  PERSONA_PARAMETER_CONTRACT,
  EGMA_PROVIDED_PERSONAS,
  defaultPersonaParameterValues,
  type NewPersona,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  errorCodeOf,
  openSingleConnection,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The factory functions are the seam: every assertion goes through create and
 * get, never through table internals. Raw SQL appears only in fixtures (signup
 * provisioning has its own tests), in row counts proving what a failed create
 * left behind, and in the one insert that bypasses the module on purpose to
 * show the database refuses what the module never attempts.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");

function actingAsAcme(role: Role = "member"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

/**
 * Two names, and the tests lean on both. "Impatient Rita" is what her team
 * calls her in a list; "Rita Alvarez" is what the agent hears her say.
 */
const rita = {
  name: "Impatient Rita",
  description: "Elderly regular, books by phone only",
  identityName: "Rita Alvarez",
  personality:
    "Rita is 70, hard of hearing, answers questions with stories, and gets louder when the agent mishears her.",
  language: "en-US",
} as const satisfies NewPersona;

beforeAll(async () => {
  database = await createConnectedDatabase("personas");

  for (const tenant of [acme, globex]) {
    await seedOrganization(database, tenant.organization, [
      { id: tenant.project, slug: "default" },
    ]);
  }
  await seedUser(database, ada, "ada@acme.example");
});

afterAll(async () => {
  await database.drop();
});

async function rowCounts(): Promise<{ personas: number; versions: number }> {
  const personas = await database.sql<{ count: string }>(
    "select count(*) as count from persona_definition",
  );
  const versions = await database.sql<{ count: string }>(
    "select count(*) as count from persona_definition_version",
  );
  return {
    personas: Number(personas.rows[0]?.count),
    versions: Number(versions.rows[0]?.count),
  };
}

describe("creating a persona", () => {
  it("returns a prs_ id and fetch round-trips every input", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    expect(isId("prs", created.id)).toBe(true);
    expect(isId("prsv", created.versionId)).toBe(true);

    const fetched = await getPersona(actingAsAcme(), created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.name).toBe(rita.name);
    expect(fetched?.description).toBe(rita.description);
    expect(fetched?.version).toBe(1);
    expect(fetched?.identityName).toBe(rita.identityName);
    expect(fetched?.personality).toBe(rita.personality);
    expect(fetched?.language).toBe(rita.language);
    expect(fetched?.settings?.models).toEqual(RECOMMENDED_PERSONA_MODELS);
    expect(fetched?.projectId).toBe(acme.project);
  });

  it("is allowed to a member and refused to a viewer, per the permission table", async () => {
    await expect(
      createPersona(actingAsAcme("viewer"), rita),
    ).rejects.toThrow(NotPermittedError);

    const fetchedByViewer = await createPersona(actingAsAcme("member"), rita)
      .then((created) => getPersona(actingAsAcme("viewer"), created.id));
    expect(fetchedByViewer?.name).toBe(rita.name);
  });

  it("is refused to a credential acting in no project", async () => {
    await expect(
      createPersona(
        { ...actingAsAcme(), projectId: undefined },
        rita,
      ),
    ).rejects.toThrow(/project/);
  });

  it("cannot commit halfway: an identity row without its version dies at commit", async () => {
    // The factory writes both rows in one transaction, so a create that fails
    // between the two inserts leaves nothing. That guarantee is the deferred
    // pointer constraint, and this proves it where it lives — at commit, in
    // the database, for a writer that is not the factory.
    const connection = await openSingleConnection(database.url);
    try {
      const orphan = newId("prs");
      await connection.sql("begin");
      await connection.sql(
        `insert into persona_definition
           (id, organization_id, project_id, name, current_version_id)
         values ($1, $2, $3, 'Halfway', $4)`,
        [orphan, acme.organization, acme.project, newId("prsv")],
      );

      await expect(connection.sql("commit")).rejects.toSatisfy(
        (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
      );

      const { rows } = await database.sql(
        "select 1 from persona_definition where id = $1",
        [orphan],
      );
      expect(rows).toEqual([]);
    } finally {
      await connection.close();
    }
  });
});

describe("a credential for the whole organization", () => {
  it("reads a project's personas without acting in the project", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const fetched = await getPersona(wholeCustomer, created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.projectId).toBe(acme.project);
  });
});

describe("a persona that fails validation", () => {
  it("is refused for a missing identity name", async () => {
    const before = await rowCounts();

    await expect(
      createPersona(actingAsAcme(), { ...rita, identityName: "  " }),
    ).rejects.toThrow(/identity name/);

    expect(await rowCounts()).toEqual(before);
  });

  it("refuses missing and non-string create fields without leaking trim errors", async () => {
    const before = await rowCounts();
    const { name: _name, ...nameless } = rita;
    const { personality: _personality, ...voiceless } = rita;
    const { language: _language, ...speechless } = rita;
    const invalid = [
      [nameless, /name/],
      [{ ...rita, name: 42 }, /name/],
      [voiceless, /personality/],
      [{ ...rita, personality: 42 }, /personality/],
      [speechless, /language/],
    ] as const;

    for (const [input, message] of invalid) {
      await expect(
        createPersona(actingAsAcme(), input as unknown as NewPersona),
      ).rejects.toThrow(message);
    }
    expect(await rowCounts()).toEqual(before);
  });
});

describe("an immutable persona version", () => {
  it("refuses a direct personality rewrite at the database boundary", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    await expect(
      database.sql(
        `update persona_definition_version set personality = 'Rewritten' where id = $1`,
        [created.versionId],
      ),
    ).rejects.toMatchObject({
      code: POSTGRES_ERROR.checkViolation,
      constraint: "persona_version_semantics_immutable",
    });

    expect((await getPersona(actingAsAcme(), created.id))?.personality).toBe(
      rita.personality,
    );
  });
});

describe("stored core and project settings validation", () => {
  it("refuses a blank core value written around the module", async () => {
    const created = await createPersona(actingAsAcme(), rita);
    await expect(database.sql(`insert into persona_definition_version (id, persona_id, version, identity_name, personality, language, parameter_contract) values ($1, $2, 99, ' ', 'Patient', 'en-US', $3)`, [newId("prsv"), created.id, JSON.stringify(PERSONA_PARAMETER_CONTRACT)])).rejects.toMatchObject({ code: POSTGRES_ERROR.checkViolation, constraint: "persona_version_identity_name_stated" });
  });
  it("refuses unknown background assets and out-of-range background gain", async () => {
    const created = await createPersona(actingAsAcme(), rita);
    await expect(database.sql(`update project_persona set parameter_values = jsonb_set(parameter_values, '{background_sound_id}', '"unknown-v1"') where persona_definition_id = $1`, [created.id])).rejects.toMatchObject({ code: POSTGRES_ERROR.checkViolation });
    await expect(database.sql(`update project_persona set parameter_values = jsonb_set(parameter_values, '{background_volume}', '0.3') where persona_definition_id = $1`, [created.id])).rejects.toMatchObject({ code: POSTGRES_ERROR.checkViolation });
  });
});

describe("tenancy", () => {
  it("refuses a context pairing one organization with another's project, leaving no rows", async () => {
    const before = await rowCounts();

    await expect(
      createPersona(
        { ...actingAsAcme(), projectId: globex.project },
        rita,
      ),
    ).rejects.toThrow(ProjectOutsideOrganizationError);

    expect(await rowCounts()).toEqual(before);
  });

  it("returns nothing when another organization asks for my persona", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    const actingAsGlobex: AuthContext = {
      userId: newId("usr"),
      organizationId: globex.organization,
      projectId: globex.project,
      role: "member",
      via: "session",
    };
    expect(await getPersona(actingAsGlobex, created.id)).toBeUndefined();
  });

  it("refuses the mismatched pairing even for raw SQL that bypasses the module", async () => {
    await expect(
      database.sql(
        `insert into persona_definition
           (id, organization_id, project_id, name, current_version_id)
         values ($1, $2, $3, 'Smuggled', $4)`,
        [newId("prs"), acme.organization, globex.project, newId("prsv")],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });
});

describe("project persona storage boundaries", () => {
  it("refuses incomplete settings and keeps the association ownership fixed", async () => {
    const created = await createPersona(actingAsAcme(), rita);
    const settings = created.settings;
    if (settings === null) throw new Error("creation saved no settings");
    const complete = defaultPersonaParameterValues(PERSONA_PARAMETER_CONTRACT);
    expect(Object.keys(complete)).toHaveLength(12);
    expect(complete.interruption_level).toBe("none");
    const { tts_model: _model, ...missing } = complete;
    for (const values of [
      missing,
      { ...complete, unrecognized: 1 },
      { ...complete, tts_speed: 1 },
      { ...complete, tts_voice_id: " " },
      { ...complete, interruption_level: "constant" },
      { ...complete, interruption_level: 1 },
      { ...complete, execution_policy_version: 1 },
      { ...complete, speech_speed: "fast" },
    ]) {
      await expect(
        database.sql(
          "update project_persona set parameter_values = $1::jsonb where id = $2",
          [JSON.stringify(values), settings.id],
        ),
      ).rejects.toSatisfy(
        (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
      );
    }
    await expect(
      database.sql(
        "update project_persona set organization_id = $1, project_id = $2 where id = $3",
        [globex.organization, globex.project, settings.id],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
    expect((await getPersona(actingAsAcme(), created.id))?.settings).toEqual(
      settings,
    );
  });

  it("refuses a foreign custom definition, mismatched tenancy, and duplicate use", async () => {
    const created = await createPersona(actingAsAcme(), rita);
    const values = JSON.stringify(
      defaultPersonaParameterValues(PERSONA_PARAMETER_CONTRACT),
    );
    const insert = (organizationId: string, projectId: string, definitionId = created.id) =>
      database.sql(
        "insert into project_persona (id, organization_id, project_id, persona_definition_id, parameter_values, parameter_contract) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)",
        [newId("ppr"), organizationId, projectId, definitionId, values, JSON.stringify(PERSONA_PARAMETER_CONTRACT)],
      );
    await expect(insert(globex.organization, globex.project)).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
    await expect(insert(globex.organization, acme.project, EGMA_PROVIDED_PERSONAS.defaultPersona)).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
    await expect(insert(acme.organization, acme.project)).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.uniqueViolation,
    );
  });
});
