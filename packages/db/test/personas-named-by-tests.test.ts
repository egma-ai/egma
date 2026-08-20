import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  archivePersona,
  createTest,
  DefaultPersonaReplacementError,
  EGMA_PROVIDED_PERSONAS,
  archiveTest,
  editTest,
  getPersona,
  getTestVersion,
  PersonaNamedByTestsError,
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
  seedPersona,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * Archiving a persona while the current version of an active test names them:
 * refused, and the refusal names those tests. What history names and what an
 * archived test names both archive fine. What a project points at by default
 * archives too — once somebody has said who takes the pointer.
 *
 * It sits in a file of its own because it belongs to neither factory alone —
 * the rule is written into the persona's Archive and answered by the test
 * tables, and a reader looking for why an Archive was refused should find both
 * halves in one place.
 *
 * The factory functions are the seam. Raw SQL appears only in the race tests,
 * where one side of the race has to be held open mid-transaction, which no seam
 * can do.
 */

let database: MigratedDatabase;
/** Acme's starter persona, and the one its project points at. */
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
): Promise<PersonaNamedByTestsError> {
  const error = await work.then(
    () => {
      throw new Error("the Archive was expected to be refused, and was not");
    },
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(PersonaNamedByTestsError);
  return error as PersonaNamedByTestsError;
}

describe("archiving a persona an active test names", () => {
  it("is refused, and the refusal names the test", async () => {
    const cass = await seedPersona(actingAsAcme(), "Called-On Cass");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [cass],
    });

    const refusal = await refusalFrom(archivePersona(actingAsAcme(), cass));

    expect(refusal.personaId).toBe(cass);
    expect(refusal.tests).toEqual([{ id: created.id, name: rescheduling.name }]);
    // Named in the message too, not only on the error, because the message is
    // what a developer running a script actually reads.
    expect(refusal.message).toContain(created.id);
    expect(refusal.message).toContain(rescheduling.name);

    // Refused means nothing written: they are still there, and still nameable.
    expect((await getPersona(actingAsAcme(), cass))?.id).toBe(cass);
  });

  it("names every test standing in the way, oldest first", async () => {
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

    const refusal = await refusalFrom(archivePersona(actingAsAcme(), mo));

    expect(refusal.tests).toEqual([
      { id: first.id, name: "Asks about parking" },
      { id: second.id, name: "Asks about insurance" },
    ]);
  });

  it("counts the rest rather than printing a page of them", async () => {
    const ellis = await seedPersona(actingAsAcme(), "Everybody's Ellis");
    const created: Test[] = [];
    for (let nth = 1; nth <= 7; nth += 1) {
      created.push(
        await createTest(actingAsAcme(), {
          ...rescheduling,
          name: `Scenario ${nth}`,
          personaIds: [ellis],
        }),
      );
    }

    const refusal = await refusalFrom(archivePersona(actingAsAcme(), ellis));

    // Every one of them on the error, because the fix is to go and edit each.
    expect(refusal.tests.map((test) => test.id)).toEqual(
      created.map((test) => test.id),
    );
    // A readable few in the message, and a count for the rest — the persona a
    // project points at by default is named by every test written without
    // naming one, so an uncapped message would be unreadable.
    expect(refusal.message).toContain('"Scenario 5"');
    expect(refusal.message).not.toContain('"Scenario 6"');
    expect(refusal.message).toContain("and 2 more");
  });
});

describe("a persona only history names", () => {
  it("archives fine, and the version that named them keeps them", async () => {
    const lena = await seedPersona(actingAsAcme(), "Leaving Lena");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [rita, lena],
    });

    // While version 1 is the current one, the Archive is refused.
    await refusalFrom(archivePersona(actingAsAcme(), lena));

    // Version 2 does not name them, so version 1 is history and blocks nothing.
    const moved = await editTest(actingAsAcme(), created.id, {
      personaIds: [rita],
    });
    expect(moved?.version).toBe(2);

    expect((await archivePersona(actingAsAcme(), lena))?.id).toBe(lena);

    // Version 1 goes on naming them, and says plainly that they are gone — what
    // a run that pinned that version needs to stay interpretable.
    const first = await getTestVersion(actingAsAcme(), created.versionId);
    expect(first?.personas.map((named) => named.id)).toEqual([rita, lena]);
    expect(first?.personas[0]?.archivedAt).toBeNull();
    expect(first?.personas[1]?.archivedAt).toBeInstanceOf(Date);
  });
});

describe("a persona only archived tests name", () => {
  it("archives fine, and the archived test's version keeps them", async () => {
    const dana = await seedPersona(actingAsAcme(), "Departing Dana");
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [dana],
    });

    await refusalFrom(archivePersona(actingAsAcme(), dana));

    await archiveTest(actingAsAcme(), created.id);

    expect((await archivePersona(actingAsAcme(), dana))?.id).toBe(dana);

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
    `insert into test (id, organization_id, project_id, name, current_version_id,
                       revision, applicability_revision)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      testId,
      acme.organization,
      named.projectId,
      named.name,
      versionId,
      newId("rev"),
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

describe("the race between archiving a persona and naming them", () => {
  it("makes a create wait behind an Archive already holding the row, then refuses the create", async () => {
    const cora = await seedPersona(actingAsAcme(), "Contested Cora");
    const connection = await openSingleConnection(database.url);
    const blockerPid = await backendPid(connection);

    try {
      // The first two statements of an Archive, held open: the exclusive lock on
      // the persona, and the marker it is about to commit.
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
      const creating = createTest(actingAsAcme(), {
        ...rescheduling,
        personaIds: [cora],
      });

      // The create cannot decide yet: checking that Cora is alive takes the
      // shared lock, and the Archive is holding the row exclusively.
      await waitUntilBlockedBy(blockerPid);
      expect(await rowCounts()).toEqual(before);

      await connection.sql("commit");

      // Released onto the row the Archive left behind, the create sees the
      // marker and refuses — rather than writing an active test naming an archived
      // persona, which is what a create deciding on its own snapshot would have
      // done.
      await expect(creating).rejects.toThrow(/is archived/);
      expect(await rowCounts()).toEqual(before);
    } finally {
      await connection.close();
    }
  });

  it("makes an Archive wait behind a create already naming them, then refuses the Archive", async () => {
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
        name: "Races the Archive",
      });

      const archiving = archivePersona(actingAsAcme(), cyrus);

      // The Archive cannot decide yet: it takes the row exclusively before it
      // counts anything, and the create is holding it shared.
      await waitUntilBlockedBy(blockerPid);

      await connection.sql("commit");

      // It counts the rows the create committed while it waited, and refuses.
      const refusal = await refusalFrom(archiving);
      expect(refusal.tests).toEqual([
        { id: written.testId, name: "Races the Archive" },
      ]);
      expect((await getPersona(actingAsAcme(), cyrus))?.id).toBe(cyrus);
    } finally {
      await connection.close();
    }
  });
});

describe("the persona a project points at by default", () => {
  /** The sibling project, which points at nobody until a test points it. */
  const inOutbound = { ...actingAsAcme(), projectId: acme.outbound };

  afterAll(async () => {
    await pointProjectAt(
      acme.outbound,
      EGMA_PROVIDED_PERSONAS.defaultPersona,
    );
  });

  it("is refused while nobody has been named to take the pointer", async () => {
    const pia = await seedPersona(inOutbound, "Pointed-At Pia");
    await pointProjectAt(acme.outbound, pia);

    // No test names Pia, so the rule that refuses an Archive is not this one.
    // A project always has a default persona, and archiving the one it points
    // at without saying who replaces them would break the commonest create
    // there is — for somebody else, later, who did nothing wrong.
    const refusal = await archivePersona(inOutbound, pia).then(
      () => {
        throw new Error("the Archive was expected to be refused");
      },
      (thrown: unknown) => thrown,
    );
    expect(refusal).toBeInstanceOf(DefaultPersonaReplacementError);

    // Nothing moved, so a test naming nobody still gets Pia.
    const taking = await createTest(inOutbound, rescheduling);
    expect(taking.personas.map((one) => one.id)).toEqual([pia]);
    await archiveTest(inOutbound, taking.id);
  });

  it("takes the replacement in the same write, so the project is never pointing at nobody", async () => {
    const parting = await seedPersona(inOutbound, "Parting Percy");
    const taking = await seedPersona(inOutbound, "Taking-Over Tam");
    await pointProjectAt(acme.outbound, parting);

    const archived = await archivePersona(inOutbound, parting, {
      replacementPersonaId: taking,
    });
    expect(archived?.archivedAt).toBeInstanceOf(Date);
    expect(archived?.isDefault).toBe(false);

    // The pointer moved with the Archive, so a test naming nobody is written
    // rather than refused — and it is written naming the replacement.
    const written = await createTest(inOutbound, rescheduling);
    expect(written.personas.map((one) => one.id)).toEqual([taking]);
    await archiveTest(inOutbound, written.id);
  });

  it("refuses a replacement that is not an active persona of this project", async () => {
    const holding = await seedPersona(inOutbound, "Holding Hattie");
    const archivedAlready = await seedPersona(inOutbound, "Already Archived");
    await archivePersona(inOutbound, archivedAlready);
    await pointProjectAt(acme.outbound, holding);

    for (const replacement of [archivedAlready, rita, newId("prs")]) {
      await expect(
        archivePersona(inOutbound, holding, {
          replacementPersonaId: replacement,
        }),
      ).rejects.toBeInstanceOf(DefaultPersonaReplacementError);
    }

    expect((await getPersona(inOutbound, holding))?.archivedAt).toBeNull();
  });

  it("refuses a raw write that would archive the project default", async () => {
    const dee = await seedPersona(inOutbound, "Default Dee");
    await pointProjectAt(acme.outbound, dee);
    const connection = await openSingleConnection(database.url);

    try {
      await expect(
        connection.sql(
          "update persona set archived_at = now() where id = $1",
          [dee],
        ),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "project_default_persona_availability",
      });
      expect((await getPersona(inOutbound, dee))?.archivedAt).toBeNull();
    } finally {
      await connection.close();
    }
  });

  it("orders a new default and a concurrent archive as one decision", async () => {
    const oldDefault = await seedPersona(inOutbound, "Old Default Odette");
    const newDefault = await seedPersona(inOutbound, "New Default Nia");
    await pointProjectAt(acme.outbound, oldDefault);
    const choosing = await openSingleConnection(database.url);
    const archiving = await openSingleConnection(database.url);
    const blockerPid = await backendPid(choosing);

    try {
      await choosing.sql("begin");
      await choosing.sql(
        "update project set default_persona_id = $1 where id = $2",
        [newDefault, acme.outbound],
      );

      const concurrentArchive = archiving.sql(
        "update persona set archived_at = now() where id = $1",
        [newDefault],
      );
      await waitUntilBlockedBy(blockerPid);

      await choosing.sql("commit");
      await expect(concurrentArchive).rejects.toMatchObject({
        code: "23503",
        constraint: "project_default_persona_availability",
      });

      const stored = await choosing.sql<{
        default_persona_id: string;
        archived_at: Date | null;
      }>(
        `select target.default_persona_id, chosen.archived_at
         from project target
         join persona chosen on chosen.id = target.default_persona_id
         where target.id = $1`,
        [acme.outbound],
      );
      expect(stored.rows[0]).toEqual({
        default_persona_id: newDefault,
        archived_at: null,
      });
    } finally {
      await choosing.sql("rollback").catch(() => undefined);
      await Promise.all([choosing.close(), archiving.close()]);
    }
  });

  it("rechecks an archived candidate after waiting for the archive", async () => {
    const oldDefault = await seedPersona(inOutbound, "Kept Default Kit");
    const candidate = await seedPersona(inOutbound, "Archived Candidate Ada");
    await pointProjectAt(acme.outbound, oldDefault);
    const archiving = await openSingleConnection(database.url);
    const choosing = await openSingleConnection(database.url);
    const blockerPid = await backendPid(archiving);

    try {
      await archiving.sql("begin");
      await archiving.sql(
        "update persona set archived_at = now() where id = $1",
        [candidate],
      );

      const concurrentChoice = choosing.sql(
        "update project set default_persona_id = $1 where id = $2",
        [candidate, acme.outbound],
      );
      await waitUntilBlockedBy(blockerPid);

      await archiving.sql("commit");
      await expect(concurrentChoice).rejects.toMatchObject({
        code: "23503",
        constraint: "project_default_persona_availability",
      });

      const stored = await database.sql<{
        default_persona_id: string;
        archived_at: Date | null;
      }>(
        `select target.default_persona_id, candidate.archived_at
         from project target
         join persona candidate on candidate.id = $1
         where target.id = $2`,
        [candidate, acme.outbound],
      );
      expect(stored.rows[0]?.default_persona_id).toBe(oldDefault);
      expect(stored.rows[0]?.archived_at).toBeInstanceOf(Date);
    } finally {
      await Promise.all([
        archiving.sql("rollback").catch(() => undefined),
        choosing.sql("rollback").catch(() => undefined),
      ]);
      await Promise.all([archiving.close(), choosing.close()]);
    }
  });

  it("makes an Archive wait behind a create taking the default, then refuses the Archive", async () => {
    const dixon = await seedPersona(inOutbound, "Default Dixon");
    await pointProjectAt(acme.outbound, dixon);
    const connection = await openSingleConnection(database.url);
    const blockerPid = await backendPid(connection);

    try {
      // What a create naming nobody does, held open: read the pointer, take the
      // shared lock on who it points at, then write the rows that name them.
      await connection.sql("begin");
      const pointer = await connection.sql<{
        default_persona_id: string | null;
      }>("select default_persona_id from project where id = $1", [
        acme.outbound,
      ]);
      expect(pointer.rows[0]?.default_persona_id).toBe(dixon);
      await connection.sql(
        "select id from persona where id = $1 for share",
        [dixon],
      );
      const written = await writeTestNaming(connection, {
        projectId: acme.outbound,
        personaId: dixon,
        name: "Takes the default",
      });

      const archiving = archivePersona(inOutbound, dixon);

      await waitUntilBlockedBy(blockerPid);

      await connection.sql("commit");

      // The test that took the default is a test naming them like any other.
      const refusal = await refusalFrom(archiving);
      expect(refusal.tests).toEqual([
        { id: written.testId, name: "Takes the default" },
      ]);
      expect((await getPersona(inOutbound, dixon))?.id).toBe(dixon);
    } finally {
      await connection.close();
    }
  });
});
