import { newId } from "@egma/ids";
import {
  CATALOGED_MEASURES,
  SPAN_DERIVED_MEASURES,
} from "@egma/simulation-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deleteGrader,
  deleteGraderLibraryEntry,
  getGrader,
  getGraderLibraryEntry,
  GRADER_LIBRARY_CATALOG,
  GraderLibraryEntryInUseError,
  listGraderLibrary,
  PredefinedGraderError,
  RESERVED_LIBRARY_TYPES,
  seedGraderLibrary,
  useLibraryEntry,
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
  // The one file that starts with an empty shelf, because filling it is what
  // this file is about: every other harness seeds the library the way a
  // deployment does, and a first run that found the rows already there could
  // never watch them arrive.
  database = await createConnectedDatabase("grader_library", {
    seedGraders: false,
  });
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
    // The judge's **reply**, not the verdict row written from it: the prompt on
    // this same row commands these three fields and the engine parses them, so
    // all three statements about one exchange have to be the one statement.
    expect(behaviors?.output_definition).toMatchObject({
      decision: { type: "string", oneOf: ["met", "not_met", "cannot_determine"] },
      rationale: { type: "string" },
      cited_turns: { type: "number[]" },
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

    const params = latency?.params as readonly {
      name: string;
      kind: string;
      options?: readonly { value: string; label: string; unit: string }[];
    }[];
    expect(params.map((one) => one.name)).toEqual(["metric", "bound"]);
    // The measure is its own kind rather than a string with a note attached:
    // the catalog is the only list the form may offer, so the dropdown and the
    // check behind it cannot drift apart.
    expect(params[0]?.kind).toBe("measure");
    // Unitless on the parameter itself: the unit is the chosen measure's own,
    // and it rides each option below rather than being fixed here.
    expect(params[1]?.kind).toBe("number");
    expect(params[1]?.options).toBeUndefined();
  });

  /**
   * **The dropdown's own values, on the entry.** The Library screen is a browser
   * page with no way to read egma's packages, so a list of measures typed there
   * would be a second copy of the measure catalog — stale the first time a
   * measure joined or left, and its first symptom a write refused for offering
   * exactly what the form offered.
   *
   * They are exactly the measures egma computes from a conversation's spans,
   * which is the same list the write door accepts and the same list the shared
   * measure module implements. Narrower than the catalog on purpose: a measure
   * that arrives on the terminal transition is a real number a grader reading a
   * trace would never find.
   */
  it("publishes the measures a copy may bound, straight off the measure catalog", async () => {
    const rows = await shelf();
    const latency = rows.find((row) => row.name === "latency");
    const params = latency?.params as readonly {
      name: string;
      options?: readonly { value: string; label: string; unit: string; means: string }[];
    }[];

    const offered = params[0]?.options ?? [];
    expect(offered.map((one) => one.value)).toEqual([...SPAN_DERIVED_MEASURES]);
    // Not the whole catalog: a measure no span carries is not offerable.
    expect(offered.length).toBeLessThan(CATALOGED_MEASURES.length);

    for (const option of offered) {
      // Words a person reads, and the unit a bound beside it is counted in —
      // both from the catalog, so a form never has an opinion of its own.
      expect(option.label).not.toBe("");
      expect(option.label).not.toContain("_");
      expect(option.unit).not.toBe("");
      expect(option.means.length).toBeGreaterThan(20);
    }
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

  it("reads oldest first, so the always-on grader is the first one met", async () => {
    const page = await listGraderLibrary(actingIn(globex));

    // A shelf is not a feed. The graders somebody meets first should be the
    // ones that are always on, which on these identifiers is the order the
    // catalog was written in.
    expect(
      page.items
        .filter((entry) => entry.owner === "egma")
        .map((entry) => entry.name),
    ).toEqual(GRADER_LIBRARY_CATALOG.map((entry) => entry.name));
    // And egma's come first outright, because they were minted before anything
    // a customer could have written.
    expect(page.items[0]?.name).toBe("expected_behaviors");
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

/**
 * **An entry a project is judging with cannot leave the shelf.**
 *
 * A running copy reads its definition through `library_id` every time it
 * judges — the words are never written down onto the copy, precisely so that
 * the screen and the judge cannot drift — so an entry taken away underneath one
 * would leave a grader that resolves to nothing and judges nothing while still
 * appearing on the Running graders screen. That is a check somebody believes in
 * that can never fire, which is the false trust this product exists to kill.
 *
 * **Refusal, never `set null` and never a cascade.** The first would leave the
 * grader with no definition to read; the second would delete judging somebody
 * set up without them asking.
 */
describe("deleting an entry that copies still point at", () => {
  it("is refused, naming the copies standing in the way", async () => {
    const theirs = await insertTeamEntry(acme);
    const copy = await useLibraryEntry(actingIn(acme), {
      libraryId: theirs,
      name: "Judging with our own",
    });

    await expect(
      deleteGraderLibraryEntry(actingIn(acme), theirs),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GraderLibraryEntryInUseError &&
        error.libraryId === theirs &&
        error.graders.length === 1 &&
        error.graders[0]?.id === copy.id &&
        // The fix is to stop running each of them, so the sentence has to name
        // them: a refusal that only said "something uses it" would send
        // somebody hunting.
        error.message.includes(copy.id) &&
        error.message.includes(copy.name),
    );

    // And it is still there afterwards, still readable, still judging.
    expect(await getGraderLibraryEntry(actingIn(acme), theirs)).toBeDefined();
    expect(await getGrader(actingIn(acme), copy.id)).toBeDefined();
  });

  /**
   * The database says the same thing, which is what makes "never orphaned" true
   * of a hand-written statement rather than only of the module above it.
   */
  it("is refused by the foreign key too, for raw SQL that bypasses the module", async () => {
    const theirs = await insertTeamEntry(acme);
    await useLibraryEntry(actingIn(acme), {
      libraryId: theirs,
      name: "Judging with our own, again",
    });

    await expect(
      database.sql("delete from grader_library where id = $1", [theirs]),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.restrictViolation,
    );
  });

  /**
   * **Switching a copy off is not enough**, and the reason is what keeps old
   * verdicts readable.
   *
   * Deleting a copy is a soft delete: the row stays and so do its versions,
   * precisely so that a verdict written under one still says what decided it.
   * That chain runs verdict → version → copy → entry, and taking the entry away
   * would break it at the last link. So the shelf keeps the definition for as
   * long as anything points at it — which is also what the foreign key
   * underneath counts, so the module and the database say one thing.
   */
  it("is still refused after the copies have been switched off", async () => {
    const theirs = await insertTeamEntry(acme);
    const copy = await useLibraryEntry(actingIn(acme), {
      libraryId: theirs,
      name: "Switched off in a moment",
    });

    await deleteGrader(actingIn(acme), copy.id);
    expect(await getGrader(actingIn(acme), copy.id)).toBeUndefined();

    await expect(
      deleteGraderLibraryEntry(actingIn(acme), theirs),
    ).rejects.toBeInstanceOf(GraderLibraryEntryInUseError);
    expect(await getGraderLibraryEntry(actingIn(acme), theirs)).toBeDefined();
  });

  /** And an entry nothing has ever pointed at leaves without complaint. */
  it("goes through for an entry no grader was ever made from", async () => {
    const theirs = await insertTeamEntry(acme);

    const removed = await deleteGraderLibraryEntry(actingIn(acme), theirs);
    expect(removed?.id).toBe(theirs);
    expect(await getGraderLibraryEntry(actingIn(acme), theirs)).toBeUndefined();
  });
});
