import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTest,
  deleteGrader,
  deleteTest,
  editTest,
  getGrader,
  getTestVersion,
  GraderNamedByTestsError,
  type Test,
} from "@egma/db";

import {
  openSingleConnection,
  type MigratedDatabase,
  type SingleConnection,
} from "./support/database.ts";
import {
  acme,
  actingAsAcme,
  rescheduling,
  rowCounts,
  seedGrader,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * Deleting a grader while the current version of a live test names it: refused,
 * and the refusal names those tests. What history names, and what a deleted
 * test names, delete fine.
 *
 * It sits in a file of its own for the reason the persona's refusal does — the
 * rule is written into the grader's delete and answered by the test tables, and
 * a reader looking for why a delete was refused should find both halves in one
 * place.
 *
 * The factory functions are the seam. Raw SQL appears only in the race tests,
 * where one side of the race has to be held open mid-transaction, which no seam
 * can do.
 */

let database: MigratedDatabase;

beforeAll(async () => {
  ({ database } = await seedTestFactory("graders_named_by_tests"));
});

afterAll(async () => {
  await database.drop();
});

/** The error a refusal threw, so the facts it carries can be read off it. */
async function refusalFrom(
  work: Promise<unknown>,
): Promise<GraderNamedByTestsError> {
  const error = await work.then(
    () => {
      throw new Error("the delete was expected to be refused, and was not");
    },
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(GraderNamedByTestsError);
  return error as GraderNamedByTestsError;
}

describe("deleting a grader a live test names", () => {
  it("is refused, and the refusal names the test", async () => {
    const named = await seedGrader(actingAsAcme(), "Named Nell");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      graderIds: [named],
    });

    const refusal = await refusalFrom(deleteGrader(actingAsAcme(), named));

    expect(refusal.graderId).toBe(named);
    expect(refusal.tests).toEqual([{ id: created.id, name: rescheduling.name }]);
    // Named in the message too, not only on the error, because the message is
    // what a developer running a script actually reads.
    expect(refusal.message).toContain(created.id);
    expect(refusal.message).toContain(rescheduling.name);

    // Refused means nothing written: it is still there, and still nameable.
    expect((await getGrader(actingAsAcme(), named))?.id).toBe(named);
  });

  it("names every test standing in the way, oldest first", async () => {
    const mo = await seedGrader(actingAsAcme(), "Much-Named Mo");
    const first = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "Asks about parking",
      graderIds: [mo],
    });
    const second = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "Asks about insurance",
      graderIds: [mo],
    });

    const refusal = await refusalFrom(deleteGrader(actingAsAcme(), mo));

    expect(refusal.tests).toEqual([
      { id: first.id, name: "Asks about parking" },
      { id: second.id, name: "Asks about insurance" },
    ]);
  });

  it("counts the rest rather than printing a page of them", async () => {
    const ellis = await seedGrader(actingAsAcme(), "Everybody's Ellis");
    const created: Test[] = [];
    for (let nth = 1; nth <= 7; nth += 1) {
      created.push(
        await createTest(actingAsAcme(), {
          ...rescheduling,
          name: `Scenario ${nth}`,
          graderIds: [ellis],
        }),
      );
    }

    const refusal = await refusalFrom(deleteGrader(actingAsAcme(), ellis));

    expect(refusal.tests.map((test) => test.id)).toEqual(
      created.map((test) => test.id),
    );
    expect(refusal.message).toContain('"Scenario 5"');
    expect(refusal.message).not.toContain('"Scenario 6"');
    expect(refusal.message).toContain("and 2 more");
  });
});

describe("a grader only history names", () => {
  it("deletes fine, and the version that named it keeps it", async () => {
    const lena = await seedGrader(actingAsAcme(), "Leaving Lena");
    const kept = await seedGrader(actingAsAcme(), "Kept Kai");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      graderIds: [kept, lena],
    });

    // While version 1 is the current one, the delete is refused.
    await refusalFrom(deleteGrader(actingAsAcme(), lena));

    // Version 2 does not name it, so version 1 is history and blocks nothing.
    const moved = await editTest(actingAsAcme(), created.id, {
      graderIds: [kept],
    });
    expect(moved?.version).toBe(2);

    expect((await deleteGrader(actingAsAcme(), lena))?.id).toBe(lena);

    // Version 1 goes on naming it, and says plainly that it is gone — what a
    // run that pinned that version needs to stay interpretable.
    const first = await getTestVersion(actingAsAcme(), created.versionId);
    expect(first?.graders.map((named) => named.id)).toEqual([kept, lena]);
    expect(first?.graders[0]?.deletedAt).toBeNull();
    expect(first?.graders[1]?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("a grader only deleted tests name", () => {
  it("deletes fine, and the deleted test's version keeps it", async () => {
    const dana = await seedGrader(actingAsAcme(), "Departing Dana");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      graderIds: [dana],
    });

    await refusalFrom(deleteGrader(actingAsAcme(), dana));

    await deleteTest(actingAsAcme(), created.id);

    expect((await deleteGrader(actingAsAcme(), dana))?.id).toBe(dana);

    const version = await getTestVersion(actingAsAcme(), created.versionId);
    expect(version?.graders.map((named) => named.id)).toEqual([dana]);
  });
});

/**
 * How long to let a write run before calling it blocked. A write waiting on a
 * row lock never finishes on its own; one that got past the lock finishes in
 * about a millisecond, against a database on this machine.
 */
const A_BEAT = 250;

/** Whether a write has finished by the time that beat has passed. */
async function hasFinished(work: Promise<unknown>): Promise<boolean> {
  const finished = Symbol("finished");
  const outcome = await Promise.race([
    work.then(
      () => finished,
      () => finished,
    ),
    new Promise((resolve) => setTimeout(resolve, A_BEAT)),
  ]);
  return outcome === finished;
}

/**
 * The rows a create writes once it has locked the grader a version will name.
 * Written out because a race test has to hold a create open between its lock
 * and its commit, which the factory cannot be asked to do.
 */
async function writeTestNaming(
  connection: SingleConnection,
  named: { readonly personaId: string; readonly graderId: string; readonly name: string },
): Promise<{ readonly testId: string; readonly versionId: string }> {
  const testId = newId("tst");
  const versionId = newId("tstv");

  await connection.sql(
    `insert into test (id, organization_id, project_id, name, current_version_id)
     values ($1, $2, $3, $4, $5)`,
    [testId, acme.organization, acme.project, named.name, versionId],
  );
  await connection.sql(
    `insert into test_version (id, test_id, version, content)
     values ($1, $2, 1, $3::jsonb)`,
    [
      versionId,
      testId,
      JSON.stringify({
        scenario: rescheduling.scenario,
        expectedBehaviors: rescheduling.expectedBehaviors,
      }),
    ],
  );
  await connection.sql(
    `insert into test_persona (test_version_id, persona_id, position) values ($1, $2, 1)`,
    [versionId, named.personaId],
  );
  await connection.sql(
    `insert into test_grader (test_version_id, grader_id, position) values ($1, $2, 1)`,
    [versionId, named.graderId],
  );

  return { testId, versionId };
}

describe("the race between deleting a grader and naming it", () => {
  it("makes a create wait behind a delete already holding the row, then refuses the create", async () => {
    const cora = await seedGrader(actingAsAcme(), "Contested Cora");
    const connection = await openSingleConnection(database.url);

    try {
      // The first two statements of a delete, held open: the exclusive lock on
      // the grader, and the marker it is about to commit.
      await connection.sql("begin");
      await connection.sql("select id from grader where id = $1 for update", [
        cora,
      ]);
      await connection.sql(
        "update grader set deleted_at = now() where id = $1",
        [cora],
      );

      const before = await rowCounts();
      const creating = createTest(actingAsAcme(), {
        ...rescheduling,
        graderIds: [cora],
      });

      // The create cannot decide yet: checking that Cora is alive takes the
      // shared lock, and the delete is holding the row exclusively.
      expect(await hasFinished(creating)).toBe(false);
      expect(await rowCounts()).toEqual(before);

      await connection.sql("commit");

      // Released onto the row the delete left behind, the create sees the
      // marker and refuses — rather than writing a live test naming a deleted
      // grader, which is what a create deciding on its own snapshot would have
      // done.
      await expect(creating).rejects.toThrow(/is deleted/);
      expect(await rowCounts()).toEqual(before);
    } finally {
      await connection.close();
    }
  });

  it("makes a delete wait behind a create already naming it, then refuses the delete", async () => {
    const cyrus = await seedGrader(actingAsAcme(), "Contested Cyrus");
    const rita = (await getTestVersion(
      actingAsAcme(),
      (await createTest(actingAsAcme(), rescheduling)).versionId,
    ))?.personas[0]?.id;
    if (rita === undefined) throw new Error("no persona to write with");

    const connection = await openSingleConnection(database.url);
    try {
      // What a create does, held open: the shared lock on the grader it is
      // about to name, then the rows that name it.
      await connection.sql("begin");
      await connection.sql("select id from grader where id = $1 for share", [
        cyrus,
      ]);
      const written = await writeTestNaming(connection, {
        personaId: rita,
        graderId: cyrus,
        name: "Races the delete",
      });

      const deleting = deleteGrader(actingAsAcme(), cyrus);

      // The delete cannot decide yet: it takes the row exclusively before it
      // counts anything, and the create is holding it shared.
      expect(await hasFinished(deleting)).toBe(false);

      await connection.sql("commit");

      // It counts the rows the create committed while it waited, and refuses.
      const refusal = await refusalFrom(deleting);
      expect(refusal.tests).toEqual([
        { id: written.testId, name: "Races the delete" },
      ]);
      expect((await getGrader(actingAsAcme(), cyrus))?.id).toBe(cyrus);
    } finally {
      await connection.close();
    }
  });
});
