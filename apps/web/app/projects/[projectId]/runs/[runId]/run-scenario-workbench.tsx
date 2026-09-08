"use client";

import { getSimulation, regradeSimulation } from "@egma/platform-api/client";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TablePanel,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import type { Refusal } from "../../../../../lib/api.ts";
import { EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID } from "../../../../../lib/graders.ts";
import { asSecond } from "../../../../../lib/instants.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { platformAnswer, platformClient } from "../../../../../lib/platform-client.ts";
import { graderDisplayName } from "../../../../../lib/presentation.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  executionFailureMessage,
  type RunSimulation,
  type SimulationStatusWord,
} from "../../../../../lib/runs.ts";
import {
  priorGrades,
  REGRADE_IS_NOT_A_REPLAY,
  regradeRefusalMessage,
  type EvidenceGrade,
  type EvidenceGradeAssertion,
  type EvidencePlanItem,
  type SimulationEvidence,
  type RegradeAsked,
} from "../../../../../lib/simulations.ts";
import { humanizeIdentifier } from "../../../../../lib/transcripts.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { Failure, Loading } from "../../../../../ui/page-state.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { Problem, Refused } from "../../../../../ui/form.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  StateMark,
  shownScore,
  simulationSquare,
} from "../../../../../ui/run-status.tsx";
import {
  SimulationTranscript,
  evidenceGradeTally,
  recordingSpeakerTimeline,
  RecordingEvidence,
  SimulationEvidenceSummary,
  useSimulationEvidenceRecording,
  waitingForSimulationTranscript,
} from "../../../../../ui/simulation-evidence.tsx";
import { Actions } from "../../../../../ui/section.tsx";
import { useShellSession } from "../../../../../ui/shell.tsx";

type MoreSimulations = {
  readonly onMore: () => void;
  readonly loading: boolean;
  readonly note: string;
};

const EXECUTION_LABEL: Readonly<Record<SimulationStatusWord, string>> = {
  queued: "Pending",
  claimed: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Execution failed",
  canceled: "Canceled",
};

/**
 * One row in the list, opening with the state square its word explains.
 *
 * The square stands at the start of the first line and the word follows the
 * persona, so a graded row reads "Patient caller · 2/3 passed" rather than
 * asking a colour to carry the verdict. The label a screen reader announces
 * carries the same word.
 */
function SimulationChoice({
  row,
  selected,
  onSelect,
}: {
  readonly row: RunSimulation;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const square = simulationSquare(row);
  return (
    <li className="m-0 min-w-0">
      <button
        className={cn(
          "relative block min-h-(--tap-target) w-full cursor-pointer border-0 border-b border-border bg-transparent px-4 py-3 text-left",
          "pointer-hover:data-[selected=false]:bg-surface-soft",
          selected && "bg-selected before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-brand",
        )}
        data-selected={selected ? "true" : "false"}
        type="button"
        aria-label={`${row.testName ?? "No stored test"}, ${row.personaName}, ${square.word}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="flex min-w-0 items-start gap-2">
          {/* The square sits on the first line's own height, not the row's. */}
          <span className="flex h-5 flex-none items-center">
            <StateMark kind={square.kind} filled pulse={square.pulse} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {row.testName ?? "No stored test"}
            </span>
            <span className="mt-1 block truncate text-sm text-muted-foreground">
              {`${row.personaName} · ${square.word}`}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

type GraderRow = {
  readonly key: string;
  readonly name: string;
  readonly plan: EvidencePlanItem | null;
  readonly grade: EvidenceGrade | null;
  readonly history: readonly EvidenceGrade[];
};

const STACKED_BEHAVIOR_CELL = cn(
  "stacked:flex stacked:h-auto stacked:min-h-0 stacked:items-start",
  "stacked:justify-between stacked:gap-4 stacked:border-0 stacked:p-0",
  "stacked:before:flex-none stacked:before:text-sm stacked:before:text-faint",
  "stacked:before:content-[attr(data-label)]",
);

function graderRows(evidence: SimulationEvidence): readonly GraderRow[] {
  const plan = evidence.gradingPlan?.items ?? [];
  const keys = new Set<string>();
  for (const item of plan) keys.add(item.projectGraderId);
  for (const grade of evidence.grades) keys.add(grade.projectGraderId);
  for (const grade of evidence.gradeHistory) keys.add(grade.projectGraderId);

  return [...keys].map((key) => {
    const item = plan.find((one) => one.projectGraderId === key) ?? null;
    const grade = evidence.grades.find((one) => one.projectGraderId === key) ?? null;
    const history = grade === null
      ? evidence.gradeHistory
          .filter((one) => one.projectGraderId === key)
          .sort((left, right) => Date.parse(right.gradedAt) - Date.parse(left.gradedAt))
      : priorGrades(grade, evidence.gradeHistory);
    const storedName = grade?.graderName ?? item?.graderName ?? "Grader unavailable";
    return {
      key,
      name: humanizeIdentifier(graderDisplayName(storedName)),
      plan: item,
      grade,
      history,
    };
  });
}

function findingOf(grade: EvidenceGrade): string {
  const rationale = grade.details.rationale;
  if (typeof rationale === "string" && rationale.trim() !== "") return rationale;
  const error = grade.details.error;
  if (typeof error === "string" && error.trim() !== "") return error;
  const assertions = grade.details.assertions ?? [];
  const findings = assertions.flatMap((assertion) => {
    if (typeof assertion.rationale === "string" && assertion.rationale.trim() !== "") {
      return [assertion.rationale];
    }
    if (typeof assertion.error === "string" && assertion.error.trim() !== "") {
      return [assertion.error];
    }
    return [];
  });
  if (findings.length > 0) return findings.join(" ");
  return grade.result === "errored"
    ? "The grader returned an error without more detail."
    : "No finding was recorded.";
}

type ExpectedBehaviorResult = {
  readonly key: string;
  readonly expected: string;
  readonly assertion: EvidenceGradeAssertion | null;
};

function expectedBehaviorResults(
  evidence: SimulationEvidence,
  grade: EvidenceGrade | null,
): readonly ExpectedBehaviorResult[] {
  const expected = evidence.test.expectedBehaviors ?? [];
  const assertions = grade?.details.assertions ?? [];
  const used = new Set<string>();
  const rows = expected.map((behavior, at): ExpectedBehaviorResult => {
    const key = `behavior_${String(at + 1)}`;
    const assertion = assertions.find((item) => item.key === key) ?? null;
    if (assertion !== null) used.add(assertion.key);
    return { key, expected: behavior, assertion };
  });
  const extras = assertions
    .filter((assertion) => !used.has(assertion.key))
    .map((assertion, at): ExpectedBehaviorResult => ({
      key: `${assertion.key}:${String(at)}`,
      expected: humanizeIdentifier(assertion.key),
      assertion,
    }));
  return [...rows, ...extras];
}

function assertionFinding(
  assertion: EvidenceGradeAssertion | null,
  stillGrading: boolean,
): string {
  if (assertion === null) {
    return stillGrading
      ? "Waiting for the grader."
      : "No result was recorded for this behavior.";
  }
  if (typeof assertion.rationale === "string" && assertion.rationale.trim() !== "") {
    return assertion.rationale;
  }
  if (typeof assertion.error === "string" && assertion.error.trim() !== "") {
    return assertion.error;
  }
  return "The grader returned a score without a written result.";
}

function GradeResultText({
  result,
  missing,
}: {
  readonly result: EvidenceGrade["result"] | null;
  readonly missing?: "Grading" | "No grade";
}) {
  const shown = result === null
    ? missing ?? "No grade"
    : result === "errored"
      ? "Error"
      : result === "passed"
        ? "Passed"
        : "Failed";
  return (
    <span className="text-sm text-muted-foreground">
      Result <span aria-hidden="true">·</span>{" "}
      <span
        className={cn(
          result === "passed" && "text-success",
          (result === "failed" || result === "errored") && "text-failure",
        )}
      >
        {shown}
      </span>
    </span>
  );
}

function EarlierGrades({ grades }: { readonly grades: readonly EvidenceGrade[] }) {
  if (grades.length === 0) return null;
  return (
    <details className="border-t border-border px-5 py-3 text-sm text-muted-foreground max-[40rem]:px-4">
      <summary className="w-fit cursor-pointer text-foreground">
        {grades.length} earlier grade{grades.length === 1 ? "" : "s"}
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        {grades.map((older) => (
          <div
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-2"
            key={`${older.gradedAt}:${String(older.graderDefinitionVersion)}`}
          >
            <span className="font-mono tabular-nums text-muted-foreground">
              {asSecond(older.gradedAt)} · score {older.score === null ? "-" : shownScore(older.score)}
            </span>
            <GradeResultText result={older.result} />
          </div>
        ))}
      </div>
    </details>
  );
}

function ExecutionFailureNotice({
  reason,
  executionFailure,
}: {
  readonly reason: string | null;
  readonly executionFailure: string | null | undefined;
}) {
  return (
    <div
      className="border border-s-[3px] border-border border-s-failure bg-surface-soft px-5 py-3 max-[40rem]:px-4"
      role="alert"
    >
      <p className="m-0 text-sm font-medium text-foreground">
        {EXECUTION_LABEL.failed}
      </p>
      <p className="m-0 mt-1 text-sm wrap-anywhere text-muted-foreground">
        {executionFailureMessage(reason, executionFailure)} This is an execution
        problem, not a failed grade.
      </p>
    </div>
  );
}

function ResultNotice({ evidence }: { readonly evidence: SimulationEvidence }) {
  if (evidence.status === "failed") {
    return (
      <ExecutionFailureNotice
        reason={evidence.reason}
        executionFailure={evidence.executionFailure}
      />
    );
  }
  if (evidence.status !== "completed") {
    const message = evidence.status === "canceled"
      ? "This simulation stopped before it finished. Any evidence recorded before it stopped remains below."
      : "This simulation is still in progress. Results update here as evidence arrives.";
    return (
      <div
        className="border border-s-[3px] border-border border-s-brand bg-surface-soft px-5 py-3 max-[40rem]:px-4"
        role="status"
      >
        <p className="m-0 text-sm font-medium text-foreground">
          {EXECUTION_LABEL[evidence.status]}
        </p>
        <p className="m-0 mt-1 text-sm wrap-anywhere text-muted-foreground">
          {message}
        </p>
      </div>
    );
  }
  if (evidence.gradingState === "pending" || evidence.gradingState === "running") {
    return (
      <div className="border border-s-[3px] border-border border-s-brand bg-selected px-5 py-3 max-[40rem]:px-4" role="status">
        <p className="m-0 text-sm font-medium text-foreground">Grading in progress</p>
        <p className="m-0 mt-1 text-sm text-muted-foreground">
          Each grader appears below as it finishes.
        </p>
      </div>
    );
  }
  if (evidence.gradingState === "error") {
    return (
      <div className="border border-s-[3px] border-border border-s-failure bg-surface-soft px-5 py-3 max-[40rem]:px-4" role="alert">
        <p className="m-0 text-sm font-medium text-foreground">Grading did not finish</p>
        <p className="m-0 mt-1 text-sm text-muted-foreground">
          Completed grader results remain available below.
        </p>
      </div>
    );
  }
  return null;
}

function GraderResultCard({
  evidence,
  row,
  stillGrading,
}: {
  readonly evidence: SimulationEvidence;
  readonly row: GraderRow;
  readonly stillGrading: boolean;
}) {
  const expectedBehaviorGrader =
    row.grade?.graderDefinitionId === EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID ||
    row.plan?.graderDefinitionId === EXPECTED_BEHAVIORS_GRADER_DEFINITION_ID;
  const behaviorRows = expectedBehaviorGrader
    ? expectedBehaviorResults(evidence, row.grade)
    : [];
  /*
   * The table is this grader's evidence, so it replaces the written finding.
   * An errored grader has no table to read: its content is the error itself.
   */
  const showsBehaviorTable =
    behaviorRows.length > 0 && row.grade?.result !== "errored";
  const frozenDefinition = row.plan ?? row.grade ?? row.history[0];
  const definitionHref = frozenDefinition === undefined
    ? null
    : `${projectPath(evidence.projectId, "graders")}?graderDefinition=${encodeURIComponent(frozenDefinition.graderDefinitionId)}&definitionVersion=${String(frozenDefinition.graderDefinitionVersion)}`;
  const passThreshold = row.plan?.passThreshold ?? row.grade?.passThreshold ?? null;
  const scoreFacts = [
    `Score ${row.grade === null || row.grade.score === null ? "-" : shownScore(row.grade.score)}`,
    passThreshold === null ? null : `Threshold ${shownScore(passThreshold)}`,
  ].filter((fact): fact is string => fact !== null);
  /*
   * A grader that passed is closed, because its row already says so. Anything
   * else — failed, errored, or still waiting for a result — opens, because the
   * finding is the reason somebody came to this page.
   */
  const openByDefault = row.grade?.result !== "passed";

  return (
    <section className="min-w-0 border border-border bg-surface" aria-label={row.name}>
      <Collapsible defaultOpen={openByDefault}>
        <header className="relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 bg-surface-soft px-5 py-3 max-[40rem]:px-4">
          {/*
            The trigger is a real button, and its hit area covers the row
            through one overlay. The grader's name stays a link above that
            overlay: the way into the frozen definition is not a way to fold
            the section away.
          */}
          <CollapsibleTrigger asChild>
            <button
              className="flex flex-none items-center border-0 bg-transparent p-0 text-muted-foreground after:absolute after:inset-0 after:content-['']"
              type="button"
            >
              <ChevronRightIcon aria-hidden="true" />
              <span className="sr-only">{row.name}</span>
            </button>
          </CollapsibleTrigger>
          <h3 className="relative z-10 m-0 min-w-0 text-sm font-medium wrap-anywhere text-foreground">
            {definitionHref === null ? row.name : (
              <Link
                className="no-underline underline-offset-4 pointer-hover:underline pointer-hover:decoration-brand focus-visible:underline"
                href={definitionHref}
              >
                {row.name}
              </Link>
            )}
          </h3>
          <GradeResultText
            result={row.grade?.result ?? null}
            missing={stillGrading ? "Grading" : "No grade"}
          />
          <span className="ms-auto flex-none text-sm tabular-nums text-faint">
            {scoreFacts.join(" · ")}
          </span>
        </header>

        {/* An opened section shows its evidence and nothing about itself. */}
        <CollapsibleContent className="border-t border-border">
          {row.grade === null && !showsBehaviorTable ? (
            <p className="m-0 px-5 py-4 text-sm text-muted-foreground max-[40rem]:px-4">
              {stillGrading
                ? "Waiting for this grader to return a result."
                : "No result is available for this grader."}
            </p>
          ) : showsBehaviorTable ? (
            <>
              <TablePanel className="stacked:overflow-visible border-0">
                <Table className="stacked:block" aria-label={`${row.name} results`}>
                  <TableHeader className="stacked:sr-only">
                    <TableRow>
                      <TableHead className="w-[38%]">Expected behavior</TableHead>
                      <TableHead>Grader result</TableHead>
                      <TableHead className="w-28 text-center">Total Score</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="stacked:block">
                    {behaviorRows.map((behavior) => (
                      <TableRow
                        className="stacked:flex stacked:flex-col stacked:gap-3 stacked:border-t stacked:border-border stacked:px-4 stacked:py-4 stacked:first:border-t-0"
                        key={behavior.key}
                      >
                        <TableCell className={STACKED_BEHAVIOR_CELL} data-label="Expected behavior">
                          <span className="wrap-anywhere text-foreground stacked:max-w-[65%] stacked:text-end">
                            {behavior.expected}
                          </span>
                        </TableCell>
                        <TableCell className={STACKED_BEHAVIOR_CELL} data-label="Grader result">
                          <span
                            className={cn(
                              "wrap-anywhere text-muted-foreground stacked:max-w-[65%] stacked:text-end",
                              behavior.assertion?.error === undefined ? null : "text-failure",
                            )}
                          >
                            {assertionFinding(behavior.assertion, stillGrading)}
                          </span>
                        </TableCell>
                        <TableCell
                          className={cn(STACKED_BEHAVIOR_CELL, "text-center font-mono tabular-nums text-foreground stacked:text-end")}
                          data-label="Total Score"
                        >
                          {behavior.assertion?.score === undefined
                            ? "-"
                            : shownScore(behavior.assertion.score)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TablePanel>
            </>
          ) : (
            <div className="px-5 py-4 max-[40rem]:px-4">
              <p className="m-0 text-sm text-faint">Grader result</p>
              <p
                className={cn(
                  "m-0 mt-1 text-sm wrap-anywhere text-foreground",
                  row.grade?.result === "errored" && "text-failure",
                )}
              >
                {row.grade === null
                  ? stillGrading
                    ? "Waiting for this grader to return a result."
                    : "No result is available for this grader."
                  : findingOf(row.grade)}
              </p>
            </div>
          )}
          <EarlierGrades grades={row.history} />
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/**
 * The line the grader sections stand under, with the regrade control on it.
 *
 * The line carries no count: the summary bar above it already says how many
 * graders passed, and ADR-0017 stands, so nothing here folds the graders into
 * one verdict. Regrade sits on this line because it is grading work.
 */
function GradersLine({ regrade }: { readonly regrade: RegradeRequest }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <h3 className="m-0 text-base font-medium text-foreground">Graders</h3>
      <RegradeAction request={regrade} />
    </div>
  );
}

/**
 * The panel while the conversation has not happened yet.
 *
 * There is no evidence to show, so the panel says which of the two waits this
 * is instead of drawing empty facts. The mark breathes on the status square's
 * own keyframe, so one motion means "still going" everywhere.
 */
function WaitingForSimulation({
  status,
}: {
  readonly status: SimulationStatusWord;
}) {
  const running = status === "running";
  return (
    <div
      className="flex min-h-full min-w-0 flex-col items-center justify-center gap-3 px-5 py-16 text-center max-[40rem]:px-4"
      role="status"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="size-14 [[data-theme=dark]_&]:invert"
        data-slot="waiting-mark"
        data-motion="pulse"
        src="/brand/egma-mark-light.svg"
        alt="Egma"
        width={56}
        height={56}
      />
      <p className="m-0 text-base font-medium text-foreground">
        {running ? "Running" : "Queued"}
      </p>
      <p className="m-0 max-w-[48ch] text-sm text-faint">
        {running
          ? "The conversation is happening now. Results appear here when it ends."
          : "Waiting for a simulator to start."}
      </p>
    </div>
  );
}

function ResultSummary({
  evidence,
  regrade,
}: {
  readonly evidence: SimulationEvidence;
  readonly regrade: RegradeRequest;
}) {
  const rows = graderRows(evidence);
  const stillGrading =
    evidence.gradingState === "pending" || evidence.gradingState === "running";

  if (
    ["queued", "claimed", "running"].includes(evidence.status) &&
    evidence.grades.length === 0
  ) {
    return <WaitingForSimulation status={evidence.status} />;
  }

  if (evidence.gradingState === "not_requested") {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <SimulationFacts evidence={evidence} />
        <ResultNotice evidence={evidence} />
        <div className="border border-border bg-surface p-5 max-[40rem]:p-4">
          <h3 className="m-0 text-base font-medium text-foreground">
            No grading was requested
          </h3>
          <p className="m-0 mt-1 text-sm text-muted-foreground">
            No grader was asked to grade this simulation.
          </p>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <SimulationFacts evidence={evidence} />
        <ResultNotice evidence={evidence} />
        <div className="border border-border bg-surface p-5 max-[40rem]:p-4">
          <h3 className="m-0 text-base font-medium text-foreground">
            {stillGrading ? "Graders are preparing" : "No grades are available"}
          </h3>
          <p className="m-0 mt-1 text-sm text-muted-foreground">
            {stillGrading
              ? "Results appear here as each grader finishes."
              : "This simulation has no current grader results."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      role="region"
      aria-label="Grader results"
    >
      <SimulationFacts evidence={evidence} />
      <ResultNotice evidence={evidence} />
      <GradersLine regrade={regrade} />
      {rows.map((row) => (
        <GraderResultCard
          evidence={evidence}
          key={row.key}
          row={row}
          stillGrading={stillGrading}
        />
      ))}
    </div>
  );
}

function SimulationFacts({ evidence }: { readonly evidence: SimulationEvidence }) {
  return <SimulationEvidenceSummary evidence={evidence} />;
}

function TranscriptAndAudio({
  evidence,
}: {
  readonly evidence: SimulationEvidence;
}) {
  const active = ["queued", "claimed", "running"].includes(evidence.status);
  const recording = useSimulationEvidenceRecording(evidence, evidence.projectId);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {evidence.modality === "voice" ? (
        <section aria-labelledby="run-evidence-recording">
          <h3 className="m-0 mb-3 text-base font-medium text-foreground" id="run-evidence-recording">
            Recording
          </h3>
          <RecordingEvidence
            active={active}
            recording={recording}
            speakerTimeline={
              evidence.transcript === null
                ? null
                : recordingSpeakerTimeline(evidence.transcript)
            }
          />
        </section>
      ) : null}
      <section aria-labelledby="run-evidence-conversation">
        <h3 className="m-0 mb-3 text-base font-medium text-foreground" id="run-evidence-conversation">
          Conversation
        </h3>
        <SimulationTranscript evidence={evidence} recording={recording} />
      </section>
    </div>
  );
}

/**
 * The regrade request, its refusals and its confirmation, held in one place.
 *
 * The control and the notices sit in two different parts of the panel — the
 * button at the end of the tab rail, the notices under it where both tabs can
 * see them — so the state machine lives here and each part reads it. There is
 * one dialog, and it is rendered with the notices.
 */
function useRegradeRequest({
  evidence,
  onReload,
}: {
  readonly evidence: SimulationEvidence;
  readonly onReload: () => void;
}) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayRegrade = role !== null && canAuthor(role);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [asked, setAsked] = useState<RegradeAsked | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    setRefused(null);
    setAsked(null);
    setConfirming(false);
    setWorking(false);
  }, [evidence.id]);

  async function regrade(): Promise<void> {
    if (!mayRegrade || working) return;
    setRefused(null);
    setAsked(null);
    setWorking(true);
    const answered = await platformAnswer(
      regradeSimulation(
        { simulationId: evidence.id, projectId: evidence.projectId },
        { client: platformClient },
      ),
    );
    setWorking(false);
    setConfirming(false);
    if (answered.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answered.status !== "ready") {
      setRefused(answered.refusal);
      return;
    }
    setAsked(answered.value);
    onReload();
  }

  return {
    evidence,
    role,
    mayRegrade,
    refused,
    asked,
    confirming,
    working,
    ask: () => setConfirming(true),
    close: () => setConfirming(false),
    regrade,
  };
}

type RegradeRequest = ReturnType<typeof useRegradeRequest>;

/**
 * The control itself: one small square beside the word `Graders`.
 *
 * It answers only when there is grading work to redo — the conversation
 * finished and no grader is running — and it says what it does in its label,
 * because the icon is the whole of what is drawn.
 */
function RegradeAction({ request }: { readonly request: RegradeRequest }) {
  if (!request.mayRegrade) return null;
  const { evidence } = request;
  const gradingBusy =
    evidence.gradingState === "pending" || evidence.gradingState === "running";
  return (
    <Button
      className={cn(
        "size-5.5 min-h-0 border-border text-muted-foreground",
        "pointer-coarse:size-(--tap-target)",
        "disabled:opacity-100 disabled:text-faint",
      )}
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Regrade this simulation"
      title="Regrade this simulation"
      disabled={request.working || evidence.status !== "completed" || gradingBusy}
      onClick={request.ask}
    >
      <RefreshCwIcon className="size-3.25" aria-hidden="true" />
    </Button>
  );
}

/**
 * What the request has to say, under the rail so both tabs show it, and the
 * one confirmation it opens.
 */
function RegradeNotices({ request }: { readonly request: RegradeRequest }) {
  const { evidence, role, mayRegrade, refused, asked, confirming, working } =
    request;
  const saysSomething =
    refused !== null || asked !== null || (role !== null && !mayRegrade);
  return (
    <>
      {!saysSomething ? null : (
        <div
          className="flex min-w-0 flex-none flex-col gap-3 border-b border-border px-5 py-3 max-[40rem]:px-4"
          aria-label="Simulation actions"
        >
          {refused === null ? null : (
            <Refused message={regradeRefusalMessage(refused)} />
          )}
          {asked === null ? null : (
            <Problem>
              {asked.reopened > 0
                ? "This simulation is queued for a whole-simulation regrade. New grades appear below as they finish."
                : "This simulation was already queued for grading, so no duplicate work was added."}
            </Problem>
          )}
          {role === null || mayRegrade ? null : (
            <Problem>
              {`Your ${String(role)} role can read every grade here but cannot request a regrade. Ask an organization admin to change your role.`}
            </Problem>
          )}
        </div>
      )}
      {!confirming ? null : (
        <Dialog
          title={`Regrade “${evidence.test.name ?? `simulation ${String(evidence.position)}`}”?`}
          onClose={request.close}
        >
          {(dismiss) => (
            <>
              <p>{REGRADE_IS_NOT_A_REPLAY}</p>
              <Actions>
                <Button type="button" variant="secondary" onClick={() => dismiss()}>
                  Not now
                </Button>
                <Button
                  type="button"
                  busy={working}
                  onClick={() => void request.regrade()}
                >
                  {working ? "Requesting…" : "Regrade simulation"}
                </Button>
              </Actions>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}

/**
 * The rail tab's own bottom line.
 *
 * The chosen tab keeps the shared two-pixel Ember edge. The other draws a
 * single neutral pixel on the same baseline, which is what the row's own
 * hairline used to do for both of them.
 */
const RAIL_TAB = cn(
  "data-[state=inactive]:after:bg-border",
  "group-data-[orientation=horizontal]/tabs:data-[state=inactive]:after:h-px",
);

function EvidenceDetail({
  evidence,
  onReload,
}: {
  readonly evidence: SimulationEvidence;
  readonly onReload: () => void;
}) {
  const regradeRequest = useRegradeRequest({ evidence, onReload });
  return (
      <Tabs
        key={evidence.id}
        defaultValue="results"
        className="min-h-0 flex-1 gap-0 overflow-hidden"
      >
        {/*
          The row draws no hairline of its own. Each tab carries its own line
          instead — two pixels of Ember under the chosen one, one neutral pixel
          under the other — so the pair reads as a rail without a rule running
          past both of them.
        */}
        <div className="flex min-w-0 flex-none items-center px-5 max-[40rem]:px-4">
          <TabsList variant="line" className="min-w-0">
            <TabsTrigger className={RAIL_TAB} value="results">
              Results summary
            </TabsTrigger>
            <TabsTrigger className={RAIL_TAB} value="transcript">
              {evidence.modality === "voice" ? "Transcript & audio" : "Transcript"}
            </TabsTrigger>
          </TabsList>
        </div>
        <RegradeNotices request={regradeRequest} />
        <TabsContent
          value="results"
          className="min-h-0 overflow-y-auto p-5 max-[40rem]:p-4"
        >
          <ResultSummary evidence={evidence} regrade={regradeRequest} />
        </TabsContent>
        <TabsContent
          value="transcript"
          className="min-h-0 overflow-y-auto p-5 max-[40rem]:p-4"
        >
          <TranscriptAndAudio evidence={evidence} />
        </TabsContent>
      </Tabs>
  );
}

export function RunScenarioWorkbench({
  projectId,
  runId,
  rows,
  total,
  selectedId,
  onSelect,
  onExecutionFailureVisible,
  more,
}: {
  readonly projectId: string;
  readonly runId: string;
  readonly rows: readonly RunSimulation[];
  readonly total: number;
  readonly selectedId: string | null;
  readonly onSelect: (simulationId: string | null) => void;
  readonly onExecutionFailureVisible: (simulationId: string) => void;
  readonly more?: MoreSimulations;
}) {
  useEffect(() => {
    if (selectedId !== null && rows.some((row) => row.id === selectedId)) return;
    onSelect(rows[0]?.id ?? selectedId ?? null);
  }, [onSelect, rows, selectedId]);

  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const evidenceProject = selected === null ? null : projectId;
  const {
    answer: evidenceAnswer,
    reload: reloadEvidence,
    refresh: refreshEvidence,
  } = useProjectRead<SimulationEvidence>(
    (selectedProjectId) =>
      platformAnswer(
        getSimulation(
          { simulationId: selected?.id ?? "", projectId: selectedProjectId },
          { client: platformClient },
        ),
      ),
    evidenceProject,
    selected?.id ?? "",
  );
  const selectedEvidence =
    evidenceAnswer?.status === "ready" &&
    selected !== null &&
    evidenceAnswer.value.id === selected.id
      ? evidenceAnswer.value
      : null;
  /*
   * The numbered feed can know execution failed before the separate evidence
   * read catches up. Keep the exact row-backed failure on screen during that
   * wait (and during a refused evidence read), then let full evidence replace
   * it without a contradictory stale "running" detail.
   */
  const selectedFailureBeforeEvidence =
    selected !== null &&
    selected.status === "failed" &&
    selectedEvidence?.status !== "failed"
      ? selected
      : null;
  const evidenceForDisplay =
    selectedFailureBeforeEvidence === null ? selectedEvidence : null;
  const displayedSelected =
    selected === null || evidenceForDisplay === null
      ? selected
      : {
          ...selected,
          status: evidenceForDisplay.status,
          gradingState: evidenceForDisplay.gradingState,
          gradeTally: evidenceGradeTally(evidenceForDisplay),
          combinedScore: evidenceForDisplay.combinedScore,
          startedAt: evidenceForDisplay.startedAt,
          endedAt: evidenceForDisplay.endedAt,
        };

  useEffect(() => {
    if (evidenceAnswer?.status === "signed-out") window.location.replace("/sign-in");
  }, [evidenceAnswer]);

  useEffect(() => {
    if (selectedEvidence === null || selectedEvidence.runId !== runId) {
      return undefined;
    }
    const evidence = selectedEvidence;
    const active = ["queued", "claimed", "running"].includes(evidence.status);
    const grading =
      evidence.gradingState === "pending" || evidence.gradingState === "running";
    if (!active && !grading && !waitingForSimulationTranscript(evidence)) return undefined;
    const timer = window.setTimeout(refreshEvidence, 2000);
    return () => window.clearTimeout(timer);
  }, [runId, selectedEvidence, refreshEvidence]);

  useEffect(() => {
    const visibleFailureId = selectedFailureBeforeEvidence?.id ?? (
      selectedEvidence !== null &&
      selectedEvidence.runId === runId &&
      selectedEvidence.status === "failed"
        ? selectedEvidence.id
        : null
    );
    if (visibleFailureId !== null) {
      // A persistent notice now contains the exact execution failure. It can
      // replace any live toast that led the person to this simulation.
      onExecutionFailureVisible(visibleFailureId);
    }
  }, [onExecutionFailureVisible, runId, selectedEvidence, selectedFailureBeforeEvidence]);

  return (
    <section
      className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)] overflow-hidden border border-border bg-surface max-[900px]:h-auto max-[900px]:grid-cols-1"
      aria-label="Run simulations workbench"
    >
      <aside className="flex min-h-0 min-w-0 flex-col border-r border-border max-[900px]:border-r-0 max-[900px]:border-b" aria-label="Simulations in this run">
        {/*
          The head is the panel's own 56px bar, so its hairline meets the
          selected simulation's heading across the fold. The count is a quiet
          annotation on the word rather than a fact of its own at the far end.
        */}
        <header className="border-b border-border px-4 pt-5 pb-3">
          <h2 className="m-0 text-base font-medium text-foreground">
            Simulations{" "}
            <span className="text-sm font-normal tabular-nums text-faint">
              <span aria-hidden="true">·</span> {String(total)}
            </span>
          </h2>
        </header>
        <ol className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 max-[900px]:max-h-80 max-[900px]:flex-none">
          {rows.map((row) => (
            <SimulationChoice
              key={row.id}
              row={row.id === displayedSelected?.id ? displayedSelected : row}
              selected={row.id === selected?.id}
              onSelect={() => onSelect(row.id)}
            />
          ))}
        </ol>
        {more === undefined ? null : (
          <div className="flex items-center justify-between gap-3 border-t border-border p-3">
            <span className="text-sm text-muted-foreground">{more.note}</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={more.loading}
              onClick={more.onMore}
            >
              {more.loading ? "Loading…" : "Show more"}
            </Button>
          </div>
        )}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background max-[900px]:overflow-visible">
        {displayedSelected === null ? null : (
          <header
            className="flex min-w-0 items-center border-b border-border bg-surface px-5 py-4 max-[40rem]:px-4"
            data-slot="selected-simulation-header"
          >
            {/*
              The test's name and nothing else. The square and the state word
              are on this simulation's row in the list, one column to the left,
              and the row is where the reader chose it.
            */}
            <h2 className="m-0 min-w-0 text-base font-medium wrap-anywhere text-foreground">
              {displayedSelected.testName ?? "No stored test"}
            </h2>
          </header>
        )}

        {selectedFailureBeforeEvidence === null ? null : (
          <div className="px-5 pt-5 max-[40rem]:px-4 max-[40rem]:pt-4">
            <ExecutionFailureNotice
              reason={selectedFailureBeforeEvidence.reason}
              executionFailure={selectedFailureBeforeEvidence.executionFailure}
            />
          </div>
        )}

        {evidenceAnswer === null ||
        evidenceAnswer.status === "signed-out" ||
        (evidenceAnswer.status === "ready" && evidenceForDisplay === null) ? (
          <div className="p-5 max-[40rem]:p-4">
            <Loading what="this simulation's results" />
          </div>
        ) : evidenceAnswer.status !== "ready" ? (
          <div className="p-5 max-[40rem]:p-4">
            <Failure message={evidenceAnswer.refusal.message} onRetry={reloadEvidence} />
          </div>
        ) : evidenceForDisplay?.runId !== runId ? (
          <div className="p-5 max-[40rem]:p-4">
            <Failure message="This simulation does not belong to this run." />
          </div>
        ) : (
          <EvidenceDetail evidence={evidenceForDisplay} onReload={refreshEvidence} />
        )}
      </div>
    </section>
  );
}
