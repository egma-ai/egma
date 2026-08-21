import { isId, newId } from "@egma/ids";
import { and, desc, eq, isNull, lt } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { test, testSuite } from "../schema/tests.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";
import { lockRepositoryProject } from "./repository-lock.ts";
import { within } from "./within.ts";

/**
 * The suite module hides tenancy, lifecycle, and atomic contained-test deletion
 * behind one small interface. A suite is an unversioned container. Its stable
 * identity never changes, and test membership is guarded by the database.
 */

export type NewTestSuite = {
  readonly name: string;
};

export type RenameTestSuite = {
  readonly name: string;
};

export type TestSuite = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type TestSuitePage = {
  readonly items: readonly TestSuite[];
  readonly nextCursor: string | undefined;
};

/** One suite declared by a complete repository change set. */
export type RepositorySuite = {
  readonly id: string;
  readonly name: string;
};

const COLUMNS = {
  id: testSuite.id,
  projectId: testSuite.projectId,
  name: testSuite.name,
  deletedAt: testSuite.deletedAt,
  createdAt: testSuite.createdAt,
  updatedAt: testSuite.updatedAt,
} as const;

function validName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new UnprocessableInputError(
      "a test suite needs a name with at least one non-whitespace character",
    );
  }
}

function projectOf(auth: AuthContext): string {
  if (auth.projectId === undefined) {
    throw new Error(
      "a test suite belongs to one project, and this credential is acting in none",
    );
  }
  return auth.projectId;
}

const active = isNull(testSuite.deletedAt);

function suiteInProject(auth: AuthContext, id: string) {
  return within(
    auth,
    testSuite,
    and(eq(testSuite.id, id), eq(testSuite.projectId, projectOf(auth)), active),
  );
}

async function readSuiteOn(
  on: Queryable,
  auth: AuthContext,
  id: string,
): Promise<TestSuite | undefined> {
  const [row] = await on
    .select(COLUMNS)
    .from(testSuite)
    .where(suiteInProject(auth, id))
    .limit(1);
  return row;
}

export async function createTestSuite(
  auth: AuthContext,
  input: NewTestSuite,
): Promise<TestSuite> {
  authorize(auth, "author_definitions", here(auth));
  validName(input.name);
  const id = newId("ste");
  const projectId = projectOf(auth);
  const [created] = await db().transaction(async (tx) => {
    await lockRepositoryProject(tx, projectId);
    return tx.insert(testSuite)
      .values({
        id,
        organizationId: auth.organizationId,
        projectId,
        name: input.name.trim(),
        createdBy: auth.userId,
      })
      .returning(COLUMNS);
  });
  if (created === undefined) throw new Error(`test suite ${id} was not written`);
  return created;
}

export async function getTestSuite(
  auth: AuthContext,
  id: string,
): Promise<TestSuite | undefined> {
  authorize(auth, "read", here(auth));
  return readSuiteOn(db(), auth, id);
}

export async function listTestSuites(
  auth: AuthContext,
  page?: PageRequest,
): Promise<TestSuitePage> {
  authorize(auth, "read", here(auth));
  const { limit, cursor } = pageWindow(page, {
    singular: "test suite",
    plural: "test suites",
    prefix: "ste",
  });
  const rows = await db()
    .select(COLUMNS)
    .from(testSuite)
    .where(
      within(
        auth,
        testSuite,
        and(
          eq(testSuite.projectId, projectOf(auth)),
          active,
          cursor === undefined ? undefined : lt(testSuite.id, cursor),
        ),
      ),
    )
    .orderBy(desc(testSuite.id))
    .limit(limit + 1);
  const { items, nextCursor } = pageOf(rows, limit);
  return { items, nextCursor };
}

export async function renameTestSuite(
  auth: AuthContext,
  id: string,
  changes: RenameTestSuite,
): Promise<TestSuite | undefined> {
  authorize(auth, "author_definitions", here(auth));
  validName(changes.name);
  return db().transaction(async (tx) => {
    await lockRepositoryProject(tx, projectOf(auth));
    const [locked] = await tx
      .select({ id: testSuite.id, name: testSuite.name })
      .from(testSuite)
      .where(suiteInProject(auth, id))
      .limit(1)
      .for("update", { of: testSuite });
    if (locked === undefined) return undefined;
    const name = changes.name.trim();
    if (locked.name !== name) {
      await tx
        .update(testSuite)
        .set({ name, updatedAt: new Date() })
        .where(eq(testSuite.id, locked.id));
    }
    return readSuiteOn(tx, auth, locked.id);
  });
}

export async function deleteTestSuite(
  auth: AuthContext,
  id: string,
): Promise<TestSuite | undefined> {
  authorize(auth, "author_definitions", here(auth));
  return db().transaction(async (tx) => {
    await lockRepositoryProject(tx, projectOf(auth));
    const [locked] = await tx
      .select(COLUMNS)
      .from(testSuite)
      .where(suiteInProject(auth, id))
      .limit(1)
      .for("update", { of: testSuite });
    if (locked === undefined) return undefined;

    const deletedAt = new Date();
    await tx
      .update(test)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(and(eq(test.suiteId, locked.id), isNull(test.deletedAt)));
    const [deleted] = await tx
      .update(testSuite)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(eq(testSuite.id, locked.id))
      .returning(COLUMNS);
    return deleted;
  });
}

/**
 * Reconcile the complete active suite set inside the repository transaction.
 * Missing server suites are refused, never inferred as deletions.
 */
export async function applyRepositorySuitesOn(
  on: Queryable,
  auth: AuthContext,
  wanted: readonly RepositorySuite[],
): Promise<readonly TestSuite[]> {
  const projectId = projectOf(auth);
  const ids = new Set<string>();
  for (const suite of wanted) {
    if (!isId("ste", suite.id)) {
      throw new UnprocessableInputError(`"${suite.id}" is not a test suite id`);
    }
    if (ids.has(suite.id)) {
      throw new UnprocessableInputError(
        `the repository names test suite ${suite.id} more than once`,
      );
    }
    ids.add(suite.id);
    validName(suite.name);
  }

  const existing = await on
    .select(COLUMNS)
    .from(testSuite)
    .where(
      within(
        auth,
        testSuite,
        eq(testSuite.projectId, projectId),
      ),
    )
    .for("update", { of: testSuite });
  const byId = new Map(existing.map((suite) => [suite.id, suite] as const));
  const unseen = existing.find(
    (suite) => suite.deletedAt === null && !ids.has(suite.id),
  );
  if (unseen !== undefined) {
    throw new UnprocessableInputError(
      `the repository does not include active test suite ${unseen.id}; pull before pushing so no server suite is deleted by inference`,
    );
  }

  const applied: TestSuite[] = [];
  for (const declared of wanted) {
    const name = declared.name.trim();
    const found = byId.get(declared.id);
    if (found !== undefined && found.deletedAt !== null) {
      throw new UnprocessableInputError(
        `test suite ${declared.id} was deleted and cannot be recreated with the same identity`,
      );
    }
    if (found === undefined) {
      throw new UnprocessableInputError(
        `there is no active test suite ${declared.id} in this project; create the suite first, then pull its stable identity before pushing`,
      );
    }
    if (found.name === name) {
      applied.push(found);
      continue;
    }
    const [renamed] = await on
      .update(testSuite)
      .set({ name, updatedAt: new Date() })
      .where(eq(testSuite.id, found.id))
      .returning(COLUMNS);
    if (renamed === undefined) {
      throw new Error(`test suite ${found.id} was not renamed`);
    }
    applied.push(renamed);
  }
  return applied;
}
