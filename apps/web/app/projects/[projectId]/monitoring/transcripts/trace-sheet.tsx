"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getTrace } from "@egma/platform-api/client";

import { asCallOverviewInstant } from "../../../../../lib/instants.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../../lib/platform-client.ts";
import { TRACE_SHEET } from "../../../../../lib/transcript-copy.ts";
import {
  howLong,
  shownTurnLatency,
  type Detail,
} from "../../../../../lib/transcripts.ts";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  ChatTranscript,
  RecordingEvidence,
  transcriptToolCalls,
  useDirectEvidenceRecording,
  type EvidenceTranscript,
} from "../../../../../ui/simulation-evidence.tsx";
import { GradeCard } from "../../../../grade-card.tsx";

const AGAIN_MS = 2000;
const SUMMARY_ID = "trace-summary";
const TRANSCRIPT_ID = "trace-transcript";

type Section = "summary" | "transcript";

export type OpenTrace = {
  readonly traceId: string;
  readonly from: string;
  readonly to: string;
};

/** The root recording Retell attaches to a production trace, when it exists. */
function recordingSpan(detail: Detail) {
  return [...detail.spans]
    .filter(
      (span) =>
        span.parentSpanId.trim() === "" && span.audioUrl.trim() !== "",
    )
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))[0] ?? null;
}

function transcriptOf(detail: Detail): EvidenceTranscript {
  return {
    traceId: detail.trace.traceId,
    startedAt: detail.trace.startedAt,
    endedAt: detail.trace.endedAt,
    durationNs: detail.trace.durationNs,
    spanCount: detail.trace.spanCount,
    turnCounts: detail.trace.turnCounts,
    toolSpanCount: detail.trace.toolSpanCount,
    erroredSpanCount: detail.trace.erroredSpanCount,
    turns: detail.turns,
    spans: detail.spans,
    spansTruncated: detail.spansTruncated,
  };
}

function turnLatencyOf(detail: Detail): string {
  const latency = detail.metrics.find(
    (metric) =>
      metric.measure === "turn_response_latency" &&
      metric.unit === "milliseconds",
  );
  return latency === undefined || !Number.isFinite(latency.p90)
    ? TRACE_SHEET.overview.notRecorded
    : shownTurnLatency(
        latency.p90,
        latency.partial ? TRACE_SHEET.overview.partial : undefined,
      );
}

/** One production trace, read in the same continuous evidence sheet as a run. */
export function TraceSheet({
  projectId,
  opened,
  returnFocusTo,
  onClose,
}: {
  readonly projectId: string;
  readonly opened: OpenTrace;
  readonly returnFocusTo?: HTMLElement | null;
  readonly onClose: () => void;
}) {
  const { answer, reload, refresh } = useProjectRead<Detail>(
    (projectId) =>
      platformAnswer(
        getTrace(
          {
            traceId: opened.traceId,
            projectId,
            from: opened.from,
            to: opened.to,
          },
          { client: platformClient },
        ),
      ),
    projectId,
    `${opened.traceId}:${opened.from}:${opened.to}`,
  );
  const [activeSection, setActiveSection] = useState<Section>("summary");
  const scroller = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLElement>(null);
  const transcript = useRef<HTMLElement>(null);

  useEffect(() => {
    setActiveSection("summary");
    scroller.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [opened.traceId]);

  useEffect(() => {
    if (answer?.status === "signed-out") globalThis.location.replace("/sign-in");
  }, [answer]);

  const detail = answer?.status === "ready" ? answer.value : null;
  const stillGrading =
    detail !== null &&
    (detail.gradingState === "pending" || detail.gradingState === "running");

  useEffect(() => {
    if (!stillGrading) return undefined;
    const timer = globalThis.setTimeout(() => refresh(), AGAIN_MS);
    return () => globalThis.clearTimeout(timer);
  }, [detail, refresh, stillGrading]);

  const evidence = useMemo(
    () => (detail === null ? null : transcriptOf(detail)),
    [detail],
  );
  const recorded = detail === null ? null : recordingSpan(detail);
  const recording = useDirectEvidenceRecording(recorded?.audioUrl ?? null);
  const tools = useMemo(
    () => (evidence === null ? [] : transcriptToolCalls(evidence)),
    [evidence],
  );

  function moveTo(section: Section): void {
    const body = scroller.current;
    const target = section === "summary" ? summary.current : transcript.current;
    if (body === null || target === null) return;
    const top =
      body.scrollTop +
      target.getBoundingClientRect().top -
      body.getBoundingClientRect().top;
    body.scrollTo({ top, behavior: "auto" });
    setActiveSection(section);
  }

  function followScroll(): void {
    const body = scroller.current;
    const target = transcript.current;
    if (body === null || target === null) return;
    /* When both sections fit, only an explicit anchor choice changes state. */
    if (body.scrollHeight <= body.clientHeight + 1) return;
    const transcriptTop =
      body.scrollTop +
      target.getBoundingClientRect().top -
      body.getBoundingClientRect().top;
    const atBottom =
      body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
    setActiveSection(
      atBottom || body.scrollTop + 24 >= transcriptTop
        ? "transcript"
        : "summary",
    );
  }

  return (
    <Dialog
      kind="sheet"
      size="wide"
      title={
        <>
          <span className="flex min-w-0 items-center gap-3 pr-2">
            <span className="font-normal">{TRACE_SHEET.title}</span>
            {detail === null ? null : (
              <span
                className={
                  stillGrading
                    ? "text-sm font-normal text-warning"
                    : "text-sm font-normal text-success"
                }
              >
                {stillGrading ? TRACE_SHEET.pending : TRACE_SHEET.completed}
              </span>
            )}
          </span>
          <span className="mt-1 block truncate font-mono text-xs font-normal text-muted-foreground">
            {opened.traceId}
          </span>
        </>
      }
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <nav
          className="flex h-13 flex-none items-stretch gap-6 border-b border-border px-6"
          aria-label={TRACE_SHEET.navigation}
        >
          {(["summary", "transcript"] as const).map((section) => (
            <button
              className="relative cursor-pointer border-0 bg-transparent px-0 text-sm text-muted-foreground aria-[current=location]:text-foreground aria-[current=location]:after:absolute aria-[current=location]:after:inset-x-0 aria-[current=location]:after:bottom-0 aria-[current=location]:after:h-0.5 aria-[current=location]:after:bg-brand"
              key={section}
              type="button"
              aria-controls={section === "summary" ? SUMMARY_ID : TRANSCRIPT_ID}
              aria-current={activeSection === section ? "location" : undefined}
              onClick={() => moveTo(section)}
            >
              {section === "summary"
                ? TRACE_SHEET.sections.summary
                : TRACE_SHEET.sections.transcript}
            </button>
          ))}
        </nav>

        <div
          className="min-h-0 flex-1 overflow-y-auto"
          ref={scroller}
          onScroll={followScroll}
        >
          {answer === null || answer.status === "signed-out" ? (
            <div className="p-6">
              <Loading what="this trace" />
            </div>
          ) : answer.status === "missing" ? (
            <div className="p-6">
              <NotFound message={answer.refusal.message} />
            </div>
          ) : answer.status === "failed" ? (
            <div className="p-6">
              <Failure message={answer.refusal.message} onRetry={reload} />
            </div>
          ) : evidence === null ? null : (
            <>
              <section
                className="scroll-mt-4 px-6 py-7"
                id={SUMMARY_ID}
                ref={summary}
                aria-labelledby="trace-call-overview"
              >
                <h2
                  className="m-0 text-lg font-normal"
                  id="trace-call-overview"
                >
                  {TRACE_SHEET.overview.title}
                </h2>
                <dl className="mt-4 grid grid-cols-4 border border-border bg-surface max-[36rem]:grid-cols-2">
                  <OverviewFact
                    label={TRACE_SHEET.overview.started}
                    value={asCallOverviewInstant(answer.value.trace.startedAt)}
                  />
                  <OverviewFact
                    label={TRACE_SHEET.overview.duration}
                    value={howLong(answer.value.trace.durationNs)}
                  />
                  <OverviewFact
                    label={TRACE_SHEET.overview.turns}
                    value={String(
                      answer.value.trace.turnCounts.human +
                        answer.value.trace.turnCounts.agent,
                    )}
                  />
                  <OverviewFact
                    label={TRACE_SHEET.overview.p90TurnLatency}
                    value={turnLatencyOf(answer.value)}
                  />
                </dl>

                <section className="mt-7" aria-labelledby="trace-grading">
                  <h2 className="m-0 text-lg font-normal" id="trace-grading">
                    {TRACE_SHEET.grading.title}
                  </h2>
                  {answer.value.grades.length === 0 ? (
                    <div
                      className="mt-4 border border-border bg-surface-soft p-5"
                      role={
                        stillGrading
                          ? "status"
                          : answer.value.gradingState === "error"
                            ? "alert"
                            : undefined
                      }
                    >
                      <strong className="text-sm font-medium text-foreground">
                        {stillGrading
                          ? TRACE_SHEET.grading.pendingTitle
                          : answer.value.gradingState === "error"
                            ? TRACE_SHEET.grading.errorTitle
                            : TRACE_SHEET.grading.emptyTitle}
                      </strong>
                      <p className="m-0 mt-1 text-sm text-muted-foreground">
                        {stillGrading
                          ? TRACE_SHEET.grading.pendingLead
                          : answer.value.gradingState === "error"
                            ? TRACE_SHEET.grading.errorLead
                            : TRACE_SHEET.grading.emptyLead}
                      </p>
                    </div>
                  ) : (
                    <>
                      {stillGrading ? (
                        <p className="m-0 mt-4 border border-s-[3px] border-border border-s-brand bg-selected px-5 py-3 text-sm" role="status">
                          {TRACE_SHEET.grading.pendingLead}
                        </p>
                      ) : answer.value.gradingState === "error" ? (
                        <p className="m-0 mt-4 border border-s-[3px] border-border border-s-failure bg-surface-soft px-5 py-3 text-sm" role="alert">
                          {TRACE_SHEET.grading.errorLead}
                        </p>
                      ) : null}
                      <div className="mt-4 grid gap-3">
                        {answer.value.grades.map((grade) => (
                          <GradeCard
                            key={`${grade.projectGraderId}:${grade.gradedAt}`}
                            grade={grade}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </section>
              </section>

              <section
                className="scroll-mt-4 border-t border-border px-6 py-7"
                id={TRANSCRIPT_ID}
                ref={transcript}
                aria-label={TRACE_SHEET.sections.transcript}
              >
                <h2 className="m-0 text-lg font-normal" id="trace-recording">
                  {TRACE_SHEET.recording.sectionTitle}
                </h2>
                <div className="mt-4">
                  <RecordingEvidence
                    active={false}
                    recording={recording}
                    labels={{
                      title: TRACE_SHEET.recording.title,
                      human: TRACE_SHEET.recording.caller,
                      agent: TRACE_SHEET.recording.agent,
                      absent: TRACE_SHEET.recording.absent,
                    }}
                  />
                </div>

                <h2 className="m-0 mt-7 text-lg font-normal">
                  {TRACE_SHEET.transcript.title}
                </h2>
                <div className="mt-4">
                  <ChatTranscript
                    transcript={evidence}
                    toolCalls={tools}
                    recordingStartedAt={recorded?.startedAt ?? null}
                    speakerLabels={{
                      human: TRACE_SHEET.recording.caller,
                      agent: TRACE_SHEET.recording.agent,
                    }}
                    emptyState={{
                      title: TRACE_SHEET.transcript.nothingTitle,
                      description: TRACE_SHEET.transcript.nothingLead,
                    }}
                    {...(recording.status === "ready"
                      ? {
                          currentTime: recording.currentTime,
                          onSeek: recording.seek,
                        }
                      : {})}
                  />
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function OverviewFact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="min-w-0 border-e border-border p-4 last:border-e-0 max-[36rem]:nth-[2n]:border-e-0 max-[36rem]:nth-[n+3]:border-t">
      <dt className="font-mono text-xs tracking-(--tracking-label) text-faint uppercase">
        {label}
      </dt>
      <dd className="m-0 mt-1 truncate font-mono text-sm tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}
