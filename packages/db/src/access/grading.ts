import { isId, newId } from "@egma/ids";
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { db, listen, type Listening, type Queryable } from "../client.ts";
import {
  gradingJob,
  type GradingJobStatus,
  type GradingSource,
} from "../schema/grading.ts";
import { run, simulation } from "../schema/runs.ts";
import { validClaimant } from "./claimants.ts";
import type { AuthContext } from "./context.ts";
import { getGrader } from "./graders.ts";
import { authorize, here } from "./permissions.ts";
import type { NewSpan } from "./spans.ts";
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
 *
 * ## And the other source, which nobody can wake for
 *
 * A production trace has no transaction to ride and no moment anybody owns. It
 * arrives as spans, so `recordProductionTraces` is called by the ingest door,
 * once per export, and writes the two facts completion is decided from: when
 * egma last heard about this trace, and whether the export carried its root
 * span. **That is a queue write and a notification and nothing else** — no
 * grader is resolved, no conversation is read, and no judgment is made anywhere
 * near a request path. What the API process must stay free of is judge work,
 * which would make an exporter's timeout depend on somebody's judge model; it
 * was never free of bookkeeping.
 *
 * The two ways such a trace completes are answered in two different places, and
 * they have to be:
 *
 * - **Its root span closed.** An exporter sends a span when the span ends, so a
 *   root arriving at the door *is* the conversation ending. The door stamps
 *   `root_closed_at` and raises the same notification a terminal transition
 *   does, so the wake-up is immediate and no interval is on the path.
 * - **It went quiet.** An exporter that never closes a root would otherwise
 *   leave a conversation unjudged forever, and there is nothing to be woken by:
 *   the completing event is the *absence* of one. So this half is inherently a
 *   sweep, and it is the claim query below — a trace nothing has arrived for in
 *   longer than `idleSeconds` is claimable, which the grader service discovers
 *   on the backstop pass it already makes.
 *
 * ## Asking for a conversation to be judged again
 *
 * A conversation becomes work once, when it ends, and a job is unique on the
 * conversation — so asking for it again **reopens** that one job rather than
 * filing a second. `reopenGradingJob` is that verb, `regrade` is the deliberate
 * action a person takes with it over a run or a window, and both raise the same
 * notification the enqueue does, because a service should wake for a re-grade
 * exactly as it wakes for a conversation ending.
 *
 * Nothing about a re-grade names a grader *version*. The job is a conversation,
 * the service judges it with whatever applies to it **at each grader's current
 * version**, and that is what puts a tightened grader's rows beside the old ones
 * rather than over them: the verdict's identity spans the grader version, so a
 * grader nobody edited rewrites its own row in place and only the edited one
 * adds.
 *
 * A re-grade **may** name a grader, and that is a question about spend rather
 * than about what the rows come to say. Re-judging the conversation whole
 * accumulates exactly the rows re-judging one grader would; it also asks every
 * LLM judge on the conversation again, and somebody who fixed one rubric did not
 * ask to pay for the other four. So the grader a re-grade named travels on the
 * reopened job — `grading_job.regrade_grader_id`, cleared the moment the job
 * settles — and the engine reads it off the claim. Omitting it re-judges the
 * conversation, which is what a re-grade has always meant.
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

/**
 * How long a production trace has to be quiet before egma judges it without a
 * closed root span.
 *
 * Five minutes, and the number is a compromise nobody gets to avoid making. Too
 * short and a caller left on hold is judged mid-conversation, on half a
 * transcript; too long and a broken exporter's traces sit unjudged for an
 * afternoon. It only ever applies to telemetry that never closed its root — a
 * well-behaved exporter's traces are judged the moment the conversation ends,
 * whatever this says — so the cost of erring long is paid by the deployment that
 * is already misconfigured.
 */
const DEFAULT_TRACE_IDLE_SECONDS = 300;

/**
 * What a claim answers with, and no more — identifiers, tenancy, and the two
 * instants egma's own door stamped on the trace.
 *
 * The window is here because reading the conversation back needs one: the trace
 * store files spans by the minute they started in, so a read naming only a trace
 * id would have nothing to prune with. They are timestamps egma wrote, not
 * anything a customer authored, which is the line this claim has always drawn.
 *
 * The grader a re-grade narrowed to is here on the same terms: an identifier
 * egma minted, saying which of this customer's graders to judge with — never
 * what that grader says, which the engine reads for itself through the scoped
 * surface with the context this claim hands back.
 */
const CLAIM_COLUMNS = {
  id: gradingJob.id,
  organizationId: gradingJob.organizationId,
  projectId: gradingJob.projectId,
  source: gradingJob.source,
  simulationId: gradingJob.simulationId,
  traceId: gradingJob.traceId,
  firstSpanAt: gradingJob.firstSpanAt,
  lastSpanAt: gradingJob.lastSpanAt,
  regradeGraderId: gradingJob.regradeGraderId,
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
  /** And the other way round: the trace, for a production job; null otherwise. */
  readonly traceId: string | null;
  /**
   * When the trace's earliest and latest spans began — the window its transcript
   * is read inside. Null for a simulation, which is read from its own row.
   */
  readonly firstSpanAt: Date | null;
  readonly lastSpanAt: Date | null;
  readonly organizationId: string;
  readonly projectId: string;
  /**
   * The one grader this job was reopened for, or null for the whole
   * conversation — which is what a first grading and an un-narrowed re-grade
   * both are.
   *
   * The engine judges with this grader and nothing else when it is set: not the
   * other graders that apply, and not the built-in. Somebody who fixed one
   * rubric asked for one rubric's judgment, and every other judge call on the
   * conversation would be spend they did not ask for.
   */
  readonly regradeGraderId: string | null;
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
  readonly traceId: string | null;
  readonly firstSpanAt: Date | null;
  readonly lastSpanAt: Date | null;
  /** When a span of this trace last arrived; what the idle window is measured from. */
  readonly lastSeenAt: Date | null;
  /** When the root span closed the trace, or null for one that never closed. */
  readonly rootClosedAt: Date | null;
  readonly status: GradingJobStatus;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly attempts: number;
  readonly lastError: string | null;
  /**
   * The one grader this job stands reopened for, or null for the whole
   * conversation. Never set on a job that has settled: the narrowing belongs to
   * the asking rather than to the job, and a check on the table holds it there.
   */
  readonly regradeGraderId: string | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
};

const JOB_COLUMNS = {
  id: gradingJob.id,
  organizationId: gradingJob.organizationId,
  projectId: gradingJob.projectId,
  source: gradingJob.source,
  simulationId: gradingJob.simulationId,
  traceId: gradingJob.traceId,
  firstSpanAt: gradingJob.firstSpanAt,
  lastSpanAt: gradingJob.lastSpanAt,
  lastSeenAt: gradingJob.lastSeenAt,
  rootClosedAt: gradingJob.rootClosedAt,
  status: gradingJob.status,
  claimedBy: gradingJob.claimedBy,
  claimedAt: gradingJob.claimedAt,
  heartbeatAt: gradingJob.heartbeatAt,
  attempts: gradingJob.attempts,
  lastError: gradingJob.lastError,
  regradeGraderId: gradingJob.regradeGraderId,
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

/**
 * What one export said about one of the conversations it carried.
 *
 * The two instants are the spans' own start times rather than anything about
 * when they arrived, and `rootClosed` is whether this export carried the span
 * the whole conversation happened inside.
 */
type ProductionTraceActivity = {
  readonly traceId: string;
  readonly firstSpanAt: Date;
  readonly lastSpanAt: Date;
  readonly rootClosed: boolean;
};

/**
 * A production trace becomes known, and — when its root closes — claimable work.
 *
 * Called by the ingest door with the very spans it just appended, after they are
 * stored and once per export. **It writes bookkeeping and raises a notification,
 * and does nothing else**: no grader is resolved, no conversation is read,
 * nothing is judged. Judging is the grader service's, and the request path stays
 * clear of it.
 *
 * It takes the spans rather than a summary of them so that **what completion
 * means is written down once**. A caller that computed "which trace, how wide,
 * did the root arrive" for itself would be a second reader of span shape,
 * disagreeing with this one the first time either changed — and the disagreement
 * would show up as conversations that were never judged, which is the failure
 * nobody notices.
 *
 * The row is written on the first export that carries any span of a trace and
 * updated by every export after it, which is why the whole thing is one upsert
 * against the `trace_id` unique: an exporter flushes a conversation in as many
 * batches as it likes, in whatever order, and they all land on one row. That
 * unique is also why no conversation is ever judged twice — a second job for a
 * trace is unrepresentable rather than merely never written.
 *
 * **A job already claimed or already graded is not touched**, which is the whole
 * of what late spans do. Telemetry that arrives after egma judged a trace does
 * not resurrect the job, does not re-open the conversation and does not queue a
 * second judgment: re-grading history is a deliberate action somebody asks for,
 * never something a straggling export causes.
 *
 * **A credential naming no project writes nothing here, deliberately.** Its
 * spans file under the store's `default` sentinel, which is not a project row
 * and could not carry the tenancy triangle a job needs; and graders belong to
 * projects, so such a trace has no graders to be judged by in the first place.
 * The same sentence the grader factory says: a credential for the whole customer
 * is acting in no project.
 *
 * No permission is asked for, on the same terms as `appendSpans` beside it: what
 * may write telemetry is decided once, at the door, before a byte of the body is
 * read.
 */
export async function recordProductionTraces(
  auth: AuthContext,
  spans: readonly NewSpan[],
): Promise<void> {
  const { projectId } = auth;
  if (projectId === undefined) return;

  const traces = productionTracesIn(spans);
  if (traces.length === 0) return;

  const seenAt = new Date();

  // One statement, and it is safe to batch precisely because the traces were
  // gathered by id above: Postgres refuses an upsert that would touch one row
  // twice, so a values list with a trace in it twice would fail the whole
  // export rather than record either half of it.
  const written = await db()
    .insert(gradingJob)
    .values(
      traces.map((trace) => ({
        id: newId("gjb"),
        organizationId: auth.organizationId,
        projectId,
        source: "production" as const,
        traceId: trace.traceId,
        status: "pending" as const,
        firstSpanAt: trace.firstSpanAt,
        lastSpanAt: trace.lastSpanAt,
        lastSeenAt: seenAt,
        rootClosedAt: trace.rootClosed ? seenAt : null,
      })),
    )
    .onConflictDoUpdate({
      target: gradingJob.traceId,
      set: {
        // Widened, never replaced: exports arrive in the order an exporter felt
        // like sending them, so the window a trace is read inside is the widest
        // anybody has seen rather than the newest anybody reported.
        firstSpanAt: sql`least(${gradingJob.firstSpanAt}, excluded.first_span_at)`,
        lastSpanAt: sql`greatest(${gradingJob.lastSpanAt}, excluded.last_span_at)`,
        lastSeenAt: sql`excluded.last_seen_at`,
        // A root closes once. Keeping the first answer means a trace cannot be
        // un-completed by a later flush of spans that were buffered behind it.
        rootClosedAt: sql`coalesce(${gradingJob.rootClosedAt}, excluded.root_closed_at)`,
      },
      // A row that came back is a row still waiting to be judged. One that did
      // not is a conversation already claimed or already graded, and a late span
      // is not a reason to do either again.
      setWhere: eq(gradingJob.status, "pending"),
    })
    .returning({ id: gradingJob.id, rootClosedAt: gradingJob.rootClosedAt });

  // The conversations that are over wake somebody — the same nudge a
  // simulation's terminal transition raises, on the same channel, carrying the
  // same nothing. A trace that goes quiet without a root raises none: there is
  // no event to raise one on, which is why the claim query sweeps for it.
  for (const job of written) {
    if (job.rootClosedAt === null) continue;
    await db().execute(sql`select pg_notify(${GRADING_WORK_CHANNEL}, ${job.id})`);
  }
}

/**
 * The production conversations one export carried, gathered by trace.
 *
 * **A trace is over when its root span closes**, and an export can tell: an
 * OpenTelemetry exporter sends a span when the span *ends*, so the root — the
 * one span the whole conversation happened inside — arriving here is the
 * conversation having ended. The captured LiveKit trace does exactly that: a
 * hundred and thirty-three spans across fourteen flushes, and `agent_session`
 * comes alone in the last one.
 *
 * A root is a span naming no parent, which is the recognition the whole store
 * already uses — `parent_span_id` is empty on a root, and the trace read files
 * such a span at the top. It has one consequence worth saying out loud: a span
 * whose parent id arrived malformed is normalised to no parent at all, so
 * telemetry a hand-written client mangled can complete a trace early. The
 * alternative is reading a framework's own word for its root out of the span
 * name, which would make completion mean something different for every provider
 * egma ever supports — and a trace completed early is judged on what arrived,
 * while a trace completed by nobody is judged by the idle window anyway.
 *
 * Simulations are skipped rather than absent: they reach the queue through the
 * transaction that ends them, so even when egma's own runtime starts exporting
 * through this door its spans must not make a second job.
 *
 * Nothing here decides whether a trace *should* be graded. It reports what
 * arrived; which graders apply, and whether this trace is their turn, are
 * questions asked much later by a service that holds no request open.
 */
function productionTracesIn(
  spans: readonly NewSpan[],
): readonly ProductionTraceActivity[] {
  const seen = new Map<
    string,
    { first: bigint; last: bigint; rootClosed: boolean }
  >();

  for (const span of spans) {
    if (span.source !== "production") continue;

    const isRoot = span.parentSpanId === "";
    const found = seen.get(span.traceId);
    if (found === undefined) {
      seen.set(span.traceId, {
        first: span.startedAtMicroseconds,
        last: span.startedAtMicroseconds,
        rootClosed: isRoot,
      });
      continue;
    }

    if (span.startedAtMicroseconds < found.first) {
      found.first = span.startedAtMicroseconds;
    }
    if (span.startedAtMicroseconds > found.last) {
      found.last = span.startedAtMicroseconds;
    }
    found.rootClosed ||= isRoot;
  }

  return [...seen].map(([traceId, when]) => ({
    traceId,
    // Milliseconds, because that is what a timestamp column reads back into.
    // The lost microseconds cost nothing: the window is widened at both ends
    // before a transcript is read with it, and the store buckets a span to the
    // minute it started in regardless.
    firstSpanAt: new Date(Number(when.first / 1_000n)),
    lastSpanAt: new Date(Number(when.last / 1_000n)),
    rootClosed: when.rootClosed,
  }));
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
  /**
   * How long a production trace must have been quiet before it is judged
   * without a closed root span. The deployment's own patience, which is why it
   * is asked for here rather than stamped on the row at ingest: the door records
   * what it saw, and how long is long enough is the judging side's policy.
   */
  readonly idleSeconds?: number | undefined;
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
 * **A production trace adds a third condition to the first of those**, and this
 * is where the idle-timeout fallback actually lives. Such a job is written when
 * the trace's first span arrives, so `pending` alone would hand out a
 * conversation that is still happening; it is claimable once its root span
 * closed it, or once nothing has arrived for it in longer than `idleSeconds`.
 * The second half is a sweep by nature — the event it waits for is the absence
 * of events, so nobody can be woken for it — and it is a predicate here rather
 * than a background job because the query that hands out work is already run on
 * an interval by every copy of the service.
 *
 * A simulation is never asked either question. It is complete because a
 * transaction said so, and sampling and idleness are both about traffic egma did
 * not cause.
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

  const idleSeconds = request.idleSeconds ?? DEFAULT_TRACE_IDLE_SECONDS;
  if (!Number.isInteger(idleSeconds) || idleSeconds < 1) {
    throw new Error("an idle window is a positive whole number of seconds");
  }

  const now = new Date();
  const silentSince = new Date(now.getTime() - leaseSeconds * 1000);
  const quietSince = new Date(now.getTime() - idleSeconds * 1000);

  // The conversation is over: a simulation's transaction said so, a trace's root
  // span closed, or nothing has arrived for the trace in longer than the idle
  // window and egma judges what it has rather than waiting forever.
  const finished = or(
    eq(gradingJob.source, "simulation"),
    isNotNull(gradingJob.rootClosedAt),
    lt(gradingJob.lastSeenAt, quietSince),
  );

  const claimed = await db().transaction(async (tx) => {
    const candidates = await tx
      .select({ id: gradingJob.id, attempts: gradingJob.attempts })
      .from(gradingJob)
      .where(
        or(
          and(eq(gradingJob.status, "pending"), finished),
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
        // The narrowing goes with the giving-up. egma is not going to judge
        // this conversation for that grader, and a job left narrowed after it
        // settles would hand the instruction to whoever reopens it next.
        .set({ status: "abandoned", finishedAt: now, regradeGraderId: null })
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
      traceId: row.traceId,
      firstSpanAt: row.firstSpanAt,
      lastSpanAt: row.lastSpanAt,
      organizationId: row.organizationId,
      projectId: row.projectId,
      regradeGraderId: row.regradeGraderId,
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
 *
 * **Finishing is where a narrowing ends.** The grader a re-grade named was an
 * instruction for this one piece of work, and the work is done — so the next
 * time this conversation is asked about, whether by an ordinary re-grade or by a
 * narrowed one naming a different grader, it starts from the whole conversation
 * again. A job that carried its last instruction forward would judge less and
 * less of a conversation the more often anybody asked about it.
 */
export async function finishGradingJob(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<GradingJob | undefined> {
  const now = new Date();
  const [row] = await db()
    .update(gradingJob)
    .set({
      status: "graded",
      finishedAt: now,
      heartbeatAt: now,
      lastError: null,
      regradeGraderId: null,
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

/**
 * The job standing behind one production trace, if egma has heard of it.
 *
 * One rather than a list, and that is the `trace_id` unique speaking: a trace
 * has exactly one job for its whole life, from the first span that arrives to
 * the verdicts that land. So this answers three questions with one row — has
 * egma seen this conversation, is it over, has it been judged — and it is what a
 * test asserts a second grading never created.
 */
export async function getGradingJobForTrace(
  auth: AuthContext,
  traceId: string,
): Promise<GradingJob | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select(JOB_COLUMNS)
    .from(gradingJob)
    .where(
      within(
        auth,
        gradingJob,
        and(
          eq(gradingJob.traceId, traceId),
          auth.projectId === undefined
            ? undefined
            : eq(gradingJob.projectId, auth.projectId),
        ),
      ),
    )
    .limit(1);

  return row === undefined ? undefined : jobFromRow(row);
}

/* ------------------------------------------------------------------- *
 * Asking for it again.
 * ------------------------------------------------------------------- */

/** A job that is finished with, one way or the other, and can be asked again. */
const SETTLED: readonly GradingJobStatus[] = ["graded", "abandoned"];

/** A job that is already going to be judged, and needs nothing asked of it. */
const OUTSTANDING: readonly GradingJobStatus[] = ["pending", "claimed"];

/**
 * How many conversations one re-grade may reopen.
 *
 * A re-grade re-spends the judge on every conversation it names, so the cost of
 * a window somebody got wrong is real money rather than a slow page. It is
 * **refused rather than quietly narrowed**, for the reason the trace store
 * refuses a window it cannot serve: narrowing answers a smaller question than
 * the one asked and says nothing about having done so, and a person who meant
 * the whole month would conclude the month was thinner than it is.
 *
 * A run conducts at most two hundred conversations, so a run can never reach
 * this — which is what keeps it a guard on the window rather than a limit on
 * the ordinary case.
 */
const MOST_CONVERSATIONS_PER_REGRADE = 500;

/**
 * A conversation that has been judged becomes claimable work again.
 *
 * `graded → pending`, or `abandoned → pending`, with the claim cleared and the
 * attempts back to nothing — an abandoned job is one egma gave up on after three
 * attempts, and reopening it without resetting the count would abandon it again
 * on the first claim. The last error is cleared with them: a reader seeing
 * `pending` beside a stale reason would read this attempt as already failed.
 *
 * **The row is reopened rather than replaced**, which is the whole reason the
 * unique on the conversation is worth having. `created_at` therefore stays the
 * moment the conversation became judgeable, so a window means the same thing
 * before and after a re-grade of it, and asking twice is asking twice rather
 * than moving the conversation to today.
 *
 * A job that is `pending` or `claimed` is left exactly alone and answers
 * `undefined`: it is already going to be judged, at today's grader versions,
 * which is everything a re-grade was going to ask for. So does a job out of the
 * caller's reach — the answer reading it would have given.
 *
 * **This verb asks for the whole conversation and cannot ask for less.**
 * Narrowing to one grader is a re-grade's decision, made by the person who named
 * one, and it travels through `regrade` — so a job reopened here is explicitly
 * un-narrowed rather than left carrying whatever the last ask said.
 *
 * The notification rides the same transaction as the update, exactly as the
 * enqueue's does, so a service woken by it always finds the row pending.
 */
export async function reopenGradingJob(
  auth: AuthContext,
  id: string,
): Promise<GradingJob | undefined> {
  authorize(auth, "revisit_verdicts", here(auth));

  const [only] = await reopenJobs(theJob(auth, id), null);
  return only;
}

/**
 * The reopen itself, over whatever set of this customer's jobs the caller
 * resolved. Every caller passes a predicate that already carries the tenancy,
 * and a predicate that came out empty is refused rather than run — an update
 * with no `where` on this table would reopen the whole deployment's queue, so
 * the one shape that could do it is the one shape that cannot be passed.
 *
 * `forGrader` is written every time, `null` included, so that what the engine
 * will read off these jobs is what this reopen asked for and never what an
 * earlier one did.
 */
async function reopenJobs(
  theseJobs: SQL | undefined,
  forGrader: string | null,
): Promise<readonly GradingJob[]> {
  if (theseJobs === undefined) {
    throw new Error("reopening grading work always names whose work it reaches");
  }

  return db().transaction(async (tx) => {
    const rows = await tx
      .update(gradingJob)
      .set({
        status: "pending",
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
        attempts: 0,
        lastError: null,
        finishedAt: null,
        regradeGraderId: forGrader,
      })
      .where(and(theseJobs, inArray(gradingJob.status, [...SETTLED])))
      .returning(JOB_COLUMNS);

    if (rows.length === 0) return [];

    // One notification per conversation, which is what the enqueue raises and
    // what a copy of the service expects to be woken by. The payload is the job
    // id and nothing reads it — a claim is a query that sees everything
    // outstanding — so this is a nudge repeated, never a delivery.
    await tx.execute(
      sql`select pg_notify(${GRADING_WORK_CHANNEL}, ${gradingJob.id})
          from ${gradingJob}
          where ${inArray(
            gradingJob.id,
            rows.map((row) => row.id),
          )}`,
    );

    return rows.map(jobFromRow);
  });
}

/**
 * A window of time, closed at the start and open at the end, measured on the
 * moment each conversation **became judgeable** — the terminal transition that
 * made it work, which is the same commit that ended it.
 *
 * That anchor rather than the conversation's own clock, because it is the one
 * fact both sources have: a simulation ends in the transaction that enqueues it,
 * and a production trace completing is what will enqueue that. And because it
 * never moves — reopening a job leaves it alone — so re-grading the same window
 * twice names the same conversations both times.
 *
 * `Date`s, because this is Postgres and the column holds a timestamp. The trace
 * store's windows count microseconds for the opposite reason: its columns do.
 */
export type RegradeWindow = {
  readonly from: Date;
  readonly to: Date;
};

/**
 * Which conversations to judge again: one run's, or every one that became
 * judgeable inside a window.
 *
 * Both are honest halves of the same act rather than one shape with a
 * convenience on top. A run is how somebody re-scores a suite they just watched
 * fail on a grader they have since fixed; a window is how they re-score
 * production, which belongs to no run and never will.
 */
type RegradeConversations =
  | { readonly runId: string }
  | { readonly window: RegradeWindow };

/**
 * What to judge again: which conversations, and — if the person asking says so
 * — which grader.
 *
 * The ticket's words are "a run (or a time window) **and a grader**", and this
 * makes the grader optional rather than required. Both readings are coherent,
 * and the difference is only ever about judge spend: re-judging the conversation
 * whole accumulates exactly the rows re-judging one grader would, because a
 * grader nobody edited rewrites its own row in place. What it also does is ask
 * every LLM judge on that conversation again.
 *
 * So:
 *
 * - **A grader named** narrows the re-judge to that one grader, at its current
 *   version. Nothing else on the conversation is judged — not the other graders,
 *   not the built-in — and nothing else's rows are touched. This is what
 *   somebody who fixed one rubric is asking for, and it is the only shape in
 *   which fixing a rubric costs one rubric's worth of judging.
 * - **No grader named** re-judges the conversation, which is what a re-grade has
 *   always meant here and stays the default so that the plain ask keeps working.
 *
 * The grader is named **by identity**, never by version. Which version judges is
 * always the current one — that is the whole point of asking again — exactly as
 * a test's grader array names a grader and gets today's version of it.
 *
 * **The built-in `expected_behaviors` grader cannot be named**, and that is a
 * consequence of what it is rather than an omission here: it is never a row in
 * any table, so it has no identity to name. Re-judging a test's expected
 * behaviors alone is future work; today they are re-judged by asking for the
 * conversation.
 */
export type RegradeTarget = RegradeConversations & {
  /**
   * The one grader to judge with, or absent for every grader that applies.
   * Validated like any other read: the shape first, then whether the caller can
   * reach it at all.
   */
  readonly graderId?: string | undefined;
};

export type Regraded = {
  /** The conversations asked for again, as their jobs now stand. */
  readonly reopened: readonly GradingJob[];
  /**
   * The grader this re-grade narrowed to, or null for the whole conversation.
   * It is what the reopened jobs carry, echoed back so a caller sees the ask
   * that was actually made rather than the one they typed.
   */
  readonly graderId: string | null;
  /**
   * How many of the conversations named were already waiting to be judged and
   * were left exactly alone. They are not a failure and not a skip: a
   * conversation still in the queue is going to be judged at today's grader
   * versions, which is all a re-grade was going to ask for.
   */
  readonly alreadyWaiting: number;
};

/**
 * Judge these conversations again, at whatever the current grader version is.
 *
 * **This is the only thing that ever re-scores history, and somebody has to ask
 * for it.** Editing a grader mints a version and changes nothing that was
 * already judged; the rows written last week keep saying what they said, in the
 * words of the version that decided them. A tightened threshold reaches
 * yesterday only through this call, which is what makes "our numbers changed
 * overnight" impossible to arrive at by accident.
 *
 * **The ask may name a grader, and then only that grader judges.** Every other
 * grader's rows on those conversations are left exactly where they are, and no
 * judge is asked anything on their behalf — which is what keeps fixing one
 * rubric from re-spending the whole conversation's judging. The narrowing rides
 * the reopened job, so the engine reads it long after the person asking has
 * gone, and it is cleared when the job finishes. Naming no grader re-judges the
 * conversation, which is what this call has always done.
 *
 * What comes of it is rows **beside** the old ones rather than over them,
 * because the verdict's identity spans the grader version: the graders nobody
 * edited rewrite their own rows in place, the edited one writes a second row
 * against the same dimension, and the read prefers the newest grading with the
 * older still fetchable underneath. Nothing is deleted and nothing is edited,
 * here or anywhere.
 *
 * The conversations are resolved, their jobs reopened, and the service does the
 * judging — so a re-grade returns as soon as the work is queued rather than when
 * it is done, on the same terms as starting a run. What comes back says how many
 * conversations were asked for and how many were already going to be judged.
 *
 * A run nobody can reach answers `undefined`, which is the answer reading it
 * would have given, and so does a grader nobody can reach — a thing that is not
 * there is not there, whichever of the two was named. A window that holds
 * nothing still answers, because a window with nothing in it is a different fact
 * from a window that is not there.
 */
export async function regrade(
  auth: AuthContext,
  target: RegradeTarget,
): Promise<Regraded | undefined> {
  authorize(auth, "revisit_verdicts", here(auth));

  const graderId = await theGraderNamed(auth, target.graderId);
  if (graderId === undefined) return undefined;

  const named = await conversationsNamed(auth, target);
  if (named === undefined) return undefined;

  // One over the cap, so the refusal is decided without reading a window that
  // holds a hundred thousand conversations in order to say it holds too many.
  const settled = await db()
    .select({ id: gradingJob.id })
    .from(gradingJob)
    .where(and(named, inArray(gradingJob.status, [...SETTLED])))
    .orderBy(asc(gradingJob.id))
    .limit(MOST_CONVERSATIONS_PER_REGRADE + 1);

  if (settled.length > MOST_CONVERSATIONS_PER_REGRADE) {
    throw new Error(
      `a re-grade judges at most ${MOST_CONVERSATIONS_PER_REGRADE} conversations at once, and this one names more; ask for a narrower window`,
    );
  }

  await widenWhatIsAlreadyWaiting(named, graderId);

  const [waiting] = await db()
    .select({ howMany: count() })
    .from(gradingJob)
    .where(and(named, inArray(gradingJob.status, [...OUTSTANDING])));

  const alreadyWaiting = Number(waiting?.howMany ?? 0);
  if (settled.length === 0) {
    return { reopened: [], graderId, alreadyWaiting };
  }

  return {
    reopened: await reopenJobs(
      and(
        named,
        inArray(
          gradingJob.id,
          settled.map((row) => row.id),
        ),
      ),
      graderId,
    ),
    graderId,
    alreadyWaiting,
  };
}

/**
 * A conversation that is already waiting keeps waiting — but a narrowing it is
 * waiting *under* is widened to cover what has now been asked as well.
 *
 * Leaving an outstanding job alone was always sound because an outstanding job
 * judges everything, and that is exactly the invariant narrowing breaks: a job
 * queued for one grader would answer a second ask about a different grader by
 * judging neither of them, silently. Two asks that disagree about how narrow the
 * work is therefore settle on the wider one, which is the only answer that
 * carries out both.
 *
 * **Only a job nobody has taken.** A claimed job is being judged right now,
 * under the instruction it was claimed with; the column no longer decides
 * anything for it, and finishing clears it — so a second ask that arrives during
 * that window is asked again once the conversation is graded, which is a re-grade
 * of a graded conversation and the ordinary case.
 */
async function widenWhatIsAlreadyWaiting(
  theseJobs: SQL,
  forGrader: string | null,
): Promise<void> {
  await db()
    .update(gradingJob)
    .set({ regradeGraderId: null })
    .where(
      and(
        theseJobs,
        eq(gradingJob.status, "pending"),
        isNotNull(gradingJob.regradeGraderId),
        forGrader === null
          ? undefined
          : sql`${gradingJob.regradeGraderId} <> ${forGrader}`,
      ),
    );
}

/**
 * The caller's own jobs that the target names, as a predicate — or `undefined`
 * when the target is a run they cannot reach.
 *
 * The run case resolves the run's conversations first rather than joining,
 * because a run holds at most two hundred of them and the id list that comes
 * back is what makes the reopen's predicate the same shape as the window's. The
 * tenancy is on both halves: the simulations are read within it, and the jobs
 * are narrowed by it again.
 */
async function conversationsNamed(
  auth: AuthContext,
  target: RegradeTarget,
): Promise<SQL | undefined> {
  const inActingProject =
    auth.projectId === undefined
      ? undefined
      : eq(gradingJob.projectId, auth.projectId);

  if ("window" in target) {
    const { from, to } = validWindow(target.window);
    return within(
      auth,
      gradingJob,
      and(
        inActingProject,
        gte(gradingJob.createdAt, from),
        lt(gradingJob.createdAt, to),
      ),
    );
  }

  const [reachable] = await db()
    .select({ id: run.id })
    .from(run)
    .where(
      within(
        auth,
        run,
        and(
          eq(run.id, target.runId),
          auth.projectId === undefined
            ? undefined
            : eq(run.projectId, auth.projectId),
        ),
      ),
    )
    .limit(1);

  if (reachable === undefined) return undefined;

  const conversations = await db()
    .select({ id: simulation.id })
    .from(simulation)
    .where(within(auth, simulation, eq(simulation.runId, reachable.id)));

  return within(
    auth,
    gradingJob,
    and(
      inActingProject,
      inArray(
        gradingJob.simulationId,
        conversations.map((conversation) => conversation.id),
      ),
    ),
  );
}

/**
 * The grader this re-grade narrows to, as the reopened jobs will carry it:
 * `null` when nobody named one, and `undefined` when somebody named one the
 * caller cannot reach.
 *
 * The two halves are the two halves every read here has. **The shape is refused
 * out loud**, because a string that is not a grader identifier is a caller
 * mistake rather than a grader that is missing — the same line `startRun` draws
 * when it is handed something that is not an agent. **Existence and tenancy are
 * one question and are asked through the ordinary scoped read**, so a grader in
 * another customer's project is exactly as absent as one that was never created,
 * and this call learns nothing about it either way.
 *
 * A grader somebody deleted is unreachable and answers the same, which is right:
 * a deleted grader judges nothing from now on, and a re-grade is from now on.
 */
async function theGraderNamed(
  auth: AuthContext,
  graderId: string | undefined,
): Promise<string | null | undefined> {
  if (graderId === undefined) return null;

  if (!isId("grd", graderId)) {
    throw new Error(
      "a re-grade narrows to a grader by its identifier, and this is not one",
    );
  }

  const reachable = await getGrader(auth, graderId);
  return reachable === undefined ? undefined : reachable.id;
}

function validWindow(window: RegradeWindow): RegradeWindow {
  const { from, to } = window;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("a re-grade's window is two moments, and one of these is not");
  }
  if (from.getTime() >= to.getTime()) {
    throw new Error("a re-grade's window starts before it ends");
  }
  return window;
}
