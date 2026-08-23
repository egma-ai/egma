"use client";

import {
  getSimulationRecording,
} from "@egma/platform-api/client";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { graderDisplayName } from "../lib/presentation.ts";
import { platformAnswer, platformClient } from "../lib/platform-client.ts";
import type { VerdictWord } from "../lib/runs.ts";
import {
  citedTurnPositions,
  judgedAssertions,
  type EvidenceVerdict,
  type JudgedAssertion,
  type SimulationEvidence,
} from "../lib/simulations.ts";
import { humanizeIdentifier, milliseconds } from "../lib/transcripts.ts";
import { Dialog } from "./dialog.tsx";
import { VerdictBadge } from "./run-status.tsx";

type RecordingStatus = "absent" | "loading" | "ready" | "failed";

function durationOf(evidence: SimulationEvidence): number | null {
  const measured = evidence.measures.durationMs;
  if (typeof measured === "number" && Number.isFinite(measured)) return measured;
  const recorded = evidence.transcript?.durationNs;
  if (recorded === undefined) return null;
  if (!/^-?\d+$/u.test(recorded)) return null;
  const elapsedMilliseconds = milliseconds(recorded);
  return Number.isFinite(elapsedMilliseconds) ? elapsedMilliseconds : null;
}

function shownDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "Not recorded";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)}m ${String(rest)}s`;
}

function turnsOf(evidence: SimulationEvidence): number | null {
  const measured = evidence.measures.turnCount;
  if (typeof measured === "number" && Number.isFinite(measured)) return measured;
  const counts = evidence.transcript?.turnCounts;
  return counts === undefined ? null : counts.human + counts.agent;
}

/**
 * The shape the review wears twice: once around the whole evidence surface, and
 * once around the grader column inside it.
 */
const REVIEW = "flex min-w-0 flex-col gap-8";

/*
 * The shape of a sentence that says why there is nothing here.
 *
 * Four places on this surface have one: nothing was said, there was nothing to
 * judge, nobody has judged this yet, and no transcript was filed. They are four
 * different facts and none of them is a failure, so they all read the same
 * quiet way rather than each inventing an appearance.
 */
const EMPTY_STATE = "p-5 max-[40rem]:px-4";
const EMPTY_STATE_TITLE = "text-base font-normal text-foreground";
const EMPTY_STATE_LEAD = "m-0 mt-1 max-w-[62ch] text-sm text-muted-foreground";

/** One of the three facts: its name at the leading edge, its value at the other. */
const SUMMARY_CELL = "flex min-w-0 items-center justify-between gap-3 px-5 py-3";

/*
 * The line between two facts. It runs beside them while the three sit in a row,
 * and above them once a narrow screen stacks the row into a column.
 */
const SUMMARY_CELL_NEXT =
  "border-border border-s max-[40rem]:border-s-0 max-[40rem]:border-t";

/**
 * Metrics and counts read straight in the mono face, on tabular figures.
 *
 * `WV-0` writes the three summary values in mono; `DESIGN.md` asks every
 * metric, date, duration and score for tabular numerals. Both together are
 * what stops "1m 04s" and "11m 40s" sitting at two widths in one strip.
 */
const SUMMARY_VALUE =
  "font-mono text-base font-normal text-foreground tabular-nums";

/**
 * The name of one fact, quiet, beside its value.
 *
 * It is on each label rather than on the strip as `span`, and that is the whole
 * of a small correction. The rule it replaces reached every `span` inside the
 * strip, and one of them is not a label — it is the overall verdict's chip. So
 * the chip was drawn in the muted grey meant for the three names, whatever the
 * verdict was, while every other verdict chip on the page carried its colour.
 *
 * Naming the labels removes the reach. The chip is left to be what it is.
 */
const SUMMARY_LABEL = "text-sm text-muted-foreground";

/** The only three simulation-level facts required before reading evidence. */
export function SimulationEvidenceSummary({
  evidence,
}: {
  readonly evidence: SimulationEvidence;
}) {
  const turns = turnsOf(evidence);
  return (
    <section
      className={cn(
        "grid min-w-0 grid-cols-3 overflow-hidden rounded-card border border-border",
        "bg-surface max-[40rem]:grid-cols-1",
      )}
      aria-label="Simulation summary"
    >
      <div className={SUMMARY_CELL}>
        <span className={SUMMARY_LABEL}>Overall verdict</span>
        <VerdictBadge verdict={evidence.verdict} />
      </div>
      <div className={cn(SUMMARY_CELL, SUMMARY_CELL_NEXT)}>
        <span className={SUMMARY_LABEL}>Duration</span>
        <strong className={SUMMARY_VALUE}>
          {shownDuration(durationOf(evidence))}
        </strong>
      </div>
      <div className={cn(SUMMARY_CELL, SUMMARY_CELL_NEXT)}>
        <span className={SUMMARY_LABEL}>Total turns</span>
        <strong className={SUMMARY_VALUE}>
          {turns === null ? "Not recorded" : String(turns)}
        </strong>
      </div>
    </section>
  );
}

export type SimulationEvidenceRecording = {
  readonly status: RecordingStatus;
  readonly message: string | null;
  readonly url: string | null;
  readonly audioRef: RefObject<HTMLAudioElement | null>;
  readonly currentTime: number;
  readonly duration: number;
  readonly playing: boolean;
  readonly waveform: {
    readonly human: readonly number[];
    readonly agent: readonly number[];
  } | null;
  readonly waveformLoading: boolean;
  readonly seek: (seconds: number, play?: boolean) => void;
  readonly onTimeUpdate: () => void;
  readonly onLoadedMetadata: () => void;
  readonly onError: () => void;
  readonly onPlay: () => void;
  readonly onPause: () => void;
};

function peaksOf(
  buffer: AudioBuffer,
  channel: number,
  bins = 360,
): readonly number[] {
  if (channel < 0 || channel >= buffer.numberOfChannels) return [];
  const channelData = buffer.getChannelData(channel);
  const size = Math.max(1, Math.ceil(channelData.length / bins));
  return Array.from({ length: bins }, (_, bin) => {
    const start = bin * size;
    const end = Math.min(channelData.length, start + size);
    let peak = 0;
    for (let at = start; at < end; at += 1) {
      peak = Math.max(peak, Math.abs(channelData[at] ?? 0));
    }
    return peak;
  });
}

/**
 * One signed recording controller for the prototype and the shipped page.
 *
 * A failed media request or stereo decode refreshes the short-lived link once.
 * The listener returns to the same point, and a same-second byte-identical URL
 * is loaded explicitly instead of being mistaken for no change.
 */
export function useSimulationEvidenceRecording(
  evidence: SimulationEvidence | null,
  projectId: string,
): SimulationEvidenceRecording {
  const recordingId = evidence?.id ?? null;
  const hasRecording = evidence?.hasRecording ?? false;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeRecording = useRef<string | null>(null);
  const [status, setStatus] = useState<RecordingStatus>(
    hasRecording ? "loading" : "absent",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [source, setSource] = useState<{
    readonly recordingId: string;
    readonly url: string;
  } | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [waveform, setWaveform] = useState<
    SimulationEvidenceRecording["waveform"]
  >(null);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [asked, setAsked] = useState(0);
  const resumeAt = useRef(0);
  const isASecondTry = useRef(false);
  const resolvedAttempt = useRef(-1);
  const mediaReadyAttempt = useRef(-1);
  const decodeReadyAttempt = useRef(-1);

  useEffect(() => {
    let current = true;
    const changed = activeRecording.current !== recordingId;
    activeRecording.current = recordingId;
    setSource(null);
    setMessage(null);
    setWaveform(null);
    setPlaying(false);
    if (changed) {
      setCurrentTime(0);
      setDuration(0);
      resumeAt.current = 0;
      isASecondTry.current = false;
    }
    if (!hasRecording || recordingId === null) {
      setStatus("absent");
      setWaveformLoading(false);
      return () => {
        current = false;
      };
    }

    setStatus("loading");
    resolvedAttempt.current = -1;
    const attempt = asked;
    void platformAnswer(
      getSimulationRecording(
        { simulationId: recordingId, projectId },
        { client: platformClient },
      ),
    )
      .then((answer) => {
        if (answer.status !== "ready") {
          throw new Error(
            answer.status === "signed-out"
              ? "Sign in again to open the recording."
              : answer.refusal.message,
          );
        }
        if (!current) return;
        resolvedAttempt.current = attempt;
        mediaReadyAttempt.current = -1;
        decodeReadyAttempt.current = -1;
        setWaveformLoading(true);
        setSource({ recordingId, url: answer.value.url });
        setStatus("ready");
      })
      .catch((why: unknown) => {
        if (!current) return;
        setStatus("failed");
        setMessage(
          why instanceof Error
            ? why.message
            : "The recording could not be opened.",
        );
      });
    return () => {
      current = false;
    };
  }, [asked, hasRecording, recordingId, projectId]);

  useEffect(() => {
    if (source === null || source.recordingId !== recordingId) return undefined;
    let current = true;
    let context: AudioContext | null = null;
    const closeContext = (): void => {
      const ownedContext = context;
      context = null;
      if (ownedContext === null) return;
      try {
        void ownedContext.close().catch(() => undefined);
      } catch {
        // Cleanup must remain safe when the browser already closed the context.
      }
    };
    const attempt = resolvedAttempt.current;
    setWaveformLoading(true);
    void fetch(source.url)
      .then((answer) => {
        if (!answer.ok) throw new Error("The audio file could not be decoded.");
        return answer.arrayBuffer();
      })
      .then(async (bytes) => {
        context = new AudioContext();
        const decoded = await context.decodeAudioData(bytes);
        if (!current) return;
        setDuration(decoded.duration);
        setWaveform(
          decoded.numberOfChannels === 2
            ? {
                human: peaksOf(decoded, 0),
                agent: peaksOf(decoded, 1),
              }
            : null,
        );
        markReady(attempt, "decode");
      })
      .catch(() => {
        if (!current) return;
        const retryFailure =
          isASecondTry.current && attempt === resolvedAttempt.current;
        setWaveform(null);
        recoverSignedLink(attempt, "decode");
        if (retryFailure) markReady(attempt, "decode");
      })
      .finally(() => {
        if (current) setWaveformLoading(false);
        closeContext();
      });
    return () => {
      current = false;
      closeContext();
    };
  }, [recordingId, source]);

  useEffect(() => {
    if (source === null || asked === 0) return;
    audioRef.current?.load();
  }, [asked, source]);

  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    const follow = (): void => {
      setCurrentTime(audioRef.current?.currentTime ?? 0);
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  function markReady(attempt: number, part: "decode" | "media"): void {
    if (attempt < 0 || attempt !== resolvedAttempt.current) return;
    if (part === "media") mediaReadyAttempt.current = attempt;
    else decodeReadyAttempt.current = attempt;
    if (
      mediaReadyAttempt.current === attempt &&
      decodeReadyAttempt.current === attempt
    ) {
      isASecondTry.current = false;
    }
  }

  function recoverSignedLink(
    attempt: number,
    sourceOfFailure: "decode" | "media",
  ): void {
    if (attempt < 0 || attempt !== resolvedAttempt.current) return;
    if (isASecondTry.current) {
      if (sourceOfFailure === "media") {
        setPlaying(false);
        setStatus("failed");
        setMessage(
          "The recording still could not be played after Egma refreshed its link.",
        );
      }
      return;
    }
    isASecondTry.current = true;
    resumeAt.current = audioRef.current?.currentTime ?? currentTime;
    setPlaying(false);
    setStatus("loading");
    setSource(null);
    setAsked((again) => again + 1);
  }

  function readClock(): void {
    setCurrentTime(audioRef.current?.currentTime ?? 0);
  }

  function readDuration(): void {
    const heard = audioRef.current?.duration;
    if (heard !== undefined && Number.isFinite(heard)) setDuration(heard);
    const attempt = resolvedAttempt.current;
    if (resumeAt.current > 0 && audioRef.current !== null) {
      const limit =
        heard !== undefined && Number.isFinite(heard) ? heard : resumeAt.current;
      audioRef.current.currentTime = Math.min(resumeAt.current, limit);
      setCurrentTime(audioRef.current.currentTime);
      resumeAt.current = 0;
    }
    markReady(attempt, "media");
  }

  function seek(seconds: number, play = false): void {
    const audio = audioRef.current;
    if (audio === null) return;
    const limit = Number.isFinite(audio.duration) ? audio.duration : duration;
    audio.currentTime = Math.min(Math.max(0, seconds), Math.max(0, limit));
    setCurrentTime(audio.currentTime);
    if (play) void audio.play().catch(() => undefined);
  }

  const currentSource =
    source?.recordingId === recordingId ? source.url : null;
  const currentStatus: RecordingStatus = !hasRecording
    ? "absent"
    : currentSource === null && status !== "failed"
      ? "loading"
      : status;

  return {
    status: currentStatus,
    message,
    url: currentSource,
    audioRef,
    currentTime,
    duration,
    playing,
    waveform: currentSource === null ? null : waveform,
    waveformLoading: currentSource === null ? false : waveformLoading,
    seek,
    onTimeUpdate: readClock,
    onLoadedMetadata: readDuration,
    onError: () => recoverSignedLink(resolvedAttempt.current, "media"),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
  };
}

type EvidenceAssertion = {
  readonly key: string;
  readonly expected: string;
  readonly finding: string | null;
  readonly verdict: VerdictWord | null;
  readonly citedTurns: readonly number[];
  readonly superseded: readonly EvidenceVerdict[];
};

type EvidenceGrader = {
  readonly key: string;
  readonly name: string;
  readonly required: boolean;
  readonly verdict: VerdictWord | null;
  readonly assertions: readonly EvidenceAssertion[];
};

function sameWords(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function behaviorPosition(assertion: string): number | null {
  const found = /^behavior_(\d+)$/u.exec(assertion)?.[1];
  if (found === undefined) return null;
  const position = Number(found);
  return Number.isInteger(position) && position > 0 ? position : null;
}

function isExpectedBehaviors(
  name: string | undefined,
  rows: readonly JudgedAssertion[],
): boolean {
  return (
    name === "expected_behaviors" ||
    (name === undefined && rows.some((row) => behaviorPosition(row.assertion) !== null))
  );
}

function readableAssertion(
  row: JudgedAssertion,
  expected: readonly string[],
  fallbackPosition: number,
): string {
  if (row.assertionText !== null && row.assertionText.trim() !== "") {
    return row.assertionText;
  }
  const position = behaviorPosition(row.assertion);
  if (position !== null) {
    const behavior = expected[position - 1];
    if (behavior !== undefined) return behavior;
  }
  // `row.assertion` is a durable storage key, not product copy. When display
  // text is absent, use this local reading order instead of turning a key such
  // as `keeps_brand_voice` into something that only looks authored.
  return `Criterion ${String(fallbackPosition)}`;
}

function evidenceRow(
  row: JudgedAssertion,
  expected: readonly string[],
  fallbackPosition: number,
  evidence: SimulationEvidence,
): EvidenceAssertion {
  return {
    key: row.key,
    expected: readableAssertion(row, expected, fallbackPosition),
    finding:
      row.speaking.rationale.trim() === "" ? null : row.speaking.rationale,
    verdict: row.speaking.verdict,
    citedTurns: citedTurnPositions(
      row.speaking.citedTurns,
      evidence.transcript?.turns ?? [],
    ),
    superseded: row.superseded,
  };
}

/** Human-named grader groups, including expected behaviors awaiting judgment. */
function evidenceGraders(
  evidence: SimulationEvidence,
  judged: readonly JudgedAssertion[],
): readonly EvidenceGrader[] {
  if (evidence.grading === "not_required") return [];
  const expected = evidence.test.expectedBehaviors ?? [];
  const planItems = evidence.gradingPlan?.items ?? [];
  const ids = new Set<string>([
    ...planItems.map((item) => item.graderId),
    ...evidence.byGrader.map((item) => item.graderId),
    ...judged.map((item) => item.graderId),
  ]);
  let expectedId = planItems.find(
    (item) => item.name === "expected_behaviors",
  )?.graderId;
  expectedId ??= judged.find(
    (row) => behaviorPosition(row.assertion) !== null,
  )?.graderId;
  if (expected.length > 0 && expectedId === undefined) {
    expectedId = "expected-behaviors";
    ids.add(expectedId);
  }

  const ordered = [...ids];
  if (expectedId !== undefined) {
    const withoutExpected = ordered.filter((id) => id !== expectedId);
    ordered.splice(0, ordered.length, expectedId, ...withoutExpected);
  }

  return ordered.map((id) => {
    const planItem = planItems.find((item) => item.graderId === id);
    const summary = evidence.byGrader.find((item) => item.graderId === id);
    const rows = judged.filter((item) => item.graderId === id);
    const expectedGroup = isExpectedBehaviors(planItem?.name, rows) || id === expectedId;
    const used = new Set<string>();
    const assertions: EvidenceAssertion[] = expectedGroup
      ? expected.map((behavior, at) => {
          const position = at + 1;
          const row = rows.find(
            (one) =>
              !used.has(one.key) &&
              (behaviorPosition(one.assertion) === position ||
                (one.assertionText !== null &&
                  sameWords(one.assertionText, behavior))),
          );
          if (row === undefined) {
            return {
              key: `expected:${String(at)}`,
              expected: behavior,
              finding: null,
              verdict: null,
              citedTurns: [],
              superseded: [],
            };
          }
          used.add(row.key);
          return evidenceRow(row, expected, position, evidence);
        })
      : [];
    rows.forEach((row, at) => {
      if (!used.has(row.key)) {
        assertions.push(evidenceRow(row, expected, at + 1, evidence));
      }
    });

    return {
      key: id,
      name: expectedGroup
        ? "Expected behaviors"
        : planItem === undefined
          ? "Grader name unavailable"
          : humanizeIdentifier(graderDisplayName(planItem.name)),
      required:
        summary?.required ?? planItem?.required ?? rows[0]?.required ?? true,
      verdict: summary?.verdict ?? null,
      assertions,
    };
  });
}

function waveformPath(peaks: readonly number[]): string {
  if (peaks.length === 0) return "";
  const width = 1000;
  const middle = 32;
  const scale = 27;
  const step = width / Math.max(1, peaks.length - 1);
  const top = peaks.map(
    (peak, at) =>
      `${(at * step).toFixed(2)},${(middle - peak * scale).toFixed(2)}`,
  );
  const bottom = [...peaks].reverse().map((peak, reverseAt) => {
    const at = peaks.length - reverseAt - 1;
    return `${(at * step).toFixed(2)},${(middle + peak * scale).toFixed(2)}`;
  });
  return `M ${top.join(" L ")} L ${bottom.join(" L ")} Z`;
}

function clockText(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${String(minutes)}:${String(rest).padStart(2, "0")}`;
}

function WaveformLane({
  label,
  peaks,
  progress,
}: {
  readonly label: "Human" | "Agent";
  readonly peaks: readonly number[];
  readonly progress: number;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-[56px_minmax(0,1fr)] items-center gap-3",
        "max-[40rem]:grid-cols-[48px_minmax(0,1fr)] max-[40rem]:gap-2",
      )}
    >
      <span className="text-sm text-foreground">{label}</span>
      {/* The hairline down the middle is the silence line the peaks grow from. */}
      <div
        className={cn(
          /*
           * 52px is the track's own height and it is off the 4px spacing list
           * in `DESIGN.md`. It is carried over rather than chosen — the
           * stylesheet this replaces said `height: 52px` — so it is written as
           * a measurement instead of `h-13`, which would read as a scale step
           * that does not exist. Worth settling in the tuning pass: 48px is on
           * the list and is one pixel of waveform away.
           */
          "relative h-[52px] overflow-hidden rounded-input border border-border bg-background",
          "bg-[linear-gradient(to_bottom,transparent_49.5%,var(--border)_49.5%,var(--border)_50.5%,transparent_50.5%)]",
        )}
      >
        <svg
          className="block h-full w-full"
          aria-hidden="true"
          preserveAspectRatio="none"
          viewBox="0 0 1000 64"
        >
          {/*
           * The ink is the page's own text colour held back to 72%, written
           * here as a value rather than as a token. The theme names the
           * derived colours this product reuses — the status chip edges and the
           * dialog scrim — and none of them is this mix; pointing at one of
           * those would mean something else and would follow it when it moved.
           */}
          <path
            className="fill-[color-mix(in_srgb,var(--foreground)_72%,transparent)]"
            d={waveformPath(peaks)}
          />
        </svg>
        <span
          className="pointer-events-none absolute top-0 bottom-0 left-(--playhead) z-1 w-0.5 bg-brand"
          style={{ "--playhead": `${String(progress)}%` } as CSSProperties}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

/*
 * A quiet sentence in its own box: there is no recording, egma is opening one,
 * or it could not be opened. Three separate facts, and none of them says
 * anything about the agent.
 */
const RECORDING_STATE =
  "m-0 rounded-input border border-border bg-surface p-4 text-sm text-muted-foreground";

/*
 * The same sentence under a player that is already drawn. It keeps the box and
 * gives up its side and bottom padding, so the line sits against the control it
 * is about rather than being inset from it.
 */
const RECORDING_STATE_UNDER_PLAYER =
  "m-0 rounded-input border border-border bg-surface px-0 pt-3 pb-0 text-sm text-muted-foreground";

function RecordingEvidence({
  recording,
  active,
}: {
  readonly recording: SimulationEvidenceRecording;
  readonly active: boolean;
}) {
  if (recording.status === "absent") {
    return (
      <p className={RECORDING_STATE} role={active ? "status" : undefined}>
        {active
          ? "Recording will be available after the call ends."
          : "No audio was recorded."}
      </p>
    );
  }
  if (recording.status === "loading") {
    return (
      <p className={RECORDING_STATE} role="status">
        Opening the recording…
      </p>
    );
  }
  if (recording.status === "failed" || recording.url === null) {
    return (
      <p
        className="m-0 rounded-input border border-border bg-surface p-4 text-sm text-failure"
        role="alert"
      >
        {recording.message ?? "The recording could not be opened."}
      </p>
    );
  }

  const limit = Math.max(1, recording.duration);
  const progress = Math.min(
    100,
    Math.max(0, (recording.currentTime / limit) * 100),
  );
  const elapsed = clockText(recording.currentTime);
  const total = clockText(recording.duration);

  return (
    <div className="min-w-0 max-[40rem]:px-4">
      <audio
        ref={recording.audioRef}
        aria-label="Simulation recording"
        className="block h-10 w-full"
        controls
        preload="metadata"
        src={recording.url}
        onError={recording.onError}
        onLoadedMetadata={recording.onLoadedMetadata}
        onPause={recording.onPause}
        onPlay={recording.onPlay}
        onTimeUpdate={recording.onTimeUpdate}
      >
        Your browser cannot play this recording.
      </audio>
      {recording.waveformLoading ? (
        <p className={RECORDING_STATE_UNDER_PLAYER} role="status">
          Drawing both audio channels…
        </p>
      ) : recording.waveform === null ? (
        <p className={RECORDING_STATE_UNDER_PLAYER}>
          The recording is playable, but its stereo channel map is unavailable.
        </p>
      ) : (
        <div
          className={cn(
            "relative mt-3 flex flex-col gap-2 outline-2 outline-offset-2 outline-transparent",
            /*
             * The seek control below is deliberately invisible, so the two
             * lanes wear its focus. Without this the keyboard could move the
             * playhead with nothing on screen saying where the focus was.
             */
            "has-[input:focus-visible]:outline-brand",
          )}
        >
          <WaveformLane
            label="Human"
            peaks={recording.waveform.human}
            progress={progress}
          />
          <WaveformLane
            label="Agent"
            peaks={recording.waveform.agent}
            progress={progress}
          />
          <input
            className={cn(
              "absolute inset-y-0 right-0 left-[68px] z-2 m-0 h-full w-[calc(100%-68px)]",
              "cursor-ew-resize appearance-none opacity-[0.001] disabled:cursor-default",
              "max-[40rem]:left-[56px] max-[40rem]:w-[calc(100%-56px)]",
              /*
               * The native track and thumb are drawn away rather than dressed.
               * The control somebody sees is the pair of lanes underneath; this
               * range input is only what a pointer drags and a keyboard steps,
               * and it is a real range input so that both still work.
               */
              "[&::-webkit-slider-runnable-track]:h-full",
              "[&::-webkit-slider-runnable-track]:bg-transparent",
              "[&::-webkit-slider-thumb]:h-full [&::-webkit-slider-thumb]:w-6",
              "[&::-webkit-slider-thumb]:appearance-none",
              "[&::-webkit-slider-thumb]:bg-transparent",
              "[&::-moz-range-track]:h-full [&::-moz-range-track]:bg-transparent",
              "[&::-moz-range-thumb]:h-full [&::-moz-range-thumb]:w-6",
              "[&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-transparent",
            )}
            type="range"
            min="0"
            max={limit}
            step="0.05"
            value={Math.min(recording.currentTime, limit)}
            aria-label="Seek the recording"
            aria-valuetext={`${elapsed} of ${total}`}
            disabled={recording.duration <= 0}
            onChange={(event) => recording.seek(Number(event.currentTarget.value))}
          />
          <output
            className={cn(
              "pointer-events-none absolute right-2 bottom-1 z-1 bg-background px-1",
              "font-mono text-sm tabular-nums text-foreground",
            )}
          >
            {elapsed} / {total}
          </output>
        </div>
      )}
    </div>
  );
}

type EvidenceTranscript = NonNullable<SimulationEvidence["transcript"]>;

/**
 * Readable speech in the sheet, with the two sides laid out like messages.
 *
 * This is still one ordered transcript. The alignment makes the speaker change
 * visible at a glance; the written Human and Agent labels keep that distinction
 * available without colour, and no timing or storage identifiers enter the
 * reading surface.
 */
function ChatTranscript({
  transcript,
}: {
  readonly transcript: EvidenceTranscript;
}) {
  if (transcript.turns.length === 0) {
    return (
      <div className={EMPTY_STATE}>
        <strong className={EMPTY_STATE_TITLE}>Nothing was said</strong>
        <p className={EMPTY_STATE_LEAD}>
          Egma filed no spoken turns for this simulation.
        </p>
      </div>
    );
  }

  return (
    <ol
      className="m-0 flex min-w-0 list-none flex-col gap-3 p-0"
      aria-label="Transcript messages"
    >
      {transcript.turns.map((turn, at) => {
        const human = turn.kind === "turn:human";
        const speaker = human ? "Human" : "Agent";
        return (
          <li
            className={cn(
              /* `group`, so the message inside can answer when this turn is the cited one. */
              "group flex w-full min-w-0 scroll-my-8",
              /*
               * Alignment makes the turn-taking visible. It carries none of the
               * meaning on its own — the written Human and Agent labels do that
               * — so the reading still works at any zoom and in any theme.
               */
              human
                ? "justify-start pe-[14%] max-[40rem]:pe-5"
                : "justify-end ps-[14%] max-[40rem]:ps-5",
            )}
            id={`transcript-turn-${String(at + 1)}`}
            key={turn.spanId}
            aria-label={`Turn ${String(at + 1)}, ${speaker}`}
          >
            <div
              className={cn(
                "min-w-0 max-w-full rounded-card border border-border bg-surface px-4 py-3",
                /* The corner nearest its own side is squarer, which is the whole of the shape. */
                human
                  ? "rounded-es-button"
                  : "rounded-ee-button bg-surface-soft",
                /* Arrived at from a judge finding, the cited turn marks itself. */
                "group-target:border-brand group-target:bg-selected",
              )}
            >
              <p className="m-0 mb-1 text-sm font-medium text-muted-foreground">
                {speaker}
              </p>
              <p className="m-0 text-sm wrap-anywhere whitespace-pre-wrap text-foreground">
                {turn.text === "" ? (
                  <span className="text-faint italic">Nothing was said.</span>
                ) : (
                  turn.text
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function verdictWord(verdict: VerdictWord): string {
  return `${verdict.slice(0, 1).toUpperCase()}${verdict.slice(1)}`;
}

function graderSummary(
  grader: EvidenceGrader,
  stillJudging: boolean,
): string {
  const passed = grader.assertions.filter(
    (assertion) => assertion.verdict === "passed",
  ).length;
  const failed = grader.assertions.filter(
    (assertion) => assertion.verdict === "failed",
  ).length;
  const skipped = grader.assertions.filter(
    (assertion) => assertion.verdict === "skipped",
  ).length;
  const errored = grader.assertions.filter(
    (assertion) => assertion.verdict === "errored",
  ).length;
  const waiting = grader.assertions.filter(
    (assertion) => assertion.verdict === null,
  ).length;
  const parts = [
    grader.required ? "Required grader" : "Reports only",
    `${String(grader.assertions.length)} check${grader.assertions.length === 1 ? "" : "s"}`,
  ];
  if (passed > 0) parts.push(`${String(passed)} passed`);
  if (failed > 0) parts.push(`${String(failed)} failed`);
  if (skipped > 0) parts.push(`${String(skipped)} skipped`);
  if (errored > 0) parts.push(`${String(errored)} errored`);
  if (waiting > 0) {
    parts.push(`${String(waiting)} ${stillJudging ? "waiting" : "not judged"}`);
  }
  return parts.join(" · ");
}

/**
 * The quiet mono kicker over a title: what kind of thing this block is.
 *
 * `--faint` rather than `--muted-foreground`, which is the recipe's one quiet
 * label colour: the same step a table's column heading takes, so a kicker over
 * a panel and a heading over a column are the same weight of voice.
 */
const PANE_KIND =
  "mb-1 block font-mono text-sm tracking-(--tracking-label) text-faint uppercase";

/** The name over each half of the expected-against-found comparison. */
const COMPARISON_LABEL =
  "m-0 mb-2 font-mono text-sm font-normal tracking-(--tracking-label) text-faint uppercase";

/** Sentences inside a check. Judge findings run long, so they break anywhere. */
const ASSERTION_TEXT = "m-0 min-w-0 text-sm wrap-anywhere text-foreground";

function GraderGroup({
  grader,
  stillJudging,
  onReadTurn,
}: {
  readonly grader: EvidenceGrader;
  readonly stillJudging: boolean;
  readonly onReadTurn: (turn: number) => void;
}) {
  return (
    <section
      className="min-w-0 not-first:border-t not-first:border-border"
      aria-label={grader.name}
    >
      <header className="flex min-w-0 items-start justify-between gap-3 bg-surface-soft p-5 max-[40rem]:px-4">
        <div className="min-w-0">
          <span className={PANE_KIND}>Grader</span>
          {/* A grader name comes from a project and can be one long word. */}
          <h3 className="m-0 text-lg font-normal wrap-anywhere text-foreground">
            {grader.name}
          </h3>
          <p className="m-0 mt-1 text-sm text-muted-foreground">
            {graderSummary(grader, stillJudging)}
          </p>
        </div>
        <VerdictBadge verdict={grader.verdict} compact />
      </header>
      {grader.assertions.length === 0 ? (
        <p className="m-0 px-5 py-4 text-sm text-muted-foreground max-[40rem]:px-4">
          {stillJudging
            ? "Waiting for this grader to return its assertions."
            : "This grader returned no assertions."}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-4 bg-background p-5 max-[40rem]:p-4">
          {grader.assertions.map((assertion, at) => (
            <article
              className="min-w-0 overflow-hidden rounded-input border border-border bg-surface"
              key={assertion.key}
            >
              <header
                className={cn(
                  "flex min-w-0 items-center justify-between gap-3",
                  "border-b border-border bg-surface-soft px-4 py-3",
                  /*
                   * A child selector, because the compact `VerdictBadge` beside
                   * the check number is not an element this component wrote and
                   * the two have to read as one line.
                   */
                  "[&>span]:font-mono [&>span]:text-sm",
                  "[&>span]:text-faint [&>span]:uppercase [&>span]:tabular-nums",
                )}
              >
                <span>Check {String(at + 1).padStart(2, "0")}</span>
                <VerdictBadge verdict={assertion.verdict} compact />
              </header>
              <div className="grid min-w-0 grid-cols-2 max-[40rem]:grid-cols-1">
                <section className="min-w-0 p-4">
                  <h4 className={COMPARISON_LABEL}>Expected behavior</h4>
                  <p className={ASSERTION_TEXT}>{assertion.expected}</p>
                </section>
                {/*
                 * The two halves are divided by a line: beside them while they
                 * sit side by side, and above the second once they stack.
                 */}
                <section className="min-w-0 border-border border-s bg-surface-soft p-4 max-[40rem]:border-s-0 max-[40rem]:border-t">
                  <h4 className={COMPARISON_LABEL}>Judge finding</h4>
                  <p className={ASSERTION_TEXT}>
                    {assertion.finding ??
                      (stillJudging
                        ? "Waiting for this grader."
                        : "No judge finding was filed.")}
                  </p>
                  {assertion.citedTurns.length === 0 ? null : (
                    <p className={cn(ASSERTION_TEXT, "mt-2 font-mono text-muted-foreground")}>
                      {assertion.citedTurns.map((turn, turnAt) => (
                        <span key={turn}>
                          {turnAt === 0 ? "" : ", "}
                          <button
                            className={cn(
                              "m-0 cursor-pointer border-0 bg-transparent p-0 text-foreground",
                              /* An Ember underline, because this goes to the words it cites. */
                              "underline decoration-brand underline-offset-[3px]",
                            )}
                            type="button"
                            onClick={() => onReadTurn(turn)}
                          >
                            Read turn {turn}
                          </button>
                        </span>
                      ))}
                    </p>
                  )}
                  {assertion.superseded.length === 0 ? null : (
                    <details className="mt-3 text-sm text-muted-foreground">
                      <summary className="w-fit cursor-pointer text-foreground">
                        {assertion.superseded.length} earlier finding
                        {assertion.superseded.length === 1 ? "" : "s"}
                      </summary>
                      {assertion.superseded.map((row) => (
                        <p
                          className={cn(ASSERTION_TEXT, "mt-2 text-muted-foreground")}
                          key={row.judgedAt}
                        >
                          {verdictWord(row.verdict)} — {row.rationale}
                        </p>
                      ))}
                    </details>
                  )}
                </section>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/*
 * A narrow Ember edge over a quiet wash: grading is still running, or the
 * transcript on screen is the first part of a longer one. Both are facts about
 * the work in hand and neither is a failure, so they wear attention rather than
 * a state colour.
 */
const NOTICE_LINE =
  "m-0 border-b border-border border-s-[3px] border-s-brand bg-selected px-5 py-3 text-sm text-foreground";

/** Recording and Transcript, the two blocks the sheet stacks. */
const SHEET_BLOCK = "flex min-w-0 flex-col gap-3";
const SHEET_BLOCK_TITLE = "m-0 text-base font-medium text-foreground";

/**
 * The one evidence review used while grading and after grading completes.
 * The grader review stays on the page. Audio and readable speech live in the
 * shared right-side sheet so a long recording never sets the page's height.
 */
function SimulationEvidencePanel({
  evidence,
  assertions,
  recording,
  evidenceOpen,
  onEvidenceChange,
}: {
  readonly evidence: SimulationEvidence;
  readonly assertions: readonly JudgedAssertion[];
  readonly recording: SimulationEvidenceRecording;
  readonly evidenceOpen: boolean;
  readonly onEvidenceChange: (open: boolean) => void;
}) {
  const stillJudging =
    evidence.grading === "pending" ||
    evidence.gradingJobs.some((job) =>
      ["pending", "claimed"].includes(job.status),
    );
  const graders = evidenceGraders(evidence, assertions);
  const simulationActive = ["queued", "claimed", "running"].includes(
    evidence.status,
  );
  const pendingTurn = useRef<number | null>(null);

  useEffect(() => {
    if (!evidenceOpen || pendingTurn.current === null) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const turn = pendingTurn.current;
      if (turn === null) return;
      const target = document.getElementById(`transcript-turn-${String(turn)}`);
      target?.scrollIntoView({ block: "center" });
      window.history.replaceState(null, "", `#transcript-turn-${String(turn)}`);
      pendingTurn.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [evidenceOpen]);

  function readTurn(turn: number): void {
    pendingTurn.current = turn;
    onEvidenceChange(true);
  }

  return (
    <section className={REVIEW} aria-label="Simulation evidence">
      <section
        className={cn(
          "flex min-h-full min-w-0 flex-col overflow-hidden",
          "rounded-card border border-border bg-surface",
        )}
        aria-labelledby="evidence-graders"
      >
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 max-[40rem]:px-4">
          <div className="min-w-0">
            <span className={PANE_KIND}>Review</span>
            <h2
              className="m-0 text-lg font-normal text-foreground"
              id="evidence-graders"
            >
              Grader results
            </h2>
          </div>
          {/*
            The quiet kind, said out loud. shadcn's `default` is the Deep Ember
            primary, and this opens a reading surface beside a page that already
            has its own main action.
          */}
          <Button
            type="button"
            variant="secondary"
            aria-controls="transcript-audio-evidence"
            aria-expanded={evidenceOpen}
            onClick={() => onEvidenceChange(true)}
          >
            Open transcript and audio
          </Button>
        </header>
        {stillJudging ? (
          <p className={NOTICE_LINE} role="status">
            Grading is still running. Findings appear here as they land.
          </p>
        ) : null}
        {evidence.grading === "not_required" ? (
          <div className={EMPTY_STATE}>
            <strong className={EMPTY_STATE_TITLE}>
              There was nothing to judge
            </strong>
            <p className={EMPTY_STATE_LEAD}>
              Egma did not conduct this simulation, so it filed no grading work.
            </p>
          </div>
        ) : graders.length === 0 ? (
          <div className={EMPTY_STATE}>
            <strong className={EMPTY_STATE_TITLE}>
              {stillJudging ? "Graders are preparing" : "Nobody has judged this yet"}
            </strong>
            <p className={EMPTY_STATE_LEAD}>
              {stillJudging
                ? "No grader has returned an assertion yet."
                : "No grader has written a verdict for this simulation."}
            </p>
          </div>
        ) : (
          <div className="flex min-w-0 flex-auto flex-col">
            {graders.map((grader) => (
              <GraderGroup
                grader={grader}
                key={grader.key}
                stillJudging={stillJudging}
                onReadTurn={readTurn}
              />
            ))}
          </div>
        )}
      </section>

      {evidenceOpen ? (
        <Dialog
          kind="sheet"
          size="wide"
          title="Transcript and audio"
          onClose={() => onEvidenceChange(false)}
        >
          <div
            className="flex min-h-0 flex-auto flex-col gap-6 overflow-y-auto bg-background p-5 max-[40rem]:p-4"
            id="transcript-audio-evidence"
          >
            <section className={SHEET_BLOCK} aria-labelledby="evidence-recording">
              <h3 className={SHEET_BLOCK_TITLE} id="evidence-recording">
                Recording
              </h3>
              <RecordingEvidence
                active={simulationActive}
                recording={recording}
              />
            </section>
            <section
              className={cn(SHEET_BLOCK, "flex-auto")}
              aria-labelledby="evidence-transcript"
            >
              <h3 className={SHEET_BLOCK_TITLE} id="evidence-transcript">
                Transcript
              </h3>
              {evidence.transcript === null ? (
                <div className={EMPTY_STATE}>
                  <strong className={EMPTY_STATE_TITLE}>
                    No transcript was filed
                  </strong>
                  <p className={EMPTY_STATE_LEAD}>
                    Egma has no speech for this simulation. It may not have started,
                    or it may have stopped before the first turn.
                  </p>
                </div>
              ) : (
                <>
                  {evidence.transcript.spansTruncated ? (
                    <p className={NOTICE_LINE}>
                      {`This simulation filed ${String(evidence.transcript.spanCount)} steps. This view shows the first steps in order.`}
                    </p>
                  ) : null}
                  <ChatTranscript transcript={evidence.transcript} />
                </>
              )}
            </section>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

/** Summary, grader review, and the default-open supporting evidence pane. */
export function SimulationEvidenceReview({
  evidence,
  recording,
  assertions = judgedAssertions(evidence.verdicts),
}: {
  readonly evidence: SimulationEvidence;
  readonly recording: SimulationEvidenceRecording;
  readonly assertions?: readonly JudgedAssertion[];
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(true);

  useEffect(() => setEvidenceOpen(true), [evidence.id]);

  return (
    <div className={REVIEW}>
      <SimulationEvidenceSummary evidence={evidence} />
      <SimulationEvidencePanel
        evidence={evidence}
        assertions={assertions}
        recording={recording}
        evidenceOpen={evidenceOpen}
        onEvidenceChange={setEvidenceOpen}
      />
    </div>
  );
}
