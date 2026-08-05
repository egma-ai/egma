import { isId, newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDigitalHuman,
  editDigitalHuman,
  getDigitalHuman,
  getDigitalHumanVersion,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  type AuthContext,
  type DigitalHumanTraits,
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
    voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 0.9 },
  },
} as const;

beforeAll(async () => {
  database = await createConnectedDatabase("digital_humans");

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

async function rowCounts(): Promise<{ humans: number; versions: number }> {
  const humans = await database.sql<{ count: string }>(
    "select count(*) as count from digital_human",
  );
  const versions = await database.sql<{ count: string }>(
    "select count(*) as count from digital_human_version",
  );
  return {
    humans: Number(humans.rows[0]?.count),
    versions: Number(versions.rows[0]?.count),
  };
}

describe("creating a digital human", () => {
  it("returns a dh_ id and fetch round-trips every input", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    expect(isId("dh", created.id)).toBe(true);
    expect(isId("dhv", created.versionId)).toBe(true);

    const fetched = await getDigitalHuman(actingAsAcme(), created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.name).toBe(rita.name);
    expect(fetched?.description).toBe(rita.description);
    expect(fetched?.version).toBe(1);
    expect(fetched?.traits).toEqual(rita.traits);
    expect(fetched?.projectId).toBe(acme.project);
  });

  it("is allowed to a member and refused to a viewer, per the permission table", async () => {
    await expect(
      createDigitalHuman(actingAsAcme("viewer"), rita),
    ).rejects.toThrow(NotPermittedError);

    const fetchedByViewer = await createDigitalHuman(actingAsAcme("member"), rita)
      .then((created) => getDigitalHuman(actingAsAcme("viewer"), created.id));
    expect(fetchedByViewer?.name).toBe(rita.name);
  });

  it("is refused to a credential acting in no project", async () => {
    await expect(
      createDigitalHuman(
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
      const orphan = newId("dh");
      await connection.sql("begin");
      await connection.sql(
        `insert into digital_human
           (id, organization_id, project_id, name, current_version_id)
         values ($1, $2, $3, 'Halfway', $4)`,
        [orphan, acme.organization, acme.project, newId("dhv")],
      );

      await expect(connection.sql("commit")).rejects.toSatisfy(
        (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
      );

      const { rows } = await database.sql(
        "select 1 from digital_human where id = $1",
        [orphan],
      );
      expect(rows).toEqual([]);
    } finally {
      await connection.close();
    }
  });
});

describe("a credential for the whole organization", () => {
  it("reads a project's digital humans without acting in the project", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const fetched = await getDigitalHuman(wholeCustomer, created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.projectId).toBe(acme.project);
  });

  it("edits what already exists: the row names its own project", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const edited = await editDigitalHuman(wholeCustomer, created.id, {
      traits: { ...rita.traits, language: "en-CA" },
    });

    expect(edited?.version).toBe(2);
    expect(edited?.projectId).toBe(acme.project);

    const version = await getDigitalHumanVersion(wholeCustomer, created.versionId);
    expect(version?.version).toBe(1);
  });
});

describe("editing a digital human's traits", () => {
  it("creates version 2, moves the pointer, and leaves version 1 untouched", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    const calmer = { ...rita.traits, personality: "Rita, but rested." };
    const edited = await editDigitalHuman(actingAsAcme(), created.id, {
      traits: calmer,
    });

    expect(edited?.version).toBe(2);
    expect(edited?.versionId).not.toBe(created.versionId);
    expect(edited?.traits).toEqual(calmer);

    const fetched = await getDigitalHuman(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(2);
    expect(fetched?.versionId).toBe(edited?.versionId);

    const frozen = await getDigitalHumanVersion(actingAsAcme(), created.versionId);
    expect(frozen?.version).toBe(1);
    expect(frozen?.digitalHumanId).toBe(created.id);
    expect(frozen?.traits).toEqual(rita.traits);
  });

  it("versions on any single trait change", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    let traits: DigitalHumanTraits = rita.traits;
    const oneAtATime = [
      { personality: "Rita after a good nap." },
      { language: "en-GB" },
      { voice: { ...rita.traits.voice, provider: "cartesia" } },
      { voice: { ...rita.traits.voice, provider: "cartesia", voiceId: "sonic-rita" } },
      {
        voice: {
          ...rita.traits.voice,
          provider: "cartesia",
          voiceId: "sonic-rita",
          speed: 1.1,
        },
      },
    ] as const;

    let expected = 1;
    for (const change of oneAtATime) {
      traits = { ...traits, ...change };
      const edited = await editDigitalHuman(actingAsAcme(), created.id, { traits });
      expected += 1;
      expect(edited?.version).toBe(expected);
    }

    const fetched = await getDigitalHuman(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(6);
    expect(fetched?.traits).toEqual(traits);
  });

  it("does nothing for a byte-identical save, and returns the current version", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);
    const before = await rowCounts();

    const saved = await editDigitalHuman(actingAsAcme(), created.id, {
      traits: { ...rita.traits, voice: { ...rita.traits.voice } },
    });

    expect(saved?.version).toBe(1);
    expect(saved?.versionId).toBe(created.versionId);
    expect(await rowCounts()).toEqual(before);

    const fetched = await getDigitalHuman(actingAsAcme(), created.id);
    expect(fetched?.updatedAt.getTime()).toBe(created.updatedAt.getTime());
  });

  it("keeps every old version fetchable by its dhv_ id after later edits", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);
    const second = await editDigitalHuman(actingAsAcme(), created.id, {
      traits: { ...rita.traits, language: "en-AU" },
    });
    await editDigitalHuman(actingAsAcme(), created.id, {
      traits: { ...rita.traits, language: "en-NZ" },
    });

    const first = await getDigitalHumanVersion(actingAsAcme(), created.versionId);
    expect(first?.version).toBe(1);
    expect(first?.traits).toEqual(rita.traits);

    if (second?.versionId === undefined) throw new Error("no second version");
    const middle = await getDigitalHumanVersion(actingAsAcme(), second.versionId);
    expect(middle?.version).toBe(2);
    expect(middle?.traits).toEqual({ ...rita.traits, language: "en-AU" });
  });

  it("validates edited traits exactly as created ones, and versions nothing", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    await expect(
      editDigitalHuman(actingAsAcme(), created.id, {
        traits: {
          ...rita.traits,
          voice: { ...rita.traits.voice, speed: 5 },
        },
      }),
    ).rejects.toThrow(/speed/);

    const fetched = await getDigitalHuman(actingAsAcme(), created.id);
    expect(fetched?.version).toBe(1);
    expect(fetched?.traits).toEqual(rita.traits);
  });

  it("is refused to a viewer, per the permission table", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    await expect(
      editDigitalHuman(actingAsAcme("viewer"), created.id, {
        traits: { ...rita.traits, language: "en-GB" },
      }),
    ).rejects.toThrow(NotPermittedError);
  });
});

describe("renaming a digital human", () => {
  it("updates name and description and creates no version", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);
    const before = await rowCounts();

    const renamed = await editDigitalHuman(actingAsAcme(), created.id, {
      name: "Patient Rita",
      description: "Rita, after the hearing aid arrived",
    });

    expect(renamed?.name).toBe("Patient Rita");
    expect(renamed?.description).toBe("Rita, after the hearing aid arrived");
    expect(renamed?.version).toBe(1);
    expect(renamed?.versionId).toBe(created.versionId);
    expect(await rowCounts()).toEqual(before);

    const fetched = await getDigitalHuman(actingAsAcme(), created.id);
    expect(fetched?.name).toBe("Patient Rita");
    expect(fetched?.version).toBe(1);
    expect(fetched?.traits).toEqual(rita.traits);
  });

  it("clears the description with null, still without versioning", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    const cleared = await editDigitalHuman(actingAsAcme(), created.id, {
      description: null,
    });

    expect(cleared?.description).toBeNull();
    expect(cleared?.version).toBe(1);
  });

  it("refuses a blank name", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    await expect(
      editDigitalHuman(actingAsAcme(), created.id, { name: "   " }),
    ).rejects.toThrow(/name/);
  });

  it("renames and versions together when one edit carries both", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    const edited = await editDigitalHuman(actingAsAcme(), created.id, {
      name: "Louder Rita",
      traits: { ...rita.traits, voice: { ...rita.traits.voice, speed: 1.2 } },
    });

    expect(edited?.name).toBe("Louder Rita");
    expect(edited?.version).toBe(2);
  });
});

describe("a digital human that fails validation", () => {
  it("is refused for a missing name, and no rows are left behind", async () => {
    const before = await rowCounts();

    await expect(
      createDigitalHuman(actingAsAcme(), { ...rita, name: "   " }),
    ).rejects.toThrow(/name/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused for an empty personality", async () => {
    const before = await rowCounts();

    await expect(
      createDigitalHuman(actingAsAcme(), {
        ...rita,
        traits: { ...rita.traits, personality: "" },
      }),
    ).rejects.toThrow(/personality/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused for a voice provider egma does not know", async () => {
    const before = await rowCounts();

    await expect(
      createDigitalHuman(actingAsAcme(), {
        ...rita,
        traits: {
          ...rita.traits,
          voice: { ...rita.traits.voice, provider: "acme-voices" as never },
        },
      }),
    ).rejects.toThrow(/provider/);

    expect(await rowCounts()).toEqual(before);
  });

  it("is refused for an empty language", async () => {
    await expect(
      createDigitalHuman(actingAsAcme(), {
        ...rita,
        traits: { ...rita.traits, language: " " },
      }),
    ).rejects.toThrow(/language/);
  });

  it("is refused for a speaking speed outside the intelligible range", async () => {
    await expect(
      createDigitalHuman(actingAsAcme(), {
        ...rita,
        traits: {
          ...rita.traits,
          voice: { ...rita.traits.voice, speed: 5 },
        },
      }),
    ).rejects.toThrow(/speed/);
  });
});

describe("a version row somebody hand-corrupted", () => {
  it("fails loudly on every read, naming the version, rather than leaking", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    // Raw SQL on purpose: the factory can never write this, so the guard is
    // the only thing standing between the row and the caller.
    await database.sql(
      `update digital_human_version set traits = '{"personality": 12}'::jsonb where id = $1`,
      [created.versionId],
    );

    await expect(getDigitalHuman(actingAsAcme(), created.id)).rejects.toThrow(
      created.versionId,
    );
    await expect(
      getDigitalHumanVersion(actingAsAcme(), created.versionId),
    ).rejects.toThrow(created.versionId);
    await expect(
      editDigitalHuman(actingAsAcme(), created.id, { name: "Renamed anyway" }),
    ).rejects.toThrow(created.versionId);
  });
});

describe("tenancy", () => {
  it("refuses a context pairing one organization with another's project, leaving no rows", async () => {
    const before = await rowCounts();

    await expect(
      createDigitalHuman(
        { ...actingAsAcme(), projectId: globex.project },
        rita,
      ),
    ).rejects.toThrow(ProjectOutsideOrganizationError);

    expect(await rowCounts()).toEqual(before);
  });

  it("returns nothing when another organization asks for my digital human", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    const actingAsGlobex: AuthContext = {
      userId: newId("usr"),
      organizationId: globex.organization,
      projectId: globex.project,
      role: "member",
      via: "session",
    };
    expect(await getDigitalHuman(actingAsGlobex, created.id)).toBeUndefined();
  });

  it("edits nothing and returns nothing when another organization asks", async () => {
    const created = await createDigitalHuman(actingAsAcme(), rita);

    const actingAsGlobex: AuthContext = {
      userId: newId("usr"),
      organizationId: globex.organization,
      projectId: globex.project,
      role: "admin",
      via: "session",
    };
    const stolen = await editDigitalHuman(actingAsGlobex, created.id, {
      name: "Globex Rita",
      traits: { ...rita.traits, language: "en-GB" },
    });
    expect(stolen).toBeUndefined();

    const untouched = await getDigitalHuman(actingAsAcme(), created.id);
    expect(untouched?.name).toBe(rita.name);
    expect(untouched?.version).toBe(1);

    expect(
      await getDigitalHumanVersion(actingAsGlobex, created.versionId),
    ).toBeUndefined();
  });

  it("edits nothing for an id that does not exist", async () => {
    expect(
      await editDigitalHuman(actingAsAcme(), newId("dh"), { name: "Nobody" }),
    ).toBeUndefined();
  });

  it("refuses the mismatched pairing even for raw SQL that bypasses the module", async () => {
    await expect(
      database.sql(
        `insert into digital_human
           (id, organization_id, project_id, name, current_version_id)
         values ($1, $2, $3, 'Smuggled', $4)`,
        [newId("dh"), acme.organization, globex.project, newId("dhv")],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });
});
