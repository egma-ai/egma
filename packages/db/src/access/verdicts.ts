import { traceStore } from "../clickhouse/client.ts";
import {
  foldVerdicts,
  foldVerdictsByGrader,
  type FoldedOutcome,
  type FoldableVerdict,
  type GraderOutcome,
  type Priority,
  type Verdict,
  type VerdictSource,
} from "../verdicts/fold.ts";
import type { AuthContext } from "./context.ts";
import { authorize, here } from "./permissions.ts";

/**
 * Writing and reading verdicts, and the only way anything ever does.
 *
 * The ClickHouse client is as private here as it is for spans, tenancy is
 * stamped from the `AuthContext` and from nothing a caller passed, and no
 * exported call takes a predicate.
 *
 * **Write-once, and there is no update surface at all.** A judgment is a row; a
 * later judgment is another row; nothing edits one. Re-grading at a new grader
 * version adds beside what is there, a person disagreeing writes their own row
 * with the machine's still underneath, and the only thing that ever collapses is
 * a literal rewrite of the identical judgment — the same grader at the same
 * version saying something about the same dimension again, which is what a
 * re-run after a transient error is. That collapse is the storage engine's, and
 * this module never asks a caller which case they are in.
 *
 * **No overall row is written here or anywhere.** `readVerdicts` answers with
 * the rows and with the fold's answer over them, computed at the moment of
 * asking, so the headline and the evidence are two views of one thing rather
 * than two records that can drift apart.
 */

/* ------------------------------------------------------------------- *
 * Writing.
 * ------------------------------------------------------------------- */

/**
 * One judgment, ready to be filed.
 *
 * Every field is required, including the empty ones — absence is a case each
 * construction site states rather than one a caller can leave out and not think
 * about, exactly as on `NewSpan`.
 */
export type NewVerdict = {
  /** The conversation that was judged, as the wire named it. */
  readonly traceId: string;
  readonly graderId: string;
  /**
   * The immutable version of the grader that produced this. It is part of the
   * row's identity, which is what makes re-grading at a tightened grader an
   * addition rather than a loss.
   */
  readonly graderVersionId: string;
  /**
   * What inside the grader was judged — one expected behavior, or the single
   * check a one-check grader makes. The grader names its own dimensions; the
   * store never interprets the name.
   */
  readonly dimension: string;
  readonly source: VerdictSource;
  /**
   * A judge model, `engine` for a deterministic grader that needed no model, or
   * `human`. Part of the identity, so a person's disagreement sits beside the
   * machine's judgment instead of replacing it.
   */
  readonly judgedBy: string;
  readonly verdict: Verdict;
  /** Between 0 and 1. The store refuses anything else. */
  readonly score: number;
  /** One line saying why. */
  readonly rationale: string;
  /** The spans this judgment is about, by their own ids. */
  readonly citedSpanIds: readonly string[];
  /** As it stood when the judgment was made, never as it stands now. */
  readonly priority: Priority;
  /** Empty for a production conversation, which has no run. */
  readonly runId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  /**
   * **Microseconds** since the epoch, stamped when the judgment was made. It is
   * the version this table keeps rows by, so a re-run of the same judgment must
   * carry a later one than the judgment it replaces.
   */
  readonly judgedAtMicroseconds: bigint;
};

export type AppendedVerdicts = {
  readonly appended: number;
  /** How many inserts it took. More than one means the batch was split. */
  readonly batches: number;
};

/**
 * How many rows one insert may carry.
 *
 * Only a row count, with none of the byte accounting the span path needs: a
 * verdict is a word, a number, one line of prose and a handful of span ids,
 * while a span carries the provider's whole payload verbatim. Re-grading a large
 * run is the only thing that reaches this, and it is split rather than refused
 * for the same reason a big batch of spans is.
 */
const MAXIMUM_ROWS_PER_INSERT = 5_000;

/** The one table this module writes. */
const VERDICTS_TABLE = "verdicts";

/**
 * The exact literal ClickHouse's `DateTime64(6)` reads, built from an integer
 * count of microseconds so that no floating-point step can move a judgment to a
 * different instant than the one it was made at.
 */
function asDateTime64(microseconds: bigint): string {
  const MILLION = 1_000_000n;
  // Floor division, so an instant before 1970 keeps a non-negative remainder.
  let seconds = microseconds / MILLION;
  let remainder = microseconds % MILLION;
  if (remainder < 0n) {
    seconds -= 1n;
    remainder += MILLION;
  }
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${whole.replace("T", " ")}.${remainder.toString().padStart(6, "0")}`;
}

/** RFC 3339 to the microsecond, which is what the column actually holds. */
function rfc3339(microseconds: bigint): string {
  return `${asDateTime64(microseconds).replace(" ", "T")}Z`;
}

/** One judgment as the columns of the `verdicts` table, tenancy included. */
function rowFor(auth: AuthContext, verdict: NewVerdict): Record<string, unknown> {
  return {
    organization_id: auth.organizationId,
    // A credential naming no project is for the whole customer, and its rows
    // file under the sentinel the schema already declares.
    project_id: auth.projectId ?? "default",
    trace_id: verdict.traceId,
    grader_id: verdict.graderId,
    grader_version_id: verdict.graderVersionId,
    dimension: verdict.dimension,
    source: verdict.source,
    judged_by: verdict.judgedBy,
    verdict: verdict.verdict,
    score: verdict.score,
    rationale: verdict.rationale,
    cited_span_ids: [...verdict.citedSpanIds],
    priority: verdict.priority,
    run_id: verdict.runId,
    agent_id: verdict.agentId,
    agent_version_id: verdict.agentVersionId,
    event_ts: asDateTime64(verdict.judgedAtMicroseconds),
  };
}

/**
 * File these judgments under the caller's organization and project.
 *
 * Nothing is read first and nothing is edited. Writing the identical judgment
 * again is not an error and does not double the row — the engine keeps the later
 * one — and writing a judgment at a new grader version, or a person's
 * disagreement with one, adds beside what is already there.
 *
 * **No permission is asked for here, deliberately**, on the same terms as
 * `appendSpans`: what may write a verdict is a question about the caller, and
 * the caller is the grading service, which decides it before it gets this far.
 * A row of the permission table decided in two places is a row that will one day
 * be decided two ways.
 *
 * A refusal from the store arrives as the store's own error rather than as
 * egma's. The ingest door translates one, because OTLP forbids retrying rejected
 * data and the sender there is a customer's exporter; the only writer here is
 * egma's own engine, so a row the store will not take is a bug in egma and is
 * worth nothing dressed up as a customer-facing refusal.
 */
export async function appendVerdicts(
  auth: AuthContext,
  verdicts: readonly NewVerdict[],
): Promise<AppendedVerdicts> {
  if (verdicts.length === 0) return { appended: 0, batches: 0 };

  const rows = verdicts.map((verdict) => rowFor(auth, verdict));
  let batches = 0;

  for (let at = 0; at < rows.length; at += MAXIMUM_ROWS_PER_INSERT) {
    await traceStore().insert({
      table: VERDICTS_TABLE,
      values: rows.slice(at, at + MAXIMUM_ROWS_PER_INSERT),
      format: "JSONEachRow",
    });
    batches += 1;
  }

  return { appended: rows.length, batches };
}

/* ------------------------------------------------------------------- *
 * Reading.
 * ------------------------------------------------------------------- */

/** One judgment as it is read back. */
export type RecordedVerdict = FoldableVerdict & {
  readonly score: number;
  readonly rationale: string;
  readonly citedSpanIds: readonly string[];
  readonly priority: Priority;
  readonly runId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  /** RFC 3339, to the microsecond the judgment was stamped at. */
  readonly judgedAt: string;
};

export type ReadVerdictsOptions = {
  /**
   * Narrow to one project, and **only narrow**: a credential that already names
   * a project reads that project whatever this says. Absence means the whole
   * customer, never a default project.
   */
  readonly projectId?: string | undefined;
};

export type TraceVerdicts = {
  /**
   * Every judgment on this conversation, superseded ones included and in a
   * stable order.
   *
   * Superseded rows are returned rather than hidden: an older grading is what
   * makes a tightened grader's effect visible, and a machine's judgment
   * underneath a person's correction is the whole reason the correction was
   * stored as a second row. Which of them counts is `speakingVerdicts`, and the
   * two answers below are already folded over exactly those.
   */
  readonly verdicts: readonly RecordedVerdict[];
  /** The conversation's own answer, computed here and stored nowhere. */
  readonly outcome: FoldedOutcome;
  /** And the same answer per grader, so a page can say which check failed. */
  readonly byGrader: readonly GraderOutcome[];
};

type VerdictRow = {
  readonly trace_id: string;
  readonly grader_id: string;
  readonly grader_version_id: string;
  readonly dimension: string;
  readonly source: string;
  readonly judged_by: string;
  readonly verdict: Verdict;
  readonly score: number;
  readonly rationale: string;
  readonly cited_span_ids: readonly string[];
  readonly priority: Priority;
  readonly run_id: string;
  readonly agent_id: string;
  readonly agent_version_id: string;
  readonly judged_at_micros: string;
};

/**
 * One conversation's verdicts, and what they add up to.
 *
 * **No time window is required, and that is not an oversight.** The two trace
 * reads insist on one because `spans` files by minute and hashes the trace id
 * underneath, so a lookup naming only an id would have nothing to prune with.
 * Here the conversation is the third column of the sorting key, straight after
 * the customer, so naming it *is* the pruning and asking for a window as well
 * would be ceremony that a caller could get wrong — a judgment is made after the
 * conversation and a re-grade long after that, so the window somebody would
 * naturally pass is the conversation's, and it would quietly hide the rows they
 * came for.
 *
 * **`FINAL`, and it is doing real work.** This is a `ReplacingMergeTree`, and
 * the merge that collapses a re-run onto the judgment it replaces happens in the
 * background at some unpromised later moment. Reading without it would show a
 * transiently-failed judgment beside the one that replaced it, which is exactly
 * the disagreement this table's identity exists to prevent. It is exact here
 * with no settings caveat because the table has no partition key for a collapse
 * to be unable to cross.
 *
 * **Nothing else is derived.** The rows come back as they are stored, and the
 * two answers beside them are the shared fold over those same rows and nothing
 * else. There is no stored rollup on this path, so there is nothing for the
 * headline to disagree with.
 *
 * Reading is permitted to every role, `viewer` included, on the same terms as
 * reading a trace: looking at what an agent did, and at what egma thought of it,
 * is the product.
 */
export async function readVerdicts(
  auth: AuthContext,
  traceId: string,
  options: ReadVerdictsOptions = {},
): Promise<TraceVerdicts> {
  authorize(auth, "read", here(auth));

  // The caller's own project wins over anything asked for, and an empty name is
  // nobody's project rather than a project called nothing — which is what a form
  // submits for a field left blank, and what would otherwise return an empty
  // list indistinguishable from having no verdicts.
  const named = (value: string | undefined): string | undefined =>
    value === undefined || value === "" ? undefined : value;
  const projectId = named(auth.projectId) ?? named(options.projectId);

  const answered = await traceStore().query({
    query: `select
              trace_id,
              grader_id,
              grader_version_id,
              dimension,
              source,
              judged_by,
              verdict,
              score,
              rationale,
              cited_span_ids,
              priority,
              run_id,
              agent_id,
              agent_version_id,
              toString(toUnixTimestamp64Micro(event_ts)) as judged_at_micros
            from ${VERDICTS_TABLE} final
            where organization_id = {organization_id:String}
              ${projectId === undefined ? "" : "and project_id = {project_id:String}"}
              and trace_id = {trace_id:String}
            order by grader_id, dimension, grader_version_id, judged_by`,
    query_params: {
      organization_id: auth.organizationId,
      ...(projectId === undefined ? {} : { project_id: projectId }),
      trace_id: traceId,
    },
    format: "JSONEachRow",
  });

  const verdicts = (await answered.json<VerdictRow>()).map(verdictOf);

  return {
    verdicts,
    outcome: foldVerdicts(verdicts),
    byGrader: foldVerdictsByGrader(verdicts),
  };
}

function verdictOf(row: VerdictRow): RecordedVerdict {
  const judgedAtMicroseconds = BigInt(row.judged_at_micros);

  return {
    traceId: row.trace_id,
    graderId: row.grader_id,
    graderVersionId: row.grader_version_id,
    dimension: row.dimension,
    // The column holds one of two words and the store refuses the rest; this is
    // the type saying so rather than a second check that could disagree.
    source: row.source as VerdictSource,
    judgedBy: row.judged_by,
    verdict: row.verdict,
    score: row.score,
    rationale: row.rationale,
    citedSpanIds: row.cited_span_ids,
    priority: row.priority,
    runId: row.run_id,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    judgedAtMicroseconds,
    judgedAt: rfc3339(judgedAtMicroseconds),
  };
}
