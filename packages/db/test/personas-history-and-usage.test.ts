import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPersona,
  deletePersona,
  editPersona,
  getPersona,
  getPersonaVersion,
  listPersonaVersions,
  testsUsingPersona,
  type AuthContext,
  type NewPersona,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Test persona history, usage, and metadata edits through the factory.
 * Metadata edits use last-write-wins semantics; behavior edits separately
 * require the current expectedVersionId.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");

function acting(role: "admin" | "member" | "viewer" = "member"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

const PERSONALITY = "Calls about a bill, and wants it settled today.";

beforeAll(async () => {
  database = await createConnectedDatabase("persona_history");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
});

afterAll(async () => {
  await database.drop();
});

async function seed(name: string) {
  const input: NewPersona = {
    name,
    identityName: `${name.split(" ").at(-1) ?? name} Nakamura`,
    personality: PERSONALITY,
    language: "en-US",
  };
  return createPersona(acting(), input);
}

describe("persona metadata and current-core edits", () => {
  it("lands, because the last write wins", async () => {
    const made = await seed("Renamed Rowan");

    const renamed = await editPersona(acting(), made.id, {
      expectedVersionId: (await getPersona(acting(), made.id))!.versionId,
      name: "Rowan, renamed",
    });
    expect(renamed?.name).toBe("Rowan, renamed");

    // The second tab, still holding what it read before the rename. It is not
    // refused, and it does not have to read anything again first.
    const again = await editPersona(acting(), made.id, {
      expectedVersionId: (await getPersona(acting(), made.id))!.versionId,
      name: "Rowan, renamed again",
    });
    expect(again?.name).toBe("Rowan, renamed again");
    expect((await getPersona(acting(), made.id))?.name).toBe(
      "Rowan, renamed again",
    );
  });

  it("refuses a stale core base after another edit wins", async () => {
    const made = await seed("Versioned Vera");
    const second = await editPersona(acting(), made.id, { expectedVersionId: made.versionId, personality: "Vera, after a long wait." });
    expect(second?.version).toBe(2);
    await expect(editPersona(acting(), made.id, { expectedVersionId: made.versionId, personality: "Vera, in a hurry." })).rejects.toThrow(/current version/);
    const now = await getPersona(acting(), made.id);
    expect(now?.version).toBe(2);
    expect(now?.personality).toBe("Vera, after a long wait.");
  });

  it("mints nothing for an identical save", async () => {
    const made = await seed("Steady Sam");

    const saved = await editPersona(acting(), made.id, {
      expectedVersionId: (await getPersona(acting(), made.id))!.versionId,
      personality: PERSONALITY,
    });

    expect(saved?.version).toBe(1);
    expect(saved?.versionId).toBe(made.versionId);
    const history = await listPersonaVersions(acting(), made.id);
    expect(history.items).toHaveLength(1);
  });
});

describe("what a detail sheet reads", () => {
  it("lists every version newest first, and each one stays readable on its own", async () => {
    const made = await seed("Historic Hana");
    const second = await editPersona(acting(), made.id, {
      expectedVersionId: (await getPersona(acting(), made.id))!.versionId,
      personality: "Hana after the first edit.",
    });
    const third = await editPersona(acting(), made.id, {
      expectedVersionId: (await getPersona(acting(), made.id))!.versionId,
      personality: "Hana after the second edit.",
    });

    const history = await listPersonaVersions(acting(), made.id);
    expect(history.items.map((one) => one.version)).toEqual([3, 2, 1]);
    expect(history.items.map((one) => one.id)).toEqual([
      third?.versionId,
      second?.versionId,
      made.versionId,
    ]);

    const older = await getPersonaVersion(acting(), made.versionId);
    expect(older?.personality).toBe(PERSONALITY);
    expect(older?.identityName).toBe(made.identityName);
    expect(history.items[2]?.personality).toBe(PERSONALITY);
  });

  it("keeps the history readable after the persona is deleted", async () => {
    const made = await seed("Filed-Away Fay");
    await editPersona(acting(), made.id, {
      expectedVersionId: (await getPersona(acting(), made.id))!.versionId,
      personality: "Fay before being filed away.",
    });
    await deletePersona(acting(), made.id);

    const history = await listPersonaVersions(acting(), made.id);
    expect(history.items.map((one) => one.version)).toEqual([2, 1]);
  });

  it("answers nothing at all for a persona this caller cannot reach", async () => {
    expect(await listPersonaVersions(acting(), newId("prs"))).toEqual({
      items: [],
      nextCursor: undefined,
    });
    expect(await testsUsingPersona(acting(), newId("prs"))).toBeUndefined();
  });

  it("answers an empty usage list for a persona no test names", async () => {
    const made = await seed("Unused Ulla");
    expect(await testsUsingPersona(acting(), made.id)).toEqual([]);
  });

  it("is refused to nobody: a viewer reads history and usage like anybody else", async () => {
    const made = await seed("Readable Rae");
    expect((await listPersonaVersions(acting("viewer"), made.id)).items).toHaveLength(1);
    expect(await testsUsingPersona(acting("viewer"), made.id)).toEqual([]);
  });
});
