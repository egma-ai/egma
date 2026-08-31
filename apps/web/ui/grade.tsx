import type { GetTraceResponse } from "@egma/platform-api/client";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";

import { humanizeIdentifier } from "../lib/transcripts.ts";
import { shownScore, StateMark } from "./run-status.tsx";

export type DisplayGrade = GetTraceResponse["grades"][number];
export type DisplayGradeAssertion = NonNullable<
  DisplayGrade["details"]["assertions"]
>[number];

function summaryScore(score: number | null): string {
  return score === null ? "Not available" : score.toFixed(2);
}

/** The count a repeated single-assertion rationale gives way to. */
function assertionCount(
  assertions: readonly DisplayGradeAssertion[],
): string {
  const total = assertions.length;
  const unit = total === 1 ? "assertion" : "assertions";
  const ungraded = assertions.filter(
    (assertion) => assertion.error !== undefined,
  ).length;
  if (ungraded > 0) {
    return `${String(ungraded)} of ${String(total)} ${unit} could not be graded.`;
  }
  const passed = assertions.filter(
    (assertion) => assertion.score === 1,
  ).length;
  return `${String(passed)} of ${String(total)} ${unit} passed.`;
}

/** The semantic tone shared by a grade badge and its evidence card. */
export function gradeResultTone(
  result: DisplayGrade["result"],
): "success" | "failure" {
  return result === "passed" ? "success" : "failure";
}

const RESULT_MARK = {
  passed: "complete",
  failed: "failed",
  errored: "error",
} as const;

/** One shared result badge for simulation and production grades. */
export function GradeResultBadge({
  result,
}: {
  readonly result: DisplayGrade["result"];
}) {
  return (
    <Badge variant={gradeResultTone(result)}>
      <StateMark kind={RESULT_MARK[result]} />
      {result}
    </Badge>
  );
}

/**
 * The compact score sentence used wherever a grade is named. A frozen plan can
 * supply the threshold and definition version while the grade is still absent.
 */
export function gradeSummary({
  grade,
  passThreshold,
  graderDefinitionVersion,
}: {
  readonly grade: DisplayGrade | null;
  readonly passThreshold?: number;
  readonly graderDefinitionVersion?: number;
}): string {
  const threshold = grade?.passThreshold ?? passThreshold;
  const version = grade?.graderDefinitionVersion ?? graderDefinitionVersion;
  const parts: string[] = [];
  if (grade !== null) parts.push(`Score ${summaryScore(grade.score)}`);
  if (threshold !== undefined) {
    parts.push(`pass threshold ${summaryScore(threshold)}`);
  }
  if (version !== undefined) parts.push(`definition v${String(version)}`);
  return parts.join(" · ");
}

/** Rationale and nested assertion evidence shared by both trace surfaces. */
export function GradeDetails({
  grade,
  assertionName = (assertion) => humanizeIdentifier(assertion.key),
  renderCitations,
}: {
  readonly grade: DisplayGrade;
  readonly assertionName?: (
    assertion: DisplayGradeAssertion,
    at: number,
  ) => string;
  readonly renderCitations?: (
    assertion: DisplayGradeAssertion,
    at: number,
  ) => ReactNode;
}) {
  const rationale = grade.details.rationale;
  const error = grade.details.error;
  const assertions = grade.details.assertions ?? [];
  /*
   * The LLM judge writes one assertion and copies its rationale to the top of
   * the grade, and every stored grade carries that copy. The assertion below is
   * the record, so a top line that only repeats it becomes the count instead —
   * computed here, so grades written before this rule read the same way.
   */
  const repeated =
    typeof rationale === "string" &&
    assertions.some((assertion) => assertion.rationale === rationale);
  const topLine = repeated ? assertionCount(assertions) : rationale;

  return (
    <>
      {typeof topLine === "string" && topLine.trim() !== "" ? (
        <p className="m-0 text-sm wrap-anywhere text-foreground">{topLine}</p>
      ) : null}
      {typeof error === "string" && error.trim() !== "" ? (
        <p className="m-0 text-sm wrap-anywhere text-failure">{error}</p>
      ) : null}
      {assertions.length === 0 ? null : (
        <div className="border-t border-border pt-3">
          <p className="m-0 text-sm font-medium">Assertion details</p>
          <ul className="mt-2 mb-0 flex list-none flex-col gap-2 p-0">
            {assertions.map((assertion, at) => {
              const citations = renderCitations?.(assertion, at);
              return (
                <li
                  key={`${assertion.key}:${String(at)}`}
                  className="rounded-input border border-border bg-surface p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="font-medium">
                      {assertionName(assertion, at)}
                    </strong>
                    {assertion.score === undefined ? null : (
                      <span className="font-mono tabular-nums">
                        {shownScore(assertion.score)}
                      </span>
                    )}
                  </div>
                  {assertion.rationale === undefined ? null : (
                    <p className="mt-1 mb-0 wrap-anywhere text-muted-foreground">
                      {assertion.rationale}
                    </p>
                  )}
                  {assertion.error === undefined ? null : (
                    <p className="mt-1 mb-0 wrap-anywhere text-failure">
                      {assertion.error}
                    </p>
                  )}
                  {/*
                    * Only a surface that can say a citation well says it at
                    * all: the simulation page passes turn links here. A raw
                    * span id tells a reader nothing, so without a renderer the
                    * cited ids stay stored and unshown.
                    */}
                  {citations === undefined || citations === null ? null : (
                    <p className="mt-1 mb-0 wrap-anywhere text-muted-foreground">
                      {citations}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
