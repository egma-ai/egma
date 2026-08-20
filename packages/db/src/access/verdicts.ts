import { traceStore } from "../clickhouse/client.ts";
import {
  foldVerdicts,
  foldVerdictsByGrader,
  verdictLanes,
  type Diagnostics,
  type FoldedOutcome,
  type FoldableVerdict,
  type GraderOutcome,
  type Verdict,
  type VerdictSource,
} from "../verdicts/fold.ts";
import type { AuthContext } from "./context.ts";
import { graderFacts } from "./graders.ts";
import { authorize, here } from "./permissions.ts";

/**
 * Writing and reading verdicts, and the only way anything ever does.
 *
 * The ClickHouse client is as private here as it is for spans, tenancy is
 * stamped from the `AuthContext` and from nothing a caller passed, and no
 * exported call takes a predicate.
 *
 * **Write-once, and there is no update surface at all.** A judgment is a row; a
 * later judgment is another row; nothing updates one in place. A production
 * re-grade at a new current grader version adds beside what is there. A
 * simulation re-grade stays on its pinned version, so the storage engine
 * collapses it as a literal rewrite of the same judgment identity. This module
 * never asks a caller which case they are in.
 *
 * **There is no door for a person's disagreement, and its absence is a
 * decision.** Human corrections leave v0 with the `judged_by` column that
 * carried them, and return as the reserved `human` grader type: a human-judged
 * grader writes its own rows under its own grader id, through this same insert,
 * beside the machine's rather than on top of it. The other half of revisiting a
 * judgment — asking the engine for a fresh one — was never here either, because
 * it is a job rather than a row: `regrade` reopens the queue, the service
 * judges, and what lands does so through `appendVerdicts` like anything else.
 *
 * **No overall row is written here or anywhere.** `readVerdicts` answers with
 * the rows and with the fold's answer over them, computed at the moment of
 * asking, so the headline and the evidence are two views of one thing rather
 * than two records that can drift apart. `readRunVerdicts` is the same act one
 * grain up — a run's outcome and each of its conversations', both from the same
 * fold over the same rows — because a run header is a thing computed and never
 * a thing stored.
 *
 * **Two lanes, and the outcome is the required one.** A running copy carrying
 * `required: false` is a diagnostic: judged like any other, its rows written and
 * returned like any other, and never able to fail a conversation or a run. Which
 * copies those are is read from Postgres at the moment of asking — the flag is a
 * live setting on the copy, so a project that makes a blocker a diagnostic reads
 * its whole history that way from that moment on — and the split is handed to
 * the shared fold rather than done a second way here. The diagnostic lane's own
 * answer comes back beside the outcome, because a check whose fraction nobody
 * could see would be a check judging in silence.
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
   * row's identity, which keeps production judgments made under different
   * current versions distinct. A simulation re-grade reuses its pinned id.
   */
  readonly graderVersionId: string;
  /**
   * Which 0-or-1 check inside the grader this row answers, as its **key** — the
   * behavior's position in the pinned test version, the config entry's index.
   * Never the content: what a person reads is fetched from the pinned versions
   * at display time. The grader names its own assertions; the store never
   * interprets the name.
   */
  readonly assertion: string;
  readonly source: VerdictSource;
  readonly verdict: Verdict;
  /** Between 0 and 1. The store refuses anything else. */
  readonly score: number;
  /**
   * One line saying why — and on an `errored` row, the plain-prose reason
   * judging broke, which is the only place that sentence is written down.
   */
  readonly rationale: string;
  /** The spans this judgment is about, by their own ids. */
  readonly citedSpanIds: readonly string[];
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
 * while a span carries the provider's whole safe payload. Re-grading a large
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
    assertion: verdict.assertion,
    source: verdict.source,
    verdict: verdict.verdict,
    score: verdict.score,
    rationale: verdict.rationale,
    cited_span_ids: [...verdict.citedSpanIds],
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
 * one — and writing a judgment at a new grader version adds beside what is
 * already there.
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
   * makes a tightened grader's effect visible, and hiding it would leave a
   * reader unable to see that the grader, rather than the agent, is what
   * changed. Which of them counts is `speakingVerdicts`, and the two answers
   * below are already folded over exactly those.
   */
  readonly verdicts: readonly RecordedVerdict[];
  /**
   * The conversation's own answer, computed here and stored nowhere — folded
   * over the **required** copies alone, because those are the ones a failure of
   * which means the conversation failed.
   */
  readonly outcome: FoldedOutcome;
  /**
   * The same fold over the diagnostic copies, or **absent** where none of them
   * judged this conversation.
   *
   * Absent rather than an empty outcome, so a reader shows a lane that exists
   * and says nothing at all about one that does not — a "0/0 diagnostics" line
   * on every page would be furniture describing a feature nobody switched on.
   */
  readonly diagnostics: FoldedOutcome | undefined;
  /**
   * And the same answer per grader, so a page can say which check failed —
   * every grader that judged, each saying which lane it is in.
   */
  readonly byGrader: readonly GraderOutcome[];
};

type VerdictRow = {
  readonly trace_id: string;
  readonly grader_id: string;
  readonly grader_version_id: string;
  readonly assertion: string;
  readonly source: string;
  readonly verdict: Verdict;
  readonly score: number;
  readonly rationale: string;
  readonly cited_span_ids: readonly string[];
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
  const diagnostics = await onlyReporting(auth, verdicts);
  const lanes = verdictLanes(verdicts, diagnostics);

  return {
    verdicts,
    outcome: foldVerdicts(lanes.required),
    diagnostics: reportedApart(lanes.diagnostic),
    byGrader: foldVerdictsByGrader(verdicts, diagnostics),
  };
}

/**
 * The diagnostic lane's own answer, or **absent** where nothing diagnostic
 * judged this grain.
 *
 * Absent rather than an empty outcome, and written once rather than at each of
 * the three grains that answer it: a "0/0 diagnostics" line on every page would
 * be furniture describing a feature nobody switched on, and three copies of the
 * rule were three chances for one grain to start describing it anyway.
 */
function reportedApart(
  rows: readonly FoldableVerdict[],
): FoldedOutcome | undefined {
  return rows.length === 0 ? undefined : foldVerdicts(rows);
}

/**
 * Which of the copies that wrote these rows only report.
 *
 * One read for a whole answer, asked of the graders actually named by the rows
 * rather than of the project — so a run judged by two copies costs one lookup of
 * two ids, whatever else the project has switched on.
 *
 * **A copy that came back with nothing is treated as required**, which is the
 * safe direction: a row nobody could resolve must not quietly stop being able to
 * fail anything.
 *
 * **`options.projectId` is deliberately not passed on**, and the asymmetry is
 * safe in exactly one direction. That option only ever *narrows* the rows, and a
 * credential naming its own project narrows them regardless; the copies are read
 * under `auth`'s own narrowing. So the worst this can do is resolve a copy whose
 * rows the caller then filtered out — an answer about a grader nobody asked
 * about, which changes nothing. It cannot do the reverse and fail to resolve one
 * whose rows *are* in the answer, because a row filed under a project is written
 * by a copy of that project. Were the option ever to widen rather than narrow,
 * this would have to take it.
 */
async function onlyReporting(
  auth: AuthContext,
  rows: readonly RecordedVerdict[],
): Promise<Diagnostics> {
  const facts = await graderFacts(
    auth,
    rows.map((row) => row.graderId),
  );

  return new Set(
    [...facts.entries()]
      .filter(([, its]) => !its.required)
      .map(([graderId]) => graderId),
  );
}

/** One conversation of a run, and what its rows add up to. */
export type SimulationVerdicts = {
  /** The conversation, by the id its verdict rows are filed under. */
  readonly simulationId: string;
  /** Folded over that conversation's required rows alone. */
  readonly outcome: FoldedOutcome;
  /** And over its diagnostic ones, where any judged it. */
  readonly diagnostics: FoldedOutcome | undefined;
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
  /**
   * The run's own answer, folded over every **required** row beneath it. A run
   * fails when a copy that can fail one did; nothing a diagnostic said reaches
   * this.
   */
  readonly outcome: FoldedOutcome;
  /** The diagnostic lane across the whole run, where anything reported. */
  readonly diagnostics: FoldedOutcome | undefined;
  /** And per grader across the whole run, so a header can say which check failed. */
  readonly byGrader: readonly GraderOutcome[];
};

/**
 * A run's outcome and each of its conversations', computed at the moment of
 * asking.
 *
 * **It is the same fold, twice, over the same rows.** A run's answer is
 * `foldVerdicts` over every required row the run holds; a simulation's is
 * `foldVerdicts` over that conversation's. Those two agree by construction
 * rather than by care: supersession is decided inside one conversation's
 * assertions and the lane split is decided per grader, so folding the run whole
 * and folding each conversation and adding the counts up are the same
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
  const diagnostics = await onlyReporting(auth, verdicts);
  const lanes = verdictLanes(verdicts, diagnostics);

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
      .map(([simulationId, its]) => {
        const apart = verdictLanes(its, diagnostics);
        return {
          simulationId,
          outcome: foldVerdicts(apart.required),
          diagnostics: reportedApart(apart.diagnostic),
        };
      }),
    outcome: foldVerdicts(lanes.required),
    diagnostics: reportedApart(lanes.diagnostic),
    byGrader: foldVerdictsByGrader(verdicts, diagnostics),
  };
}

/**
 * What every conversation of several runs has been judged, folded per
 * conversation — one query for a whole page of runs.
 *
 * **It exists so a run list can show a verdict per row without asking this store
 * once per run.** A page of fifty runs read one at a time is fifty round trips
 * to a columnar store, on the one surface somebody scrolls; the run ids are the
 * second column of this table's sorting key, so naming all of them at once is
 * one prune rather than fifty.
 *
 * The answer is deliberately per **conversation** rather than per run. A run's
 * verdict is folded over its conversations' verdicts — one vote each — and
 * folding a run's rows whole would let a test with forty expected behaviors
 * outvote a test with two. `foldRun` in `verdicts/read-fold.ts` does that
 * arithmetic, and it needs each conversation's own answer to do it.
 *
 * **Only the required lane is folded here, and the diagnostics are resolved the
 * same way every other read here resolves them.** A `required: false` copy
 * reports its fraction and can fail nothing, so a list that folded its rows in
 * would show a run as failed on the strength of a check that is not allowed to
 * fail anything — and it would disagree with the run's own detail page, which
 * splits the lanes. One read of the graders named by these rows covers every run
 * on the page.
 *
 * A run with nothing judged is absent from the outer map rather than present and
 * empty: absence is what "nobody has looked" already means everywhere else here,
 * and inventing an entry would be this module guessing at the run table's
 * business.
 */
export async function readVerdictsAcrossRuns(
  auth: AuthContext,
  runIds: readonly string[],
  options: ReadVerdictsOptions = {},
): Promise<ReadonlyMap<string, ReadonlyMap<string, FoldedOutcome>>> {
  authorize(auth, "read", here(auth));

  if (runIds.length === 0) {
    return new Map<string, ReadonlyMap<string, FoldedOutcome>>();
  }

  const named = (value: string | undefined): string | undefined =>
    value === undefined || value === "" ? undefined : value;
  const projectId = named(auth.projectId) ?? named(options.projectId);

  const answered = await traceStore().query({
    query: `select
              trace_id,
              grader_id,
              grader_version_id,
              assertion,
              source,
              verdict,
              score,
              rationale,
              cited_span_ids,
              run_id,
              agent_id,
              agent_version_id,
              toString(toUnixTimestamp64Micro(event_ts)) as judged_at_micros
            from ${VERDICTS_TABLE} final
            where organization_id = {organization_id:String}
              ${projectId === undefined ? "" : "and project_id = {project_id:String}"}
              and run_id in {run_ids:Array(String)}
            order by run_id, trace_id, grader_id, assertion, grader_version_id`,
    query_params: {
      organization_id: auth.organizationId,
      ...(projectId === undefined ? {} : { project_id: projectId }),
      run_ids: [...runIds],
    },
    format: "JSONEachRow",
  });

  const rows = (await answered.json<VerdictRow>()).map(verdictOf);
  const diagnostics = await onlyReporting(auth, rows);

  const byRun = new Map<string, Map<string, RecordedVerdict[]>>();
  for (const row of rows) {
    const conversations = byRun.get(row.runId) ?? new Map();
    byRun.set(row.runId, conversations);
    const held = conversations.get(row.traceId);
    if (held === undefined) conversations.set(row.traceId, [row]);
    else held.push(row);
  }

  return new Map(
    [...byRun].map(([runId, conversations]) => [
      runId,
      new Map(
        [...conversations].map(([simulationId, its]) => [
          simulationId,
          foldVerdicts(verdictLanes(its, diagnostics).required),
        ]),
      ),
    ]),
  );
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
 * Ordered by the conversation first, then by grader, assertion and version — a
 * stable order at both grains, and the order the run read groups in.
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
              assertion,
              source,
              verdict,
              score,
              rationale,
              cited_span_ids,
              run_id,
              agent_id,
              agent_version_id,
              toString(toUnixTimestamp64Micro(event_ts)) as judged_at_micros
            from ${VERDICTS_TABLE} final
            where organization_id = {organization_id:String}
              ${projectId === undefined ? "" : "and project_id = {project_id:String}"}
              and ${under.column} = {filed_under:String}
            order by trace_id, grader_id, assertion, grader_version_id`,
    query_params: {
      organization_id: auth.organizationId,
      ...(projectId === undefined ? {} : { project_id: projectId }),
      filed_under: under.value,
    },
    format: "JSONEachRow",
  });

  return (await answered.json<VerdictRow>()).map(verdictOf);
}

function verdictOf(row: VerdictRow): RecordedVerdict {
  const judgedAtMicroseconds = BigInt(row.judged_at_micros);

  return {
    traceId: row.trace_id,
    graderId: row.grader_id,
    graderVersionId: row.grader_version_id,
    assertion: row.assertion,
    // The column holds one of two words and the store refuses the rest; this is
    // the type saying so rather than a second check that could disagree.
    source: row.source as VerdictSource,
    verdict: row.verdict,
    score: row.score,
    rationale: row.rationale,
    citedSpanIds: row.cited_span_ids,
    runId: row.run_id,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    judgedAtMicroseconds,
    judgedAt: rfc3339(judgedAtMicroseconds),
  };
}
