"use client";

import { getSimulation, regradeSimulation } from "@egma/platform-api/client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
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
import type {
  RunSimulation,
  SimulationStatusWord,
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
import { shownScore } from "../../../../../ui/run-status.tsx";
import {
  ChatTranscript,
  RecordingEvidence,
  recordingOriginOf,
  SimulationEvidenceSummary,
  simulationToolCalls,
  TranscriptEmpty,
  useSimulationEvidenceRecording,
} from "../../../../../ui/simulation-evidence.tsx";
import { Actions, SearchField } from "../../../../../ui/section.tsx";
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

function SimulationChoice({
  row,
  selected,
  onSelect,
}: {
  readonly row: RunSimulation;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
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
        aria-label={`${row.testName ?? "No stored test"}, ${row.personaName}, ${EXECUTION_LABEL[row.status]}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {row.testName ?? "No stored test"}
          </span>
          <span className="mt-1 block truncate text-sm text-muted-foreground">
            {row.personaName}
            {row.status === "completed" ? null : ` · ${EXECUTION_LABEL[row.status]}`}
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

function ResultNotice({ evidence }: { readonly evidence: SimulationEvidence }) {
  if (evidence.status !== "completed") {
    const failed = evidence.status === "failed";
    const message = failed
      ? "Egma could not conduct this simulation. This is an execution problem, not a failed grade."
      : evidence.status === "canceled"
        ? "This simulation stopped before it finished. Any evidence recorded before it stopped remains below."
        : "This simulation is still in progress. Results update here as evidence arrives.";
    return (
      <div
        className={cn(
          "border border-s-[3px] border-border bg-surface-soft px-5 py-3 max-[40rem]:px-4",
          failed ? "border-s-failure" : "border-s-brand",
        )}
        role={failed ? "alert" : "status"}
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
  const behaviorRowsHaveWrittenResults = behaviorRows.some(({ assertion }) =>
    assertion !== null &&
    ((typeof assertion.rationale === "string" && assertion.rationale.trim() !== "") ||
      (typeof assertion.error === "string" && assertion.error.trim() !== "")),
  );
  const planFacts = [
    row.plan?.passThreshold === undefined
      ? null
      : `Pass threshold ${shownScore(row.plan.passThreshold)}`,
    row.plan?.graderDefinitionVersion === undefined
      ? null
      : `Definition v${String(row.plan.graderDefinitionVersion)}`,
  ].filter((fact): fact is string => fact !== null);
  const frozenDefinition = row.plan ?? row.grade ?? row.history[0];
  const definitionHref = frozenDefinition === undefined
    ? null
    : `${projectPath(evidence.projectId, "graders")}?graderDefinition=${encodeURIComponent(frozenDefinition.graderDefinitionId)}&definitionVersion=${String(frozenDefinition.graderDefinitionVersion)}`;

  return (
    <section className="min-w-0 border border-border bg-surface" aria-label={row.name}>
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-b border-border bg-surface-soft px-5 py-4 max-[40rem]:px-4">
        <div className="min-w-0">
          <h3 className="m-0 text-sm font-medium wrap-anywhere text-foreground">
            Grader <span aria-hidden="true">·</span>{" "}
            {definitionHref === null ? row.name : (
              <Link
                className="no-underline underline-offset-4 pointer-hover:underline pointer-hover:decoration-brand focus-visible:underline"
                href={definitionHref}
              >
                {row.name}
              </Link>
            )}
          </h3>
          {planFacts.length === 0 ? null : (
            <p className="m-0 mt-1 text-sm tabular-nums text-muted-foreground">
              {planFacts.join(" · ")}
            </p>
          )}
        </div>
        <div className="flex flex-none flex-wrap items-center justify-end gap-3">
          <GradeResultText
            result={row.grade?.result ?? null}
            missing={stillGrading ? "Grading" : "No grade"}
          />
          <span className="font-mono text-sm tabular-nums text-foreground">
            Total Score {row.grade === null || row.grade.score === null
              ? "-"
              : shownScore(row.grade.score)}
          </span>
        </div>
      </header>

      {row.grade === null && !(expectedBehaviorGrader && behaviorRows.length > 0) ? (
        <p className="m-0 px-5 py-4 text-sm text-muted-foreground max-[40rem]:px-4">
          {stillGrading
            ? "Waiting for this grader to return a result."
            : "No result is available for this grader."}
        </p>
      ) : expectedBehaviorGrader && behaviorRows.length > 0 ? (
        <>
          {!behaviorRowsHaveWrittenResults &&
          typeof row.grade?.details.rationale === "string" &&
          row.grade.details.rationale.trim() !== "" ? (
            <p className="m-0 border-b border-border px-5 py-3 text-sm wrap-anywhere text-muted-foreground max-[40rem]:px-4">
              {row.grade.details.rationale}
            </p>
          ) : null}
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
    </section>
  );
}

function ResultSummary({ evidence }: { readonly evidence: SimulationEvidence }) {
  const rows = graderRows(evidence);
  const stillGrading =
    evidence.gradingState === "pending" || evidence.gradingState === "running";

  if (evidence.gradingState === "not_requested") {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <ResultNotice evidence={evidence} />
        <SimulationFacts evidence={evidence} />
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
        <ResultNotice evidence={evidence} />
        <SimulationFacts evidence={evidence} />
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
      <ResultNotice evidence={evidence} />
      <SimulationFacts evidence={evidence} />
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
  const toolCalls = useMemo(() => simulationToolCalls(evidence), [evidence]);
  const recordingStartedAt =
    evidence.transcript === null ? null : recordingOriginOf(evidence.transcript);

  return (
    <div className="flex min-w-0 flex-col gap-6">
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
              : {
                  startedAt:
                    recordingStartedAt ?? evidence.transcript.startedAt,
                  endedAt: evidence.transcript.endedAt,
                  turns: evidence.transcript.turns,
                }
          }
        />
      </section>
      <section aria-labelledby="run-evidence-conversation">
        <h3 className="m-0 mb-3 text-base font-medium text-foreground" id="run-evidence-conversation">
          Conversation
        </h3>
        {evidence.transcript === null ? (
          <TranscriptEmpty />
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            {evidence.transcript.spansTruncated ? (
              <p
                className="m-0 border border-s-[3px] border-border border-s-brand bg-selected px-5 py-3 text-sm text-foreground max-[40rem]:px-4"
                role="status"
              >
                {`This simulation filed ${String(evidence.transcript.spanCount)} steps. This view shows the first steps in order, so later tool calls or speech may be absent.`}
              </p>
            ) : null}
            <ChatTranscript
              transcript={evidence.transcript}
              toolCalls={toolCalls}
              recordingStartedAt={recordingStartedAt}
              {...(recording.status === "ready"
                ? {
                    currentTime: recording.currentTime,
                    onSeek: recording.seek,
                  }
                : {})}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function SimulationReviewActions({
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

  return (
    <div className="flex min-w-0 flex-col gap-3" aria-label="Simulation actions">
      {mayRegrade ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="secondary"
            disabled={working}
            onClick={() => setConfirming(true)}
          >
            Regrade
          </Button>
        </div>
      ) : null}
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
      {!confirming ? null : (
        <Dialog
          title={`Regrade “${evidence.test.name ?? `simulation ${String(evidence.position)}`}”?`}
          onClose={() => setConfirming(false)}
        >
          {(dismiss) => (
            <>
              <p>{REGRADE_IS_NOT_A_REPLAY}</p>
              <Actions>
                <Button type="button" variant="secondary" onClick={() => dismiss()}>
                  Not now
                </Button>
                <Button type="button" busy={working} onClick={() => void regrade()}>
                  {working ? "Requesting…" : "Regrade simulation"}
                </Button>
              </Actions>
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}

function EvidenceDetail({
  evidence,
  onReload,
}: {
  readonly evidence: SimulationEvidence;
  readonly onReload: () => void;
}) {
  return (
      <Tabs
        key={evidence.id}
        defaultValue="results"
        className="min-h-0 flex-1 gap-0 overflow-hidden"
      >
        <TabsList variant="line" className="w-full border-b border-border px-5 max-[40rem]:px-4">
          <TabsTrigger value="results">Results summary</TabsTrigger>
          <TabsTrigger value="transcript">Transcript &amp; audio</TabsTrigger>
        </TabsList>
        <TabsContent
          value="results"
          className="min-h-0 overflow-y-auto p-5 max-[40rem]:p-4"
        >
          <div className="flex min-w-0 flex-col gap-4">
            <SimulationReviewActions evidence={evidence} onReload={onReload} />
            <ResultSummary evidence={evidence} />
          </div>
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
  more,
}: {
  readonly projectId: string;
  readonly runId: string;
  readonly rows: readonly RunSimulation[];
  readonly total: number;
  readonly more?: MoreSimulations;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(rows[0]?.id ?? null);

  const visibleRows = useMemo(() => {
    const asked = query.trim().toLocaleLowerCase();
    if (asked === "") return rows;
    return rows.filter((row) =>
      [row.testName ?? "", row.personaName]
        .join(" ")
        .toLocaleLowerCase()
        .includes(asked),
    );
  }, [query, rows]);

  useEffect(() => {
    setQuery("");
    setSelectedId(rows[0]?.id ?? null);
  }, [projectId, runId]);

  useEffect(() => {
    setSelectedId((current) => {
      if (current !== null && visibleRows.some((row) => row.id === current)) {
        return current;
      }
      return visibleRows[0]?.id ?? current ?? rows[0]?.id ?? null;
    });
  }, [rows, visibleRows]);

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
  const displayedSelected =
    selected === null || selectedEvidence === null
      ? selected
      : {
          ...selected,
          status: selectedEvidence.status,
          gradingState: selectedEvidence.gradingState,
          combinedScore: selectedEvidence.combinedScore,
          startedAt: selectedEvidence.startedAt,
          endedAt: selectedEvidence.endedAt,
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
    if (!active && !grading) return undefined;
    const timer = window.setTimeout(refreshEvidence, 2000);
    return () => window.clearTimeout(timer);
  }, [runId, selectedEvidence, refreshEvidence]);

  return (
    <section
      className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)] overflow-hidden border border-border bg-surface max-[900px]:h-auto max-[900px]:grid-cols-1"
      aria-label="Run simulations workbench"
    >
      <aside className="flex min-h-0 min-w-0 flex-col border-r border-border max-[900px]:border-r-0 max-[900px]:border-b" aria-label="Simulations in this run">
        <header className="border-b border-border p-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="m-0 text-base font-medium text-foreground">Simulations</h2>
            <span className="text-sm tabular-nums text-muted-foreground">
              {String(total)} {total === 1 ? "simulation" : "simulations"}
            </span>
          </div>
          <SearchField
            className="w-full [&_input]:w-full"
            aria-label="Search simulations"
            placeholder="Search simulations"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </header>
        {visibleRows.length === 0 ? (
          <p className="m-0 p-4 text-sm text-muted-foreground">
            No simulation matches this search.
          </p>
        ) : (
          <ol className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 max-[900px]:max-h-80 max-[900px]:flex-none">
            {visibleRows.map((row) => (
              <SimulationChoice
                key={row.id}
                row={row.id === displayedSelected?.id ? displayedSelected : row}
                selected={row.id === selected?.id}
                onSelect={() => setSelectedId(row.id)}
              />
            ))}
          </ol>
        )}
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
            className="min-w-0 border-b border-border bg-surface p-5 max-[40rem]:p-4"
            data-slot="selected-simulation-header"
          >
            <h2 className="m-0 text-lg font-medium wrap-anywhere text-foreground">
              {displayedSelected.testName ?? "No stored test"}
            </h2>
          </header>
        )}

        {evidenceAnswer === null ||
        evidenceAnswer.status === "signed-out" ||
        (evidenceAnswer.status === "ready" && selectedEvidence === null) ? (
          <div className="p-5 max-[40rem]:p-4">
            <Loading what="this simulation's results" />
          </div>
        ) : evidenceAnswer.status !== "ready" ? (
          <div className="p-5 max-[40rem]:p-4">
            <Failure message={evidenceAnswer.refusal.message} onRetry={reloadEvidence} />
          </div>
        ) : selectedEvidence?.runId !== runId ? (
          <div className="p-5 max-[40rem]:p-4">
            <Failure message="This simulation does not belong to this run." />
          </div>
        ) : (
          <EvidenceDetail evidence={selectedEvidence} onReload={refreshEvidence} />
        )}
      </div>
    </section>
  );
}
