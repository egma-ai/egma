import { newId } from "@egma/ids";
import { and, asc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";

import { db, listen, type Listening, type Queryable } from "../client.ts";
import {
  gradingJob,
  type GradingJobStatus,
  type GradingSource,
} from "../schema/grading.ts";
import { validClaimant } from "./claimants.ts";
import type { AuthContext } from "./context.ts";
import { authorize, here } from "./permissions.ts";
import { within } from "./within.ts";

/**
 * The grading queue: how a finished conversation becomes work, and how the
 * grader service takes it. What a job *is* is the schema file's story
 * (`schema/grading.ts`); this file is how it is reached.
 *
 * ## The one place in this module that works the whole deployment
 *
 * Everything else here reads or writes one customer's rows and takes an
 * `AuthContext` to say which customer — resolved from a credential, never from
 * anything a caller passed. **The grader service has no credential**, and there
 * is no honest one to give it: it is egma's own engine, standing behind every
 * organization on the deployment at once, and an API key minted inside one
 * customer would be a key that either sees too little to do the job or is
 * quietly shared between customers to do it.
 *
 * So the exception is drawn as narrowly as it can be drawn, and it is drawn
 * here:
 *
 * - **`claimGradingJobs` is the only call that crosses organizations**, and the
 *   only table it can reach is this one — egma's own queue. It cannot be *asked*
 *   about a customer: it takes a claimant's name and a capacity, and there is
 *   no argument by which a caller could name whose work they want. A build rule
 *   holds it to that.
 * - **It carries out identifiers and no content.** A claim is a job id, a
 *   source, the conversation's id, and the organization and project that
 *   conversation belongs to. No transcript, no name, no configuration — nothing
 *   a customer wrote.
 * - **It hands back the context the work is done under.** Every read the grader
 *   makes afterwards — the conversation, the graders, the pinned test version —
 *   and every verdict it writes goes through the ordinary scoped surface, with
 *   the context this module built from the claimed job's own tenancy. The
 *   service never constructs one and so has no way to widen one.
 *
 * That is the same shape `resolveApiKey` has, with the claim in the credential's
 * place: something egma issued is handed back, and what it resolves to is the
 * only thing the holder can then reach. The difference — and it is why this is
 * written out at length rather than added to a list — is that a key is issued to
 * a person and a claim is issued by egma to itself.
 *
 * ## Waking, rather than asking again
 *
 * `watchGradingWork` is a `LISTEN` on the channel the enqueue raises inside the
 * transaction that lands a terminal transition, so a service wakes when a
 * conversation finishes rather than at the top of some interval. It is a hint
 * and not a delivery: the claim query is the whole truth, and a service that was
 * not running when a notification was raised finds the row waiting when it next
 * asks. That is why the watch also fires once on every connection it
 * establishes, and why a slow backstop sweep costs a service nothing to keep.
 */

/**
 * The Postgres channel a finished conversation is announced on. One channel for
 * the whole deployment: the payload is a job id, and what a listener does with
 * it is claim, which is a query that sees every outstanding job anyway.
 */
export const GRADING_WORK_CHANNEL = "egma_grading_work";

/** How many jobs one claim may take, however many copies are running. */
const LARGEST_CLAIM_CAPACITY = 50;

/**
 * How long a claimed job may go silent before another copy may take it.
 *
 * Generous next to the heartbeat interval, for the reason the orphan sweep's
 * window is: the one sin of a lease is calling a working service dead, and the
 * cost of waiting a little longer is a verdict arriving a little later — which
 * this product promises nothing about.
 */
const DEFAULT_LEASE_SECONDS = 120;

/**
 * How many times egma tries to judge one conversation before giving up on it.
 *
 * Counted on the claim rather than on the failure, so a copy that dies without
 * saying anything still counts. Three, because the failures worth retrying are
 * the transient ones — a judge model that timed out, a copy that was replaced
 * mid-judgment — and a fourth attempt at a conversation that has broken three
 * copies is a queue of one job growing forever.
 */
const MOST_ATTEMPTS = 3;

/** What a claim answers with, and no more — identifiers and tenancy. */
const CLAIM_COLUMNS = {
  id: gradingJob.id,
  organizationId: gradingJob.organizationId,
  projectId: gradingJob.projectId,
  source: gradingJob.source,
  simulationId: gradingJob.simulationId,
  attempts: gradingJob.attempts,
  claimedBy: gradingJob.claimedBy,
  claimedAt: gradingJob.claimedAt,
} as const;

/**
 * One job as the grader service holds it: which conversation, whose it is, and
 * the context every read and write about it goes through.
 */
export type GradingClaim = {
  readonly id: string;
  readonly source: GradingSource;
  /** The conversation, for a simulation's job; null for a production trace's. */
  readonly simulationId: string | null;
  readonly organizationId: string;
  readonly projectId: string;
  /** Including this one, so a copy can say which attempt it is making. */
  readonly attempts: number;
  readonly claimedBy: string;
  readonly claimedAt: Date;
  /**
   * Narrowed to this job's own organization and project, built here from the
   * claimed row and from nothing the claimant said. It is what the grader
   * reads the conversation and writes the verdicts through, so the work is done
   * inside one customer even though the claim that found it was not.
   */
  readonly auth: AuthContext;
};

/** One job as anybody reads it back. */
export type GradingJob = {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly source: GradingSource;
  readonly simulationId: string | null;
  readonly status: GradingJobStatus;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
};

const JOB_COLUMNS = {
  id: gradingJob.id,
  organizationId: gradingJob.organizationId,
  projectId: gradingJob.projectId,
  source: gradingJob.source,
  simulationId: gradingJob.simulationId,
  status: gradingJob.status,
  claimedBy: gradingJob.claimedBy,
  claimedAt: gradingJob.claimedAt,
  heartbeatAt: gradingJob.heartbeatAt,
  attempts: gradingJob.attempts,
  lastError: gradingJob.lastError,
  finishedAt: gradingJob.finishedAt,
  createdAt: gradingJob.createdAt,
} as const;

type JobRow = Omit<GradingJob, "source" | "status"> & {
  readonly source: string;
  readonly status: string;
};

function jobFromRow(row: JobRow): GradingJob {
  return {
    ...row,
    source: row.source as GradingSource,
    status: row.status as GradingJobStatus,
  };
}

/**
 * The person the engine is, which is nobody.
 *
 * `AuthContext.userId` is egma's own user id everywhere else, and there is no
 * user here — the grader service is a process, and the work it does was asked
 * for by whoever started the run rather than by it. Deliberately not shaped like
 * an identifier: nothing on the grading path writes it, and anything that ever
 * tried would be refused out loud by the foreign key to `user` rather than
 * quietly attributing a machine's act to a person.
 */
const THE_ENGINE = "engine";

/**
 * The context one claimed job is graded under.
 *
 * `viewer`, and that is the whole permission the engine needs: it reads the
 * conversation, the graders and the pinned test version, and the two things it
 * writes — verdict rows and this job's own bookkeeping — are egma's own records
 * rather than anything a customer authored. A context that could author
 * definitions would be a context that could do more than grade.
 */
function gradingContext(organizationId: string, projectId: string): AuthContext {
  return {
    userId: THE_ENGINE,
    organizationId,
    projectId,
    role: "viewer",
    via: "engine",
  };
}

/* ------------------------------------------------------------------- *
 * Becoming work.
 * ------------------------------------------------------------------- */

export type NewGradingJob = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly source: GradingSource;
  readonly simulationId: string | null;
};

/**
 * A finished conversation becomes claimable work.
 *
 * **Internal, and called only from inside the transaction that made the
 * conversation terminal.** That is the whole design: a simulation cannot land
 * `completed` or `failed` and leave no work behind, because the row that says
 * so and the row that says it needs judging are one commit. Nothing polls the
 * simulation table looking for conversations somebody forgot to enqueue,
 * because there is no window in which one could have been forgotten.
 *
 * The insert is idempotent — one job per conversation, held by a unique — so a
 * replayed terminal transition is a no-op rather than a second judgment.
 *
 * The notification rides the same transaction, so it is raised on commit and
 * never before: a listener woken by it always finds the row.
 */
export async function enqueueGradingJob(
  on: Queryable,
  job: NewGradingJob,
): Promise<void> {
  const [written] = await on
    .insert(gradingJob)
    .values({
      id: newId("gjb"),
      organizationId: job.organizationId,
      projectId: job.projectId,
      source: job.source,
      simulationId: job.simulationId,
      status: "pending",
    })
    .onConflictDoNothing({ target: gradingJob.simulationId })
    .returning({ id: gradingJob.id });

  if (written === undefined) return;
  await on.execute(
    sql`select pg_notify(${GRADING_WORK_CHANNEL}, ${written.id})`,
  );
}

/* ------------------------------------------------------------------- *
 * Taking work. The one call that works the whole deployment.
 * ------------------------------------------------------------------- */

export type GradingClaimRequest = {
  /** This copy of the grader service's own name for itself. */
  readonly claimant: string;
  /** How many conversations it will judge at once. */
  readonly capacity: number;
  /** How long its claim survives its silence; the default is generous. */
  readonly leaseSeconds?: number | undefined;
};

/**
 * The atomic claim, across every organization on this deployment.
 *
 * Up to `capacity` of the oldest outstanding jobs move to `claimed` in one
 * transaction, stamped with the claimant and their first heartbeat; whatever
 * another copy holds locked is skipped rather than waited on, so two copies
 * drain one queue without ever taking the same conversation. `SKIP LOCKED`,
 * exactly as `claimSimulations` does it, because it is exactly the same
 * problem.
 *
 * **Outstanding means two things**, and that is what makes a crashed copy cost
 * nothing: a job nobody has taken, and a job whose holder has been silent longer
 * than the lease. The second case is why there is no orphan sweep beside this
 * function — reclaiming an abandoned job *is* claiming, and a job has no
 * half-finished state for a sweep to tidy, because grading either produced
 * verdict rows or did not.
 *
 * A job that has been claimed `MOST_ATTEMPTS` times and still is not finished is
 * `abandoned` here instead of handed out again. egma stops trying; it does not
 * say anything about the agent, which is why the word is not `failed`.
 *
 * **It takes no `AuthContext` and cannot be given one.** See the note at the top
 * of this file: it is the one call in the module that reaches across customers,
 * it reaches only egma's own queue, it carries out identifiers rather than
 * content, and every claim it returns arrives with the narrowed context the work
 * is actually done under.
 */
export async function claimGradingJobs(
  request: GradingClaimRequest,
): Promise<readonly GradingClaim[]> {
  const claimant = validClaimant(request.claimant);
  const { capacity } = request;
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > LARGEST_CLAIM_CAPACITY
  ) {
    throw new Error(
      `a claim takes between 1 and ${LARGEST_CLAIM_CAPACITY} grading jobs`,
    );
  }

  const leaseSeconds = request.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error("a lease is a positive whole number of seconds");
  }

  const now = new Date();
  const silentSince = new Date(now.getTime() - leaseSeconds * 1000);

  const claimed = await db().transaction(async (tx) => {
    const candidates = await tx
      .select({ id: gradingJob.id, attempts: gradingJob.attempts })
      .from(gradingJob)
      .where(
        or(
          eq(gradingJob.status, "pending"),
          and(
            eq(gradingJob.status, "claimed"),
            lt(gradingJob.heartbeatAt, silentSince),
          ),
        ),
      )
      .orderBy(asc(gradingJob.id))
      .limit(capacity)
      .for("update", { skipLocked: true });

    if (candidates.length === 0) return [];

    // Bare `eq`s and `inArray`s from here down: every id came off the rows
    // locked just above, in this same transaction, so nothing below reaches
    // further than that select already did.
    const exhausted = candidates
      .filter((candidate) => candidate.attempts >= MOST_ATTEMPTS)
      .map((candidate) => candidate.id);
    if (exhausted.length > 0) {
      await tx
        .update(gradingJob)
        .set({ status: "abandoned", finishedAt: now })
        .where(inArray(gradingJob.id, exhausted));
    }

    const takeable = candidates
      .filter((candidate) => candidate.attempts < MOST_ATTEMPTS)
      .map((candidate) => candidate.id);
    if (takeable.length === 0) return [];

    return tx
      .update(gradingJob)
      .set({
        status: "claimed",
        claimedBy: claimant,
        claimedAt: now,
        heartbeatAt: now,
        attempts: sql`${gradingJob.attempts} + 1`,
      })
      .where(inArray(gradingJob.id, takeable))
      .returning(CLAIM_COLUMNS);
  });

  return claimed
    .map((row) => ({
      id: row.id,
      source: row.source as GradingSource,
      simulationId: row.simulationId,
      organizationId: row.organizationId,
      projectId: row.projectId,
      attempts: row.attempts,
      claimedBy: row.claimedBy ?? claimant,
      claimedAt: row.claimedAt ?? now,
      auth: gradingContext(row.organizationId, row.projectId),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Wake `onWork` whenever a conversation somewhere on this deployment becomes
 * claimable, and once when the watch is established.
 *
 * The nudge carries nothing — not which job, not whose — because what a listener
 * does with it is claim, and the claim is a query that sees everything
 * outstanding regardless. So this is the second call in the module that takes no
 * `AuthContext`, and the safer of the two: it names no table and returns no row.
 *
 * The handle is how a service stops listening. Closing it is the only thing to
 * do with it.
 */
export async function watchGradingWork(
  onWork: () => void,
): Promise<Listening> {
  return listen(GRADING_WORK_CHANNEL, onWork);
}

/* ------------------------------------------------------------------- *
 * Holding it, and letting it go. All inside one customer.
 * ------------------------------------------------------------------- */

/**
 * The job as the caller can reach it: this customer's, and this project's when
 * the context names one.
 */
function theJob(auth: AuthContext, id: string): SQL {
  return within(
    auth,
    gradingJob,
    auth.projectId === undefined
      ? eq(gradingJob.id, id)
      : and(eq(gradingJob.id, id), eq(gradingJob.projectId, auth.projectId)),
  );
}

/**
 * **No permission is asked for on the three calls below, deliberately**, on the
 * same terms as `appendVerdicts`: what may move a grading job is a question
 * about the caller, and the caller is the grader service, which answered it by
 * holding the claim. The guard is the claim itself — every one of them requires
 * the claimant's own name on the row, inside the context's tenancy — so a caller
 * who does not hold a job cannot move it, whatever their role.
 *
 * A row of the permission table decided in two places is a row that will one day
 * be decided two ways.
 */

/**
 * Still alive, still holding this job. `undefined` is a heartbeat with nothing
 * under it: a job out of reach, not this claimant's, or no longer claimed — the
 * signal to stop, not to retry.
 */
export async function recordGradingHeartbeat(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<{ readonly held: true } | undefined> {
  const [row] = await db()
    .update(gradingJob)
    .set({ heartbeatAt: new Date() })
    .where(
      and(
        theJob(auth, id),
        eq(gradingJob.claimedBy, validClaimant(claimant)),
        eq(gradingJob.status, "claimed"),
      ),
    )
    .returning({ id: gradingJob.id });

  return row === undefined ? undefined : { held: true };
}

/**
 * The conversation has been judged and the verdicts are written: `claimed →
 * graded`, once, by whoever held it. The guarded update is the check, so there
 * is no window in which the job moves between being looked at and being moved.
 */
export async function finishGradingJob(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<GradingJob | undefined> {
  const now = new Date();
  const [row] = await db()
    .update(gradingJob)
    .set({ status: "graded", finishedAt: now, heartbeatAt: now, lastError: null })
    .where(
      and(
        theJob(auth, id),
        eq(gradingJob.claimedBy, validClaimant(claimant)),
        eq(gradingJob.status, "claimed"),
      ),
    )
    .returning(JOB_COLUMNS);

  return row === undefined ? undefined : jobFromRow(row);
}

/**
 * This copy could not finish, and says so: `claimed → pending`, the claim
 * cleared, the reason kept. The job is anybody's again at once rather than
 * after the lease — a copy that knows it failed should not make the queue wait
 * out a silence that is not happening.
 *
 * The attempt is already counted, on the claim, so a job released this way is
 * one attempt closer to being abandoned exactly as a job whose holder vanished
 * is.
 */
export async function releaseGradingJob(
  auth: AuthContext,
  id: string,
  claimant: string,
  why: string,
): Promise<GradingJob | undefined> {
  const reason = why.trim();
  if (reason === "") {
    throw new Error("releasing a grading job says why it was released");
  }

  const [row] = await db()
    .update(gradingJob)
    .set({
      status: "pending",
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      lastError: reason,
    })
    .where(
      and(
        theJob(auth, id),
        eq(gradingJob.claimedBy, validClaimant(claimant)),
        eq(gradingJob.status, "claimed"),
      ),
    )
    .returning(JOB_COLUMNS);

  return row === undefined ? undefined : jobFromRow(row);
}

/** One job as it stands, within the caller's tenancy. */
export async function getGradingJob(
  auth: AuthContext,
  id: string,
): Promise<GradingJob | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select(JOB_COLUMNS)
    .from(gradingJob)
    .where(theJob(auth, id))
    .limit(1);

  return row === undefined ? undefined : jobFromRow(row);
}

/**
 * The jobs outstanding for one conversation — none once it has been graded.
 * What a page asking "is this judged yet" reads, and what a test asserts a
 * second grading of the same conversation did not create.
 */
export async function listGradingJobsForSimulation(
  auth: AuthContext,
  simulationId: string,
): Promise<readonly GradingJob[]> {
  authorize(auth, "read", here(auth));

  const rows = await db()
    .select(JOB_COLUMNS)
    .from(gradingJob)
    .where(
      within(
        auth,
        gradingJob,
        and(
          eq(gradingJob.simulationId, simulationId),
          auth.projectId === undefined
            ? undefined
            : eq(gradingJob.projectId, auth.projectId),
        ),
      ),
    )
    .orderBy(asc(gradingJob.id));

  return rows.map(jobFromRow);
}
