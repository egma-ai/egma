import { isId, newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDigitalHuman,
  getDigitalHuman,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  type AuthContext,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  errorCodeOf,
  openSingleConnection,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";

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
    await database.sql(
      "insert into organization (id, name, slug) values ($1, $2, $2)",
      [tenant.organization, tenant.organization.slice(-8)],
    );
    await database.sql(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [tenant.project, tenant.organization],
    );
  }
  await database.sql('insert into "user" (id, email) values ($1, $2)', [
    ada,
    "ada@acme.example",
  ]);
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
