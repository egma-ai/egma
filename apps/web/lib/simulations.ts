/**
 * One simulation's evidence, exactly as the platform API answers it.
 *
 * A completed simulation can have several grades. Each grader returns one
 * normalized score, its individual pass threshold and optional assertion
 * details. The server already selects the current grade for each project
 * grader and computes the display-only combined score. The browser does not
 * fold rows or create another pass/fail decision.
 */
import type {
  GetSimulationResponse,
  Refusal,
  RegradeSimulationResponse,
  TraceSpan,
} from "@egma/platform-api/client";

/** One timed thing inside the simulation, with whatever happened under it. */
export type EvidenceStep = TraceSpan;

export type EvidenceTranscript = NonNullable<
  GetSimulationResponse["transcript"]
>;

/** One current or historical grade. */
export type EvidenceGrade = GetSimulationResponse["grades"][number];

/** One assertion reported inside a grade. Assertions are not separate rows. */
export type EvidenceGradeAssertion = NonNullable<
  EvidenceGrade["details"]["assertions"]
>[number];

/** The exact project-grader plan frozen when the run started. */
export type EvidencePlan = NonNullable<GetSimulationResponse["gradingPlan"]>;
export type EvidencePlanItem = EvidencePlan["items"][number];

/** One simulation and all evidence available for it. */
export type SimulationEvidence = GetSimulationResponse;

/** What the whole-simulation regrade request reached. */
export type RegradeAsked = RegradeSimulationResponse;

/** Where one simulation lives inside its run and project. */
export function simulationSection(runId: string): readonly string[] {
  return ["runs", runId, "simulations"];
}

function samePublicGrade(left: EvidenceGrade, right: EvidenceGrade): boolean {
  return left.projectGraderId === right.projectGraderId &&
    left.graderDefinitionId === right.graderDefinitionId &&
    left.graderDefinitionVersion === right.graderDefinitionVersion &&
    left.graderName === right.graderName &&
    left.score === right.score &&
    JSON.stringify(left.details) === JSON.stringify(right.details) &&
    left.passThreshold === right.passThreshold &&
    left.result === right.result &&
    left.gradedAt === right.gradedAt;
}

/** Remove exactly the one public history row represented by `current`. */
export function withoutCurrentGrade<Grade extends EvidenceGrade>(
  current: Grade,
  history: readonly Grade[],
): readonly Grade[] {
  let removed = false;
  return history.filter((grade) => {
    if (removed || !samePublicGrade(grade, current)) return true;
    removed = true;
    return false;
  });
}

/** Historical grades for one project grader, newest first. */
export function priorGrades(
  current: EvidenceGrade,
  history: readonly EvidenceGrade[],
): readonly EvidenceGrade[] {
  return withoutCurrentGrade(current, history)
    .filter((grade) => grade.projectGraderId === current.projectGraderId)
    .sort(
      (left, right) => Date.parse(right.gradedAt) - Date.parse(left.gradedAt),
    );
}

/**
 * Which transcript turns a grade assertion cites, by reading order.
 *
 * A cited nested span resolves to the turn that contains it. A span that is not
 * in this transcript is ignored instead of producing a link to nowhere.
 */
export function citedTurnPositions(
  citedSpanIds: readonly string[],
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
  for (const id of citedSpanIds) {
    const position = positionOf.get(id);
    if (position !== undefined) found.add(position);
  }
  return [...found].sort((left, right) => left - right);
}

/** What the simulation page says before a whole-simulation regrade. */
export const REGRADE_IS_NOT_A_REPLAY =
  "A regrade asks every grader in this simulation's frozen plan to grade the same evidence again. It does not conduct the simulation again: nothing is dialed, nothing is said, and the transcript does not change. New grades are added to history; earlier grades stay available.";

/** Keep internal simulation ids out of a regrade refusal shown to a person. */
export function regradeRefusalMessage(refusal: Refusal): string {
  if (refusal.error === "unprocessable") {
    return "This simulation did not finish with gradeable evidence, so it cannot be regraded.";
  }
  return refusal.message
    .replace(/\bsimulation\s+sim_[a-z0-9]+\b/giu, "this simulation")
    .replace(/\bsim_[a-z0-9]+\b/giu, "this simulation");
}
