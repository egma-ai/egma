import { isId, newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPersona,
  editPersona,
  getPersona,
  getPersonaVersion,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  RECOMMENDED_PERSONA_MODELS,
  type AuthContext,
  type NewPersona,
  type PersonaChanges,
  type PersonaTraits,
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

const rita = {
  name: "Impatient Rita",
  description: "Elderly regular, books by phone only",
  traits: {
    personality:
      "Rita is 70, hard of hearing, answers questions with stories, and gets louder when the agent mishears her.",
    language: "en-US",
    accent: "Neutral American English.",
    backgroundNoise: "A quiet kitchen.",
  },
} as const satisfies NewPersona;

const ritaTraits: PersonaTraits = rita.traits;

function ritaWith(personality: string): PersonaTraits {
  return { ...ritaTraits, personality };
}

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
    "select count(*) as count from persona",
  );
  const versions = await database.sql<{ count: string }>(
    "select count(*) as count from persona_version",
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
    expect(fetched?.traits).toEqual(ritaTraits);
    expect(fetched?.models).toEqual(RECOMMENDED_PERSONA_MODELS);
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
        `insert into persona
           (id, organization_id, project_id, name, current_version_id, revision)
         values ($1, $2, $3, 'Halfway', $4, 'a-revision')`,
        [orphan, acme.organization, acme.project, newId("prsv")],
      );

      await expect(connection.sql("commit")).rejects.toSatisfy(
        (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
      );

      const { rows } = await database.sql(
        "select 1 from persona where id = $1",
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

  it("edits what already exists: the row names its own project", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const edited = await editPersona(wholeCustomer, created.id, {
      traits: ritaWith("Rita calls from the whole customer context."),
    });

    expect(edited?.version).toBe(2);
    expect(edited?.projectId).toBe(acme.project);

    const version = await getPersonaVersion(wholeCustomer, created.versionId);
    expect(version?.version).toBe(1);
  });
});

describe("editing a persona's personality", () => {
  it("creates version 2, moves the pointer, and leaves version 1 untouched", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    const calmer = "Rita, but rested.";
    const edited = await editPersona(actingAsAcme(), created.id, {
      traits: ritaWith(calmer),
    });

    expect(edited?.version).toBe(2);
    expect(edited?.versionId).not.toBe(created.versionId);
    expect(edited?.traits).toEqual({ ...ritaTraits, personality: calmer });

    const fetched = await getPersona(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(2);
    expect(fetched?.versionId).toBe(edited?.versionId);

    const frozen = await getPersonaVersion(actingAsAcme(), created.versionId);
    expect(frozen?.version).toBe(1);
    expect(frozen?.personaId).toBe(created.id);
    expect(frozen?.traits).toEqual(ritaTraits);
  });

  it("versions each personality change", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    const personalities = [
      "Rita after a good nap.",
      "Rita after a short wait.",
      "Rita after the issue is resolved.",
    ] as const;

    let expected = 1;
    for (const personality of personalities) {
      const edited = await editPersona(actingAsAcme(), created.id, {
        traits: ritaWith(personality),
      });
      expected += 1;
      expect(edited?.version).toBe(expected);
    }

    const fetched = await getPersona(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(4);
    expect(fetched?.traits).toEqual({
      ...ritaTraits,
      personality: personalities[2],
    });
  });

  it("does nothing for a byte-identical save, and returns the current version", async () => {
    const created = await createPersona(actingAsAcme(), rita);
    const before = await rowCounts();

    const saved = await editPersona(actingAsAcme(), created.id, {
      traits: ritaTraits,
    });

    expect(saved?.version).toBe(1);
    expect(saved?.versionId).toBe(created.versionId);
    expect(await rowCounts()).toEqual(before);

    const fetched = await getPersona(actingAsAcme(), created.id);
    expect(fetched?.updatedAt.getTime()).toBe(created.updatedAt.getTime());
  });

  it("keeps every old version fetchable by its prsv_ id after later edits", async () => {
    const created = await createPersona(actingAsAcme(), rita);
    const second = await editPersona(actingAsAcme(), created.id, {
      traits: ritaWith("Rita after the first edit."),
    });
    await editPersona(actingAsAcme(), created.id, {
      traits: ritaWith("Rita after the second edit."),
    });

    const first = await getPersonaVersion(actingAsAcme(), created.versionId);
    expect(first?.version).toBe(1);
    expect(first?.traits).toEqual(ritaTraits);

    if (second?.versionId === undefined) throw new Error("no second version");
    const middle = await getPersonaVersion(actingAsAcme(), second.versionId);
    expect(middle?.version).toBe(2);
    expect(middle?.traits).toEqual({
      ...ritaTraits,
      personality: "Rita after the first edit.",
    });
  });

  it("refuses an empty edited personality and versions nothing", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    await expect(
      editPersona(actingAsAcme(), created.id, {
        traits: ritaWith("   "),
      }),
    ).rejects.toThrow(/personality/);

    const fetched = await getPersona(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(1);
    expect(fetched?.traits).toEqual(ritaTraits);
  });

  it("is refused to a viewer, per the permission table", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    await expect(
      editPersona(actingAsAcme("viewer"), created.id, {
        traits: ritaWith("Rita after a viewer's edit."),
      }),
    ).rejects.toThrow(NotPermittedError);
  });
});

describe("editing a persona's model selection", () => {
  it("mints a version and leaves the previous complete selection frozen", async () => {
    const created = await createPersona(actingAsAcme(), rita);
    const nextModels = {
      ...RECOMMENDED_PERSONA_MODELS,
      stt: { provider: "deepgram", model: "nova-3-general" },
    } as const;

    const edited = await editPersona(actingAsAcme(), created.id, {
      models: nextModels,
    });

    expect(edited?.version).toBe(2);
    expect(edited?.models).toEqual(nextModels);
    expect(
      (await getPersonaVersion(actingAsAcme(), created.versionId))?.models,
    ).toEqual(RECOMMENDED_PERSONA_MODELS);
  });

  it("refuses an unsupported provider/model pair before writing", async () => {
    const created = await createPersona(actingAsAcme(), rita);
    await expect(
      editPersona(actingAsAcme(), created.id, {
        models: {
          ...RECOMMENDED_PERSONA_MODELS,
          stt: { provider: "openai", model: "gpt-4o-transcribe" },
        },
      }),
    ).rejects.toThrow(/supported openai stt model/i);
    expect((await getPersona(actingAsAcme(), created.id))?.version).toBe(1);
  });
});

describe("renaming a persona", () => {
  it("updates name and description and creates no version", async () => {
    const created = await createPersona(actingAsAcme(), rita);
    const before = await rowCounts();

    const renamed = await editPersona(actingAsAcme(), created.id, {
      name: "Patient Rita",
      description: "Rita, after the hearing aid arrived",
    });

    expect(renamed?.name).toBe("Patient Rita");
    expect(renamed?.description).toBe("Rita, after the hearing aid arrived");
    expect(renamed?.version).toBe(1);
    expect(renamed?.versionId).toBe(created.versionId);
    expect(await rowCounts()).toEqual(before);

    const fetched = await getPersona(actingAsAcme(), created.id);
    expect(fetched?.name).toBe("Patient Rita");
    expect(fetched?.version).toBe(1);
    expect(fetched?.traits).toEqual(ritaTraits);
  });

  it("clears the description with null, still without versioning", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    const cleared = await editPersona(actingAsAcme(), created.id, {
      description: null,
    });

    expect(cleared?.description).toBeNull();
    expect(cleared?.version).toBe(1);
  });

  it("refuses a blank name", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    await expect(
      editPersona(actingAsAcme(), created.id, { name: "   " }),
    ).rejects.toThrow(/name/);
  });

  it("renames and versions together when one edit carries both", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    const edited = await editPersona(actingAsAcme(), created.id, {
      name: "Louder Rita",
      traits: ritaWith("Rita gets louder when the agent mishears her."),
    });

    expect(edited?.name).toBe("Louder Rita");
    expect(edited?.version).toBe(2);
  });
});

describe("a persona that fails validation", () => {
  it("is refused for a missing name, and no rows are left behind", async () => {
    const before = await rowCounts();

    await expect(
      createPersona(actingAsAcme(), { ...rita, name: "   " }),
    ).rejects.toThrow(/name/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused for an empty personality", async () => {
    const before = await rowCounts();

    await expect(
      createPersona(actingAsAcme(), {
        ...rita,
        traits: ritaWith(""),
      }),
    ).rejects.toThrow(/personality/);

    expect(await rowCounts()).toEqual(before);
  });

  it("refuses non-object create input instead of leaking Object.keys errors", async () => {
    const before = await rowCounts();
    for (const invalid of [null, "not an object"]) {
      await expect(
        createPersona(actingAsAcme(), invalid as unknown as NewPersona),
      ).rejects.toThrow("persona create input must be an object");
    }
    expect(await rowCounts()).toEqual(before);
  });

  it("refuses missing and non-string create fields without leaking trim errors", async () => {
    const before = await rowCounts();
    const invalid = [
      [{ traits: ritaTraits }, /name/],
      [{ name: 42, traits: ritaTraits }, /name/],
      [{ name: "Rita" }, /traits/],
      [{ name: "Rita", traits: { ...ritaTraits, personality: 42 } }, /personality/],
      [{ name: "Rita", traits: { personality: "Ready" } }, /language/],
    ] as const;

    for (const [input, message] of invalid) {
      await expect(
        createPersona(actingAsAcme(), input as unknown as NewPersona),
      ).rejects.toThrow(message);
    }
    expect(await rowCounts()).toEqual(before);
  });

  it("refuses stale create fields clearly and writes nothing", async () => {
    const before = await rowCounts();
    const staleInput = { ...rita, personality: "Old flat field" } as unknown as NewPersona;

    await expect(
      createPersona(actingAsAcme(), staleInput),
    ).rejects.toThrow(
      'persona create received unsupported fields "personality"; accepted fields are "name", "description", "traits", "models"',
    );

    expect(await rowCounts()).toEqual(before);
  });

  it.each(["manner", "patience", "underFriction"])(
    "refuses the removed %s trait and writes nothing",
    async (removedTrait) => {
      const before = await rowCounts();
      const input = {
        ...rita,
        traits: { ...ritaTraits, [removedTrait]: "Legacy behavior." },
      } as unknown as NewPersona;

      await expect(createPersona(actingAsAcme(), input)).rejects.toThrow(
        `persona traits have unsupported fields ${removedTrait}`,
      );
      expect(await rowCounts()).toEqual(before);
    },
  );

  it("refuses stale edit fields clearly and versions nothing", async () => {
    const created = await createPersona(actingAsAcme(), rita);
    const before = await rowCounts();
    const staleChanges = { personality: "Old flat field" } as unknown as PersonaChanges;

    await expect(
      editPersona(actingAsAcme(), created.id, staleChanges),
    ).rejects.toThrow(
      'persona edit received unsupported fields "personality"; accepted fields are "name", "description", "traits", "models", "expectedRevision", "expectedVersionId"',
    );

    expect(await rowCounts()).toEqual(before);
    expect((await getPersona(actingAsAcme(), created.id))?.version).toBe(1);
  });

  it("refuses malformed edit input without leaking implementation errors", async () => {
    const created = await createPersona(actingAsAcme(), rita);
    const before = await rowCounts();

    for (const invalid of [null, "not an object"]) {
      await expect(
        editPersona(
          actingAsAcme(),
          created.id,
          invalid as unknown as PersonaChanges,
        ),
      ).rejects.toThrow("persona edit input must be an object");
    }
    await expect(
      editPersona(actingAsAcme(), created.id, {
        name: 42,
      } as unknown as PersonaChanges),
    ).rejects.toThrow(/name/);
    await expect(
      editPersona(actingAsAcme(), created.id, {
        traits: { ...ritaTraits, personality: 42 },
      } as unknown as PersonaChanges),
    ).rejects.toThrow(/personality/);

    expect(await rowCounts()).toEqual(before);
    expect((await getPersona(actingAsAcme(), created.id))?.version).toBe(1);
  });
});

describe("an immutable persona version", () => {
  it("refuses a direct traits rewrite at the database boundary", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    await expect(
      database.sql(
        `update persona_version set traits = '{"personality": 12}'::jsonb where id = $1`,
        [created.versionId],
      ),
    ).rejects.toMatchObject({
      code: POSTGRES_ERROR.checkViolation,
      constraint: "persona_version_semantics_immutable",
    });

    expect((await getPersona(actingAsAcme(), created.id))?.traits).toEqual(
      ritaTraits,
    );
  });

  it("refuses a direct models rewrite at the database boundary", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    await expect(
      database.sql(
        `update persona_version
            set models = jsonb_set(models, '{stt,model}', '"gpt-4o-transcribe"')
          where id = $1`,
        [created.versionId],
      ),
    ).rejects.toMatchObject({
      code: POSTGRES_ERROR.checkViolation,
      constraint: "persona_version_semantics_immutable",
    });

    expect((await getPersona(actingAsAcme(), created.id))?.models).toEqual(
      RECOMMENDED_PERSONA_MODELS,
    );
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

  it("edits nothing and returns nothing when another organization asks", async () => {
    const created = await createPersona(actingAsAcme(), rita);

    const actingAsGlobex: AuthContext = {
      userId: newId("usr"),
      organizationId: globex.organization,
      projectId: globex.project,
      role: "admin",
      via: "session",
    };
    const stolen = await editPersona(actingAsGlobex, created.id, {
      name: "Globex Rita",
      traits: ritaWith("Globex tries to change Rita."),
    });
    expect(stolen).toBeUndefined();

    const untouched = await getPersona(actingAsAcme(), created.id);
    expect(untouched?.name).toBe(rita.name);
    expect(untouched?.version).toBe(1);

    expect(
      await getPersonaVersion(actingAsGlobex, created.versionId),
    ).toBeUndefined();
  });

  it("edits nothing for an id that does not exist", async () => {
    expect(
      await editPersona(actingAsAcme(), newId("prs"), { name: "Nobody" }),
    ).toBeUndefined();
  });

  it("refuses the mismatched pairing even for raw SQL that bypasses the module", async () => {
    await expect(
      database.sql(
        `insert into persona
           (id, organization_id, project_id, name, current_version_id, revision)
         values ($1, $2, $3, 'Smuggled', $4, 'a-revision')`,
        [newId("prs"), acme.organization, globex.project, newId("prsv")],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });
});
