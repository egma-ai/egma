import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTest,
  deleteDigitalHuman,
  deleteTest,
  DigitalHumanNamedByTestsError,
  editTest,
  getDigitalHuman,
  getTestVersion,
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
  pointProjectAt,
  rescheduling,
  rowCounts,
  seedDigitalHuman,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * Deleting a digital human while the current version of a live test names them:
 * refused, and the refusal names those tests. What history names, what a
 * deleted test names, and what a project points at by default all delete fine.
 *
 * It sits in a file of its own because it belongs to neither factory alone —
 * the rule is written into the digital human's delete and answered by the test
 * tables, and a reader looking for why a delete was refused should find both
 * halves in one place.
 *
 * The factory functions are the seam. Raw SQL appears only in the race tests,
 * where one side of the race has to be held open mid-transaction, which no seam
 * can do.
 */

let database: MigratedDatabase;
/** Acme's starter digital human, and the one its project points at. */
let rita: string;

beforeAll(async () => {
  ({ database, rita } = await seedTestFactory("named-by-tests"));
});

afterAll(async () => {
  await database.drop();
});

/** The error a refusal threw, so the facts it carries can be read off it. */
async function refusalFrom(
  work: Promise<unknown>,
): Promise<DigitalHumanNamedByTestsError> {
  const error = await work.then(
    () => {
      throw new Error("the delete was expected to be refused, and was not");
    },
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DigitalHumanNamedByTestsError);
  return error as DigitalHumanNamedByTestsError;
}

describe("deleting a digital human a live test names", () => {
  it("is refused, and the refusal names the test", async () => {
    const cass = await seedDigitalHuman(actingAsAcme(), "Called-On Cass");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [cass],
    });

    const refusal = await refusalFrom(deleteDigitalHuman(actingAsAcme(), cass));

    expect(refusal.digitalHumanId).toBe(cass);
    expect(refusal.tests).toEqual([{ id: created.id, name: rescheduling.name }]);
    // Named in the message too, not only on the error, because the message is
    // what a developer running a script actually reads.
    expect(refusal.message).toContain(created.id);
    expect(refusal.message).toContain(rescheduling.name);

    // Refused means nothing written: they are still there, and still nameable.
    expect((await getDigitalHuman(actingAsAcme(), cass))?.id).toBe(cass);
  });

  it("names every test standing in the way, oldest first", async () => {
    const mo = await seedDigitalHuman(actingAsAcme(), "Much-Named Mo");
    const first = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "Asks about parking",
      digitalHumanIds: [mo],
    });
    const second = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "Asks about insurance",
      digitalHumanIds: [rita, mo],
    });

    const refusal = await refusalFrom(deleteDigitalHuman(actingAsAcme(), mo));

    expect(refusal.tests).toEqual([
      { id: first.id, name: "Asks about parking" },
      { id: second.id, name: "Asks about insurance" },
    ]);
  });

  it("counts the rest rather than printing a page of them", async () => {
    const ellis = await seedDigitalHuman(actingAsAcme(), "Everybody's Ellis");
    const created: Test[] = [];
    for (let nth = 1; nth <= 7; nth += 1) {
      created.push(
        await createTest(actingAsAcme(), {
          ...rescheduling,
          name: `Scenario ${nth}`,
          digitalHumanIds: [ellis],
        }),
      );
    }

    const refusal = await refusalFrom(deleteDigitalHuman(actingAsAcme(), ellis));

    // Every one of them on the error, because the fix is to go and edit each.
    expect(refusal.tests.map((test) => test.id)).toEqual(
      created.map((test) => test.id),
    );
    // A readable few in the message, and a count for the rest — the digital
    // human a project points at by default is named by every test written
    // without naming one, so an uncapped message would be unreadable.
    expect(refusal.message).toContain('"Scenario 5"');
    expect(refusal.message).not.toContain('"Scenario 6"');
    expect(refusal.message).toContain("and 2 more");
  });
});

describe("a digital human only history names", () => {
  it("deletes fine, and the version that named them keeps them", async () => {
    const lena = await seedDigitalHuman(actingAsAcme(), "Leaving Lena");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [rita, lena],
    });

    // While version 1 is the current one, the delete is refused.
    await refusalFrom(deleteDigitalHuman(actingAsAcme(), lena));

    // Version 2 does not name them, so version 1 is history and blocks nothing.
    const moved = await editTest(actingAsAcme(), created.id, {
      digitalHumanIds: [rita],
    });
    expect(moved?.version).toBe(2);

    expect((await deleteDigitalHuman(actingAsAcme(), lena))?.id).toBe(lena);

    // Version 1 goes on naming them, and says plainly that they are gone —
    // what a run that pinned that version needs to stay interpretable.
    const first = await getTestVersion(actingAsAcme(), created.versionId);
    expect(first?.digitalHumans.map((human) => human.id)).toEqual([rita, lena]);
    expect(first?.digitalHumans[0]?.deletedAt).toBeNull();
    expect(first?.digitalHumans[1]?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("a digital human only deleted tests name", () => {
  it("deletes fine, and the deleted test's version keeps them", async () => {
    const dana = await seedDigitalHuman(actingAsAcme(), "Departing Dana");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      digitalHumanIds: [dana],
    });

    await refusalFrom(deleteDigitalHuman(actingAsAcme(), dana));

    await deleteTest(actingAsAcme(), created.id);

    expect((await deleteDigitalHuman(actingAsAcme(), dana))?.id).toBe(dana);

    const version = await getTestVersion(actingAsAcme(), created.versionId);
    expect(version?.digitalHumans.map((human) => human.id)).toEqual([dana]);
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
 * The rows a create writes once it has resolved and locked the digital human a
 * version will name. Written out because a race test has to hold a create open
 * between its lock and its commit, which the factory cannot be asked to do.
 */
async function writeTestNaming(
  connection: SingleConnection,
  named: {
    readonly projectId: string;
    readonly digitalHumanId: string;
    readonly name: string;
  },
): Promise<{ readonly testId: string; readonly versionId: string }> {
  const testId = newId("tst");
  const versionId = newId("tstv");

  await connection.sql(
    `insert into test (id, organization_id, project_id, name, current_version_id)
     values ($1, $2, $3, $4, $5)`,
    [testId, acme.organization, named.projectId, named.name, versionId],
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
    `insert into test_version_digital_human (test_version_id, digital_human_id, position)
     values ($1, $2, 1)`,
    [versionId, named.digitalHumanId],
  );

  return { testId, versionId };
}

describe("the race between deleting a digital human and naming them", () => {
  it("makes a create wait behind a delete already holding the row, then refuses the create", async () => {
    const cora = await seedDigitalHuman(actingAsAcme(), "Contested Cora");
    const connection = await openSingleConnection(database.url);

    try {
      // The first two statements of a delete, held open: the exclusive lock on
      // the digital human, and the marker it is about to commit.
      await connection.sql("begin");
      await connection.sql(
        "select id from digital_human where id = $1 for update",
        [cora],
      );
      await connection.sql(
        "update digital_human set deleted_at = now() where id = $1",
        [cora],
      );

      const before = await rowCounts();
      const creating = createTest(actingAsAcme(), {
        ...rescheduling,
        digitalHumanIds: [cora],
      });

      // The create cannot decide yet: checking that Cora is alive takes the
      // shared lock, and the delete is holding the row exclusively.
      expect(await hasFinished(creating)).toBe(false);
      expect(await rowCounts()).toEqual(before);

      await connection.sql("commit");

      // Released onto the row the delete left behind, the create sees the
      // marker and refuses — rather than writing a live test naming a deleted
      // digital human, which is what a create deciding on its own snapshot
      // would have done.
      await expect(creating).rejects.toThrow(/is deleted/);
      expect(await rowCounts()).toEqual(before);
    } finally {
      await connection.close();
    }
  });

  it("makes a delete wait behind a create already naming them, then refuses the delete", async () => {
    const cyrus = await seedDigitalHuman(actingAsAcme(), "Contested Cyrus");
    const connection = await openSingleConnection(database.url);

    try {
      // What a create does, held open: the shared lock on the digital human it
      // is about to name, then the rows that name them.
      await connection.sql("begin");
      await connection.sql(
        "select id from digital_human where id = $1 for share",
        [cyrus],
      );
      const written = await writeTestNaming(connection, {
        projectId: acme.project,
        digitalHumanId: cyrus,
        name: "Races the delete",
      });

      const deleting = deleteDigitalHuman(actingAsAcme(), cyrus);

      // The delete cannot decide yet: it takes the row exclusively before it
      // counts anything, and the create is holding it shared.
      expect(await hasFinished(deleting)).toBe(false);

      await connection.sql("commit");

      // It counts the rows the create committed while it waited, and refuses.
      const refusal = await refusalFrom(deleting);
      expect(refusal.tests).toEqual([
        { id: written.testId, name: "Races the delete" },
      ]);
      expect((await getDigitalHuman(actingAsAcme(), cyrus))?.id).toBe(cyrus);
    } finally {
      await connection.close();
    }
  });
});

describe("the digital human a project points at by default", () => {
  /** The sibling project, which points at nobody until a test points it. */
  const inOutbound = { ...actingAsAcme(), projectId: acme.outbound };

  afterAll(async () => {
    await pointProjectAt(acme.outbound, null);
  });

  it("deletes like any other, because a pointer is not a test naming them", async () => {
    const pia = await seedDigitalHuman(inOutbound, "Pointed-At Pia");
    await pointProjectAt(acme.outbound, pia);

    // A project setting is not a test's claim: only a test standing to lose a
    // simulation refuses a delete, and no test here names them.
    expect((await deleteDigitalHuman(inOutbound, pia))?.id).toBe(pia);

    // A soft delete leaves the row where it was, so the pointer goes on naming
    // them — and the next test written without naming anybody says so out loud
    // rather than picking somebody.
    await expect(createTest(inOutbound, rescheduling)).rejects.toThrow(
      /is deleted/,
    );
  });

  it("makes a create taking the default wait behind a delete, then refuses it in the pointer's own words", async () => {
    const dee = await seedDigitalHuman(inOutbound, "Default Dee");
    await pointProjectAt(acme.outbound, dee);
    const connection = await openSingleConnection(database.url);

    try {
      // The first two statements of a delete, held open.
      await connection.sql("begin");
      await connection.sql(
        "select id from digital_human where id = $1 for update",
        [dee],
      );
      await connection.sql(
        "update digital_human set deleted_at = now() where id = $1",
        [dee],
      );

      const before = await rowCounts();
      // Naming nobody, which is the commonest create there is: who calls comes
      // off the project's pointer rather than out of the input.
      const creating = createTest(inOutbound, rescheduling);

      // The create cannot decide yet: resolving the pointer takes the shared
      // lock on the digital human it points at, and the delete is holding the
      // row exclusively.
      expect(await hasFinished(creating)).toBe(false);
      expect(await rowCounts()).toEqual(before);

      await connection.sql("commit");

      const refused = String(await creating.catch((thrown: unknown) => thrown));
      // Released onto the row the delete left behind, the create reads the
      // marker off it and names the fix that matches: repoint the default.
      expect(refused).toMatch(/default digital human .* is deleted/);
      // Not the other way a pointer can be wrong, which wants a different fix
      // — which is what a read that filtered the deleted row out would say.
      expect(refused).not.toMatch(/there is no digital human/);
      expect(await rowCounts()).toEqual(before);
    } finally {
      await connection.close();
    }
  });

  it("makes a delete wait behind a create taking the default, then refuses the delete", async () => {
    const dixon = await seedDigitalHuman(inOutbound, "Default Dixon");
    await pointProjectAt(acme.outbound, dixon);
    const connection = await openSingleConnection(database.url);

    try {
      // What a create naming nobody does, held open: read the pointer, take the
      // shared lock on who it points at, then write the rows that name them.
      await connection.sql("begin");
      const pointer = await connection.sql<{
        default_digital_human_id: string | null;
      }>("select default_digital_human_id from project where id = $1", [
        acme.outbound,
      ]);
      expect(pointer.rows[0]?.default_digital_human_id).toBe(dixon);
      await connection.sql(
        "select id from digital_human where id = $1 for share",
        [dixon],
      );
      const written = await writeTestNaming(connection, {
        projectId: acme.outbound,
        digitalHumanId: dixon,
        name: "Takes the default",
      });

      const deleting = deleteDigitalHuman(inOutbound, dixon);

      expect(await hasFinished(deleting)).toBe(false);

      await connection.sql("commit");

      // The test that took the default is a test naming them like any other.
      const refusal = await refusalFrom(deleting);
      expect(refusal.tests).toEqual([
        { id: written.testId, name: "Takes the default" },
      ]);
      expect((await getDigitalHuman(inOutbound, dixon))?.id).toBe(dixon);
    } finally {
      await connection.close();
    }
  });
});
