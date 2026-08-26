import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTest,
  deletePersona,
  deleteTest,
  editTest,
  getPersona,
  getTestVersion,
  testsUsingPersona,
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
  seedPersona,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * What happens to the tests that name a persona when that persona is deleted,
 * and what happens when the two writes race.
 *
 * **Delete asks the tests nothing.** It used to: an Archive counted the live
 * tests naming the persona and refused if there were any. That guard was
 * written when every test created without naming anybody was silently given
 * the project's default persona, so one Archive could quietly empty a page of
 * tests. Tests name their personas explicitly now, Delete is one honest verb
 * with one confirmation, and the protection sits where the loss would happen
 * instead — a run for a test naming a deleted persona is refused, and that
 * test's next write has to name somebody alive.
 *
 * It sits in a file of its own because it belongs to neither factory alone —
 * the rule is written into the persona's Delete and answered by the test
 * tables, and a reader looking for what a Delete does to a test should find
 * both halves in one place.
 *
 * The factory functions are the seam. Raw SQL appears only in the race tests,
 * where one side of the race has to be held open mid-transaction, which no seam
 * can do.
 */

let database: MigratedDatabase;
/** Acme's starter persona, named by the tests these files write. */
let rita: string;

beforeAll(async () => {
  ({ database, rita } = await seedTestFactory("named-by-tests"));
});

afterAll(async () => {
  await database.drop();
});

/** Observe an expected rejection now, even when the test releases its lock later. */
function rejectionFrom(work: Promise<unknown>, ifResolved: string): Promise<unknown> {
  return work.then(
    () => {
      throw new Error(ifResolved);
    },
    (thrown: unknown) => thrown,
  );
}

describe("deleting a persona an active test names", () => {
  it("lands, and the test goes on naming them while saying they are gone", async () => {
    const cass = await seedPersona(actingAsAcme(), "Called-On Cass");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [cass],
    });

    expect((await deletePersona(actingAsAcme(), cass))?.id).toBe(cass);

    // The version goes on naming them, and says plainly that they are gone —
    // what a run that pinned that version needs to stay interpretable.
    const version = await getTestVersion(actingAsAcme(), created.versionId);
    expect(version?.personas.map((named) => named.id)).toEqual([cass]);
    expect(version?.personas[0]?.archivedAt).toBeInstanceOf(Date);
  });

  it("leaves that test's next write demanding somebody alive", async () => {
    const dale = await seedPersona(actingAsAcme(), "Dropped Dale");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "Asks about the deposit",
      personaIds: [dale],
    });

    await deletePersona(actingAsAcme(), dale);

    await expect(
      editTest(actingAsAcme(), created.id, {
        expectedVersionId: created.versionId,
        personaIds: [dale],
      }),
    ).rejects.toThrow(/is deleted/);

    // Naming somebody alive is the way through, and nothing else had to change.
    const moved = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: created.versionId,
      personaIds: [rita],
    });
    expect(moved?.version).toBe(2);
  });

  it("is shown before the fact by the usage read the sheet displays", async () => {
    const mo = await seedPersona(actingAsAcme(), "Much-Named Mo");
    const first = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "Asks about parking",
      personaIds: [mo],
    });
    const second = await createTest(actingAsAcme(), {
      ...rescheduling,
      name: "Asks about insurance",
      personaIds: [rita, mo],
    });

    // The question somebody about to press Delete wants answered: who goes
    // quiet if I do. Oldest first, and every one of them.
    expect(await testsUsingPersona(actingAsAcme(), mo)).toEqual([
      { id: first.id, name: "Asks about parking" },
      { id: second.id, name: "Asks about insurance" },
    ]);
  });
});

describe("a persona only history names", () => {
  it("deletes fine, and the version that named them keeps them", async () => {
    const lena = await seedPersona(actingAsAcme(), "Leaving Lena");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [rita, lena],
    });

    // Version 2 does not name them, so version 1 is history.
    const moved = await editTest(actingAsAcme(), created.id, {
      expectedVersionId: created.versionId,
      personaIds: [rita],
    });
    expect(moved?.version).toBe(2);
    expect(await testsUsingPersona(actingAsAcme(), lena)).toEqual([]);

    expect((await deletePersona(actingAsAcme(), lena))?.id).toBe(lena);

    const first = await getTestVersion(actingAsAcme(), created.versionId);
    expect(first?.personas.map((named) => named.id)).toEqual([rita, lena]);
    expect(first?.personas[0]?.archivedAt).toBeNull();
    expect(first?.personas[1]?.archivedAt).toBeInstanceOf(Date);
  });
});

describe("a persona only deleted tests name", () => {
  it("deletes fine, and the deleted test's version keeps them", async () => {
    const dana = await seedPersona(actingAsAcme(), "Departing Dana");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [dana],
    });

    await deleteTest(actingAsAcme(), created.id);
    expect(await testsUsingPersona(actingAsAcme(), dana)).toEqual([]);

    expect((await deletePersona(actingAsAcme(), dana))?.id).toBe(dana);

    const version = await getTestVersion(actingAsAcme(), created.versionId);
    expect(version?.personas.map((named) => named.id)).toEqual([dana]);
  });
});

/** The backend whose open transaction will block the competing write. */
async function backendPid(connection: SingleConnection): Promise<number> {
  const { rows } = await connection.sql<{ pid: number }>(
    "select pg_backend_pid() as pid",
  );
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error("Postgres did not answer its backend pid");
  return pid;
}

/** Wait for a real Postgres lock edge, not an elapsed-time guess. */
async function waitUntilBlockedBy(blockerPid: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { rows } = await database.sql<{ blocked: boolean }>(
      `select exists (
         select 1
           from pg_stat_activity
          where $1::integer = any(pg_blocking_pids(pid))
       ) as blocked`,
      [blockerPid],
    );
    if (rows[0]?.blocked === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the competing persona write never reached its lock");
}

/**
 * The rows a create writes once it has resolved and locked the persona a
 * version will name. Written out because a race test has to hold a create open
 * between its lock and its commit, which the factory cannot be asked to do.
 */
async function writeTestNaming(
  connection: SingleConnection,
  named: {
    readonly projectId: string;
    readonly personaId: string;
    readonly name: string;
  },
): Promise<{ readonly testId: string; readonly versionId: string }> {
  const testId = newId("tst");
  const versionId = newId("tstv");

  await connection.sql(
    `insert into test (id, organization_id, project_id, suite_id, name,
                       current_version_id, revision)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      testId,
      acme.organization,
      named.projectId,
      named.projectId === acme.outbound ? acme.outboundSuite : acme.suite,
      named.name,
      versionId,
      newId("rev"),
    ],
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
    `insert into test_persona (test_version_id, persona_id, position)
     values ($1, $2, 1)`,
    [versionId, named.personaId],
  );

  return { testId, versionId };
}

describe("the race between deleting a persona and naming them", () => {
  it("makes a create wait behind a Delete already holding the row, then refuses the create", async () => {
    const cora = await seedPersona(actingAsAcme(), "Contested Cora");
    const connection = await openSingleConnection(database.url);
    const blockerPid = await backendPid(connection);

    try {
      // The first two statements of a Delete, held open: the exclusive lock on
      // the persona, and the stamp it is about to commit.
      await connection.sql("begin");
      await connection.sql(
        "select id from persona where id = $1 for update",
        [cora],
      );
      await connection.sql(
        "update persona set archived_at = now() where id = $1",
        [cora],
      );

      const before = await rowCounts();
      const creating = rejectionFrom(
        createTest(actingAsAcme(), {
          ...rescheduling,
          personaIds: [cora],
        }),
        "the concurrent create was expected to be refused",
      );

      // The create cannot decide yet: checking that Cora is alive takes the
      // shared lock, and the Delete is holding the row exclusively.
      await waitUntilBlockedBy(blockerPid);
      expect(await rowCounts()).toEqual(before);

      await connection.sql("commit");

      // Released onto the row the Delete left behind, the create sees the
      // stamp and refuses — rather than writing a test against a decision it
      // could not see, which is what a create deciding on its own snapshot
      // would have done.
      expect(await creating).toMatchObject({
        message: expect.stringMatching(/is deleted/),
      });
      expect(await rowCounts()).toEqual(before);
    } finally {
      await connection.close();
    }
  });

  it("makes a Delete wait behind a create already naming them, and then lands", async () => {
    const cyrus = await seedPersona(actingAsAcme(), "Contested Cyrus");
    const connection = await openSingleConnection(database.url);
    const blockerPid = await backendPid(connection);

    try {
      // What a create does, held open: the shared lock on the persona it is
      // about to name, then the rows that name them.
      await connection.sql("begin");
      await connection.sql(
        "select id from persona where id = $1 for share",
        [cyrus],
      );
      const written = await writeTestNaming(connection, {
        projectId: acme.project,
        personaId: cyrus,
        name: "Races the Delete",
      });

      const deleting = deletePersona(actingAsAcme(), cyrus);

      // The Delete cannot land yet: it takes the row exclusively, and the
      // create is holding it shared.
      await waitUntilBlockedBy(blockerPid);

      await connection.sql("commit");

      // The test won the race and keeps the persona it named; the Delete lands
      // all the same. That is the shape on purpose — nothing is lost, and the
      // run this test would start is the thing that refuses.
      expect((await deleting)?.archivedAt).toBeInstanceOf(Date);
      expect((await getPersona(actingAsAcme(), cyrus))?.archivedAt).toBeInstanceOf(
        Date,
      );
      expect(await testsUsingPersona(actingAsAcme(), cyrus)).toEqual([
        { id: written.testId, name: "Races the Delete" },
      ]);
    } finally {
      await connection.close();
    }
  });
});
