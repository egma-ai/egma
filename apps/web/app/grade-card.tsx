import type { GetTraceResponse } from "@egma/platform-api/client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { graderDisplayName } from "../lib/presentation.ts";
import { humanizeIdentifier } from "../lib/transcripts.ts";
import { shownScore } from "../ui/run-status.tsx";

type Grade = GetTraceResponse["grades"][number];

function toneOf(result: Grade["result"]): "success" | "failure" | "warning" {
  if (result === "passed") return "success";
  return result === "failed" ? "failure" : "warning";
}

/** One current or earlier result from one project grader. */
export function GradeCard({
  grade,
  historical = false,
}: {
  readonly grade: Grade;
  readonly historical?: boolean;
}) {
  const rationale = grade.details.rationale;
  const error = grade.details.error;
  const assertions = grade.details.assertions ?? [];

  return (
    <article
      className={cn(
        "min-w-0 rounded-input border border-border border-s-[3px] bg-surface-soft p-4",
        grade.result === "passed"
          ? "border-s-success"
          : grade.result === "failed"
            ? "border-s-failure"
            : "border-s-warning",
      )}
      data-result={grade.result}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant={toneOf(grade.result)}>{grade.result}</Badge>
        <strong className="text-sm font-medium">
          {graderDisplayName(grade.graderName)}
        </strong>
        {historical ? (
          <Badge className="ms-auto" variant="neutral">
            Earlier grade
          </Badge>
        ) : null}
      </div>
      <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Score</dt>
          <dd className="m-0 font-mono tabular-nums">{shownScore(grade.score)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Pass threshold</dt>
          <dd className="m-0 font-mono tabular-nums">
            {shownScore(grade.passThreshold)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Graded</dt>
          <dd className="m-0">{new Date(grade.gradedAt).toLocaleString()}</dd>
        </div>
      </dl>
      {typeof rationale === "string" && rationale.trim() !== "" ? (
        <p className="mb-0 text-sm text-foreground">{rationale}</p>
      ) : null}
      {typeof error === "string" && error.trim() !== "" ? (
        <p className="mb-0 text-sm text-failure">{error}</p>
      ) : null}
      {assertions.length === 0 ? null : (
        <div className="mt-4 border-t border-border pt-3">
          <p className="m-0 text-sm font-medium">Assertion details</p>
          <ul className="mt-2 mb-0 flex list-none flex-col gap-2 p-0">
            {assertions.map((assertion) => (
              <li
                key={assertion.key}
                className="rounded-input border border-border bg-surface p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="font-medium">
                    {humanizeIdentifier(assertion.key)}
                  </strong>
                  {assertion.score === undefined ? null : (
                    <span className="font-mono tabular-nums">
                      {shownScore(assertion.score)}
                    </span>
                  )}
                </div>
                {assertion.rationale === undefined ? null : (
                  <p className="mt-1 mb-0 text-muted-foreground">
                    {assertion.rationale}
                  </p>
                )}
                {assertion.error === undefined ? null : (
                  <p className="mt-1 mb-0 text-failure">{assertion.error}</p>
                )}
                {assertion.citedSpanIds === undefined ||
                assertion.citedSpanIds.length === 0 ? null : (
                  <p className="mt-1 mb-0 text-muted-foreground">
                    Cited spans: {assertion.citedSpanIds.join(", ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
