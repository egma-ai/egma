import { isId, newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cloneDigitalHuman,
  createDigitalHuman,
  deleteDigitalHuman,
  getDigitalHuman,
  getDigitalHumanVersion,
  listDigitalHumans,
  NotPermittedError,
  type AuthContext,
  type DigitalHuman,
  type NewDigitalHuman,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";

/**
 * List, clone, delete — through the factory functions only, like the create
 * and fetch tests before them. Raw SQL appears in fixtures and in row counts
 * proving what a refused clone left behind and how many versions a clone
 * carries; every id an assertion needs comes off the seam itself.
 *
 * Each concern acts in a project of its own, so no assertion here depends on
 * what another describe block created.
 */

let database: MigratedDatabase;

const acme = {
  organization: newId("org"),
  listing: newId("prj"),
  cloning: newId("prj"),
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

function human(name: string): NewDigitalHuman {
  return {
    name,
    description: `${name}, of the list-clone-delete tests`,
    traits: {
      personality: `${name} books by phone, repeats the booking back twice, and hangs up satisfied.`,
      language: "en-US",
      voice: {
        provider: "elevenlabs",
        voiceId: "EXAVITQu4vr4xnSDxMaL",
        speed: 0.9,
      },
    },
  };
}

beforeAll(async () => {
  database = await createConnectedDatabase("digital_humans_list_clone_delete");

  await database.sql(
    "insert into organization (id, name, slug) values ($1, $2, $2), ($3, $4, $4)",
    [
      acme.organization,
      acme.organization.slice(-8),
      globex.organization,
      globex.organization.slice(-8),
    ],
  );
  for (const [projectId, organizationId, slug] of [
    [acme.listing, acme.organization, "listing"],
    [acme.cloning, acme.organization, "cloning"],
    [acme.deleting, acme.organization, "deleting"],
    [globex.project, globex.organization, "default"],
  ]) {
    await database.sql(
      "insert into project (id, organization_id, name, slug) values ($1, $2, $3, $3)",
      [projectId, organizationId, slug],
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

async function versionIdsOf(digitalHumanId: string): Promise<readonly string[]> {
  const { rows } = await database.sql<{ id: string }>(
    "select id from digital_human_version where digital_human_id = $1 order by version",
    [digitalHumanId],
  );
  return rows.map((row) => row.id);
}

describe("listing digital humans", () => {
  const created: DigitalHuman[] = [];
  let neighbour: DigitalHuman;
  let stranger: DigitalHuman;

  beforeAll(async () => {
    for (const name of ["One", "Two", "Three", "Four", "Five"]) {
      created.push(await createDigitalHuman(actingIn(acme.listing), human(name)));
    }
    // One in a sibling project and one at another customer, so "only the
    // acting project's" is a claim the assertions can actually falsify.
    neighbour = await createDigitalHuman(
      actingIn(acme.cloning),
      human("Neighbour"),
    );
    stranger = await createDigitalHuman(actingAsGlobex(), human("Stranger"));
  });

  it("returns only the acting project's digital humans, newest first", async () => {
    const page = await listDigitalHumans(actingIn(acme.listing));

    expect(page.items.map((item) => item.id)).toEqual(
      created.map((item) => item.id).reverse(),
    );
    expect(page.items.map((item) => item.name)).toEqual([
      "Five",
      "Four",
      "Three",
      "Two",
      "One",
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("carries the current traits on every row", async () => {
    const page = await listDigitalHumans(actingIn(acme.listing));
    const five = page.items[0];
    expect(five?.version).toBe(1);
    expect(five?.traits.personality).toContain("Five");
  });

  it("pages across the whole set with no overlap and no missed row", async () => {
    const first = await listDigitalHumans(actingIn(acme.listing), { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]?.id);

    const second = await listDigitalHumans(actingIn(acme.listing), {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBe(second.items[1]?.id);

    const third = await listDigitalHumans(actingIn(acme.listing), {
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeUndefined();

    const walked = [...first.items, ...second.items, ...third.items];
    expect(walked.map((item) => item.id)).toEqual(
      created.map((item) => item.id).reverse(),
    );
  });

  it("refuses a page size outside the range and a cursor that is not a dh_ id", async () => {
    await expect(
      listDigitalHumans(actingIn(acme.listing), { limit: 0 }),
    ).rejects.toThrow(/between 1 and/);
    await expect(
      listDigitalHumans(actingIn(acme.listing), { limit: 201 }),
    ).rejects.toThrow(/between 1 and/);
    await expect(
      listDigitalHumans(actingIn(acme.listing), { cursor: "dhv_nonsense" }),
    ).rejects.toThrow(/cursor/);
  });

  it("shows a credential for the whole organization every project, and no other customer", async () => {
    const page = await listDigitalHumans(actingIn(undefined));

    const ids = page.items.map((item) => item.id);
    expect(ids).toHaveLength(6);
    expect(ids).toContain(neighbour.id);
    expect(ids).not.toContain(stranger.id);
    expect(
      page.items.every((item) =>
        [acme.listing, acme.cloning].includes(item.projectId),
      ),
    ).toBe(true);
  });

  it("shows another customer none of them", async () => {
    const page = await listDigitalHumans(actingAsGlobex());
    expect(page.items.map((item) => item.id)).toEqual([stranger.id]);
  });

  it("drops a deleted digital human from the list immediately", async () => {
    const [three] = created.filter((item) => item.name === "Three");
    if (three === undefined) throw new Error("Three was never created");

    await deleteDigitalHuman(actingIn(acme.listing), three.id);

    const page = await listDigitalHumans(actingIn(acme.listing));
    expect(page.items.map((item) => item.name)).toEqual([
      "Five",
      "Four",
      "Two",
      "One",
    ]);
  });
});

describe("cloning a digital human", () => {
  let source: DigitalHuman;

  beforeAll(async () => {
    source = await createDigitalHuman(actingIn(acme.cloning), human("Original"));
  });

  it("copies the current traits into a fresh digital human at version 1, with its own ids", async () => {
    const clone = await cloneDigitalHuman(actingIn(acme.cloning), source.id);

    expect(clone).toBeDefined();
    if (clone === undefined) throw new Error("unreachable");
    expect(isId("dh", clone.id)).toBe(true);
    expect(clone.id).not.toBe(source.id);
    expect(clone.versionId).not.toBe(source.versionId);
    expect(clone.version).toBe(1);
    expect(clone.name).toBe(source.name);
    expect(clone.description).toBe(source.description);
    expect(clone.traits).toEqual(source.traits);

    const fetched = await getDigitalHuman(actingIn(acme.cloning), clone.id);
    expect(fetched?.traits).toEqual(source.traits);

    // No shared history: one version row each, and not the same row.
    const sourceVersions = await versionIdsOf(source.id);
    const cloneVersions = await versionIdsOf(clone.id);
    expect(sourceVersions).toHaveLength(1);
    expect(cloneVersions).toHaveLength(1);
    expect(cloneVersions[0]).not.toBe(sourceVersions[0]);
  });

  it("returns nothing for a digital human the caller could not have fetched", async () => {
    expect(
      await cloneDigitalHuman(actingAsGlobex(), source.id),
    ).toBeUndefined();
    expect(
      await cloneDigitalHuman(actingIn(acme.deleting), source.id),
    ).toBeUndefined();

    const { rows } = await database.sql(
      "select count(*) as count from digital_human where organization_id = $1",
      [globex.organization],
    );
    expect(Number(rows[0]?.count)).toBe(1); // Stranger, and nobody else
  });

  it("is refused to a viewer", async () => {
    await expect(
      cloneDigitalHuman(actingIn(acme.cloning, "viewer"), source.id),
    ).rejects.toThrow(NotPermittedError);
  });

  it("is refused to a credential acting in no project, which has nowhere to put the clone", async () => {
    await expect(
      cloneDigitalHuman(actingIn(undefined), source.id),
    ).rejects.toThrow(/project/);
  });
});

describe("deleting a digital human", () => {
  let doomed: DigitalHuman;

  beforeAll(async () => {
    doomed = await createDigitalHuman(actingIn(acme.deleting), human("Doomed"));
  });

  it("is refused to a credential acting in no project, like create", async () => {
    await expect(
      deleteDigitalHuman(actingIn(undefined), doomed.id),
    ).rejects.toThrow(/project/);

    const stillThere = await getDigitalHuman(actingIn(acme.deleting), doomed.id);
    expect(stillThere?.id).toBe(doomed.id);
  });

  it("hides it from fetch and list, while its version rows stay readable", async () => {
    const deleted = await deleteDigitalHuman(actingIn(acme.deleting), doomed.id);
    expect(deleted?.id).toBe(doomed.id);
    expect(deleted?.deletedAt).toBeInstanceOf(Date);

    expect(
      await getDigitalHuman(actingIn(acme.deleting), doomed.id),
    ).toBeUndefined();
    const page = await listDigitalHumans(actingIn(acme.deleting));
    expect(page.items.map((item) => item.id)).not.toContain(doomed.id);

    const version = await getDigitalHumanVersion(
      actingIn(acme.deleting),
      doomed.versionId,
    );
    expect(version?.digitalHumanId).toBe(doomed.id);
    expect(version?.version).toBe(1);
    expect(version?.traits).toEqual(doomed.traits);
  });

  it("deletes only once: a second delete finds nothing", async () => {
    expect(
      await deleteDigitalHuman(actingIn(acme.deleting), doomed.id),
    ).toBeUndefined();
  });

  it("keeps the surviving version invisible to another customer", async () => {
    expect(
      await getDigitalHumanVersion(actingAsGlobex(), doomed.versionId),
    ).toBeUndefined();
  });

  it("returns nothing for another customer's digital human, and leaves it live", async () => {
    const bystander = await createDigitalHuman(
      actingIn(acme.deleting),
      human("Bystander"),
    );

    expect(
      await deleteDigitalHuman(actingAsGlobex(), bystander.id),
    ).toBeUndefined();

    const fetched = await getDigitalHuman(actingIn(acme.deleting), bystander.id);
    expect(fetched?.id).toBe(bystander.id);
  });

  it("is refused to a viewer", async () => {
    await expect(
      deleteDigitalHuman(actingIn(acme.deleting, "viewer"), doomed.id),
    ).rejects.toThrow(NotPermittedError);
  });
});
