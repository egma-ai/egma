import type { GetTraceResponse } from "@egma/platform-api/client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { graderDisplayName } from "../lib/presentation.ts";
import {
  GradeDetails,
  GradeResultBadge,
  gradeResultTone,
} from "../ui/grade.tsx";
import { shownScore } from "../ui/run-status.tsx";

type Grade = GetTraceResponse["grades"][number];

/** One current or earlier result from one project grader. */
export function GradeCard({
  grade,
  historical = false,
}: {
  readonly grade: Grade;
  readonly historical?: boolean;
}) {
  const resultTone = gradeResultTone(grade.result);
  return (
    <article
      className={cn(
        "min-w-0 rounded-input border border-border border-s-[3px] bg-surface-soft p-4",
        resultTone === "success" ? "border-s-success" : "border-s-failure",
      )}
      data-result={grade.result}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <GradeResultBadge result={grade.result} />
        <strong className="text-sm font-medium">
          {graderDisplayName(grade.graderName)}
        </strong>
        {historical ? (
          <Badge className="ms-auto" variant="neutral">
            Earlier grade
          </Badge>
        ) : null}
      </div>
      <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(var(--grade-fact-min),1fr))] gap-3 text-sm">
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
      <div className="mt-4">
        <GradeDetails grade={grade} />
      </div>
    </article>
  );
}
