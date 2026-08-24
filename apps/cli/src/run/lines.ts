/** Plain-line run output shared by `egma run` and the headless wizard. */

import type { GradeProjection, PlatformGrade } from "../platform/runs.ts";
import type { RunChange, RunProgress, SimulationRow } from "./follow.ts";

export function scoreText(score: number | null | undefined): string {
  return score === null || score === undefined ? "unavailable" : score.toFixed(2);
}

export function graderLabel(name: string): string {
  const words = name.replaceAll("_", " ").replaceAll("-", " ").trim();
  return words === "" ? "Unnamed grader" : `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

export function assertionLabel(key: string, at: number): string {
  const behavior = /^behavior_(\d+)$/u.exec(key)?.[1];
  return (behavior ?? String(at + 1)).padStart(2, "0");
}

export function assertionBehavior(
  key: string,
  expectedBehaviors: readonly string[] | null,
): string | null {
  const at = Number(/^behavior_(\d+)$/u.exec(key)?.[1] ?? "0") - 1;
  return at < 0 ? null : (expectedBehaviors?.[at] ?? null);
}

function gradeLines(
  grade: PlatformGrade,
  expectedBehaviors: readonly string[] | null,
): readonly string[] {
  const lines = [
    `grade: ${graderLabel(grade.graderName)} score ${scoreText(grade.score)} pass-threshold ${scoreText(grade.passThreshold)} result ${grade.result}`,
    `graded-at: ${grade.gradedAt}`,
  ];
  if (grade.details.rationale !== undefined) {
    lines.push(`grade-rationale: ${grade.details.rationale}`);
  }
  if (grade.details.error !== undefined) {
    lines.push(`grade-error: ${grade.details.error}`);
  }
  for (const assertion of grade.details.assertions ?? []) {
    const parts = [`assertion: ${assertion.key}`];
    if (assertion.score !== undefined) parts.push(`score ${scoreText(assertion.score)}`);
    const behavior = assertionBehavior(assertion.key, expectedBehaviors);
    if (behavior !== null) parts.push(`behavior ${behavior}`);
    if (assertion.rationale !== undefined) parts.push(`rationale ${assertion.rationale}`);
    if (assertion.citedSpanIds !== undefined && assertion.citedSpanIds.length > 0) {
      parts.push(`spans ${assertion.citedSpanIds.join(",")}`);
    }
    if (assertion.error !== undefined) parts.push(`error ${assertion.error}`);
    lines.push(parts.join(" "));
  }
  return lines;
}

/** Current individual grades plus their display-only mean, without an overall result. */
export function gradeProjectionLines(
  projection: GradeProjection,
): readonly string[] {
  const lines: string[] = [];
  if (projection.combinedScore !== null) {
    lines.push(`combined-score: ${scoreText(projection.combinedScore)}`);
  } else if (projection.grades.length > 0) {
    lines.push("combined-score: unavailable");
  }
  for (const grade of projection.grades) {
    lines.push(...gradeLines(grade, projection.expectedBehaviors));
  }
  return lines;
}

export function simulationLine(row: SimulationRow): string {
  return `simulation: ${row.name} ${row.persona} ${row.status}`;
}

export function gradingLine(row: SimulationRow): string | null {
  return row.gradingState === null
    ? null
    : `grading: ${row.name} ${row.persona} ${row.gradingState}`;
}

/** Report execution changes and trace-level grading progress without a verdict. */
export function changeLines(change: RunChange): readonly string[] {
  const lines: string[] = [];
  if (change.statusChanged) lines.push(simulationLine(change.row));
  if (change.reasonChanged && change.row.reason !== null) {
    lines.push(`reason: ${change.row.reason}`);
  }
  if (change.gradingChanged) {
    const grading = gradingLine(change.row);
    if (grading !== null) lines.push(grading);
  }
  if (change.gradeProjectionChanged && change.row.gradeProjection !== null) {
    lines.push(...gradeProjectionLines(change.row.gradeProjection));
  }
  if (change.firstResult && change.row.gradingState !== null) {
    lines.push(
      `first-result: ${change.row.name} ${change.row.persona} ${change.row.gradingState}`,
    );
  }
  return lines;
}

/** Final operational progress, separate from the grade detail lines above. */
export function progressLines(progress: RunProgress): readonly string[] {
  return [
    `execution-finished: ${progress.executionFinished}`,
    `execution-failed: ${progress.executionFailed}`,
    `execution-canceled: ${progress.executionCanceled}`,
    `grading-terminal: ${progress.gradingTerminal}`,
    `grading-complete: ${progress.gradingComplete}`,
    `grading-not-requested: ${progress.gradingNotRequested}`,
    `grading-errors: ${progress.gradingErrors}`,
    `grading-pending: ${progress.gradingPending}`,
    `grading-running: ${progress.gradingRunning}`,
    `simulations: ${progress.total}`,
  ];
}
