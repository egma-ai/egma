import { newId } from "@egma/ids";
import { and, eq, exists, isNull, sql } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import {
  GRADER_LIBRARY_CATALOG,
  PREDEFINED_GRADERS,
  type PredefinedGrader,
} from "../grader-library/catalog.ts";
import { grader, graderVersion } from "../schema/graders.ts";
import { project } from "../schema/tenancy.ts";
import type { GraderConfig } from "./graders.ts";

/**
 * The grader every project has, whether or not anybody asked for one.
 *
 * **`expected_behaviors` is not optional, and this file is why.** A test says
 * what should happen; running it means checking whether it did. Before the
 * redesign that check was implicit — a built-in that was never a row, judging
 * every simulation and writing a sentinel string where verdict rows want a
 * grader id. It is a row now, and the moment it became one it became something a
 * project could be missing. So two writes make sure no project ever is:
 *
 * - **At birth.** Project creation writes the copy in its own transaction, so
 *   there is no instant in which a project exists and judges nothing.
 * - **At start-up.** The backfill below gives one to every project that has
 *   never had one, which is every project created before this change. The
 *   product is pre-launch, and dev and demo databases still hold projects; none
 *   of them may quietly lose mandatory grading because a release moved where it
 *   lived.
 *
 * The two write the same rows, and `insertSeededGrader` is the one place that
 * decides what they are.
 */

/**
 * The entry every project is seeded with, read off the catalog rather than
 * described again here — a second description of one entry is a second thing
 * that can be wrong about it.
 */
const THE_SEEDED_ENTRY = ((): PredefinedGrader => {
  const entry = GRADER_LIBRARY_CATALOG.find(
    (candidate) => candidate.id === PREDEFINED_GRADERS.expectedBehaviors,
  );
  if (entry === undefined) {
    throw new Error(
      "Egma's catalog no longer ships the expected-behaviors grader, and every project is seeded with a copy of it",
    );
  }
  return entry;
})();

/** The copy's config: empty, and complete. Written once, used by both writers. */
const NOTHING_TO_FILL_IN: GraderConfig = { assertions: [] };

/**
 * What the backfill's advisory lock is taken on: this act, on this deployment,
 * and nothing narrower.
 *
 * Not per project, which would be the finer lock and the wrong one — the read
 * that decides which projects lack a copy spans them all, so two replicas
 * holding two different project locks would still both read the same "none of
 * them has one" and both write.
 */
const SEEDING_RUNNING_GRADERS = "egma:seed-running-graders";

/**
 * What one seeded copy is, as two rows.
 *
 * **Written by hand rather than by calling the Use door**, for the reason the
 * starter persona is: this happens inside somebody else's transaction — project
 * creation, or the backfill — and there is no `AuthContext` at either of those
 * moments. The two write shapes are held together by a test rather than by the
 * compiler.
 *
 * The two inserts are the two Use makes, in the same order: the identity row
 * first, naming a version that does not exist yet, because that pointer's
 * constraint is deferred and Postgres checks it at commit.
 *
 * Nothing here reads the entry from the database. The identifier is the
 * catalog's own fixed one, and the foreign key is what says the row is really
 * there — a project seeded before egma's own graders reached the shelf is
 * refused rather than left pointing at nothing.
 */
export async function insertSeededGrader(
  on: Queryable,
  values: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly createdBy: string | null;
  },
): Promise<string> {
  const id = newId("grd");
  const versionId = newId("grv");

  await on.insert(grader).values({
    id,
    organizationId: values.organizationId,
    projectId: values.projectId,
    libraryId: THE_SEEDED_ENTRY.id,
    // Name and type off the catalog entry itself, so the row a project is born
    // with is the row pressing Use would have made.
    name: THE_SEEDED_ENTRY.name,
    description: null,
    type: THE_SEEDED_ENTRY.type,
    // Required, and simulations-only. Structurally: a production trace has no
    // test, so there are no expected behaviors for this grader to read there.
    required: true,
    scope: "simulations",
    currentVersionId: versionId,
    createdBy: values.createdBy,
  });

  await on.insert(graderVersion).values({
    id: versionId,
    graderId: id,
    version: 1,
    config: NOTHING_TO_FILL_IN,
    judgeModel: null,
    createdBy: values.createdBy,
  });

  return id;
}

/** One copy the backfill wrote, as the boot log names it. */
export type SeededGraderCopy = {
  readonly id: string;
  readonly projectId: string;
};

/**
 * Give every project that has never had one a copy of egma's
 * `expected_behaviors` grader.
 *
 * **Idempotent, and the question it asks is what makes it so.** It asks whether
 * a project has *ever* held a copy of the entry, deleted rows included — not
 * whether it holds a living one. Deleting a copy is how a grader is switched off
 * (there is no other switch), so a backfill that only looked at living rows
 * would write the grader back every time a container started and overrule a
 * person every morning. Run it twice on an untouched deployment and the second
 * run writes nothing at all.
 *
 * **Not authorized against an `AuthContext`, on the platform settings' and the
 * library seeding's exact terms.** There is no user here: this is the deployment
 * finishing a change it shipped, in the same breath as applying its migrations,
 * and it reaches every project because a project missing its mandatory grading
 * is missing it whoever owns it. It takes no argument at all, so there is no
 * customer for a caller to name.
 *
 * **One backfill runs at a time across the whole deployment**, held by an
 * advisory lock taken before anything is read. Two replicas start together far
 * more often than they do not — that is what a rolling deploy *is* — and this
 * is a read followed by a write with nothing in the database to stop the second
 * one: both would find a project holding no copy, both would insert, and the
 * project would end up judging every behavior twice and billing for it, forever,
 * with no surface to remove either row.
 *
 * The lock rather than a unique index, deliberately. **A second copy of one
 * entry is allowed** — it is how per-agent strictness will work once filters
 * arrive — so the database must not forbid what the product means to permit.
 * What has to be single is this act, and an advisory lock says exactly that.
 * `runMigrations` takes one for the same reason a line earlier in the same boot.
 *
 * Soft-deleted projects are left alone: nothing runs in them, so nothing in them
 * can run unjudged.
 */
export async function seedRunningGraders(): Promise<
  readonly SeededGraderCopy[]
> {
  return db().transaction(async (tx) => {
    // Taken before anything is read and let go when the transaction ends, so
    // the replica that arrives second waits here and then reads what the first
    // one wrote — finding every project already holding its copy, and writing
    // nothing.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${SEEDING_RUNNING_GRADERS}::text, 0))`,
    );

    const projects = await tx
      .select({
        id: project.id,
        organizationId: project.organizationId,
      })
      .from(project)
      .where(
        and(
          isNull(project.deletedAt),
          sql`not ${exists(
            tx
              .select({ one: sql`1` })
              .from(grader)
              .where(
                and(
                  eq(grader.projectId, project.id),
                  eq(grader.libraryId, THE_SEEDED_ENTRY.id),
                ),
              ),
          )}`,
        ),
      )
      .orderBy(project.id);

    if (projects.length === 0) return [];

    const seeded: SeededGraderCopy[] = [];
    for (const one of projects) {
      // One project at a time, in the same transaction: the list is a set
      // somebody maintains by hand rather than a stream, and a loop that writes
      // the two rows Use writes is worth more than a set-based insert that has
      // to say the same thing twice.
      const id = await insertSeededGrader(tx, {
        organizationId: one.organizationId,
        projectId: one.id,
        // Nobody: egma wrote this, and a project's owner did not ask for it.
        createdBy: null,
      });
      seeded.push({ id, projectId: one.id });
    }

    return seeded;
  });
}
