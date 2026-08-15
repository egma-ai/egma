/**
 * One simulation's evidence, as the API answers it — and the two reads a page
 * does over it that are decisions rather than rendering.
 *
 * A **simulation** is one test executed once inside a run: one conversation,
 * start to finish. It produces a transcript, an outcome and measures, and
 * **graders** judge it into **verdicts**. A person may disagree with any of
 * those, and their word supersedes the machine's at read time while the
 * machine's stays exactly where it was.
 *
 * The field names are the API's own. Renaming them on the way in would put a
 * second vocabulary between the contract and the page, and the two would drift
 * the first time the API grew a field.
 *
 * **The browser decides almost nothing here.** Which versions were pinned, which
 * graders judged, which verdict the conversation folds to and whether it has
 * been judged at all are all answered by `GET /api/simulations/{id}`. The two
 * things this module works out are the two the *page* is about: which rows count
 * once a person has spoken, and which turns a judgment is pointing at.
 */

import type {
  GradingWord,
  SimulationStatusWord,
  VerdictCounts,
  VerdictWord,
} from "./runs.ts";

/** What a grader's priority was **when it judged**, never what it is today. */
export type PriorityWord = "P0" | "P1" | "P2";

/** The word `judged_by` carries when a person, rather than a model, spoke. */
export const JUDGED_BY_HUMAN = "human";

/** One judgment as the evidence read carries it. */
export type EvidenceVerdict = {
  readonly grader_id: string;
  /** Part of the row's identity: a re-grade at a new version adds beside this. */
  readonly grader_version_id: string;
  /** What inside the grader was judged — one expected behavior, or its one check. */
  readonly dimension: string;
  readonly source: string;
  readonly verdict: VerdictWord;
  readonly score: number;
  /**
   * The machine's own stable word for why, or empty. Branch on this and show
   * the rationale; branching on the rationale breaks the first time somebody
   * improves a sentence.
   */
  readonly reason: string;
  readonly priority: PriorityWord;
  readonly rationale: string;
  /** The spans this judgment is about, by their own ids. */
  readonly cited_turns: readonly string[];
  /** A judge model, `engine`, or `human`. */
  readonly judged_by: string;
  readonly judged_at: string;
};

/** One timed thing inside the conversation, with whatever happened under it. */
export type EvidenceStep = {
  readonly span_id: string;
  readonly parent_span_id: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly started_at: string;
  /** Nanoseconds, as a decimal string: a count that passes what JSON holds. */
  readonly duration_ns: string;
  readonly text: string;
  readonly audio_url: string;
  readonly tool_name: string;
  readonly tool_arguments: string;
  readonly tool_result: string;
  readonly spans: readonly EvidenceStep[];
};

export type EvidenceTranscript = {
  readonly trace_id: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly duration_ns: string;
  readonly span_count: number;
  readonly turn_counts: { readonly human: number; readonly agent: number };
  readonly tool_span_count: number;
  readonly errored_span_count: number;
  /** The turns in the order they happened, each holding what happened inside it. */
  readonly turns: readonly EvidenceStep[];
  /** Everything top-level that is not a turn — the system's own bookkeeping. */
  readonly spans: readonly EvidenceStep[];
  /** The tree is a prefix and the counts are the whole conversation. */
  readonly spans_truncated: boolean;
};

/** One grader as the run's frozen plan named it for this conversation. */
export type EvidencePlanItem =
  | {
      readonly kind: "built_in";
      readonly grader_key: string;
      readonly engine_version: string;
      readonly reads: readonly string[];
      readonly modalities: readonly string[];
      readonly judge: EvidenceJudge;
    }
  | {
      readonly kind: "authored";
      readonly grader_id: string;
      readonly grader_version_id: string;
      readonly name: string;
      readonly origin: "project_default" | "scenario_specific";
      readonly priority: PriorityWord;
      readonly scope: string;
      readonly reads: readonly string[];
      readonly modalities: readonly string[];
      readonly judge: EvidenceJudge;
    };

export type EvidenceJudge =
  | { readonly tag: "not_required" }
  | { readonly tag: "unavailable_at_capture" }
  | {
      readonly tag: "configured";
      readonly provider: string;
      readonly model: string;
      /** A credential reference or the `platform` sentinel. Never a key. */
      readonly source: string;
    };

/**
 * When this run's grading plan was decided, and whether one was decided at all.
 *
 * The state has to be shown, because it decides how much of the rest can be
 * believed. `migration_snapshot` was captured during an upgrade rather than when
 * the run began, and `not_recorded` has no plan at all — nothing reconstructs
 * one from today's graders, because that would be a claim nobody can check.
 */
export type EvidencePlan = {
  readonly state: "run_start" | "migration_snapshot" | "not_recorded";
  readonly captured_at: string | null;
  readonly items: readonly EvidencePlanItem[];
};

/** Where the judging of this conversation stands, job by job. */
export type EvidenceGradingJob = {
  readonly status: string;
  readonly regrade_grader_id: string | null;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly finished_at: string | null;
};

/** One mocked answer this conversation was conducted against. */
export type EvidenceMockTool = {
  readonly tool_name: string;
  readonly mock_tool_id?: string;
};

/**
 * Which of the agent's own tools egma stood in the path of.
 *
 * **Its absence is a fact of its own.** Null means nothing ever asked the agent
 * what tools it has, so nothing was learned and nothing is claimed; three empty
 * lists mean the asking happened and nothing came back.
 */
export type EvidenceCoverage = {
  readonly discovered: readonly string[];
  readonly covered: readonly string[];
  readonly uncovered: readonly string[];
};

/** One conversation, whole — everything one page load reads. */
export type SimulationEvidence = {
  readonly id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly run_label: string | null;
  readonly position: number;
  /** The machinery. Never a judgement of what the agent did. */
  readonly status: SimulationStatusWord;
  /** Where the judging stands. Never what it decided. */
  readonly grading: GradingWord;
  /** What was decided — and null for *nobody has decided yet*. */
  readonly verdict: VerdictWord | null;
  readonly score: number | null;
  readonly counts: VerdictCounts | null;
  readonly reason: string | null;
  readonly skip_reason: string | null;
  readonly skipped_capabilities: readonly string[] | null;
  readonly modality: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  /** The platform's own name for the exchange — the join to their telemetry. */
  readonly provider_reference: string | null;
  readonly has_recording: boolean;
  /** Only what was actually measured. A measure nobody emitted is absent. */
  readonly measures: Readonly<Record<string, number>>;
  readonly test: {
    readonly id: string | null;
    readonly version_id: string | null;
    readonly name: string | null;
    readonly scenario: string | null;
    readonly expected_behaviors:
      | readonly { readonly behavior: string; readonly priority: PriorityWord }[]
      | null;
    readonly required_capabilities: readonly string[] | null;
  };
  readonly persona: {
    readonly id: string;
    readonly name: string | null;
    readonly version_id: string;
    readonly traits: unknown;
  };
  readonly agent: {
    readonly id: string;
    readonly name: string | null;
    readonly archived: boolean | null;
  };
  readonly connection: {
    readonly id: string;
    readonly name: string | null;
    readonly archived: boolean | null;
  };
  readonly connection_snapshot: {
    readonly type: string;
    readonly modality: string;
    readonly topology: string;
    readonly environment: string | null;
    readonly config: unknown;
  };
  readonly mock_tool_coverage: EvidenceCoverage | null;
  readonly mock_tools: {
    readonly defaults: readonly EvidenceMockTool[];
    readonly overrides: readonly EvidenceMockTool[];
  };
  readonly grading_plan: EvidencePlan | null;
  readonly grading_jobs: readonly EvidenceGradingJob[];
  readonly verdicts: readonly EvidenceVerdict[];
  readonly by_grader: readonly {
    readonly grader_id: string;
    readonly verdict: VerdictWord;
    readonly score: number | null;
    readonly counts: VerdictCounts;
  }[];
  readonly transcript: EvidenceTranscript | null;
};

/** What a re-grade answers: what was asked, and what it reached. */
export type RegradeAsked = {
  readonly simulation_id: string;
  readonly grader_id: string | null;
  readonly reopened: number;
  readonly already_waiting: number;
};

/**
 * Where one conversation's own paths begin.
 *
 * Deliberately not exported as a collection address, because there is no
 * collection route: conversations are listed by the run that holds them, and a
 * constant claiming `/api/simulations` answers something would be a promise
 * nothing keeps.
 */
const ONE_SIMULATION = "/api/simulations";

export function simulationPath(simulationId: string): string {
  return `${ONE_SIMULATION}/${encodeURIComponent(simulationId)}`;
}

export function simulationRegradePath(simulationId: string): string {
  return `${simulationPath(simulationId)}/regrade`;
}

export function simulationCorrectionsPath(simulationId: string): string {
  return `${simulationPath(simulationId)}/corrections`;
}

/** Where one conversation's evidence lives inside its run, inside its project. */
export function simulationSection(runId: string): readonly string[] {
  return ["runs", runId, "simulations"];
}

/* ------------------------------------------------------------------------ *
 * Reading the rows: which of them count, and what they are about.
 * ------------------------------------------------------------------------ */

/**
 * One judged dimension, with the row that counts and the rows beneath it.
 *
 * **The machine's word is kept and shown, never replaced.** That is the whole
 * reason a correction is stored as a second row: accumulated, those pairs are
 * the ground truth any future measurement of judge accuracy is made of, and a
 * page that hid the machine's row would be an edit with extra steps.
 */
export type JudgedDimension = {
  readonly key: string;
  readonly graderId: string;
  readonly graderVersionId: string;
  readonly dimension: string;
  readonly source: string;
  /** What counts now: the person's word where there is one, the machine's else. */
  readonly speaking: EvidenceVerdict;
  /** The machine's row for the grading that speaks, where there is one. */
  readonly machine: EvidenceVerdict | null;
  /** True where a person's word is what counts. */
  readonly corrected: boolean;
  /** Earlier gradings of the same dimension, newest first. Evidence, not noise. */
  readonly superseded: readonly EvidenceVerdict[];
};

/** A dimension's identity: everything except which grading of it this is. */
function dimensionKey(row: EvidenceVerdict): string {
  return `${row.grader_id} ${row.dimension} ${row.source}`;
}

function whenJudged(row: EvidenceVerdict): number {
  const at = Date.parse(row.judged_at);
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Every judged dimension of this conversation, folded the way the store folds
 * it: **the newest grading speaks, and inside it the person's word wins.**
 *
 * The newest grading is decided by the clock on the machine's rows, because a
 * grading is something the engine did and a re-grade happens after the grading
 * it supersedes — so nothing here has to understand version identifiers to know
 * which came second. A grading with no machine row at all falls back to its own
 * rows' clock, because this has to be total: it is handed whatever rows exist.
 *
 * A person correcting an *older* grading therefore does not pull it back in
 * front of a newer one. Their word stands against the grading they read, which
 * is the only one they can have read.
 *
 * This is the browser's copy of an algebra the server also performs, and that is
 * deliberate rather than accidental duplication: the server folds it into one
 * verdict for the header, and the page has to show the working — which rows
 * count, which are superseded, and which the machine wrote underneath a person's
 * word. Neither can produce the other's answer from the other's output.
 */
export function judgedDimensions(
  rows: readonly EvidenceVerdict[],
): readonly JudgedDimension[] {
  const byDimension = new Map<string, EvidenceVerdict[]>();
  for (const row of rows) {
    const key = dimensionKey(row);
    const held = byDimension.get(key);
    if (held === undefined) byDimension.set(key, [row]);
    else held.push(row);
  }

  return [...byDimension.entries()].map(([key, its]) => {
    const gradings = new Map<string, EvidenceVerdict[]>();
    for (const row of its) {
      const held = gradings.get(row.grader_version_id);
      if (held === undefined) gradings.set(row.grader_version_id, [row]);
      else held.push(row);
    }

    const clockOf = (grading: readonly EvidenceVerdict[]): number => {
      const machine = grading.filter((row) => row.judged_by !== JUDGED_BY_HUMAN);
      const read = machine.length > 0 ? machine : grading;
      return Math.max(...read.map(whenJudged));
    };

    const ordered = [...gradings.values()].sort(
      (left, right) => clockOf(right) - clockOf(left),
    );
    const [newest = [], ...older] = ordered;

    const machine =
      newest.find((row) => row.judged_by !== JUDGED_BY_HUMAN) ?? null;
    const said = newest.find((row) => row.judged_by === JUDGED_BY_HUMAN) ?? null;
    // `newest` is never empty: a grading only exists here because a row is in
    // it. The fallback keeps the type honest without inventing a row.
    const speaking = said ?? machine ?? (newest[0] as EvidenceVerdict);

    return {
      key,
      graderId: speaking.grader_id,
      graderVersionId: speaking.grader_version_id,
      dimension: speaking.dimension,
      source: speaking.source,
      speaking,
      machine,
      corrected: said !== null,
      superseded: older.flat(),
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
      positionOf.set(step.span_id, at + 1);
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
    return "Frozen when this run started. These are the exact grader versions and judge choices this conversation was judged against.";
  }
  if (state === "migration_snapshot") {
    return "Captured while egma was upgraded, not when this run started. This run predates frozen plans and still had work outstanding, so the plan as it stood at the upgrade is what its grading used.";
  }
  return "This run predates frozen grading plans and had nothing outstanding when egma was upgraded, so no plan was recorded. Egma will not reconstruct one from today's graders.";
}

/**
 * The sentence a page shows above a full re-grade.
 *
 * It is never described as a replay. A re-grade judges this conversation again
 * at **today's** grader versions, so a grader somebody has since tightened will
 * say something different — which is the point, and which somebody who read
 * "run it again" would not expect.
 */
export const REGRADE_IS_NOT_A_REPLAY =
  "A regrade judges this conversation again at today's grader versions. The conversation itself is not conducted again — nothing is dialed, nothing is said, and the transcript below does not change. A grader that has been edited since will write a new row beside the old one rather than over it, and both stay readable.";

/**
 * The sentence a page shows above a correction.
 *
 * The whole point is that it adds rather than replaces, and somebody about to
 * disagree with a judge should know that before they do it rather than after.
 */
export const A_CORRECTION_ADDS =
  "Your word is written as a verdict of its own, beside the machine's. The machine's verdict stays exactly where it is and stays readable; yours is what counts from the next read on.";
