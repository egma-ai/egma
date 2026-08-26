import { isId, newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPersona,
  deletePersona,
  forkPersona,
  getPersona,
  getPersonaVersion,
  listPersonas,
  NotPermittedError,
  EGMA_PROVIDED_PERSONAS,
  type AuthContext,
  type NewPersona,
  type Persona,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * List, Fork and Delete — through the factory functions only, like the create
 * and fetch tests before them. Raw SQL appears in fixtures and in the one
 * count proving how many version rows a fork carries, which no seam lists
 * yet; every id an assertion needs comes off the seam itself.
 *
 * Each concern acts in a project of its own, so no assertion here depends on
 * what another describe block created.
 */

let database: MigratedDatabase;

const acme = {
  organization: newId("org"),
  listing: newId("prj"),
  forking: newId("prj"),
  deleting: newId("prj"),
};
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");

function actingIn(
  projectId: string | undefined,
  role: Role = "member",
): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId,
    role,
    via: "session",
  };
}

function actingAsGlobex(): AuthContext {
  return {
    userId: ada,
    organizationId: globex.organization,
    projectId: globex.project,
    role: "member",
    via: "session",
  };
}

function personaNamed(name: string): NewPersona {
  return {
    name,
    description: `${name}, of the list-fork-delete tests`,
    identityName: `${name} Alvarez`,
    personality: `${name} books by phone, repeats the booking back twice, and hangs up satisfied.`,
    language: "en-US",
  };
}

beforeAll(async () => {
  database = await createConnectedDatabase("personas_list_fork_delete");

  await seedOrganization(database, acme.organization, [
    { id: acme.listing, slug: "listing" },
    { id: acme.forking, slug: "forking" },
    { id: acme.deleting, slug: "deleting" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
});

afterAll(async () => {
  await database.drop();
});

async function versionIdsOf(personaId: string): Promise<readonly string[]> {
  const { rows } = await database.sql<{ id: string }>(
    "select id from persona_version where persona_id = $1 order by version",
    [personaId],
  );
  return rows.map((row) => row.id);
}

describe("listing personas", () => {
  const created: Persona[] = [];
  let neighbour: Persona;
  let stranger: Persona;

  beforeAll(async () => {
    for (const name of ["One", "Two", "Three", "Four", "Five"]) {
      created.push(await createPersona(actingIn(acme.listing), personaNamed(name)));
    }
    // One in a sibling project and one at another customer, so "only the
    // acting project's" is a claim the assertions can actually falsify.
    neighbour = await createPersona(
      actingIn(acme.forking),
      personaNamed("Neighbour"),
    );
    stranger = await createPersona(actingAsGlobex(), personaNamed("Stranger"));
  });

  it("returns only the acting project's personas, newest first", async () => {
    const page = await listPersonas(actingIn(acme.listing));

    expect(page.items.map((item) => item.id)).toEqual(
      [
        ...created.map((item) => item.id).reverse(),
        EGMA_PROVIDED_PERSONAS.defaultPersona,
      ],
    );
    expect(page.items.map((item) => item.name)).toEqual([
      "Five",
      "Four",
      "Three",
      "Two",
      "One",
      "Default Persona",
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("carries the current behavior on every row", async () => {
    const page = await listPersonas(actingIn(acme.listing));
    const five = page.items[0];
    expect(five?.version).toBe(1);
    expect(five?.personality).toContain("Five");
    expect(five?.identityName).toBe("Five Alvarez");
  });

  it("pages across the whole set with no overlap and no missed row", async () => {
    const first = await listPersonas(actingIn(acme.listing), { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]?.id);

    const second = await listPersonas(actingIn(acme.listing), {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBe(second.items[1]?.id);

    const third = await listPersonas(actingIn(acme.listing), {
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.items).toHaveLength(2);
    expect(third.nextCursor).toBeUndefined();

    const walked = [...first.items, ...second.items, ...third.items];
    expect(walked.map((item) => item.id)).toEqual(
      [
        ...created.map((item) => item.id).reverse(),
        EGMA_PROVIDED_PERSONAS.defaultPersona,
      ],
    );
  });

  it("refuses a page size outside the range and a cursor that is not a prs_ id", async () => {
    await expect(
      listPersonas(actingIn(acme.listing), { limit: 0 }),
    ).rejects.toThrow(/between 1 and/);
    await expect(
      listPersonas(actingIn(acme.listing), { limit: 201 }),
    ).rejects.toThrow(/between 1 and/);
    await expect(
      listPersonas(actingIn(acme.listing), { cursor: "prsv_nonsense" }),
    ).rejects.toThrow(/cursor/);
  });

  it("shows a credential for the whole organization every project, and no other customer", async () => {
    const page = await listPersonas(actingIn(undefined));

    const ids = page.items.map((item) => item.id);
    expect(ids).toHaveLength(7);
    expect(ids).toContain(neighbour.id);
    expect(ids).toContain(EGMA_PROVIDED_PERSONAS.defaultPersona);
    expect(ids).not.toContain(stranger.id);
    expect(
      page.items
        .filter((item) => item.owner === "organization")
        .every((item) =>
          item.projectId !== null &&
          [acme.listing, acme.forking].includes(item.projectId),
        ),
    ).toBe(true);
  });

  it("shows another customer none of them", async () => {
    const page = await listPersonas(actingAsGlobex());
    expect(page.items.map((item) => item.id)).toEqual([
      stranger.id,
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    ]);
  });

  it("drops a deleted persona from the list immediately", async () => {
    const [three] = created.filter((item) => item.name === "Three");
    if (three === undefined) throw new Error("Three was never created");

    await deletePersona(actingIn(acme.listing), three.id);

    const page = await listPersonas(actingIn(acme.listing));
    expect(page.items.map((item) => item.name)).toEqual([
      "Five",
      "Four",
      "Two",
      "One",
      "Default Persona",
    ]);
  });
});

describe("forking a persona", () => {
  let source: Persona;

  beforeAll(async () => {
    source = await createPersona(actingIn(acme.forking), personaNamed("Original"));
  });

  it("copies the current behavior into a fresh persona at version 1, with its own ids", async () => {
    const fork = await forkPersona(actingIn(acme.forking), source.id);

    expect(fork).toBeDefined();
    if (fork === undefined) throw new Error("unreachable");
    expect(isId("prs", fork.id)).toBe(true);
    expect(fork.id).not.toBe(source.id);
    expect(fork.versionId).not.toBe(source.versionId);
    expect(fork.version).toBe(1);
    expect(fork.name).toBe(source.name);
    expect(fork.description).toBe(source.description);
    expect(fork.identityName).toBe(source.identityName);
    expect(fork.personality).toBe(source.personality);
    expect(fork.language).toBe(source.language);
    expect(fork.models).toEqual(source.models);

    const fetched = await getPersona(actingIn(acme.forking), fork.id);
    expect(fetched?.identityName).toBe(source.identityName);
    expect(fetched?.personality).toBe(source.personality);

    // No shared history: one version row each, and not the same row.
    const sourceVersions = await versionIdsOf(source.id);
    const forkVersions = await versionIdsOf(fork.id);
    expect(sourceVersions).toHaveLength(1);
    expect(forkVersions).toHaveLength(1);
    expect(forkVersions[0]).not.toBe(sourceVersions[0]);
  });

  it("returns nothing for a persona the caller could not have fetched", async () => {
    expect(
      await forkPersona(actingAsGlobex(), source.id),
    ).toBeUndefined();
    expect(
      await forkPersona(actingIn(acme.deleting), source.id),
    ).toBeUndefined();

    // Neither refused fork created anything. Both lists still contain only
    // their earlier local rows plus the shared default persona.
    const globexPage = await listPersonas(actingAsGlobex());
    expect(globexPage.items.map((item) => item.name)).toEqual([
      "Stranger",
      "Default Persona",
    ]);
    const archivingPage = await listPersonas(actingIn(acme.deleting));
    expect(archivingPage.items.map((item) => item.name)).toEqual([
      "Default Persona",
    ]);
  });

  it("is refused to a viewer", async () => {
    await expect(
      forkPersona(actingIn(acme.forking, "viewer"), source.id),
    ).rejects.toThrow(NotPermittedError);
  });

  it("is refused to a credential acting in no project, which has nowhere to put the fork", async () => {
    await expect(
      forkPersona(actingIn(undefined), source.id),
    ).rejects.toThrow(/project/);

    // The refusal comes before the read, so an id that names nothing gets
    // the same loud answer — never an `undefined` that reads as invisible.
    await expect(
      forkPersona(actingIn(undefined), newId("prs")),
    ).rejects.toThrow(/project/);
  });
});

describe("deleting a persona", () => {
  let doomed: Persona;

  beforeAll(async () => {
    doomed = await createPersona(actingIn(acme.deleting), personaNamed("Doomed"));
  });

  it("is refused to a credential acting in no project, like create", async () => {
    await expect(
      deletePersona(actingIn(undefined), doomed.id),
    ).rejects.toThrow(/project/);

    const stillThere = await getPersona(actingIn(acme.deleting), doomed.id);
    expect(stillThere?.archivedAt).toBeNull();
  });

  it("takes them out of every list and leaves the record where it was", async () => {
    const deleted = await deletePersona(actingIn(acme.deleting), doomed.id);
    expect(deleted?.id).toBe(doomed.id);
    expect(deleted?.archivedAt).toBeInstanceOf(Date);

    // Still reachable by identifier, because a run that pinned one of their
    // versions is still on the record and still has to be interpretable.
    const fetched = await getPersona(actingIn(acme.deleting), doomed.id);
    expect(fetched?.archivedAt).toBeInstanceOf(Date);

    const listed = await listPersonas(actingIn(acme.deleting));
    expect(listed.items.map((item) => item.id)).not.toContain(doomed.id);

    const version = await getPersonaVersion(
      actingIn(acme.deleting),
      doomed.versionId,
    );
    expect(version?.personaId).toBe(doomed.id);
    expect(version?.version).toBe(1);
    expect(version?.identityName).toBe(doomed.identityName);
    expect(version?.personality).toBe(doomed.personality);
  });

  it("deletes once: a second Delete changes nothing and says so", async () => {
    const again = await deletePersona(actingIn(acme.deleting), doomed.id);
    const first = await getPersona(actingIn(acme.deleting), doomed.id);
    expect(again?.archivedAt?.getTime()).toBe(first?.archivedAt?.getTime());
  });

  it("keeps the surviving version invisible to another customer", async () => {
    expect(
      await getPersonaVersion(actingAsGlobex(), doomed.versionId),
    ).toBeUndefined();
  });

  it("returns nothing for another customer's persona, and leaves it active", async () => {
    const bystander = await createPersona(
      actingIn(acme.deleting),
      personaNamed("Bystander"),
    );

    expect(
      await deletePersona(actingAsGlobex(), bystander.id),
    ).toBeUndefined();

    const fetched = await getPersona(actingIn(acme.deleting), bystander.id);
    expect(fetched?.archivedAt).toBeNull();
  });

  it("is refused to a viewer", async () => {
    await expect(
      deletePersona(actingIn(acme.deleting, "viewer"), doomed.id),
    ).rejects.toThrow(NotPermittedError);
  });

  it("is refused for a Predefined persona, which no project may remove", async () => {
    await expect(
      deletePersona(
        actingIn(acme.deleting),
        EGMA_PROVIDED_PERSONAS.defaultPersona,
      ),
    ).rejects.toThrow(/is Predefined/);

    const listed = await listPersonas(actingIn(acme.deleting));
    expect(listed.items.map((item) => item.name)).toContain("Default Persona");
  });
});
