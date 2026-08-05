import { newId } from "@egma/ids";
import {
  createPersona,
  createTest,
  editPersona,
  getPersona,
  listPersonas,
  provisionOrganization,
  type AuthContext,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedUser } from "./support/tenancy.ts";

/**
 * Signup provisions a customer, and the project it creates already holds a
 * persona for a test that names none.
 *
 * Everything here goes through the front door signup itself uses: one call to
 * `provisionOrganization`, and then the ordinary factory reads. Raw SQL appears
 * three times and never to set anything up — to read the pointer column, which
 * no exported call answers; to compare the seeded rows against ones the persona
 * factory wrote itself; and to count what a refused provisioning left behind,
 * absence being the one thing no seam can show.
 *
 * Who the starter is is deliberately not asserted. Their personality and their
 * voice are a placeholder waiting on a product decision, so a test spelling
 * either out would fail the day that decision is made, and would be checking a
 * wording rather than the guarantee. What is asserted is that a starter is
 * there, that they are a persona the factory itself would have accepted, and
 * that a first test naming nobody receives them.
 */

let database: MigratedDatabase;

type Provisioned = {
  readonly auth: AuthContext;
  readonly organizationId: string;
  readonly projectId: string;
  readonly userId: string;
};

/** A customer arriving the way signup brings one in, and acting as its owner. */
async function signUp(slug: string, email: string): Promise<Provisioned> {
  const userId = newId("usr");
  await seedUser(database, userId, email);

  const provisioned = await provisionOrganization({
    ownerUserId: userId,
    organizationName: slug,
    organizationSlug: slug,
    projectName: "Default",
    projectSlug: "default",
  });

  return {
    userId,
    organizationId: provisioned.organizationId,
    projectId: provisioned.projectId,
    auth: {
      userId,
      organizationId: provisioned.organizationId,
      projectId: provisioned.projectId,
      role: provisioned.membership.role,
      via: "session",
    },
  };
}

/** The pointer column itself, which no exported read answers. */
async function pointerOf(projectId: string): Promise<string | null> {
  const { rows } = await database.sql<{ default_persona_id: string | null }>(
    "select default_persona_id from project where id = $1",
    [projectId],
  );
  return rows[0]?.default_persona_id ?? null;
}

/** The same, where a test has already shown the pointer is set. */
async function starterOf(projectId: string): Promise<string> {
  const id = await pointerOf(projectId);
  if (id === null) throw new Error(`project ${projectId} points at nobody`);
  return id;
}

async function countOf(query: string): Promise<string | undefined> {
  const { rows } = await database.sql<{ count: string }>(query);
  return rows[0]?.count;
}

/** One whole row, `select *`, so a column added later arrives without being named. */
async function rowOf(
  table: string,
  id: string,
): Promise<Record<string, unknown>> {
  const { rows } = await database.sql(`select * from ${table} where id = $1`, [
    id,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`no ${table} ${id}`);
  return row;
}

/**
 * Two rows of one table, compared column by column.
 *
 * `ownWords` names the columns each row is entitled to differ on — its id, what
 * it points at, when it was written, and what it was called — and nothing else
 * is excused from the comparison of values.
 *
 * Which columns are *filled* is then compared over every column, `ownWords`
 * included, and that is the half that catches drift in both directions: a
 * column one write fills and the other leaves null fails here whichever of the
 * two started it.
 */
async function expectSameWriteShape(
  table: string,
  starterId: string,
  factoryId: string,
  ownWords: readonly string[],
): Promise<void> {
  const starter = await rowOf(table, starterId);
  const factory = await rowOf(table, factoryId);

  const filled = (row: Record<string, unknown>): string[] =>
    Object.keys(row)
      .filter((column) => row[column] !== null)
      .sort();
  expect(filled(starter), `${table}: which columns are filled`).toEqual(
    filled(factory),
  );

  const said = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(row).filter(([column]) => !ownWords.includes(column)),
    );
  expect(said(starter), `${table}: what the two rows say`).toEqual(said(factory));
}

let acme: Provisioned;

beforeAll(async () => {
  database = await createConnectedDatabase("provisioning_starter");
  acme = await signUp("acme", "ada@acme.example");
  // A second customer, seeded before anything is read, so that a read missing
  // its tenancy predicate has another customer's starter to wrongly return.
  await signUp("globex", "grace@globex.example");
});

afterAll(async () => {
  await database.drop();
});

describe("the project provisioning creates", () => {
  it("points at a persona seeded into it", async () => {
    const pointer = await pointerOf(acme.projectId);
    expect(pointer).not.toBeNull();

    const starter = await getPersona(
      acme.auth,
      await starterOf(acme.projectId),
    );
    expect(starter).toBeDefined();
    expect(starter?.projectId).toBe(acme.projectId);
    expect(starter?.version).toBe(1);
  });

  it("holds that persona and nobody else", async () => {
    const page = await listPersonas(acme.auth);
    expect(page.items.map((named) => named.id)).toEqual([
      await starterOf(acme.projectId),
    ]);
  });

  it("seeded one the factory itself would have accepted", async () => {
    const pointer = await starterOf(acme.projectId);
    const starter = await getPersona(acme.auth, pointer);
    if (starter === undefined) throw new Error("the starter was not seeded");

    // Handing the seeded traits straight back to the factory puts them through
    // the validation a hand-authored persona passes, and through the no-op
    // comparison beside it. Invalid traits are refused here; traits the module
    // reads back differently from how they were written would mint a second
    // version. Neither happens, so the seeded row is one the factory could have
    // written itself.
    const edited = await editPersona(acme.auth, pointer, {
      traits: starter.traits,
    });
    expect(edited?.version).toBe(1);
    expect(edited?.versionId).toBe(starter.versionId);
  });

  it("seeded rows the factory would have written the same way", async () => {
    // Its own customer, because this test puts a second persona in the project
    // it reads.
    const initech = await signUp("initech", "hedy@initech.example");
    const pointer = await starterOf(initech.projectId);
    const starter = await getPersona(initech.auth, pointer);
    if (starter === undefined) throw new Error("the starter was not seeded");

    // Provisioning writes these rows itself, because `createPersona` cannot run
    // inside its transaction, so nothing but this keeps the two writes saying
    // the same thing.
    //
    // The name and the description are typed here rather than copied off the
    // starter, deliberately. Copying them would let the starter stop writing a
    // description and this test hand the same emptiness to the factory, and the
    // two rows would agree all the way to the day nobody could explain why a
    // new project's persona had none. What is asserted about them is that both
    // writes fill them; what they say is each write's own business. The traits
    // are the one thing copied, because comparing the stored jsonb is what
    // shows provisioning writes traits the way the factory does.
    const made = await createPersona(initech.auth, {
      name: "Authored by hand",
      description: "Whatever the developer typed",
      traits: starter.traits,
    });

    // `created_by` is compared rather than excused: provisioning knows who it
    // is provisioning for, and records them exactly as the factory records the
    // credential that called it.
    await expectSameWriteShape("persona", pointer, made.id, [
      "id",
      "current_version_id",
      "name",
      "description",
      "created_at",
      "updated_at",
    ]);
    await expectSameWriteShape(
      "persona_version",
      starter.versionId,
      made.versionId,
      ["id", "persona_id", "created_at"],
    );
  });

  it("seeded an ordinary row, renamed and rewritten like any other", async () => {
    const umbrella = await signUp("umbrella", "ada@umbrella.example");
    const pointer = await starterOf(umbrella.projectId);

    const renamed = await editPersona(umbrella.auth, pointer, {
      name: "Impatient Rita",
    });
    expect(renamed?.name).toBe("Impatient Rita");
    expect(renamed?.version).toBe(1);

    const rewritten = await editPersona(umbrella.auth, pointer, {
      traits: {
        personality: "Interrupts, and will not be put on hold.",
        language: "en-GB",
        voice: { provider: "cartesia", voiceId: "a-catalog-id", speed: 1.15 },
      },
    });
    expect(rewritten?.version).toBe(2);

    // Still the project's default: editing them is not replacing them.
    expect(await pointerOf(umbrella.projectId)).toBe(pointer);
  });
});

describe("a first test in a freshly provisioned project", () => {
  it("is created naming no persona, and receives the starter", async () => {
    const wayne = await signUp("wayne", "lucius@wayne.example");

    const created = await createTest(wayne.auth, {
      name: "Reschedules a booked appointment",
      scenario:
        "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
      expectedBehaviors: ["offers at least one afternoon slot next week"],
    });

    expect(created.personas.map((named) => named.id)).toEqual([
      await starterOf(wayne.projectId),
    ]);
    expect(created.personas[0]?.deletedAt).toBeNull();
  });
});

describe("provisioning that cannot finish", () => {
  it("leaves no starter behind either", async () => {
    const before = await countOf("select count(*) as count from persona");

    // A person already belongs to an organization, so the membership at the end
    // of the transaction is refused, and the starter written before it goes
    // down with the organization and the project.
    await expect(
      provisionOrganization({
        ownerUserId: acme.userId,
        organizationName: "Second",
        organizationSlug: "second",
        projectName: "Default",
        projectSlug: "default",
      }),
    ).rejects.toThrow();

    expect(await countOf("select count(*) as count from persona")).toBe(
      before,
    );
    expect(
      await countOf(
        `select count(*) as count from persona_version v
          where not exists (select 1 from persona h where h.id = v.persona_id)`,
      ),
    ).toBe("0");
  });
});
