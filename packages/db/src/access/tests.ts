import { isId, newId } from "@egma/ids";
import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { digitalHuman } from "../schema/digital-humans.ts";
import { project } from "../schema/tenancy.ts";
import { test, testVersion, testVersionDigitalHuman } from "../schema/tests.ts";
import type { AuthContext } from "./context.ts";
import { ProjectOutsideOrganizationError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { theProject, within } from "./within.ts";

/**
 * Reading and writing tests — what they are is the schema file's story
 * (`schema/tests.ts`); this file is how they are reached.
 *
 * Project scoping works as the digital-human factory's does, verb for verb. A
 * context acting in a project writes and reads there; a context acting in
 * none — an organization-scoped credential — reads the whole customer and
 * creates nothing, because a test belongs to a project and a credential for
 * the whole customer is acting in none. What already exists it may edit: the
 * row names its own project, so that write has somewhere to land.
 *
 * **A test is falsifiable from birth.** Its expected behaviors are required
 * non-empty at write time, and judging a simulation against them is part of
 * what running a test means, so there is no window in which a stored test
 * could pass without ever having been able to fail.
 */

/**
 * What a version of a test says. The scenario is the situation as free text —
 * what the digital human wants, and the circumstances. The expected behaviors
 * are statements about what should happen, in the order they were authored,
 * and at least one of them always exists.
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
   * takes the project's default digital human, so authoring a first test never
   * waits on authoring a digital human.
   */
  readonly digitalHumanIds?: readonly string[] | undefined;
};

/**
 * A digital human as a test names them: by identity, with their current name,
 * and saying plainly whether they have since been deleted. A read that hid
 * that would show a test whose simulations cannot all run and give no sign.
 */
export type TestDigitalHuman = {
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
  readonly digitalHumans: readonly TestDigitalHuman[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. Name and description are identity and version
 * nothing; the scenario, the expected behaviors and the digital humans are what
 * the test checks, and version on any change. Absent means keep.
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
   * project's default digital human. The two verbs are deliberately not allowed
   * to disagree about one input — a developer who learns `[]` on a create
   * cannot be ambushed by a different meaning on an edit. It could not mean
   * "name nobody" in any case: a test with no digital humans produces no
   * simulations, so it could never run. Leaving the set alone is what leaving
   * the field out does.
   */
  readonly digitalHumanIds?: readonly string[];
};

/** One version, frozen: the test exactly as some simulation executed it. */
export type TestVersion = {
  readonly id: string;
  readonly testId: string;
  readonly version: number;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  /** By identity, in the order they were authored. */
  readonly digitalHumans: readonly TestDigitalHuman[];
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
 * Everything about the named ids that is answerable without the database:
 * every one is an identifier of a digital human, and each one is named once.
 * Naming the same digital human twice would ask for the same simulation
 * twice, which is a run's business and not a test's, so it is refused here
 * rather than left to a constraint.
 */
function validateDigitalHumanIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isId("dh", id)) {
      throw new Error(`"${id}" is not a digital-human id`);
    }
    if (seen.has(id)) {
      throw new Error(`digital human ${id} is named twice on one test`);
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
 * and the digital humans are named in the order they were authored, so a
 * version that reorders either says something the version before it did not.
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
 * added to the content refuses to build until it is also told how to compare.
 * A hand-maintained comparator that missed a field would call two different
 * versions identical, and an edit would vanish without a version — the one loss
 * the whole versioning exists to rule out.
 *
 * The jsonb content is all this table covers. The digital humans a version
 * names are content too and version on exactly the same terms, but they are
 * rows rather than a field, so they are compared beside this rather than
 * inside it — `editTest` asks both questions and mints on either answer.
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
 * Whether the ids a write names are digital humans this project can use:
 * each one exists, is alive, and is this project's.
 *
 * One read for the whole set, and then one refusal per id that did not come
 * back whole. A digital human of another customer or another project is not
 * found and is refused in the same words as one that never existed, because
 * confirming that somebody else's row exists is itself a leak.
 */
async function validateNamedDigitalHumans(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  ids: readonly string[],
): Promise<void> {
  const found = new Map(
    (
      await on
        .select({ id: digitalHuman.id, deletedAt: digitalHuman.deletedAt })
        .from(digitalHuman)
        .where(
          within(
            auth,
            digitalHuman,
            and(
              inArray(digitalHuman.id, [...ids]),
              eq(digitalHuman.projectId, projectId),
            ),
          ),
        )
    ).map((row) => [row.id, row.deletedAt] as const),
  );

  for (const id of ids) {
    if (!found.has(id)) {
      throw new Error(`there is no digital human ${id} in this project`);
    }
    if (found.get(id) !== null) {
      throw new Error(
        `digital human ${id} is deleted, and a test cannot name a deleted digital human`,
      );
    }
  }
}

/**
 * The one digital human the project points at, for a write that named none.
 *
 * The pointer can be wrong in two different ways and they need different
 * words, because they need different fixes. A pointer at a digital human who
 * has since been deleted wants a living one; a pointer at nothing, or at
 * another project's digital human — which the column's plain foreign key
 * allows — wants pointing somewhere real. Reading the row without the
 * deleted filter is what lets the two be told apart, instead of reporting
 * every reachable failure as a deletion.
 *
 * Every way this fails says what to do about it and writes nothing: a test
 * whose digital human egma picked for itself would be a test nobody authored.
 */
async function projectDefaultDigitalHuman(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
): Promise<string> {
  const [row] = await on
    .select({ defaultDigitalHumanId: project.defaultDigitalHumanId })
    .from(project)
    .where(theProject(auth, projectId))
    .limit(1);

  const id = row?.defaultDigitalHumanId ?? null;
  if (id === null) {
    throw new Error(
      "this test names no digital human and the project has no default digital human; name one on the test, or set the project's default",
    );
  }

  const [pointed] = await on
    .select({ id: digitalHuman.id, deletedAt: digitalHuman.deletedAt })
    .from(digitalHuman)
    .where(
      within(
        auth,
        digitalHuman,
        and(
          eq(digitalHuman.id, id),
          eq(digitalHuman.projectId, projectId),
        ),
      ),
    )
    .limit(1);

  if (pointed === undefined) {
    throw new Error(
      `this test names no digital human and the project's default points at ${id}, and there is no digital human ${id} in this project; name one on the test, or point the project's default at a living digital human of this project`,
    );
  }
  if (pointed.deletedAt !== null) {
    throw new Error(
      `this test names no digital human and the project's default digital human ${id} is deleted; name one on the test, or point the project's default at a living digital human`,
    );
  }

  return id;
}

/**
 * Which digital humans a write should name, from what it was handed.
 *
 * One function for both write verbs, so the two can never come to disagree
 * about the same input. Naming none — an empty list — takes the project's
 * default on a create and on an edit alike; a developer who learns the meaning
 * once has learned it everywhere. Naming some checks them, and the ids come
 * back in the order they were given, because that order is content.
 *
 * Every set a version is about to name comes through here, including the one an
 * edit carried forward from the version before it. A version names digital
 * humans that exist, are alive, and are this project's — a rule about the row
 * being written, not about who typed the ids.
 *
 * Called inside the write's transaction, so the set that was checked is the
 * set the join rows name.
 */
async function digitalHumanIdsFor(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  named: readonly string[],
): Promise<readonly string[]> {
  if (named.length === 0) {
    return [await projectDefaultDigitalHuman(on, auth, projectId)];
  }
  await validateNamedDigitalHumans(on, auth, projectId, named);
  return named;
}

/** The join rows of one version, in the order the ids were authored. */
async function nameDigitalHumansOn(
  on: Queryable,
  versionId: string,
  digitalHumanIds: readonly string[],
): Promise<void> {
  await on.insert(testVersionDigitalHuman).values(
    digitalHumanIds.map((digitalHumanId, index) => ({
      testVersionId: versionId,
      digitalHumanId,
      position: index + 1,
    })),
  );
}

/**
 * The test, its first version and the version's digital humans, or none of
 * them. The identity row goes in first naming a version that does not exist
 * yet — its pointer's constraint is deferred, so Postgres checks it at commit
 * — and anything that fails on the way out takes the whole write with it.
 *
 * The digital humans are resolved inside the transaction, so the set that was
 * checked is the set the join rows name.
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

  // Everything answerable without the database is answered first; only an
  // input worth writing costs the reads below.
  const name = validName(input.name);
  const content = validContent(input);
  const named = input.digitalHumanIds ?? [];
  validateDigitalHumanIds(named);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const id = newId("tst");
  const versionId = newId("tstv");

  const written = await db().transaction(async (tx) => {
    const digitalHumanIds = await digitalHumanIdsFor(tx, auth, projectId, named);

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

    await nameDigitalHumansOn(tx, versionId, digitalHumanIds);

    // Read back inside the transaction, so what the create answers with is
    // what the transaction wrote and checked, rather than whatever the table
    // holds by the time it has committed.
    return { ...identity, digitalHumans: await digitalHumansOf(tx, versionId) };
  });

  return { ...written, version: 1, versionId, ...content };
}

/**
 * The version's digital humans, in the order they were authored.
 *
 * The `where` starts from a bare `eq` rather than `within`: every caller hands
 * it a version id that has already come off a tenancy-checked row, so the
 * predicate cannot reach further than that check already did.
 */
async function digitalHumansOf(
  on: Queryable,
  versionId: string,
): Promise<readonly TestDigitalHuman[]> {
  return on
    .select({
      id: digitalHuman.id,
      name: digitalHuman.name,
      deletedAt: digitalHuman.deletedAt,
    })
    .from(testVersionDigitalHuman)
    .innerJoin(
      digitalHuman,
      eq(testVersionDigitalHuman.digitalHumanId, digitalHuman.id),
    )
    .where(eq(testVersionDigitalHuman.testVersionId, versionId))
    .orderBy(asc(testVersionDigitalHuman.position));
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
 * scenario, its expected behaviors, and the digital humans who call about it
 * in the order they were authored — deleted ones included, and marked.
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
    digitalHumans: await digitalHumansOf(db(), row.versionId),
  };
}

/**
 * One door for every change, so no caller needs the version rules to pick a
 * function — the rules live here. Name and description write in place and
 * version nothing. The scenario, the expected behaviors and the digital humans
 * are what the test checks: any of them differing from the current version
 * inserts the next version, with its own join rows, and moves the pointer — all
 * in one transaction with the identity row locked, so two concurrent edits
 * number one after the other rather than fighting over the same version number.
 * The rows of the version being left behind are never touched, because a run
 * that pinned it must still say what it executed. Content byte-identical to the
 * current version is not an edit at all: nothing is written, not even
 * `updated_at`, and the current version comes back.
 *
 * What an edit leaves out, it keeps. A field absent from the changes is read
 * off the current version and carried into the next one, which is what lets an
 * edit to the scenario alone stay an edit to the scenario alone. Carried
 * forward is not a way past validation, though: the digital humans a version is
 * about to name are checked whether the edit typed them or inherited them, so
 * no version can come to name one that is missing, deleted, or another
 * project's.
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
  const named = changes.digitalHumanIds;
  if (named !== undefined) validateDigitalHumanIds(named);

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
    const storedDigitalHumans = await digitalHumansOf(tx, currentVersion.id);
    const storedIds = storedDigitalHumans.map((human) => human.id);

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
    const digitalHumanIds = await digitalHumanIdsFor(
      tx,
      auth,
      current.projectId,
      named ?? storedIds,
    );

    const mintsVersion =
      !sameContent(storedContent, content) ||
      !sameOrderedList(storedIds, digitalHumanIds);
    const identityChanged =
      changes.name !== undefined || changes.description !== undefined;

    if (!mintsVersion && !identityChanged) {
      return {
        ...current,
        version: currentVersion.version,
        versionId: currentVersion.id,
        ...storedContent,
        digitalHumans: storedDigitalHumans,
      };
    }

    let versionId = currentVersion.id;
    let version = currentVersion.version;
    let digitalHumans = storedDigitalHumans;
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
      await nameDigitalHumansOn(tx, versionId, digitalHumanIds);
      // Read back inside the transaction, for the reason create reads back
      // inside it: the answer is what this transaction wrote and checked.
      digitalHumans = await digitalHumansOf(tx, versionId);
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
    return { ...updated, version, versionId, ...content, digitalHumans };
  });
}

/**
 * One frozen version, by its own `tstv_` id — the read a run uses to stay
 * interpretable after the test moves on: the scenario and expected behaviors as
 * they were, and the digital humans the version named, by identity and in the
 * order they were authored. Which version of each of them a simulation met is
 * the run's to pin, never this row's.
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
    digitalHumans: await digitalHumansOf(db(), row.id),
  };
}
