import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  archivePersona,
  createPersona,
  DefaultPersonaReplacementError,
  getPersona,
  WriteAbortedError,
  type AuthContext,
} from "@egma/db";

import {
  createConnectedDatabase,
  errorCodeOf,
  openSingleConnection,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Two archives racing over the same project's default pointer.
 *
 * **An archive touches two kinds of row and can touch three rows.** It locks
 * the persona leaving, the project whose pointer may have to move, and — when
 * it is the default leaving — the persona taking that pointer. Two of those
 * happening at once is an ordinary Tuesday: somebody archives the default and
 * names a colleague as the replacement, while the colleague is being archived
 * from another tab.
 *
 * If the two take their locks in different orders, Postgres finds the cycle
 * and aborts one of them. That abort is a `40P01`, it arrives as a driver
 * error rather than as anything egma wrote, and it would surface to whoever
 * pressed Archive as an internal failure on a request that was perfectly
 * valid. So this file asks the real question of the real function, many times
 * over, and holds the answer to two claims: **no run ever deadlocks**, and
 * every outcome is either the archive happening or a refusal egma authored.
 *
 * The loop is what makes it a race rather than a rehearsal. Nothing is staged,
 * nothing is held open, and neither side is told about the other — because the
 * ordering that matters is the one the production path really takes, not the
 * one a test could arrange for it.
 */

let database: MigratedDatabase;

const organizationId = newId("org");
const projectId = newId("prj");
const ada = newId("usr");

const auth: AuthContext = {
  userId: ada,
  organizationId,
  projectId,
  role: "member",
  via: "session",
};

const PERSONALITY = "Speaks plainly and asks one question at a time.";
const TRAITS = { personality: PERSONALITY, language: "en-US" } as const;

/** How many times the pair is raced. Enough for an ordering bug to show. */
const ROUNDS = 40;

beforeAll(async () => {
  database = await createConnectedDatabase("persona_archive_race");
  await seedOrganization(database, organizationId, [
    { id: projectId, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
});

afterAll(async () => {
  await database.drop();
});

/** Who this project points at when a test names nobody. */
async function pointProjectAt(personaId: string): Promise<void> {
  await database.sql("update project set default_persona_id = $1 where id = $2", [
    personaId,
    projectId,
  ]);
}

/**
 * Postgres gave up on one of the two and rolled it back.
 *
 * `40P01` is the deadlock the cycle produces; `40001` is the serialization
 * failure a stricter isolation level would produce instead. Both are the same
 * thing to whoever pressed Archive — a valid request that died of how egma
 * takes its locks — so both are looked for and neither is allowed.
 */
const ABORTED = ["40P01", "40001"];

function abortedByPostgres(thrown: unknown): boolean {
  const code = errorCodeOf(thrown);
  return (
    (code !== undefined && ABORTED.includes(code)) ||
    /deadlock/i.test(String(thrown))
  );
}

/**
 * What egma is allowed to answer with. Either archive can lose the race
 * honestly: the replacement may have been archived a moment earlier, so a
 * `not_available` replacement is a correct answer rather than a fault.
 */
function egmasOwnRefusal(thrown: unknown): boolean {
  return thrown instanceof DefaultPersonaReplacementError;
}

describe("archiving the default while its replacement is archived", () => {
  it("never deadlocks, whichever of the two gets there first", async () => {
    const aborted: unknown[] = [];
    const unexpected: unknown[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const leaving = await createPersona(auth, {
        name: `Leaving ${round}`,
        traits: TRAITS,
      });
      const taking = await createPersona(auth, {
        name: `Taking ${round}`,
        traits: TRAITS,
      });
      await pointProjectAt(leaving.id);

      // The two requests, started together and told nothing about each other.
      // One archives the default and names the other as its replacement; the
      // other archives that replacement. Half the rounds start them the other
      // way round, because which one asks first is not egma's to decide.
      const archivingDefault = () =>
        archivePersona(auth, leaving.id, {
          expectedRevision: leaving.revision,
          replacementPersonaId: taking.id,
        });
      const archivingReplacement = () =>
        archivePersona(auth, taking.id, { expectedRevision: taking.revision });

      const both =
        round % 2 === 0
          ? [archivingDefault(), archivingReplacement()]
          : [archivingReplacement(), archivingDefault()];

      for (const settled of await Promise.allSettled(both)) {
        if (settled.status === "fulfilled") continue;
        if (abortedByPostgres(settled.reason)) aborted.push(settled.reason);
        else if (!egmasOwnRefusal(settled.reason)) unexpected.push(settled.reason);
      }
    }

    expect(aborted.map(String)).toEqual([]);
    expect(unexpected.map(String)).toEqual([]);
  });

  it("leaves the project pointing at an active persona, whichever way each round went", async () => {
    for (let round = 0; round < 8; round += 1) {
      const leaving = await createPersona(auth, {
        name: `Pointed ${round}`,
        traits: TRAITS,
      });
      const taking = await createPersona(auth, {
        name: `Pointing ${round}`,
        traits: TRAITS,
      });
      await pointProjectAt(leaving.id);

      await Promise.allSettled([
        archivePersona(auth, leaving.id, {
          expectedRevision: leaving.revision,
          replacementPersonaId: taking.id,
        }),
        archivePersona(auth, taking.id, { expectedRevision: taking.revision }),
      ]);

      // Whoever won, the invariant holds: a project points at somebody, and
      // the somebody it points at can still be given to a new test.
      const { rows } = await database.sql<{ default_persona_id: string | null }>(
        "select default_persona_id from project where id = $1",
        [projectId],
      );
      const pointer = rows[0]?.default_persona_id;
      expect(pointer, `round ${round}`).not.toBeNull();
      const pointedAt = await getPersona(auth, String(pointer));
      expect(pointedAt?.archivedAt, `round ${round}`).toBeNull();
    }
  });
});

/**
 * The net under the order, for the day something gets past it.
 *
 * The lock order above is what stops a cycle forming between two archives. It
 * cannot stop one forming between an archive and a transaction that takes the
 * same rows the other way round — a path written later, a migration, somebody
 * at a psql prompt — and it cannot stop a stricter isolation level aborting a
 * transaction outright. Those are the store's to do, so what is proved here is
 * what egma *says* when it happens: not a driver error escaping as an internal
 * failure, but a refusal that states the true thing — nothing was written, and
 * sending it again is safe.
 *
 * Deterministic: the second transaction is held open by hand, and the cycle is
 * closed by a statement rather than by a timer.
 */
describe("a cycle egma's own order cannot prevent", () => {
  /** Long enough for a blocked query to be blocked rather than merely slow. */
  const A_BEAT = 250;

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

  it("comes back as a refusal that says so, never as a driver error", async () => {
    const leaving = await createPersona(auth, {
      name: "Cornered Cora",
      traits: TRAITS,
    });
    const taking = await createPersona(auth, {
      name: "Cornering Cyrus",
      traits: TRAITS,
    });
    await pointProjectAt(leaving.id);

    const connection = await openSingleConnection(database.url);
    try {
      // Somebody else's transaction, taking the two rows the other way round:
      // the replacement first, and the project afterwards.
      await connection.sql("begin");
      await connection.sql("select id from persona where id = $1 for update", [
        taking.id,
      ]);

      // The archive takes the project, then the persona leaving, then blocks
      // reaching for the replacement this connection is holding.
      const archiving = archivePersona(auth, leaving.id, {
        expectedRevision: leaving.revision,
        replacementPersonaId: taking.id,
      });
      expect(await hasFinished(archiving)).toBe(false);

      // And now the cycle closes: this connection reaches for the project the
      // archive is holding. Postgres breaks it by killing one of the two.
      const closing = connection
        .sql("select id from project where id = $1 for update", [projectId])
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

      const [archived, closed] = await Promise.all([
        archiving.then(
          () => undefined,
          (thrown: unknown) => thrown,
        ),
        closing,
      ]);

      // Whichever of the two Postgres chose, the archive never leaks a driver
      // error: it either finished, or it says what happened in egma's words.
      if (archived !== undefined) {
        expect(archived).toBeInstanceOf(WriteAbortedError);
        expect(String(archived)).toMatch(/sending it again is safe/);
      } else {
        expect(closed).toBeDefined();
      }
      expect(archived === undefined || closed === undefined).toBe(true);
    } finally {
      await connection.sql("rollback").catch(() => undefined);
      await connection.close();
    }
  });
});
