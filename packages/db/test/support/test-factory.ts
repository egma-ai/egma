import { newId } from "@egma/ids";
import {
  createGrader,
  createPersona,
  type AuthContext,
  type ExpectedBehavior,
  type NewTest,
  type Role,
} from "@egma/db";

import { createConnectedDatabase, type MigratedDatabase } from "./database.ts";
import { seedOrganization, seedUser } from "./tenancy.ts";

/**
 * The world a test-factory test needs before it can write a test: two
 * customers, a sibling project inside the first one to be narrowed past, a
 * persona in each, and the scenario every file authors.
 *
 * It lives here rather than in whichever file needed it first, because every
 * file needs all of it and a second copy is a copy that drifts. The ids are
 * minted when this module loads, and vitest gives each test file its own module
 * registry, so two files running side by side are seeding two databases and
 * never each other's — the same thing that lets each file connect the data
 * access module to a database of its own.
 *
 * Personas arrive through their own factory, which has its own tests: they are
 * an input to these files, not a thing they are checking. Tenancy arrives by
 * raw SQL, for the reason `tenancy.ts` gives.
 */

export const acme = {
  organization: newId("org"),
  project: newId("prj"),
  /** A second project of Acme's, so a read can be narrowed past its sibling. */
  outbound: newId("prj"),
};
export const globex = { organization: newId("org"), project: newId("prj") };

const ada = newId("usr");
const gene = newId("usr");

/** What Acme's starter persona is called, for the reads that show it. */
export const STARTER_PERSONA = "Impatient Rita";

export function actingAsAcme(role: Role = "member"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

export function actingAsGlobex(role: Role = "member"): AuthContext {
  return {
    userId: gene,
    organizationId: globex.organization,
    projectId: globex.project,
    role,
    via: "session",
  };
}

/** The scenario these files author, whole enough to be worth reading back. */
export const rescheduling = {
  name: "Reschedules a booked appointment",
  description: "The bread-and-butter front-desk call",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week. They do not remember the exact time of the existing booking.",
  expectedBehaviors: [
    "verifies who it is speaking to before discussing the booking",
    "offers at least one afternoon slot next week",
    "confirms the new time back before finishing",
  ],
} as const satisfies NewTest;

/**
 * The fixture's behaviors as a read hands them back. A behavior written as a
 * bare string is a P0, so this is the same list said the other way round —
 * which is what every file that authors strings and reads objects asserts.
 */
export function blocking(
  behaviors: readonly string[],
): readonly ExpectedBehavior[] {
  return behaviors.map((behavior) => ({ behavior, priority: "P0" }));
}

/** Somebody plain, because who the persona is is not under test here. */
export const neutralTraits = {
  personality: "Speaks plainly, stays patient, asks one question at a time.",
  language: "en-US",
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 1 },
} as const;

let database: MigratedDatabase;

export async function seedPersona(
  auth: AuthContext,
  name: string,
): Promise<string> {
  const created = await createPersona(auth, { name, traits: neutralTraits });
  return created.id;
}

/**
 * A grader for a test to name. Deterministic and cheap to state, because what
 * the grader judges by is the grader factory's business — here it is only
 * something a test's array can point at.
 */
export async function seedGrader(
  auth: AuthContext,
  name: string,
): Promise<string> {
  const created = await createGrader(auth, {
    name,
    type: "phrase_match",
    config: { banned: [{ text: "I promise" }] },
  });
  return created.id;
}

/** What provisioning does when it seeds a project's starter persona. */
export async function pointProjectAt(
  projectId: string,
  personaId: string | null,
): Promise<void> {
  await database.sql(
    "update project set default_persona_id = $1 where id = $2",
    [personaId, projectId],
  );
}

/**
 * How many rows the tables a write touches hold, for the assertions that a
 * refusal wrote nothing. Counted raw, because absence is the one thing no seam
 * can show.
 */
export async function rowCounts(): Promise<{
  tests: number;
  versions: number;
  named: number;
  namedGraders: number;
  graders: number;
  graderVersions: number;
}> {
  const count = async (table: string): Promise<number> => {
    const { rows } = await database.sql<{ count: string }>(
      `select count(*) as count from ${table}`,
    );
    return Number(rows[0]?.count);
  };
  return {
    tests: await count("test"),
    versions: await count("test_version"),
    named: await count("test_persona"),
    namedGraders: await count("test_grader"),
    graders: await count("grader"),
    graderVersions: await count("grader_version"),
  };
}

export type SeededWorld = {
  /** The raw handle, for the reads and writes that go around the module. */
  readonly database: MigratedDatabase;
  /** Acme's starter persona, and the one its project points at. */
  readonly rita: string;
  /** Globex's, so a cross-project reference has something real to name. */
  readonly grace: string;
};

export async function seedTestFactory(label: string): Promise<SeededWorld> {
  database = await createConnectedDatabase(label);

  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
    { id: acme.outbound, slug: "outbound" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, gene, "gene@globex.example");

  const rita = await seedPersona(actingAsAcme(), STARTER_PERSONA);
  const grace = await seedPersona(actingAsGlobex(), "Careful Grace");
  await pointProjectAt(acme.project, rita);

  return { database, rita, grace };
}
