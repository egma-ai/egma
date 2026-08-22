export type GradeResult = "passed" | "failed" | "errored";

export type GradeForCurrentResult = {
  readonly projectGraderId: string;
  readonly score: number | null;
  readonly graderPassThreshold: number;
  /** Internal order assigned when a worker claims the trace-level job. */
  readonly gradingSequence: number;
  readonly gradedAtMicroseconds: bigint;
};

export type CurrentGradeOf<Grade extends GradeForCurrentResult> = Grade & {
  readonly result: GradeResult;
};

/** Keep the latest claimed result for each project grader. */
export function currentGrades<Grade extends GradeForCurrentResult>(
  history: readonly Grade[],
): readonly CurrentGradeOf<Grade>[] {
  const current = new Map<string, Grade>();
  for (const grade of history) {
    const held = current.get(grade.projectGraderId);
    if (
      held === undefined ||
      grade.gradingSequence > held.gradingSequence ||
      (grade.gradingSequence === held.gradingSequence &&
        grade.gradedAtMicroseconds > held.gradedAtMicroseconds)
    ) {
      current.set(grade.projectGraderId, grade);
    }
  }
  return [...current.values()]
    .sort((left, right) =>
      left.projectGraderId.localeCompare(right.projectGraderId)
    )
    .map((grade) => ({
      ...grade,
      result:
        grade.score === null
          ? ("errored" as const)
          : grade.score >= grade.graderPassThreshold
            ? ("passed" as const)
            : ("failed" as const),
    }));
}

/**
 * The display-only arithmetic mean for one frozen plan.
 *
 * Missing work and a current grading error both return null. The caller must
 * pass the selected project graders from the immutable simulation plan or
 * production receipt; using only rows would silently ignore pending work.
 */
export function combinedGradeScore(
  selectedProjectGraderIds: readonly string[],
  current: readonly {
    readonly projectGraderId: string;
    readonly score: number | null;
  }[],
): number | null {
  if (selectedProjectGraderIds.length === 0) return null;

  const selected = new Set(selectedProjectGraderIds);
  if (selected.size !== selectedProjectGraderIds.length) {
    throw new TypeError(
      "a frozen grader plan cannot contain duplicate project graders",
    );
  }

  const byProjectGrader = new Map(
    current.map((grade) => [grade.projectGraderId, grade] as const),
  );
  let total = 0;
  for (const projectGraderId of selected) {
    const grade = byProjectGrader.get(projectGraderId);
    if (grade === undefined || grade.score === null) return null;
    total += grade.score;
  }
  return total / selected.size;
}
