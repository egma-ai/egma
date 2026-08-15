import { traceStore } from "../clickhouse/client.ts";
import {
  foldVerdicts,
  foldVerdictsByGrader,
  JUDGED_BY_HUMAN,
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
 * `correctVerdict` is the third door and it breaks none of that: a person's
 * disagreement is a whole verdict row of their own, written through the same
 * insert as every other, and the machine's row is left exactly where it was.
 * The other half of revisiting a judgment — asking the engine for a fresh one —
 * is not here at all, because it is a job rather than a row: `regrade` reopens
 * the queue, the service judges, and what lands does so through `appendVerdicts`
 * like anything else.
 *
 * **No overall row is written here or anywhere.** `readVerdicts` answers with
 * the rows and with the fold's answer over them, computed at the moment of
 * asking, so the headline and the evidence are two views of one thing rather
 * than two records that can drift apart. `readRunVerdicts` is the same act one
 * grain up — a run's outcome and each of its conversations', both from the same
 * fold over the same rows — because a run header is a thing computed and never
 * a thing stored.
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
  /** One line saying why, in words a person reads. */
  readonly rationale: string;
  /**
   * Why this verdict is what it is, as a **stable word a reader may branch
   * on** — `modality_unsupported` on a grader that cannot score this
   * conversation, and empty when there is nothing to say beyond the rationale.
   *
   * It is separate from the rationale on purpose. The rationale is prose,
   * written to be read and free to be reworded whenever it reads badly; a page
   * that had to recognise a case would have to match on that wording, and the
   * first person to improve a sentence would break the page. So the machine's
   * word and the person's sentence are two fields, and each is free to be good
   * at its own job.
   *
   * Not part of a row's identity: two gradings of one dimension are still one
   * row and the later one still wins, whatever either of them says here.
   */
  readonly reason?: string | undefined;
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
    reason: verdict.reason ?? "",
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
  /** The stable word, or empty where nothing beyond the rationale was said. */
  readonly reason: string;
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
  readonly reason: string;
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

  const verdicts = await verdictsFiledUnder(auth, options, {
    column: "trace_id",
    value: traceId,
  });

  return {
    verdicts,
    outcome: foldVerdicts(verdicts),
    byGrader: foldVerdictsByGrader(verdicts),
  };
}

/** One conversation of a run, and what its rows add up to. */
export type SimulationVerdicts = {
  /** The conversation, by the id its verdict rows are filed under. */
  readonly simulationId: string;
  /** Folded over that conversation's rows alone. */
  readonly outcome: FoldedOutcome;
};

export type RunVerdicts = {
  readonly runId: string;
  /**
   * One entry per conversation of this run that has been judged, in id order.
   *
   * Id order is arbitrary and deterministic, exactly as `byGrader`'s is: the
   * order to show simulations in is the run's own — their position — and that
   * lives with the simulation rows rather than with their verdicts.
   *
   * A conversation nobody has judged yet has no rows and so is not here at all.
   * That is the honest answer from this side: the run knows how many
   * conversations it expects and this table knows what has been judged, and a
   * placeholder invented here would be this module guessing at the other's
   * business.
   */
  readonly simulations: readonly SimulationVerdicts[];
  /** The run's own answer, folded over every row beneath it. */
  readonly outcome: FoldedOutcome;
  /** And per grader across the whole run, so a header can say which check failed. */
  readonly byGrader: readonly GraderOutcome[];
};

/**
 * A run's outcome and each of its conversations', computed at the moment of
 * asking.
 *
 * **It is the same fold, twice, over the same rows.** A run's answer is
 * `foldVerdicts` over every row the run holds; a simulation's is `foldVerdicts`
 * over that conversation's. Those two agree by construction rather than by care:
 * supersession is decided inside one conversation's dimensions, so folding the
 * run whole and folding each conversation and adding the counts up are the same
 * arithmetic. That is what makes a run header and the rows on the page beneath
 * it incapable of disagreeing — and it is why there is no second algebra here,
 * no aggregate in the query, and no stored rollup anywhere for either to drift
 * from. The run header's verdict-count slots are filled by this, at read time.
 *
 * **The rows themselves are deliberately not returned.** A conversation's rows
 * are bounded and `readVerdicts` hands them over with its answer, because the
 * evidence is what somebody opening one conversation came for. A run is two
 * hundred of those, and a caller that wanted every row of it would be building
 * the page one conversation at a time anyway. So this answers the two grains a
 * run header actually shows and nothing more.
 *
 * `FINAL` and the project narrowing are `readVerdicts`'s, for its reasons: the
 * background merge is unpromised, and a caller's own project always wins over
 * anything asked for. A run of another customer's simply has no rows here, which
 * is the same answer an unjudged run gives — this read confirms nothing about
 * whether a run exists, and the run table is where that question is asked.
 *
 * Permitted to every role, `viewer` included, on the same terms as reading one
 * conversation's: looking at what egma thought is the product.
 */
export async function readRunVerdicts(
  auth: AuthContext,
  runId: string,
  options: ReadVerdictsOptions = {},
): Promise<RunVerdicts> {
  authorize(auth, "read", here(auth));

  const verdicts = await verdictsFiledUnder(auth, options, {
    column: "run_id",
    value: runId,
  });

  const byConversation = new Map<string, RecordedVerdict[]>();
  for (const row of verdicts) {
    const held = byConversation.get(row.traceId);
    if (held === undefined) byConversation.set(row.traceId, [row]);
    else held.push(row);
  }

  return {
    runId,
    simulations: [...byConversation.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([simulationId, its]) => ({
        simulationId,
        outcome: foldVerdicts(its),
      })),
    outcome: foldVerdicts(verdicts),
    byGrader: foldVerdictsByGrader(verdicts),
  };
}

/**
 * The rows of one conversation, or of one run, read the one way this module
 * reads rows.
 *
 * Two callers and one query, so that `FINAL`, the tenancy and the projection can
 * never come to differ between the grain somebody opened a conversation at and
 * the grain a run header is folded from. The column is one of two literals
 * written here rather than anything a caller passes, which is what makes
 * interpolating it into the text safe; the value it is compared against is a
 * bound parameter like every other.
 *
 * Ordered by the conversation first, then by grader, dimension, version and
 * judge — a stable order at both grains, and the order the run read groups in.
 */
async function verdictsFiledUnder(
  auth: AuthContext,
  options: ReadVerdictsOptions,
  under: { readonly column: "trace_id" | "run_id"; readonly value: string },
): Promise<readonly RecordedVerdict[]> {
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
              reason,
              cited_span_ids,
              priority,
              run_id,
              agent_id,
              agent_version_id,
              toString(toUnixTimestamp64Micro(event_ts)) as judged_at_micros
            from ${VERDICTS_TABLE} final
            where organization_id = {organization_id:String}
              ${projectId === undefined ? "" : "and project_id = {project_id:String}"}
              and ${under.column} = {filed_under:String}
            order by trace_id, grader_id, dimension, grader_version_id, judged_by`,
    query_params: {
      organization_id: auth.organizationId,
      ...(projectId === undefined ? {} : { project_id: projectId }),
      filed_under: under.value,
    },
    format: "JSONEachRow",
  });

  return (await answered.json<VerdictRow>()).map(verdictOf);
}

/* ------------------------------------------------------------------- *
 * The human word.
 * ------------------------------------------------------------------- */

/**
 * A person disagreeing with a judgment, and what they say instead.
 *
 * **What it names is the judged thing, not who judged it** — the conversation,
 * the grader, the version that decided it, the dimension and the source. There
 * is no `judgedBy` to give, because there is exactly one human row per judged
 * thing and this is it. Correcting a correction is therefore the same act as
 * making one: the row carries the same identity, the store keeps the later of
 * the two, and a third voice is unrepresentable rather than merely discouraged.
 *
 * The grader version is part of what is named because a correction answers one
 * grading. Somebody who reads a re-graded conversation and disagrees is
 * disagreeing with the grading they read, and naming its version is how they say
 * which one — a word against version 1 does not follow the conversation forward
 * into version 2's grading, which they have not read.
 */
export type VerdictCorrection = {
  readonly traceId: string;
  readonly graderId: string;
  readonly graderVersionId: string;
  readonly dimension: string;
  readonly source: VerdictSource;
  /** What the person says happened, in the same four words the machine has. */
  readonly verdict: Verdict;
  /**
   * Between 0 and 1, and **optional**, because a person states a verdict and a
   * reason — a number is what a rubric produces, not what a reader has. Left
   * out, it follows the word: 1 for `passed`, 0 for anything else, which is the
   * same arithmetic the deterministic graders do. Somebody correcting a rubric's
   * 0.6 to 0.8 has a number, and says so.
   */
  readonly score?: number | undefined;
  /** Why they disagree. Required: a correction with no reason is an assertion. */
  readonly rationale: string;
  /** The turns they are pointing at, if they are pointing at any. */
  readonly citedSpanIds?: readonly string[] | undefined;
};

/**
 * Disagree with a judgment, and have the disagreement be what counts.
 *
 * **It is a whole verdict row and not an edit.** The machine's row stays exactly
 * where it is, still returned by `readVerdicts`, still saying what egma thought
 * — which is the entire reason the correction is stored as a second row rather
 * than written over the first. Accumulated, those pairs are the ground truth a
 * future measurement of judge accuracy is made of, and an edit would have thrown
 * away one half of every pair.
 *
 * What the person is handed back is the row they wrote. The fold prefers it over
 * the machine's inside that grading from the next read on, and the arithmetic
 * that makes a run's headline is the same arithmetic it always was — no reader
 * knows a human spoke except by looking at `judged_by`.
 *
 * **The priority is the corrected row's, not today's.** A person disagreeing
 * with a P1 warning from last week is disagreeing with a warning; promoting that
 * grader to P0 this morning did not make their word a blocker retroactively, and
 * copying the row's own snapshot forward is what says so. It is the one place
 * this module reads before it writes, and that is what it reads for. A re-grade
 * snapshots today's priority instead, because a re-grade is a judgment made
 * today.
 *
 * **The column says a person spoke, and not which person.** `judged_by` is the
 * word the fold reads, and the identity spans it — so a second reviewer's
 * correction replaces the first's rather than stacking beside it, and one judged
 * thing has one human word. Recording who, and keeping every reviewer's, is a
 * column this table does not have and a decision this ticket does not make.
 *
 * There has to be something to disagree with: a correction of a judgment that
 * was never made would be authoring a verdict by hand, which is a different act
 * with none of this one's reasoning behind it, and it is refused out loud.
 */
export async function correctVerdict(
  auth: AuthContext,
  correction: VerdictCorrection,
): Promise<RecordedVerdict> {
  authorize(auth, "revisit_verdicts", here(auth));

  const rationale = correction.rationale.trim();
  if (rationale === "") {
    throw new Error("correcting a verdict says why you disagree");
  }

  const score = correction.score ?? (correction.verdict === "passed" ? 1 : 0);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error("a verdict's score is a number between 0 and 1");
  }

  const { verdicts } = await readVerdicts(auth, correction.traceId);
  const judged = verdicts.filter(
    (row) =>
      row.graderId === correction.graderId &&
      row.graderVersionId === correction.graderVersionId &&
      row.dimension === correction.dimension &&
      row.source === correction.source,
  );

  // The machine's row is what carries the snapshot; a correction of a
  // correction falls back to the row it is replacing, which carried it forward
  // from the machine's in the first place.
  const machine = judged.find((row) => row.judgedBy !== JUDGED_BY_HUMAN);
  const said = judged.find((row) => row.judgedBy === JUDGED_BY_HUMAN);
  const corrected = machine ?? said;

  if (corrected === undefined) {
    throw new Error(
      `there is no verdict on ${correction.dimension} from that grading of ${correction.traceId} to disagree with`,
    );
  }

  const row: NewVerdict = {
    traceId: correction.traceId,
    graderId: correction.graderId,
    graderVersionId: correction.graderVersionId,
    dimension: correction.dimension,
    source: correction.source,
    judgedBy: JUDGED_BY_HUMAN,
    verdict: correction.verdict,
    score,
    rationale,
    citedSpanIds: correction.citedSpanIds ?? [],
    priority: corrected.priority,
    // The conversation's own facts, copied rather than asked for: they belong to
    // what was judged and not to who is judging it, so a caller who mistyped one
    // could otherwise file their correction against a different run.
    runId: corrected.runId,
    agentId: corrected.agentId,
    agentVersionId: corrected.agentVersionId,
    judgedAtMicroseconds: correctedNow(said),
  };

  await appendVerdicts(auth, [row]);

  return {
    ...row,
    // A person's disagreement states no machine reason: what they wrote is the
    // whole of what they said, and inventing a word for it would be egma
    // classifying somebody else's judgment.
    reason: row.reason ?? "",
    citedSpanIds: [...row.citedSpanIds],
    judgedAt: rfc3339(row.judgedAtMicroseconds),
  };
}

/**
 * When the disagreement was made, in microseconds, and always after the word it
 * replaces.
 *
 * The clock is the version this table keeps rows by, so a second correction that
 * landed inside the same millisecond as the first — or on a copy whose clock is
 * a moment behind — would be free to lose to it, and the reviewer would be told
 * their correction had been saved while the store kept the old one. A microsecond
 * past the row being replaced is enough, and it never runs further ahead of the
 * clock than the corrections actually made.
 */
function correctedNow(replacing: RecordedVerdict | undefined): bigint {
  const now = BigInt(Date.now()) * 1000n;
  if (replacing === undefined) return now;
  const after = replacing.judgedAtMicroseconds + 1n;
  return now > after ? now : after;
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
    reason: row.reason,
    citedSpanIds: row.cited_span_ids,
    priority: row.priority,
    runId: row.run_id,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    judgedAtMicroseconds,
    judgedAt: rfc3339(judgedAtMicroseconds),
  };
}
