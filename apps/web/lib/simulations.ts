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
 * `GET /api/simulations/{id}`. The two things this module works out are the two
 * the *page* is about: which of several gradings of one assertion counts, and
 * which turns a judgment is pointing at.
 */

import type {
  GradingWord,
  SimulationStatusWord,
  VerdictCounts,
  VerdictWord,
} from "./runs.ts";

/** One judgment as the evidence read carries it. */
export type EvidenceVerdict = {
  readonly grader_id: string;
  /**
   * Which 0-or-1 check inside the grader this answers, as its **key** — a
   * behavior's position in the pinned test version, a measure's own name.
   * Opaque here: it is what a page groups and filters by.
   */
  readonly assertion: string;
  /**
   * The words behind that key, resolved from the version this conversation was
   * pinned to — or null where nothing could place it, in which case a page
   * shows the key rather than a guess.
   */
  readonly assertion_text: string | null;
  /** `false` for a diagnostic copy's row: shown, and never able to fail this. */
  readonly required: boolean;
  readonly verdict: VerdictWord;
  readonly score: number;
  readonly rationale: string;
  /** The spans this judgment is about, by their own ids. */
  readonly cited_turns: readonly string[];
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

/**
 * One running copy as the run's frozen plan named it for this conversation.
 *
 * One shape, where there used to be two: the expected-behaviors built-in is an
 * ordinary running copy now and arrives here like everything else.
 */
export type EvidencePlanItem = {
  readonly kind: "authored";
  readonly grader_id: string;
  readonly grader_version_id: string;
  readonly name: string;
  readonly library_id: string;
  /** `false` makes it a diagnostic: judged, shown, never able to fail a test. */
  readonly required: boolean;
  readonly scope: string;
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

/** One folded answer, at whichever grain answers it. */
export type EvidenceOutcome = {
  readonly verdict: VerdictWord;
  readonly score: number | null;
  readonly counts: VerdictCounts;
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
    /** Plain sentences, in the order they were written. */
    readonly expected_behaviors: readonly string[] | null;
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
  /** The required lane's answer for this conversation, and the other lane. */
  readonly outcome: EvidenceOutcome | null;
  readonly diagnostics: EvidenceOutcome | null;
  readonly by_grader: readonly {
    readonly grader_id: string;
    /** `false` marks a diagnostic: judged, shown, never able to fail. */
    readonly required: boolean;
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
 * **An earlier judgment is kept and shown, never replaced.** A re-grade writes a
 * new row rather than over the old one, and a page that hid the earlier one
 * would make "this grader was tightened and now disagrees" invisible.
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
  return JSON.stringify([row.grader_id, row.assertion]);
}

function whenJudged(row: EvidenceVerdict): number {
  const at = Date.parse(row.judged_at);
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Every judged assertion of this conversation, folded the way the store folds
 * it: **the newest judgment speaks, and the ones under it stay readable.**
 *
 * Decided by the clock on the rows and by nothing else. The grader version each
 * row was written at is deliberately not on this wire — a copy's definition is
 * read through its library pointer at judging time and a version identifier is
 * not something a reader can act on — so "which grading" is answered by when,
 * which is the same order a re-grade actually happened in.
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
      graderId: speaking.grader_id,
      assertion: speaking.assertion,
      assertionText: speaking.assertion_text,
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
    return "Frozen when this run started. These are the exact grader versions and judge choices this simulation was judged against.";
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
 * at **today's** grader versions, so a grader somebody has since tightened will
 * say something different — which is the point, and which somebody who read
 * "run it again" would not expect.
 */
export const REGRADE_IS_NOT_A_REPLAY =
  "A regrade judges this simulation again at today's grader versions. The simulation itself is not conducted again — nothing is dialed, nothing is said, and the transcript below does not change. A grader that has been edited since will write a new row beside the old one rather than over it, and both stay readable.";

/*
 * **There was a sentence here about disagreeing with a judge, and it goes with
 * the endpoint.** ADR-0009 takes corrections out of v0; they return as the
 * reserved `human` grader type, writing rows of their own under a grader id of
 * their own, and the words for that belong with it when it arrives.
 */
