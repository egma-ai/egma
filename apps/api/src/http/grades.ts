import type {
  NamedCurrentGrade,
  NamedRecordedGrade,
  TraceGrading,
} from "@egma/db";

/**
 * The one grade shape shared by simulation and production trace reads.
 *
 * ClickHouse keeps storage names and microsecond sort keys. The public API
 * sends only the stable product facts. History derives its individual result
 * from the same frozen threshold as the current row; it never re-reads today's
 * project policy.
 */
function describedGrade(
  grade: NamedRecordedGrade | NamedCurrentGrade,
): Record<string, unknown> {
  const result =
    "result" in grade
      ? grade.result
      : grade.score === null
        ? "errored"
        : grade.score >= grade.graderPassThreshold
          ? "passed"
          : "failed";

  return {
    projectGraderId: grade.projectGraderId,
    graderDefinitionId: grade.graderDefinitionId,
    graderDefinitionVersion: grade.graderDefinitionVersion,
    graderName: grade.graderName,
    score: grade.score,
    details: grade.details,
    passThreshold: grade.graderPassThreshold,
    result,
    gradedAt: grade.gradedAt,
  };
}

/** The shared public projection for one trace's grading work. */
export function describedTraceGrading(
  grading: TraceGrading | undefined,
): {
  readonly gradingState: TraceGrading["state"] | null;
  readonly grades: readonly Record<string, unknown>[];
  readonly gradeHistory: readonly Record<string, unknown>[];
  readonly combinedScore: number | null;
} {
  if (grading === undefined) {
    return {
      gradingState: null,
      grades: [],
      gradeHistory: [],
      combinedScore: null,
    };
  }

  return {
    gradingState: grading.state,
    grades: grading.current.map(describedGrade),
    gradeHistory: grading.history.map(describedGrade),
    combinedScore: grading.combinedScore,
  };
}
