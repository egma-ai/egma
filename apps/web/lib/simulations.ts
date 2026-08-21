/**
 * One simulation's evidence, as the API answers it — and the two reads a page
 * does over it that are decisions rather than rendering.
 *
 * A **simulation** is one test executed once inside a run: one conversation,
 * start to finish. It produces a transcript, an outcome and measures, and the
 * project's **graders** judge it into **verdicts** — one per **assertion**, the
 * 0-or-1 checks inside a grader.
 *
 * The field names are the API's own. Renaming them on the way in would put a
 * second vocabulary between the contract and the page, and the two would drift
 * the first time the API grew a field.
 *
 * **The browser decides almost nothing here.** Which versions were pinned, which
 * graders judged, which verdict the conversation folds to, which of them only
 * report, and whether it has been judged at all are all answered by
 * `GET /v1/simulations/{id}`. The two things this module works out are the two
 * the *page* is about: which of several gradings of one assertion counts, and
 * which turns a judgment is pointing at.
 */
import type {
  GetSimulationResponse,
  RegradeSimulationResponse,
  TraceSpan,
} from "@egma/platform-api/client";

/** One judgment as the evidence read carries it. */
export type EvidenceVerdict = GetSimulationResponse["verdicts"][number];

/** One timed thing inside the conversation, with whatever happened under it. */
export type EvidenceStep = TraceSpan;

export type EvidenceTranscript = NonNullable<
  GetSimulationResponse["transcript"]
>;

/**
 * One running copy as the run's frozen plan named it for this conversation.
 *
 * One shape, where there used to be two: the expected-behaviors built-in is an
 * ordinary running copy now and arrives here like everything else.
 */
export type EvidencePlan = NonNullable<GetSimulationResponse["gradingPlan"]>;
export type EvidencePlanItem = EvidencePlan["items"][number];

/**
 * When this run's grading plan was decided, and whether one was decided at all.
 *
 * The state has to be shown, because it decides how much of the rest can be
 * believed. `migration_snapshot` was captured during an upgrade rather than when
 * the run began, and `not_recorded` has no plan at all — nothing reconstructs
 * one from today's graders, because that would be a claim nobody can check.
 */
/** Where the judging of this conversation stands, job by job. */
export type EvidenceGradingJob = GetSimulationResponse["gradingJobs"][number];

/** One mocked answer this conversation was conducted against. */
export type EvidenceMockTool =
  GetSimulationResponse["mockTools"]["defaults"][number];

/**
 * Which of the agent's own tools egma stood in the path of.
 *
 * **Its absence is a fact of its own.** Null means nothing ever asked the agent
 * what tools it has, so nothing was learned and nothing is claimed; three empty
 * lists mean the asking happened and nothing came back.
 */
export type EvidenceCoverage = NonNullable<
  GetSimulationResponse["mockToolCoverage"]
>;

/** One folded answer, at whichever grain answers it. */
export type EvidenceOutcome = NonNullable<GetSimulationResponse["outcome"]>;

/** One conversation, whole — everything one page load reads. */
export type SimulationEvidence = GetSimulationResponse;

/** What a re-grade answers: what was asked, and what it reached. */
export type RegradeAsked = RegradeSimulationResponse;

/** Where one conversation's evidence lives inside its run, inside its project. */
export function simulationSection(runId: string): readonly string[] {
  return ["runs", runId, "simulations"];
}

/* ------------------------------------------------------------------------ *
 * Reading the rows: which of them count, and what they are about.
 * ------------------------------------------------------------------------ */

/**
 * One judged assertion, with the judgment that counts and the ones beneath it.
 *
 * **Different grader-version judgments stay visible.** Re-grading this
 * simulation replaces the prior row for its same run-pinned version. Any row
 * already stored under another version remains as superseded evidence.
 */
export type JudgedAssertion = {
  readonly key: string;
  readonly graderId: string;
  /** The stored key, which is what this is filed under. */
  readonly assertion: string;
  /** The words behind it, or null where nothing could place the key. */
  readonly assertionText: string | null;
  /** `false` for a diagnostic copy's row: shown, never able to fail this. */
  readonly required: boolean;
  /** The judgment that counts: the newest one. */
  readonly speaking: EvidenceVerdict;
  /** Earlier judgments of the same assertion, newest first. Evidence, not noise. */
  readonly superseded: readonly EvidenceVerdict[];
};

/**
 * An assertion's identity: the grader, and what inside it was judged.
 *
 * `JSON.stringify` of the tuple rather than a joined string, for the reason the
 * store's own key uses it: a grader names its own assertions, and any separator
 * chosen here would be one an assertion key is one day allowed to contain. The
 * previous version of this line joined on a raw NUL byte, which made this
 * source file binary to git and to grep.
 */
function assertionKey(row: EvidenceVerdict): string {
  return JSON.stringify([row.graderId, row.assertion]);
}

function whenJudged(row: EvidenceVerdict): number {
  const at = Date.parse(row.judgedAt);
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Every judged assertion of this conversation, folded the way the store folds
 * it: **the newest judgment speaks, and the ones under it stay readable.**
 *
 * Decided by the clock on the rows and by nothing else. The grader version each
 * row was written at is deliberately not on this wire because this browser
 * fold only needs to choose the latest judgment. The server already executed
 * the exact immutable definition revision pinned by that grader version, so a
 * catalog edit cannot change what an older row meant.
 *
 * This is the browser's copy of an algebra the server also performs, and that is
 * deliberate rather than accidental duplication: the server folds it into one
 * verdict for the header, and the page has to show the working — which rows
 * count and which are superseded. Neither can produce the other's answer from
 * the other's output.
 */
export function judgedAssertions(
  rows: readonly EvidenceVerdict[],
): readonly JudgedAssertion[] {
  const byAssertion = new Map<string, EvidenceVerdict[]>();
  for (const row of rows) {
    const key = assertionKey(row);
    const held = byAssertion.get(key);
    if (held === undefined) byAssertion.set(key, [row]);
    else held.push(row);
  }

  return [...byAssertion.entries()].map(([key, its]) => {
    const ordered = [...its].sort(
      (left, right) => whenJudged(right) - whenJudged(left),
    );
    // Never empty: the entry exists because a row went into it.
    const [speaking, ...superseded] = ordered as [
      EvidenceVerdict,
      ...EvidenceVerdict[],
    ];

    return {
      key,
      graderId: speaking.graderId,
      assertion: speaking.assertion,
      assertionText: speaking.assertionText,
      required: speaking.required,
      speaking,
      superseded,
    };
  });
}

/**
 * Which turns a judgment is pointing at, by their position in the transcript.
 *
 * A judgment cites spans by their own ids, and a reader wants *turn three*. The
 * mapping is the transcript's own order, so it is worked out here rather than
 * stored — a stored position would be wrong the moment a late span arrived.
 *
 * A cited id that is not a turn — a tool call inside one — resolves to the turn
 * it happened inside, because that is the turn a reader would be sent to. An id
 * that is nowhere in the transcript at all is dropped rather than shown as a
 * position that does not exist.
 */
export function citedTurnPositions(
  cited: readonly string[],
  turns: readonly EvidenceStep[],
): readonly number[] {
  const positionOf = new Map<string, number>();
  turns.forEach((turn, at) => {
    const mark = (step: EvidenceStep): void => {
      positionOf.set(step.spanId, at + 1);
      for (const child of step.spans) mark(child);
    };
    mark(turn);
  });

  const found = new Set<number>();
  for (const id of cited) {
    const at = positionOf.get(id);
    if (at !== undefined) found.add(at);
  }
  return [...found].sort((left, right) => left - right);
}

/**
 * What a page says about the plan this conversation was judged under.
 *
 * Three states and three different sentences, because the state decides how much
 * of the plan can be believed. Nothing here reconstructs a plan from today's
 * graders — a run that recorded none says so.
 */
export function planExplanation(state: EvidencePlan["state"]): string {
  if (state === "run_start") {
    return "Frozen when this run started. These are the exact grader versions this simulation was judged against.";
  }
  if (state === "migration_snapshot") {
    return "Captured while Egma was upgraded, not when this run started. This run predates frozen plans and still had work outstanding, so the plan as it stood at the upgrade is what its grading used.";
  }
  return "This run predates frozen grading plans and had nothing outstanding when Egma was upgraded, so no plan was recorded. Egma will not reconstruct one from today's graders.";
}

/**
 * The sentence a page shows above a full re-grade.
 *
 * It is never described as a replay. A re-grade judges this conversation again
 * with the immutable grader versions its run pinned. An edit applies only to a
 * new run, so neither the simulation nor its grading meaning changes here.
 */
export const REGRADE_IS_NOT_A_REPLAY =
  "A regrade judges this simulation again with the exact grader versions frozen when its run started. The simulation itself is not conducted again — nothing is dialed, nothing is said, and the transcript below does not change. An edited grader applies only to a new run; this regrade replaces the prior judgment for the same pinned version.";

/*
 * **There was a sentence here about disagreeing with a judge, and it goes with
 * the endpoint.** ADR-0009 takes corrections out of v0; they return as the
 * reserved `human` grader type, writing rows of their own under a grader id of
 * their own, and the words for that belong with it when it arrives.
 */
