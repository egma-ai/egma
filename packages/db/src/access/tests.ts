import { isId, newId } from "@egma/ids";
import { and, asc, desc, eq, inArray, isNull, lt, type SQL } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { persona } from "../schema/personas.ts";
import { project } from "../schema/tenancy.ts";
import { test, testVersion, testVersionPersona } from "../schema/tests.ts";
import type { AuthContext } from "./context.ts";
import {
  ProjectOutsideOrganizationError,
  type TestNamingPersona,
} from "./errors.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { theProject, within } from "./within.ts";

/**
 * Reading and writing tests — what they are is the schema file's story
 * (`schema/tests.ts`); this file is how they are reached.
 *
 * Project scoping works as the persona factory's does, verb for verb. A context
 * acting in a project writes and reads there; a context acting in none — an
 * organization-scoped credential — reads the whole customer and creates
 * nothing, because a test belongs to a project and a credential for the whole
 * customer is acting in none. What already exists it may edit: the row names
 * its own project, so that write has somewhere to land.
 *
 * **A test is falsifiable from birth.** Its expected behaviors are required
 * non-empty at write time, and judging a simulation against them is part of
 * what running a test means, so there is no window in which a stored test could
 * pass without ever having been able to fail.
 */

/**
 * What a version of a test says. The scenario is the situation as free text —
 * what the persona wants, and the circumstances. The expected behaviors are
 * statements about what should happen, in the order they were authored, and at
 * least one of them always exists.
 *
 * Internal, because the exported API is flat: a caller hands the two fields to
 * `createTest` beside the name, and reads them back off a `Test` the same way.
 * The pairing matters only to the version row that stores them together.
 */
type TestContent = {
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
};

export type NewTest = {
  readonly name: string;
  readonly description?: string | undefined;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  /**
   * Who calls about the scenario. Naming none — absent, or an empty list —
   * takes the project's default persona, so authoring a first test never waits
   * on authoring a persona.
   */
  readonly personaIds?: readonly string[] | undefined;
};

/**
 * A persona as a test names them: by identity, with their current name, and
 * saying plainly whether they have since been deleted. A read that hid that
 * would show a test whose simulations cannot all run and give no sign.
 */
export type TestPersona = {
  readonly id: string;
  readonly name: string;
  /** Set once they are deleted; the test goes on naming them either way. */
  readonly deletedAt: Date | null;
};

export type Test = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  /** The current version's own `tstv_` id — what a run pins. */
  readonly versionId: string;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  /** In the order they were authored. */
  readonly personas: readonly TestPersona[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. Name and description are identity and version
 * nothing; the scenario, the expected behaviors and the personas are what the
 * test checks, and version on any change. Absent means keep.
 */
export type TestChanges = {
  readonly name?: string;
  readonly description?: string | null;
  readonly scenario?: string;
  readonly expectedBehaviors?: readonly string[];
  /**
   * Who calls about the scenario, as the next version should name them.
   *
   * An empty list means here exactly what it means on a create: take the
   * project's default persona. The two verbs are deliberately not allowed to
   * disagree about one input — a developer who learns `[]` on a create cannot
   * be ambushed by a different meaning on an edit. It could not mean "name
   * nobody" in any case: a test with no personas produces no simulations, so it
   * could never run. Leaving the set alone is what leaving the field out does.
   */
  readonly personaIds?: readonly string[];
};

/** One version, frozen: the test exactly as some simulation executed it. */
export type TestVersion = {
  readonly id: string;
  readonly testId: string;
  readonly version: number;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  /** By identity, in the order they were authored. */
  readonly personas: readonly TestPersona[];
  readonly createdAt: Date;
};

const notDeleted: SQL = isNull(test.deletedAt);

/** An answer's columns, and no more — the tenant-free view. */
const COLUMNS = {
  id: test.id,
  projectId: test.projectId,
  name: test.name,
  description: test.description,
  createdAt: test.createdAt,
  updatedAt: test.updatedAt,
} as const;

/**
 * The name as it will be stored: trimmed, so a test somebody has to recognise
 * in a list is not named by invisible characters.
 */
function validName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("a test needs a name");
  return trimmed;
}

/**
 * The scenario and the behaviors, as they will be stored.
 *
 * An empty behaviors list is refused rather than accepted, because a test with
 * nothing to check is a test that can never be red — and a suite of tests that
 * could never be red is the false confidence this product exists to kill.
 */
function validContent(input: {
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
}): TestContent {
  const scenario = input.scenario.trim();
  if (scenario === "") {
    throw new Error("a test needs a scenario: the situation the agent is put in");
  }

  if (input.expectedBehaviors.length === 0) {
    throw new Error(
      "a test needs at least one expected behavior, because a test that cannot fail is not a test",
    );
  }
  const expectedBehaviors = input.expectedBehaviors.map((behavior) => {
    const trimmed = behavior.trim();
    if (trimmed === "") {
      throw new Error("an expected behavior needs to say something");
    }
    return trimmed;
  });

  return { scenario, expectedBehaviors };
}

/**
 * Everything about the named ids that is answerable without the database: every
 * one is an identifier of a persona, and each one is named once. Naming the
 * same persona twice would ask for the same simulation twice, which is a run's
 * business and not a test's, so it is refused here rather than left to a
 * constraint.
 */
function validatePersonaIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isId("prs", id)) {
      throw new Error(`"${id}" is not a persona id`);
    }
    if (seen.has(id)) {
      throw new Error(`persona ${id} is named twice on one test`);
    }
    seen.add(id);
  }
}

/**
 * The shape guard on every read. Stored jsonb comes back `unknown`, and a row
 * somebody hand-edited must fail here, loudly and naming itself, rather than
 * leak into a caller as a `TestContent` that isn't one. Shape only,
 * deliberately: an old version must stay readable exactly as it was written.
 */
function contentFromRow(value: unknown, versionId: string): TestContent {
  const malformed = () =>
    new Error(
      `version ${versionId} holds content in a shape egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || value === null) throw malformed();
  const { scenario, expectedBehaviors } = value as Record<string, unknown>;
  if (typeof scenario !== "string" || scenario.trim() === "") throw malformed();
  if (!Array.isArray(expectedBehaviors) || expectedBehaviors.length === 0) {
    throw malformed();
  }
  for (const behavior of expectedBehaviors) {
    if (typeof behavior !== "string" || behavior.trim() === "") throw malformed();
  }

  return { scenario, expectedBehaviors: expectedBehaviors as string[] };
}

/**
 * Two ordered lists of strings, compared as written. Order is content in both
 * places this is asked: the expected behaviors are a list a reader goes down,
 * and the personas are named in the order they were authored, so a version that
 * reorders either says something the version before it did not.
 */
function sameOrderedList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * Byte-identical or not, decided field by field — the same answer canonical
 * serialization would give, without trusting any serializer to order keys the
 * way jsonb re-ordered them.
 *
 * One comparator per field, in a table the compiler holds exhaustive: a field
 * added to the content refuses to build until it is also told how to compare. A
 * hand-maintained comparator that missed a field would call two different
 * versions identical, and an edit would vanish without a version — the one loss
 * the whole versioning exists to rule out.
 *
 * The jsonb content is all this table covers. The personas a version names are
 * content too and version on exactly the same terms, but they are rows rather
 * than a field, so they are compared beside this rather than inside it —
 * `editTest` asks both questions and mints on either answer.
 */
const sameContentField: {
  readonly [K in keyof TestContent]: (a: TestContent, b: TestContent) => boolean;
} = {
  scenario: (a, b) => a.scenario === b.scenario,
  expectedBehaviors: (a, b) =>
    sameOrderedList(a.expectedBehaviors, b.expectedBehaviors),
};

function sameContent(a: TestContent, b: TestContent): boolean {
  return Object.values(sameContentField).every((same) => same(a, b));
}

/** Acting in a project narrows to it; acting in none reaches the customer. */
function inActingProject(auth: AuthContext): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(test.projectId, auth.projectId);
}

/** The named test, alive, within the caller's tenancy and scope. */
function theTest(auth: AuthContext, id: string): SQL {
  return within(auth, test, and(eq(test.id, id), notDeleted, inActingProject(auth)));
}

/**
 * Whether the ids a write names are personas this project can use: each one
 * exists, is alive, and is this project's.
 *
 * One read for the whole set, and then one refusal per id that did not come
 * back whole. A persona of another customer or another project is not found and
 * is refused in the same words as one that never existed, because confirming
 * that somebody else's row exists is itself a leak.
 *
 * **The read takes a shared lock on every row it finds, and this write's
 * transaction holds it until it commits.** Deleting a persona takes an
 * exclusive lock on the same row before it counts the tests naming them, and
 * the two lock modes conflict, so a delete and a write naming the same persona
 * cannot walk past each other: whichever reaches the row first makes the other
 * wait and then see how it ended. If this write got there first, the delete
 * counts the rows it wrote and refuses. If the delete got there first, this
 * read resumes on the row it left behind and the deleted marker below refuses
 * this write — which is why the marker is selected and judged here rather than
 * filtered out in the `where`, where a re-read would simply find nothing and
 * say the persona never existed. Without the lock both could pass their own
 * check and a live test would end up naming a deleted persona, which is the one
 * state this rule exists to make impossible.
 */
async function validateNamedPersonas(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  ids: readonly string[],
): Promise<void> {
  const found = new Map(
    (
      await on
        .select({ id: persona.id, deletedAt: persona.deletedAt })
        .from(persona)
        .where(
          within(
            auth,
            persona,
            and(
              inArray(persona.id, [...ids]),
              eq(persona.projectId, projectId),
            ),
          ),
        )
        .for("share")
    ).map((row) => [row.id, row.deletedAt] as const),
  );

  for (const id of ids) {
    if (!found.has(id)) {
      throw new Error(`there is no persona ${id} in this project`);
    }
    if (found.get(id) !== null) {
      throw new Error(
        `persona ${id} is deleted, and a test cannot name a deleted persona`,
      );
    }
  }
}

/**
 * The one persona the project points at, for a write that named none.
 *
 * The pointer can be wrong in two different ways and they need different words,
 * because they need different fixes. A pointer at a persona who has since been
 * deleted wants a living one; a pointer at nothing, or at another project's
 * persona — which the column's plain foreign key allows — wants pointing
 * somewhere real. Reading the row without the deleted filter is what lets the
 * two be told apart, instead of reporting every reachable failure as a
 * deletion.
 *
 * Every way this fails says what to do about it and writes nothing: a test
 * whose persona egma picked for itself would be a test nobody authored.
 */
async function projectDefaultPersona(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
): Promise<string> {
  const [row] = await on
    .select({ defaultPersonaId: project.defaultPersonaId })
    .from(project)
    .where(theProject(auth, projectId))
    .limit(1);

  const id = row?.defaultPersonaId ?? null;
  if (id === null) {
    throw new Error(
      "this test names no persona and the project has no default persona; name one on the test, or set the project's default",
    );
  }

  // The shared lock a named persona is read under, for the same reason and on
  // the same terms: the pointer resolves to a persona this write is about to
  // name, so a delete of that row must either land before this read and refuse
  // the write, or wait behind it and be refused itself. A default resolved
  // without the lock would be the one way past the rule.
  const [pointed] = await on
    .select({ id: persona.id, deletedAt: persona.deletedAt })
    .from(persona)
    .where(
      within(
        auth,
        persona,
        and(
          eq(persona.id, id),
          eq(persona.projectId, projectId),
        ),
      ),
    )
    .limit(1)
    .for("share");

  if (pointed === undefined) {
    throw new Error(
      `this test names no persona and the project's default points at ${id}, and there is no persona ${id} in this project; name one on the test, or point the project's default at a living persona of this project`,
    );
  }
  if (pointed.deletedAt !== null) {
    throw new Error(
      `this test names no persona and the project's default persona ${id} is deleted; name one on the test, or point the project's default at a living persona`,
    );
  }

  return id;
}

/**
 * Which personas a write should name, from what it was handed.
 *
 * One function for both write verbs, so the two can never come to disagree
 * about the same input. Naming none — an empty list — takes the project's
 * default on a create and on an edit alike; a developer who learns the meaning
 * once has learned it everywhere. Naming some checks them, and the ids come
 * back in the order they were given, because that order is content.
 *
 * Every set a version is about to name comes through here, including the one an
 * edit carried forward from the version before it. A version names personas
 * that exist, are alive, and are this project's — a rule about the row being
 * written, not about who typed the ids.
 *
 * Called inside the write's transaction, so the set that was checked is the set
 * the join rows name.
 */
async function personaIdsFor(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  named: readonly string[],
): Promise<readonly string[]> {
  if (named.length === 0) {
    return [await projectDefaultPersona(on, auth, projectId)];
  }
  await validateNamedPersonas(on, auth, projectId, named);
  return named;
}

/** The join rows of one version, in the order the ids were authored. */
async function namePersonasOn(
  on: Queryable,
  versionId: string,
  personaIds: readonly string[],
): Promise<void> {
  await on.insert(testVersionPersona).values(
    personaIds.map((personaId, index) => ({
      testVersionId: versionId,
      personaId,
      position: index + 1,
    })),
  );
}

/**
 * The test, its first version and the version's personas, or none of them. The
 * identity row goes in first naming a version that does not exist yet — its
 * pointer's constraint is deferred, so Postgres checks it at commit — and
 * anything that fails on the way out takes the whole write with it.
 *
 * The personas are resolved inside the transaction, so the set that was checked
 * is the set the join rows name.
 */
export async function createTest(
  auth: AuthContext,
  input: NewTest,
): Promise<Test> {
  authorize(auth, "author_definitions", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a test belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  // Everything answerable without the database is answered first; only an input
  // worth writing costs the reads below.
  const name = validName(input.name);
  const content = validContent(input);
  const named = input.personaIds ?? [];
  validatePersonaIds(named);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const id = newId("tst");
  const versionId = newId("tstv");

  const written = await db().transaction(async (tx) => {
    const personaIds = await personaIdsFor(tx, auth, projectId, named);

    const [identity] = await tx
      .insert(test)
      .values({
        id,
        organizationId: auth.organizationId,
        projectId,
        name,
        description: input.description ?? null,
        currentVersionId: versionId,
        createdBy: auth.userId,
      })
      .returning(COLUMNS);

    if (identity === undefined) throw new Error("the test was not written");

    await tx.insert(testVersion).values({
      id: versionId,
      testId: id,
      version: 1,
      content,
      createdBy: auth.userId,
    });

    await namePersonasOn(tx, versionId, personaIds);

    // Read back inside the transaction, so what the create answers with is what
    // the transaction wrote and checked, rather than whatever the table holds
    // by the time it has committed.
    return { ...identity, personas: await personasOf(tx, versionId) };
  });

  return { ...written, version: 1, versionId, ...content };
}

/**
 * The personas of several versions at once, keyed by version and each list in
 * the order it was authored — one read for a whole page of tests rather than
 * one read per row.
 *
 * The `where` starts from a bare `inArray` rather than `within`: every caller
 * hands it version ids that have already come off tenancy-checked rows, so the
 * predicate cannot reach further than that check already did.
 */
async function personasOfVersions(
  on: Queryable,
  versionIds: readonly string[],
): Promise<Map<string, TestPersona[]>> {
  const byVersion = new Map<string, TestPersona[]>();
  if (versionIds.length === 0) return byVersion;

  const rows = await on
    .select({
      versionId: testVersionPersona.testVersionId,
      id: persona.id,
      name: persona.name,
      deletedAt: persona.deletedAt,
    })
    .from(testVersionPersona)
    .innerJoin(
      persona,
      eq(testVersionPersona.personaId, persona.id),
    )
    .where(inArray(testVersionPersona.testVersionId, [...versionIds]))
    .orderBy(
      asc(testVersionPersona.testVersionId),
      asc(testVersionPersona.position),
    );

  for (const { versionId, ...named } of rows) {
    const already = byVersion.get(versionId);
    if (already === undefined) byVersion.set(versionId, [named]);
    else already.push(named);
  }
  return byVersion;
}

/** The one version's personas, in the order they were authored. */
async function personasOf(
  on: Queryable,
  versionId: string,
): Promise<readonly TestPersona[]> {
  return (await personasOfVersions(on, [versionId])).get(versionId) ?? [];
}

/**
 * The identity row joined to its current version — the shape every read of a
 * whole test answers with, written once so two readers can never drift.
 */
function selectWithCurrentVersion() {
  return db()
    .select({
      ...COLUMNS,
      version: testVersion.version,
      versionId: testVersion.id,
      content: testVersion.content,
    })
    .from(test)
    .innerJoin(testVersion, eq(test.currentVersionId, testVersion.id));
}

/**
 * One test with what it currently checks: its name and description, its
 * scenario, its expected behaviors, and the personas who call about it in the
 * order they were authored — deleted ones included, and marked.
 */
export async function getTest(
  auth: AuthContext,
  id: string,
): Promise<Test | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await selectWithCurrentVersion()
    .where(theTest(auth, id))
    .limit(1);

  if (row === undefined) return undefined;

  const { content, ...rest } = row;
  return {
    ...rest,
    ...contentFromRow(content, row.versionId),
    personas: await personasOf(db(), row.versionId),
  };
}

/**
 * One door for every change, so no caller needs the version rules to pick a
 * function — the rules live here. Name and description write in place and
 * version nothing. The scenario, the expected behaviors and the personas are
 * what the test checks: any of them differing from the current version inserts
 * the next version, with its own join rows, and moves the pointer — all in one
 * transaction with the identity row locked, so two concurrent edits number one
 * after the other rather than fighting over the same version number. The rows
 * of the version being left behind are never touched, because a run that pinned
 * it must still say what it executed. Content byte-identical to the current
 * version is not an edit at all: nothing is written, not even
 * `updated_at`, and the current version comes back.
 *
 * What an edit leaves out, it keeps. A field absent from the changes is read
 * off the current version and carried into the next one, which is what lets an
 * edit to the scenario alone stay an edit to the scenario alone. Carried
 * forward is not a way past validation, though: the personas a version is about
 * to name are checked whether the edit typed them or inherited them, so no
 * version can come to name one that is missing, deleted, or another project's.
 *
 * Editing what the caller cannot see returns what reading it would have:
 * `undefined`, with nothing disturbed.
 */
export async function editTest(
  auth: AuthContext,
  id: string,
  changes: TestChanges,
): Promise<Test | undefined> {
  authorize(auth, "author_definitions", here(auth));

  // Everything answerable without the database is answered first, exactly as
  // create answers it, so an edit is refused on the same grounds a create is.
  const name = changes.name === undefined ? undefined : validName(changes.name);
  const named = changes.personaIds;
  if (named !== undefined) validatePersonaIds(named);

  return db().transaction(async (tx) => {
    const [locked] = await tx
      .select({ ...COLUMNS, currentVersionId: test.currentVersionId })
      .from(test)
      .where(theTest(auth, id))
      .limit(1)
      .for("update");

    if (locked === undefined) return undefined;
    const { currentVersionId, ...current } = locked;

    // This select and the update below are the two `where`s in this file that
    // start from a bare `eq` rather than `within`: each names an id that just
    // came off the tenancy-checked row locked above, in this same transaction,
    // so neither predicate can reach further than that check already did.
    const [currentVersion] = await tx
      .select({
        id: testVersion.id,
        version: testVersion.version,
        content: testVersion.content,
      })
      .from(testVersion)
      .where(eq(testVersion.id, currentVersionId))
      .limit(1);
    if (currentVersion === undefined) {
      throw new Error("the test's current version is missing");
    }

    const storedContent = contentFromRow(currentVersion.content, currentVersion.id);
    const storedPersonas = await personasOf(tx, currentVersion.id);
    const storedIds = storedPersonas.map((named) => named.id);

    // Omitted means unchanged: what the edit did not mention is read off the
    // current version, and the whole is then held to what a create is held to.
    // One path, both ways round — a set carried forward is a set this write is
    // about to name, and it is checked like any other.
    //
    // `contentFromRow` hands back what the row holds, untrimmed, because an old
    // version has to stay readable exactly as it was written; `validContent`
    // trims what it is given. Only raw SQL can make the two disagree, and when
    // one has, the next edit mints a version that trims the row and every edit
    // after it agrees.
    const content = validContent({
      scenario: changes.scenario ?? storedContent.scenario,
      expectedBehaviors:
        changes.expectedBehaviors ?? storedContent.expectedBehaviors,
    });
    const personaIds = await personaIdsFor(
      tx,
      auth,
      current.projectId,
      named ?? storedIds,
    );

    const mintsVersion =
      !sameContent(storedContent, content) ||
      !sameOrderedList(storedIds, personaIds);
    const identityChanged =
      changes.name !== undefined || changes.description !== undefined;

    if (!mintsVersion && !identityChanged) {
      return {
        ...current,
        version: currentVersion.version,
        versionId: currentVersion.id,
        ...storedContent,
        personas: storedPersonas,
      };
    }

    let versionId = currentVersion.id;
    let version = currentVersion.version;
    let personas = storedPersonas;
    if (mintsVersion) {
      versionId = newId("tstv");
      version = currentVersion.version + 1;
      await tx.insert(testVersion).values({
        id: versionId,
        testId: current.id,
        version,
        content,
        createdBy: auth.userId,
      });
      await namePersonasOn(tx, versionId, personaIds);
      // Read back inside the transaction, for the reason create reads back
      // inside it: the answer is what this transaction wrote and checked.
      personas = await personasOf(tx, versionId);
    }

    const [updated] = await tx
      .update(test)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(changes.description === undefined
          ? {}
          : { description: changes.description }),
        ...(mintsVersion ? { currentVersionId: versionId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(test.id, current.id))
      .returning(COLUMNS);

    if (updated === undefined) throw new Error("the test was not written");
    return { ...updated, version, versionId, ...content, personas };
  });
}

/**
 * One frozen version, by its own `tstv_` id — the read a run uses to stay
 * interpretable after the test moves on: the scenario and expected behaviors as
 * they were, and the personas the version named, by identity and in the order
 * they were authored. Which version of each of them a simulation met is the
 * run's to pin, never this row's.
 *
 * Deliberately no deleted filter: versions outlive their test's deletion, so a
 * run that pinned one can always say exactly what it executed.
 */
export async function getTestVersion(
  auth: AuthContext,
  versionId: string,
): Promise<TestVersion | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select({
      id: testVersion.id,
      testId: testVersion.testId,
      version: testVersion.version,
      content: testVersion.content,
      createdAt: testVersion.createdAt,
    })
    .from(testVersion)
    .innerJoin(test, eq(testVersion.testId, test.id))
    .where(
      within(
        auth,
        test,
        and(eq(testVersion.id, versionId), inActingProject(auth)),
      ),
    )
    .limit(1);

  if (row === undefined) return undefined;

  const { content, ...rest } = row;
  return {
    ...rest,
    ...contentFromRow(content, row.id),
    personas: await personasOf(db(), row.id),
  };
}

/**
 * One page of the tests the caller can reach — the acting project's, or the
 * whole customer's for a credential acting in none — and where the next page
 * starts.
 *
 * The ids are Crockford base32 of UUIDv7 under `COLLATE "C"`, so ordering by id
 * *is* ordering by mint time and the last id of a page is the whole cursor
 * — no second sort column, no offset to drift when rows arrive mid-scroll.
 * Newest first, because the test somebody is looking for is usually the one
 * they just wrote.
 */
export type TestPage = {
  readonly items: readonly Test[];
  /** Hand back as `cursor` to continue; absent on the last page. */
  readonly nextCursor: string | undefined;
};

export async function listTests(
  auth: AuthContext,
  page?: PageRequest,
): Promise<TestPage> {
  authorize(auth, "read", here(auth));

  const { limit, cursor } = pageWindow(page, {
    singular: "test",
    plural: "tests",
    prefix: "tst",
  });
  const olderThanCursor = cursor === undefined ? undefined : lt(test.id, cursor);

  const rows = await selectWithCurrentVersion()
    .where(
      within(
        auth,
        test,
        and(notDeleted, inActingProject(auth), olderThanCursor),
      ),
    )
    .orderBy(desc(test.id))
    .limit(limit + 1);

  // A page's personas come back in one read, not one per row: a page of two
  // hundred tests is two queries, the same as a page of one.
  const { items: wanted, nextCursor } = pageOf(rows, limit);
  const byVersion = await personasOfVersions(
    db(),
    wanted.map((row) => row.versionId),
  );

  return {
    items: wanted.map(({ content, ...rest }) => ({
      ...rest,
      ...contentFromRow(content, rest.versionId),
      personas: byVersion.get(rest.versionId) ?? [],
    })),
    nextCursor,
  };
}

/**
 * A new test whose version 1 carries the source's current content: the same
 * scenario, the same expected behaviors, the same personas in the same order,
 * under the same name — there is no per-project name uniqueness, so the name
 * copies verbatim exactly as the persona factory copies it.
 *
 * A clone is a create with the retyping saved: fresh `tst_` and `tstv_` ids,
 * version numbering starting over at 1, and no link back — the source's history
 * is the source's, and nothing of it comes along. The source is read through
 * the same seam as `getTest`, so a clone can only be taken of what the caller
 * could have fetched: same customer, same acting project, not deleted.
 *
 * The personas are handed on exactly as the source names them, and
 * `createTest` is the only thing that judges them — one rule about what a
 * version may name, in one place. So a source whose current version names a
 * deleted persona is refused by that same validation, rather than quietly
 * cloned without them or quietly given the project's default; neither silence
 * would be a copy, and a clone that checked something the source does not is
 * worse than no clone. That refusal is out of reach in practice: the persona's
 * own delete is refused while a live test's current version names them, and a
 * test that cannot be fetched cannot be cloned, so no clonable source can name
 * a deleted persona.
 *
 * Authorization is layered on purpose, not by accident of delegation. The
 * leading check refuses a viewer before anything is read, and a credential
 * acting in no project is refused right after it, still before the read — the
 * same stance as create and delete, and it keeps `undefined` meaning invisible
 * rather than refused.
 */
export async function cloneTest(
  auth: AuthContext,
  id: string,
): Promise<Test | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "a clone lands in the acting project, and this credential is for the whole organization and acting in none",
    );
  }

  const source = await getTest(auth, id);
  if (source === undefined) return undefined;

  return createTest(auth, {
    name: source.name,
    description: source.description ?? undefined,
    scenario: source.scenario,
    expectedBehaviors: source.expectedBehaviors,
    personaIds: source.personas.map((named) => named.id),
  });
}

export type DeletedTest = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly deletedAt: Date;
};

/**
 * The soft-delete marker, and only the marker. The test vanishes from lists and
 * fetches at once; the version rows stay exactly where they are, because a run
 * that pinned one must stay interpretable for as long as the run itself is
 * kept. Sweeping orphaned versions is the deletion worker's job, not this
 * function's.
 *
 * Nothing blocks this, ever. A persona's delete is the one that can be refused,
 * because a live test's current version naming them would silently lose one of
 * the people who call about it; a test has no dependant of its own that could
 * lose anything that way. A suite selects tests and a run executes them, and
 * neither is a reason to keep a test somebody has abandoned, because both keep
 * what they need by pinning versions that outlive it.
 *
 * Like create, this refuses a credential acting in no project. An edit lands on
 * a row that already names its own project; a delete decides the test should
 * stop appearing in one, and emptying a project is an act taken from inside it
 * — the persona factory's stance, held here.
 */
export async function deleteTest(
  auth: AuthContext,
  id: string,
): Promise<DeletedTest | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "deleting a test happens inside its project, and this credential is for the whole organization and acting in none",
    );
  }

  const deletedAt = new Date();
  const [row] = await db()
    .update(test)
    .set({ deletedAt, updatedAt: deletedAt })
    .where(theTest(auth, id))
    .returning({
      id: test.id,
      projectId: test.projectId,
      name: test.name,
    });

  if (row === undefined) return undefined;
  return { ...row, deletedAt };
}

/**
 * The live tests whose current version names this persona — the set that
 * refuses the persona's own delete, and the set that refusal names.
 *
 * Current versions of live tests, and nothing else. A historical version names
 * who it named for as long as it is kept, because a run that pinned it has to
 * stay readable, and no delete taken today can change what that run executed; a
 * deleted test has no simulation left to lose. So neither is a reason to keep a
 * persona somebody wants gone, and neither appears here.
 *
 * The walk starts from the join table, where `persona_id` is indexed for
 * exactly this question, and keeps the rows a live test currently points at.
 *
 * No tenancy predicate, deliberately, and this is the one read in the file
 * without one. Whether the delete is refused is a fact about the persona rather
 * than about who is asking, and a refusal that depended on the asker would let
 * one credential delete what another credential's test needs. The persona's own
 * delete has checked its tenancy on that row before asking this, and a version
 * may only ever name a persona of its own project, so every row this can return
 * is a test of that same project.
 *
 * Exported to the module, not from the package: this answers a question the
 * persona factory has to ask before it deletes, and the test tables have one
 * owner, which is this file.
 */
export async function liveTestsNamingPersona(
  on: Queryable,
  personaId: string,
): Promise<readonly TestNamingPersona[]> {
  return on
    .select({ id: test.id, name: test.name })
    .from(testVersionPersona)
    .innerJoin(
      test,
      eq(test.currentVersionId, testVersionPersona.testVersionId),
    )
    .where(
      and(
        eq(testVersionPersona.personaId, personaId),
        notDeleted,
      ),
    )
    .orderBy(asc(test.id));
}
