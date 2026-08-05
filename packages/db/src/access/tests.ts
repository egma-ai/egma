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
 * the whole customer is acting in none.
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
 * Whether the ids a create names are digital humans this project can use:
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
 * The one digital human the project points at, for a create that named none.
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
    let digitalHumanIds: readonly string[];
    if (named.length === 0) {
      digitalHumanIds = [await projectDefaultDigitalHuman(tx, auth, projectId)];
    } else {
      await validateNamedDigitalHumans(tx, auth, projectId, named);
      digitalHumanIds = named;
    }

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

    await tx.insert(testVersionDigitalHuman).values(
      digitalHumanIds.map((digitalHumanId, index) => ({
        testVersionId: versionId,
        digitalHumanId,
        position: index + 1,
      })),
    );

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
