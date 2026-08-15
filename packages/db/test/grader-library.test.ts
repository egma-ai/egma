import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deleteGraderLibraryEntry,
  getGraderLibraryEntry,
  GRADER_LIBRARY_CATALOG,
  listGraderLibrary,
  PredefinedGraderError,
  RESERVED_LIBRARY_TYPES,
  seedGraderLibrary,
  type AuthContext,
  type LibraryEntry,
  type PredefinedGrader,
} from "@egma/db";

import {
  createConnectedDatabase,
  errorCodeOf,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The grader library: the shelf egma ships, seeded from egma's own catalog.
 *
 * **Two properties carry the whole mechanism, and both are here.** Run the
 * seeding twice and the second run writes nothing at all — not a row, not a
 * version, not an `updated_at` — which is what makes running it on every boot
 * free rather than merely harmless. Change an entry's words and ship the
 * release, and that row refreshes and its version moves — which is what makes
 * an improved judge prompt reach every project with nobody migrating anything,
 * and what keeps "which words judged this verdict" answerable afterwards.
 *
 * The third property is the one the schema holds rather than the module:
 * **null tenancy means egma owns the entry**, the one deliberate exception in
 * this schema, and it is where the Owner label is derived from. So the reads
 * below check the derivation, and the delete checks the refusal that follows
 * from it — egma's entries are written again at the next start, so removing one
 * could only ever be temporary, and saying no is the honest answer.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");

function actingIn(tenant: {
  organization: string;
  project: string;
}): AuthContext {
  return {
    userId: ada,
    organizationId: tenant.organization,
    projectId: tenant.project,
    role: "admin",
    via: "session",
  };
}

/** Every column of the shelf, as only a raw read can see it. */
type StoredEntry = {
  id: string;
  organization_id: string | null;
  project_id: string | null;
  name: string;
  description: string | null;
  type: string;
  version: number;
  prompt: string | null;
  params: unknown;
  output_definition: unknown;
  source_code: string | null;
  source_code_language: string | null;
  created_at: Date;
  updated_at: Date;
};

async function shelf(): Promise<readonly StoredEntry[]> {
  const { rows } = await database.sql<StoredEntry>(
    "select * from grader_library order by id",
  );
  return rows;
}

/**
 * A team's own entry, written by raw SQL on purpose: custom authoring is
 * shelved in v0, so there is no door that writes one — and the reads and the
 * delete both have to be answerable about the row shape that arrives the day
 * there is.
 */
async function insertTeamEntry(tenant: {
  organization: string;
  project: string;
}): Promise<string> {
  const id = newId("grl");
  await database.sql(
    `insert into grader_library
       (id, organization_id, project_id, name, description, type, params)
     values ($1, $2, $3, $4, $5, 'llm_as_judge', '[]'::jsonb)`,
    [id, tenant.organization, tenant.project, `team_${id.slice(-6)}`, "theirs"],
  );
  return id;
}

beforeAll(async () => {
  database = await createConnectedDatabase("grader_library");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
});

afterAll(async () => {
  await database.drop();
});

describe("seeding egma's own graders", () => {
  it("writes the catalog, with the catalog's own identifiers and birthdays", async () => {
    const written = await seedGraderLibrary();

    expect(written.map((entry) => entry.name).sort()).toEqual(
      GRADER_LIBRARY_CATALOG.map((entry) => entry.name).sort(),
    );
    // Everything arrives at version 1: nothing has been refreshed yet.
    expect(written.every((entry) => entry.version === 1)).toBe(true);

    const rows = await shelf();
    expect(rows).toHaveLength(GRADER_LIBRARY_CATALOG.length);

    for (const entry of GRADER_LIBRARY_CATALOG) {
      const row = rows.find((candidate) => candidate.id === entry.id);
      expect(row, entry.name).toBeDefined();
      // The identifier is the catalog's, not one minted at boot — which is
      // what lets a running copy keep pointing at the entry across upgrades.
      expect(row?.name).toBe(entry.name);
      expect(row?.type).toBe(entry.type);
      expect(row?.prompt).toBe(entry.prompt);
      expect(row?.params).toEqual(entry.params);
      expect(row?.output_definition).toEqual(entry.outputDefinition);
      // The day egma shipped it, from the catalog — not the day this database
      // was created.
      expect(row?.created_at.toISOString()).toBe(entry.createdAt.toISOString());
      // Null on both, which is this schema's way of saying egma owns it.
      expect(row?.organization_id).toBeNull();
      expect(row?.project_id).toBeNull();
      // Reserved for custom code entries, and nothing writes them in v0.
      expect(row?.source_code).toBeNull();
      expect(row?.source_code_language).toBeNull();
    }
  });

  it("ships expected_behaviors judged, with a prompt and an answer shape", async () => {
    const rows = await shelf();
    const behaviors = rows.find((row) => row.name === "expected_behaviors");

    expect(behaviors?.type).toBe("llm_as_judge");
    // The words a developer reads on the Library screen, and the words their
    // conversations are judged by — one prompt, on the row.
    expect(behaviors?.prompt ?? "").toContain("Decide only the criterion you are given");
    expect(behaviors?.output_definition).toMatchObject({
      score: { type: "number" },
      rationale: { type: "string" },
    });
    // Its assertions are the test's own sentences, supplied at judging time,
    // so pressing Use asks for nothing at all.
    expect(behaviors?.params).toEqual([]);
  });

  it("ships latency computed, asking for a measure and a bound", async () => {
    const rows = await shelf();
    const latency = rows.find((row) => row.name === "latency");

    expect(latency?.type).toBe("code");
    // Nobody asks a model anything, so there is no prompt and no answer shape.
    expect(latency?.prompt).toBeNull();
    expect(latency?.output_definition).toBeNull();

    const params = latency?.params as readonly { name: string; kind: string }[];
    expect(params.map((one) => one.name)).toEqual(["metric", "bound"]);
    // The measure is its own kind rather than a string with a note attached:
    // the catalog is the only list the form may offer, so the dropdown and the
    // check behind it cannot drift apart.
    expect(params[0]?.kind).toBe("measure");
    // Unitless on purpose: the unit is the chosen measure's own, and the
    // measure catalog is where that is already written down.
    expect(params[1]?.kind).toBe("number");
  });

  it("changes nothing on a second run, so every boot is safe", async () => {
    const before = await shelf();

    const again = await seedGraderLibrary();
    expect(again).toEqual([]);

    // Byte for byte, `updated_at` included: nothing here treats a container
    // starting as somebody editing a grader.
    expect(await shelf()).toEqual(before);
  });
});

describe("a catalog entry whose words changed", () => {
  it("refreshes its row and bumps its version, leaving its birthday alone", async () => {
    const [first, ...rest] = GRADER_LIBRARY_CATALOG;
    if (first === undefined) throw new Error("the catalog ships no entries");

    const before = (await shelf()).find((row) => row.id === first.id);
    const improved: PredefinedGrader = {
      ...first,
      description: `${first.description} And now it says one thing more.`,
    };

    const written = await seedGraderLibrary([improved, ...rest]);

    // Only the entry that moved, and it moved by exactly one.
    expect(written).toEqual([
      { id: first.id, name: first.name, version: 2 },
    ]);

    const after = (await shelf()).find((row) => row.id === first.id);
    expect(after?.description).toBe(improved.description);
    expect(after?.version).toBe(2);
    // Its birthday is the day egma shipped it and does not move; the moment it
    // last changed does.
    expect(after?.created_at.toISOString()).toBe(
      before?.created_at.toISOString(),
    );
    expect(after?.updated_at.getTime()).toBeGreaterThan(
      before?.updated_at.getTime() ?? 0,
    );
  });

  it("leaves every entry it did not change exactly where it was", async () => {
    const [, second] = GRADER_LIBRARY_CATALOG;
    if (second === undefined) throw new Error("the catalog ships one entry");

    const untouched = (await shelf()).find((row) => row.id === second.id);
    expect(untouched?.version).toBe(1);
  });

  it("puts the shipped words back when the improvement is reverted", async () => {
    // The catalog is the source of truth in both directions: rolling a release
    // back is a change like any other, so the row follows and the version
    // moves again rather than the row being stuck at whatever shipped last.
    const written = await seedGraderLibrary();
    expect(written.map((entry) => entry.version)).toEqual([3]);

    const [first] = GRADER_LIBRARY_CATALOG;
    const row = (await shelf()).find((candidate) => candidate.id === first?.id);
    expect(row?.description).toBe(first?.description);
  });
});

describe("a type no engine executes", () => {
  it.each(RESERVED_LIBRARY_TYPES)(
    "is refused by Postgres, not by the application: %s",
    async (reserved) => {
      // Raw SQL on purpose: the constraint defends the paths that never pass
      // through the application — a migration, an import, a fix at three in the
      // morning — so a write through the module could not reach it. A row
      // holding a reserved word would be a grader nothing can run, which is a
      // check somebody believes in that can never fire.
      await expect(
        database.sql(
          `insert into grader_library (id, name, type, params)
           values ($1, $2, $3, '[]'::jsonb)`,
          [newId("grl"), `reserved_${reserved}`, reserved],
        ),
      ).rejects.toSatisfy(
        (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
      );
    },
  );

  it("is refused for a word egma has never heard of either", async () => {
    await expect(
      database.sql(
        `insert into grader_library (id, name, type, params)
         values ($1, 'invented', 'vibes', '[]'::jsonb)`,
        [newId("grl")],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });
});

describe("half a tenancy", () => {
  it("is refused, because an entry belongs to a project or to egma", async () => {
    // The nullable pair is one fact, not two columns somebody can set
    // independently: an entry owned by an organization and by no project would
    // be a definition nothing could scope.
    await expect(
      database.sql(
        `insert into grader_library (id, organization_id, name, type, params)
         values ($1, $2, 'half', 'code', '[]'::jsonb)`,
        [newId("grl"), acme.organization],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });
});

describe("reading the shelf", () => {
  it("derives egma as the owner of an entry that belongs to nobody", async () => {
    const page = await listGraderLibrary(actingIn(acme));

    expect(page.items.map((entry) => entry.name).sort()).toEqual(
      GRADER_LIBRARY_CATALOG.map((entry) => entry.name).sort(),
    );
    for (const entry of page.items) {
      // Read off the tenancy, never off a stored flag — which is why there is
      // nothing on the row anybody could set the other way.
      expect(entry.owner, entry.name).toBe("egma");
      expect(entry.projectId, entry.name).toBeNull();
    }
  });

  it("derives the organization as the owner of an entry a team wrote", async () => {
    const theirs = await insertTeamEntry(acme);

    const page = await listGraderLibrary(actingIn(acme));
    const found = page.items.find((entry) => entry.id === theirs);
    expect(found?.owner).toBe("organization");
    expect(found?.projectId).toBe(acme.project);

    // And egma's are still on the shelf beside it, which is the whole point of
    // one table for both owners.
    const owners = page.items.map((entry: LibraryEntry) => entry.owner).sort();
    expect(owners).toEqual(["egma", "egma", "organization"]);
  });

  it("shows one customer nothing of another's, while both see egma's", async () => {
    const theirs = await insertTeamEntry(globex);

    const asAcme = await listGraderLibrary(actingIn(acme));
    expect(asAcme.items.some((entry) => entry.id === theirs)).toBe(false);

    const asGlobex = await listGraderLibrary(actingIn(globex));
    expect(asGlobex.items.some((entry) => entry.id === theirs)).toBe(true);
    expect(
      asGlobex.items.filter((entry) => entry.owner === "egma"),
    ).toHaveLength(GRADER_LIBRARY_CATALOG.length);

    // Reading one by its own id answers on the same terms as the list.
    expect(await getGraderLibraryEntry(actingIn(acme), theirs)).toBeUndefined();
    expect(await getGraderLibraryEntry(actingIn(globex), theirs)).toMatchObject({
      id: theirs,
      owner: "organization",
    });
  });

  it("hands back the prompt, so a developer can read what judges them", async () => {
    const page = await listGraderLibrary(actingIn(acme));
    const behaviors = page.items.find(
      (entry) => entry.name === "expected_behaviors",
    );
    expect(behaviors?.prompt ?? "").toContain("cannot_determine");
    expect(behaviors?.type).toBe("llm_as_judge");
  });
});

describe("deleting from the shelf", () => {
  it("refuses one of egma's, naming it", async () => {
    const [predefined] = GRADER_LIBRARY_CATALOG;
    if (predefined === undefined) throw new Error("the catalog ships no entries");

    await expect(
      deleteGraderLibraryEntry(actingIn(acme), predefined.id),
    ).rejects.toBeInstanceOf(PredefinedGraderError);

    // And it is still there afterwards, which is the part that matters: the
    // next boot would write it back anyway, so a delete that appeared to work
    // would be a grader that vanished until somebody restarted a container.
    expect(
      await getGraderLibraryEntry(actingIn(acme), predefined.id),
    ).toMatchObject({ id: predefined.id, owner: "egma" });
  });

  it("says which grader it refused, in the words a person reads", async () => {
    const [predefined] = GRADER_LIBRARY_CATALOG;
    if (predefined === undefined) throw new Error("the catalog ships no entries");

    await expect(
      deleteGraderLibraryEntry(actingIn(acme), predefined.id),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PredefinedGraderError &&
        error.graderName === predefined.name &&
        error.libraryId === predefined.id &&
        error.message.includes(predefined.name),
    );
  });

  it("takes a team's own entry off, because that one is theirs", async () => {
    const theirs = await insertTeamEntry(acme);

    const removed = await deleteGraderLibraryEntry(actingIn(acme), theirs);
    expect(removed?.id).toBe(theirs);
    expect(await getGraderLibraryEntry(actingIn(acme), theirs)).toBeUndefined();
  });

  it("answers a delete of what the caller cannot see as though it were not there", async () => {
    const theirs = await insertTeamEntry(globex);
    expect(await deleteGraderLibraryEntry(actingIn(acme), theirs)).toBeUndefined();
    // Untouched, and its existence never confirmed to the wrong customer.
    expect(await getGraderLibraryEntry(actingIn(globex), theirs)).toBeDefined();
  });
});
