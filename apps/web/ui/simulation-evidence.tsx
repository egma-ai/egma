"use client";

import {
  getSimulationRecording,
} from "@egma/platform-api/client";
import { ChevronRightIcon, PauseIcon, PlayIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { asSecond } from "../lib/instants.ts";
import { graderDisplayName } from "../lib/presentation.ts";
import { platformAnswer, platformClient } from "../lib/platform-client.ts";
import {
  citedTurnPositions,
  priorGrades,
  type EvidenceGrade,
  type EvidencePlanItem,
  type EvidenceStep,
  type SimulationEvidence,
} from "../lib/simulations.ts";
import {
  howFarIn,
  howLong,
  humanizeIdentifier,
  metricLine,
  milliseconds,
  workedOutMetric,
  type Measured,
} from "../lib/transcripts.ts";
import { MEASURES } from "../lib/transcript-copy.ts";
import { Dialog } from "./dialog.tsx";
import { PlanItems } from "./evidence.tsx";
import {
  GradeDetails,
  GradeResultBadge,
  gradeSummary,
  type DisplayGradeAssertion,
} from "./grade.tsx";
import { StateMark } from "./run-status.tsx";

type RecordingStatus = "absent" | "loading" | "ready" | "failed";

export type EvidenceTranscript = NonNullable<SimulationEvidence["transcript"]>;

/** Audio sample zero, read from trace evidence instead of a simulation row. */
export function recordingOriginOf(
  transcript: EvidenceTranscript,
): string | null {
  const recordings: EvidenceStep[] = [];
  const audioRoots: EvidenceStep[] = [];
  const visit = (step: EvidenceStep): void => {
    if (step.kind === "recording") recordings.push(step);
    else if (step.parentSpanId === "" && step.audioUrl.trim() !== "") {
      audioRoots.push(step);
    }
    for (const nested of step.spans) visit(nested);
  };
  for (const step of transcript.spans) visit(step);
  const candidates = recordings.length > 0 ? recordings : audioRoots;
  candidates.sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  );
  return candidates[0]?.startedAt ?? null;
}

export type RecordingSpeakerTimeline = {
  /** The instant the first audio sample represents. */
  readonly startedAt: string;
  /** The end of the trace, used to close the final speaker range. */
  readonly endedAt: string;
  /** Spoken turns only. Extra span fields are accepted and ignored. */
  readonly turns: readonly Pick<
    EvidenceStep,
    "kind" | "startedAt" | "durationNs"
  >[];
};

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
 * Four places on this surface have one: nothing was said, no grade was requested,
 * no grade is available yet, and no transcript was filed. They are four
 * different facts and none of them is a failure, so they all read the same
 * quiet way rather than each inventing an appearance.
 */
const EMPTY_STATE = "p-5 max-[40rem]:px-4";
const EMPTY_STATE_TITLE = "text-base font-normal text-foreground";
const EMPTY_STATE_LEAD = "m-0 mt-1 max-w-[62ch] text-sm text-muted-foreground";

/** One summary fact: its name at the leading edge, its value at the other. */
const SUMMARY_CELL = "flex min-w-0 items-center justify-between gap-3 px-5 py-3";

/**
 * Metrics and counts read straight in the mono face, on tabular figures.
 *
 * `WV-0` writes the summary values in mono; `DESIGN.md` asks every
 * metric, date, duration and score for tabular numerals. Both together are
 * what stops "1m 04s" and "11m 40s" sitting at two widths in one strip.
 */
const SUMMARY_VALUE =
  "whitespace-nowrap font-mono text-base font-normal text-foreground tabular-nums";

/**
 * The name of one fact, quiet, beside its value.
 */
const SUMMARY_LABEL = "text-sm text-muted-foreground";
const SUMMARY_STRIP_CELL = cn(
  SUMMARY_CELL,
  "bg-surface px-4",
  "@max-[48rem]/summary:flex-col @max-[48rem]/summary:items-start @max-[48rem]/summary:gap-1",
);
const SUMMARY_STRIP_LABEL = cn(SUMMARY_LABEL, "whitespace-nowrap");

/**
 * What this simulation measured — the observed metrics, mean-led, under the
 * summary facts and apart from the verdicts for the transcript page's exact
 * reason: a metric measures and a grader judges, and a number is not good or
 * bad until a grader has been asked.
 *
 * **Every figure came off the platform's one shared measure module through the
 * one shared projection**, and the words come off the one shared formatter —
 * so this strip and the production transcript's can never come to word one
 * conversation's numbers two ways.
 *
 * A simulation whose spans carried no metrics renders nothing here: a measure
 * the conversation did not produce is absent, not zero, and the summary facts
 * above already say what the machinery recorded.
 */
export function SimulationMetrics({
  metrics,
}: {
  readonly metrics: readonly Measured[];
}) {
  if (metrics.length === 0) return null;
  return (
    <div className="@container/metrics min-w-0">
      <section
        className="min-w-0 overflow-hidden rounded-card border border-border bg-surface"
        aria-label={MEASURES.label}
      >
        {metrics.map((one, at) => (
          <div
            key={one.measure}
            className={cn(
              SUMMARY_CELL,
              "flex-wrap",
              at > 0 && "border-border border-t",
            )}
          >
            <span className={SUMMARY_LABEL}>
              {humanizeIdentifier(one.measure)}
            </span>
            <span className="min-w-0 text-end font-mono text-sm font-normal text-foreground tabular-nums">
              {metricLine(one)}
            </span>
          </div>
        ))}
        {metrics.some(workedOutMetric) ? (
          <p className="m-0 border-border border-t px-5 py-3 text-sm text-muted-foreground">
            {MEASURES.derived}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function scoreText(score: number | null): string {
  return score === null ? "Not available" : score.toFixed(2);
}

function p90TurnLatency(metrics: readonly Measured[]): string {
  const latency = metrics.find(
    (metric) =>
      metric.measure === "turn_response_latency" &&
      metric.unit === "milliseconds",
  );
  if (latency === undefined || !Number.isFinite(latency.p90)) {
    return "Not recorded";
  }

  /*
   * The summary needs scale, not sample-level precision. Keep three
   * significant digits, but keep the familiar millisecond unit visible.
   */
  const rounded = Number(latency.p90.toPrecision(3));
  return `${String(rounded)} ms${latency.partial ? " · partial" : ""}`;
}

/** The four simulation-level facts required before reading grader output. */
export function SimulationEvidenceSummary({
  evidence,
}: {
  readonly evidence: SimulationEvidence;
}) {
  const turns = turnsOf(evidence);
  return (
    <div className="@container/summary min-w-0">
    <section
      className={cn(
        "grid min-w-0 grid-cols-4 gap-px overflow-hidden rounded-card border border-border bg-border",
        "@max-[36rem]/summary:grid-cols-2 @max-[24rem]/summary:grid-cols-1",
      )}
      aria-label="Simulation summary"
    >
      <div className={SUMMARY_STRIP_CELL}>
        <span className={SUMMARY_STRIP_LABEL}>Combined score</span>
        <strong className={SUMMARY_VALUE}>
          {scoreText(evidence.combinedScore)}
        </strong>
      </div>
      <div className={SUMMARY_STRIP_CELL}>
        <span className={SUMMARY_STRIP_LABEL}>Duration</span>
        <strong className={SUMMARY_VALUE}>
          {shownDuration(durationOf(evidence))}
        </strong>
      </div>
      <div className={SUMMARY_STRIP_CELL}>
        <span className={SUMMARY_STRIP_LABEL}>Total turns</span>
        <strong className={SUMMARY_VALUE}>
          {turns === null ? "Not recorded" : String(turns)}
        </strong>
      </div>
      <div className={SUMMARY_STRIP_CELL}>
        <span className={SUMMARY_STRIP_LABEL}>P90 turn latency</span>
        <strong className={SUMMARY_VALUE}>
          {p90TurnLatency(evidence.metrics)}
        </strong>
      </div>
    </section>
    </div>
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
  readonly waveform:
    | {
        readonly kind: "stereo";
        readonly human: readonly number[];
        readonly agent: readonly number[];
      }
    | {
        readonly kind: "mono";
        readonly peaks: readonly number[];
      }
    | null;
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

/** Keep a decoded mono recording visible without guessing that it is stereo. */
function waveformOf(
  buffer: AudioBuffer,
): NonNullable<SimulationEvidenceRecording["waveform"]> {
  if (buffer.numberOfChannels === 2) {
    return {
      kind: "stereo",
      human: peaksOf(buffer, 0),
      agent: peaksOf(buffer, 1),
    };
  }
  return { kind: "mono", peaks: peaksOf(buffer, 0) };
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
  const pendingSeekAt = useRef<number | null>(null);
  const lastClock = useRef(0);
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
      pendingSeekAt.current = null;
      lastClock.current = 0;
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
        setWaveform(waveformOf(decoded));
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
      const next = audioRef.current?.currentTime ?? 0;
      if (Math.abs(next - lastClock.current) >= 0.1) {
        lastClock.current = next;
        setCurrentTime(next);
      }
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
    const next = audioRef.current?.currentTime ?? 0;
    lastClock.current = next;
    setCurrentTime(next);
  }

  function readDuration(): void {
    const heard = audioRef.current?.duration;
    if (heard !== undefined && Number.isFinite(heard)) setDuration(heard);
    const attempt = resolvedAttempt.current;
    if (pendingSeekAt.current !== null && audioRef.current !== null) {
      const requested = pendingSeekAt.current;
      const limit =
        heard !== undefined && Number.isFinite(heard) ? heard : requested;
      audioRef.current.currentTime = Math.min(requested, limit);
      lastClock.current = audioRef.current.currentTime;
      setCurrentTime(audioRef.current.currentTime);
      pendingSeekAt.current = null;
      resumeAt.current = 0;
    } else if (resumeAt.current > 0 && audioRef.current !== null) {
      const limit =
        heard !== undefined && Number.isFinite(heard) ? heard : resumeAt.current;
      audioRef.current.currentTime = Math.min(resumeAt.current, limit);
      lastClock.current = audioRef.current.currentTime;
      setCurrentTime(audioRef.current.currentTime);
      resumeAt.current = 0;
    }
    markReady(attempt, "media");
  }

  const seek = useCallback((seconds: number, play = false): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      pendingSeekAt.current = Math.max(0, seconds);
      return;
    }
    const limit = audio.duration;
    audio.currentTime = Math.min(Math.max(0, seconds), Math.max(0, limit));
    lastClock.current = audio.currentTime;
    setCurrentTime(audio.currentTime);
    if (play) void audio.play().catch(() => undefined);
  }, []);

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

type DirectRecordingClock = {
  readonly url: string;
  readonly currentTime: number;
  readonly duration: number;
  readonly playing: boolean;
};

type DirectRecordingWaveform = {
  readonly url: string;
  readonly value: SimulationEvidenceRecording["waveform"];
  readonly loading: boolean;
};

/**
 * A recording controller for an audio URL that is already usable by the media
 * element. Unlike a simulation recording, this source has no signed-link
 * refresh step. A waveform decode is only an enhancement: CORS and decode
 * failures keep the native player usable through its seek control.
 */
export function useDirectEvidenceRecording(
  url: string | null,
): SimulationEvidenceRecording {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSeekAt = useRef<number | null>(null);
  const lastClock = useRef(0);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [clock, setClock] = useState<DirectRecordingClock | null>(null);
  const [waveform, setWaveform] = useState<DirectRecordingWaveform | null>(
    null,
  );

  useEffect(() => {
    pendingSeekAt.current = null;
    lastClock.current = 0;
    setFailedUrl(null);
    if (url === null) {
      setClock(null);
      setWaveform(null);
      return undefined;
    }

    setClock({ url, currentTime: 0, duration: 0, playing: false });
    setWaveform({ url, value: null, loading: true });
    let current = true;
    let context: AudioContext | null = null;
    const closeContext = (): void => {
      const ownedContext = context;
      context = null;
      if (ownedContext === null) return;
      try {
        void ownedContext.close().catch(() => undefined);
      } catch {
        // Cleanup stays safe if the browser already closed the context.
      }
    };

    void fetch(url)
      .then((answer) => {
        if (!answer.ok) throw new Error("The audio file could not be decoded.");
        return answer.arrayBuffer();
      })
      .then(async (bytes) => {
        context = new AudioContext();
        const decoded = await context.decodeAudioData(bytes);
        if (!current) return;
        setClock((present) =>
          present?.url === url
            ? { ...present, duration: decoded.duration }
            : present,
        );
        setWaveform({
          url,
          value: waveformOf(decoded),
          loading: false,
        });
      })
      .catch(() => {
        if (!current) return;
        setWaveform({ url, value: null, loading: false });
      })
      .finally(closeContext);

    return () => {
      current = false;
      closeContext();
    };
  }, [url]);

  const currentClock =
    clock?.url === url
      ? clock
      : { url: url ?? "", currentTime: 0, duration: 0, playing: false };
  const currentWaveform = waveform?.url === url ? waveform : null;

  useEffect(() => {
    if (!currentClock.playing || url === null) return undefined;
    let frame = 0;
    const follow = (): void => {
      const next = audioRef.current?.currentTime ?? 0;
      if (Math.abs(next - lastClock.current) >= 0.1) {
        lastClock.current = next;
        setClock((present) =>
          present?.url === url
            ? { ...present, currentTime: next }
            : present,
        );
      }
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [currentClock.playing, url]);

  const seek = useCallback((seconds: number, play = false): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      pendingSeekAt.current = Math.max(0, seconds);
      return;
    }
    audio.currentTime = Math.min(
      Math.max(0, seconds),
      Math.max(0, audio.duration),
    );
    lastClock.current = audio.currentTime;
    setClock((present) =>
      present === null
        ? present
        : { ...present, currentTime: audio.currentTime },
    );
    if (play) void audio.play().catch(() => undefined);
  }, []);

  function readClock(): void {
    if (url === null) return;
    const next = audioRef.current?.currentTime ?? 0;
    lastClock.current = next;
    setClock((present) =>
      present?.url === url ? { ...present, currentTime: next } : present,
    );
  }

  function readDuration(): void {
    if (url === null) return;
    const audio = audioRef.current;
    const heard = audio?.duration;
    const duration =
      heard !== undefined && Number.isFinite(heard) ? heard : null;
    if (duration !== null) {
      setClock((present) =>
        present?.url === url ? { ...present, duration } : present,
      );
    }
    if (pendingSeekAt.current === null || audio === null) return;
    const requested = pendingSeekAt.current;
    audio.currentTime = Math.min(requested, duration ?? requested);
    lastClock.current = audio.currentTime;
    setClock((present) =>
      present?.url === url
        ? { ...present, currentTime: audio.currentTime }
        : present,
    );
    pendingSeekAt.current = null;
  }

  const failed = url !== null && failedUrl === url;
  return {
    status: url === null ? "absent" : failed ? "failed" : "ready",
    message: failed ? "The recording could not be played." : null,
    url,
    audioRef,
    currentTime: currentClock.currentTime,
    duration: currentClock.duration,
    playing: currentClock.playing,
    waveform: currentWaveform?.value ?? null,
    waveformLoading:
      url !== null && (currentWaveform?.loading ?? true),
    seek,
    onTimeUpdate: readClock,
    onLoadedMetadata: readDuration,
    onError: () => {
      if (url === null) return;
      setFailedUrl(url);
      setClock((present) =>
        present?.url === url ? { ...present, playing: false } : present,
      );
    },
    onPlay: () => {
      if (url === null) return;
      setClock((present) =>
        present?.url === url ? { ...present, playing: true } : present,
      );
    },
    onPause: () => {
      if (url === null) return;
      setClock((present) =>
        present?.url === url ? { ...present, playing: false } : present,
      );
    },
  };
}

type EvidenceGrader = {
  readonly key: string;
  readonly name: string;
  readonly plan: EvidencePlanItem | null;
  readonly grade: EvidenceGrade | null;
  readonly history: readonly EvidenceGrade[];
};

function behaviorPosition(key: string): number | null {
  const found = /^behavior_(\d+)$/u.exec(key)?.[1];
  if (found === undefined) return null;
  const position = Number(found);
  return Number.isInteger(position) && position > 0 ? position : null;
}

function assertionName(
  assertion: DisplayGradeAssertion,
  expected: readonly string[],
): string {
  const position = behaviorPosition(assertion.key);
  if (position !== null) {
    const behavior = expected[position - 1];
    if (behavior !== undefined) return behavior;
  }
  return humanizeIdentifier(assertion.key);
}

function graderName(name: string): string {
  return humanizeIdentifier(graderDisplayName(name));
}

/** Current grades, ordered by the frozen plan, with history kept underneath. */
function evidenceGraders(evidence: SimulationEvidence): readonly EvidenceGrader[] {
  const planItems = evidence.gradingPlan?.items ?? [];
  const keys = new Set<string>();
  for (const item of planItems) keys.add(item.projectGraderId);
  for (const grade of evidence.grades) keys.add(grade.projectGraderId);
  for (const grade of evidence.gradeHistory) keys.add(grade.projectGraderId);

  return [...keys].map((key) => {
    const plan = planItems.find((item) => item.projectGraderId === key) ?? null;
    const grade =
      evidence.grades.find((item) => item.projectGraderId === key) ?? null;
    const history =
      grade === null
        ? evidence.gradeHistory
            .filter((item) => item.projectGraderId === key)
            .sort(
              (left, right) =>
                Date.parse(right.gradedAt) - Date.parse(left.gradedAt),
            )
        : priorGrades(grade, evidence.gradeHistory);
    const name = grade?.graderName ?? plan?.graderName ?? "Grader unavailable";
    return { key, name: graderName(name), plan, grade, history };
  });
}

function waveformPath(
  peaks: readonly number[],
  middle = 32,
  scale = 27,
): string {
  if (peaks.length === 0) return "";
  const width = 1000;
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

function CombinedWaveform({
  human,
  agent,
  progress,
}: {
  readonly human: readonly number[];
  readonly agent: readonly number[];
  readonly progress: number;
}) {
  return (
    <div
      className={cn(
        "relative h-16 min-w-0 overflow-hidden border border-border bg-background",
        "bg-[linear-gradient(to_bottom,transparent_49.5%,var(--border)_49.5%,var(--border)_50.5%,transparent_50.5%)]",
      )}
      data-waveform-channels="stereo"
    >
      <svg
        className="block h-full w-full"
        aria-hidden="true"
        preserveAspectRatio="none"
        viewBox="0 0 1000 64"
      >
        {/*
         * Both stereo channels share one time axis and one playhead. Each keeps
         * half the panel so overlap remains legible: neutral ink is the User;
         * Ember is the Agent.
         */}
        <path
          className="fill-waveform-user"
          d={waveformPath(human, 16, 13)}
        />
        <path
          className="fill-waveform-agent"
          d={waveformPath(agent, 48, 13)}
        />
      </svg>
      <span
        className="pointer-events-none absolute top-0 bottom-0 left-(--playhead) z-1 w-0.5 bg-brand"
        style={{ "--playhead": `${String(progress)}%` } as CSSProperties}
        aria-hidden="true"
      />
    </div>
  );
}

type RecordingSpeakerRange = {
  readonly speaker: "human" | "agent";
  readonly startedSeconds: number;
  readonly endedSeconds: number;
};

function recordedDurationSeconds(nanoseconds: string): number | null {
  if (!/^\d+$/u.test(nanoseconds)) return null;
  const seconds = milliseconds(nanoseconds) / 1000;
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * A mono file has no channel identity. The spoken-turn timestamps are still a
 * useful source of speaker identity. Each turn owns only its recorded duration,
 * capped at the next turn. A missing duration falls back to the next turn.
 * Time outside those ranges stays neutral.
 */
function recordingSpeakerRanges(
  timeline: RecordingSpeakerTimeline | null | undefined,
  duration: number,
): readonly RecordingSpeakerRange[] {
  if (timeline === null || timeline === undefined || duration <= 0) return [];
  const origin = Date.parse(timeline.startedAt);
  if (!Number.isFinite(origin)) return [];
  const ended = Date.parse(timeline.endedAt);
  const timelineEnd = Number.isFinite(ended)
    ? Math.min(duration, Math.max(0, (ended - origin) / 1000))
    : duration;
  const turns = timeline.turns
    .flatMap((turn) => {
      const speaker: RecordingSpeakerRange["speaker"] | null =
        turn.kind === "turn:human"
          ? "human"
          : turn.kind === "turn:agent"
            ? "agent"
            : null;
      const started = Date.parse(turn.startedAt);
      if (speaker === null || !Number.isFinite(started)) return [];
      return [
        {
          speaker,
          durationSeconds: recordedDurationSeconds(turn.durationNs),
          startedSeconds: Math.min(
            duration,
            Math.max(0, (started - origin) / 1000),
          ),
        },
      ];
    })
    .sort((left, right) => left.startedSeconds - right.startedSeconds);

  const ranges: RecordingSpeakerRange[] = [];
  for (let at = 0; at < turns.length; at += 1) {
    const turn = turns[at];
    if (turn === undefined) continue;
    const next = turns[at + 1];
    const nextBoundary = Math.min(
      duration,
      next?.startedSeconds ?? timelineEnd,
      timelineEnd,
    );
    const endedSeconds = Math.max(
      turn.startedSeconds,
      turn.durationSeconds === null
        ? nextBoundary
        : Math.min(
            turn.startedSeconds + turn.durationSeconds,
            nextBoundary,
          ),
    );
    if (endedSeconds <= turn.startedSeconds) continue;
    const prior = ranges.at(-1);
    if (
      prior !== undefined &&
      prior.speaker === turn.speaker &&
      prior.endedSeconds >= turn.startedSeconds
    ) {
      ranges[ranges.length - 1] = { ...prior, endedSeconds };
      continue;
    }
    ranges.push({ ...turn, endedSeconds });
  }
  return ranges;
}

function MonoWaveform({
  peaks,
  progress,
  duration,
  speakerRanges,
}: {
  readonly peaks: readonly number[];
  readonly progress: number;
  readonly duration: number;
  readonly speakerRanges: readonly RecordingSpeakerRange[];
}) {
  const id = useId().replaceAll(":", "");
  const humanClip = `${id}-human`;
  const agentClip = `${id}-agent`;
  const path = waveformPath(peaks);
  const clipRectangles = (speaker: RecordingSpeakerRange["speaker"]) =>
    speakerRanges
      .filter((range) => range.speaker === speaker)
      .map((range, at) => {
        const x = (range.startedSeconds / duration) * 1000;
        const width =
          ((range.endedSeconds - range.startedSeconds) / duration) * 1000;
        return (
          <rect
            data-speaker={speaker}
            height="64"
            key={`${speaker}:${String(at)}`}
            width={width}
            x={x}
            y="0"
          />
        );
      });

  return (
    <div
      className={cn(
        "relative h-16 min-w-0 overflow-hidden border border-border bg-background",
        "bg-[linear-gradient(to_bottom,transparent_49.5%,var(--border)_49.5%,var(--border)_50.5%,transparent_50.5%)]",
      )}
      data-waveform-channels="mono"
    >
      <svg
        className="block h-full w-full"
        aria-hidden="true"
        preserveAspectRatio="none"
        viewBox="0 0 1000 64"
      >
        <defs>
          <clipPath id={humanClip}>{clipRectangles("human")}</clipPath>
          <clipPath id={agentClip}>{clipRectangles("agent")}</clipPath>
        </defs>
        <path className="fill-faint" d={path} />
        <path
          className="fill-waveform-user"
          clipPath={`url(#${humanClip})`}
          d={path}
        />
        <path
          className="fill-waveform-agent"
          clipPath={`url(#${agentClip})`}
          d={path}
        />
      </svg>
      <span
        className="pointer-events-none absolute top-0 bottom-0 left-(--playhead) z-1 w-0.5 bg-brand"
        style={{ "--playhead": `${String(progress)}%` } as CSSProperties}
        aria-hidden="true"
      />
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
  "m-0 border-t border-border bg-surface px-3 py-3 text-sm text-muted-foreground";

export type RecordingEvidenceLabels = {
  readonly title: string;
  readonly human: string;
  readonly agent: string;
  readonly absent: string;
};

const DEFAULT_RECORDING_LABELS: RecordingEvidenceLabels = {
  title: "Simulation recording",
  human: "User",
  agent: "Agent",
  absent: "No audio was recorded.",
};

export function RecordingEvidence({
  recording,
  active,
  labels,
  speakerTimeline,
}: {
  readonly recording: SimulationEvidenceRecording;
  readonly active: boolean;
  readonly labels?: Partial<RecordingEvidenceLabels>;
  readonly speakerTimeline?: RecordingSpeakerTimeline | null;
}) {
  const title = labels?.title ?? DEFAULT_RECORDING_LABELS.title;
  const human = labels?.human ?? DEFAULT_RECORDING_LABELS.human;
  const agent = labels?.agent ?? DEFAULT_RECORDING_LABELS.agent;
  const absent =
    labels?.absent ??
    (active
      ? "Recording will be available after the call ends."
      : DEFAULT_RECORDING_LABELS.absent);
  if (recording.status === "absent") {
    return (
      <p className={RECORDING_STATE} role={active ? "status" : undefined}>
        {absent}
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
  const speakerRanges = recording.waveform?.kind === "mono"
    ? recordingSpeakerRanges(speakerTimeline, limit)
    : [];
  const showsSpeakerLegend = recording.waveform?.kind === "stereo" ||
    speakerRanges.length > 0;

  function toggle(): void {
    const audio = recording.audioRef.current;
    if (audio === null) return;
    if (recording.playing) {
      audio.pause();
      return;
    }
    void audio.play().catch(() => undefined);
  }

  return (
    <div className="min-w-0 overflow-hidden border border-border bg-surface">
      <audio
        ref={recording.audioRef}
        aria-label={title}
        className="sr-only"
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
      <div className="flex min-w-0 items-center gap-3 p-3">
        <Button
          className="min-h-(--control-lg) w-(--control-lg)"
          type="button"
          size="icon"
          variant="secondary"
          aria-label={recording.playing ? "Pause recording" : "Play recording"}
          onClick={toggle}
        >
          {recording.playing ? (
            <PauseIcon aria-hidden="true" />
          ) : (
            <PlayIcon aria-hidden="true" />
          )}
        </Button>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <span className="truncate text-sm font-medium text-foreground">
            {title}
          </span>
          <output className="flex-none font-mono text-sm tabular-nums text-muted-foreground">
            {elapsed} / {total}
          </output>
        </div>
      </div>
      {recording.waveformLoading ? (
        <p className={RECORDING_STATE_UNDER_PLAYER} role="status">
          Drawing the audio waveform…
        </p>
      ) : recording.waveform === null ? (
        <div className="border-t border-border p-3">
          <input
            className="block h-(--tap-target) w-full cursor-ew-resize accent-brand"
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
        </div>
      ) : (
        <div className="border-t border-border p-3">
          <div
            className={cn(
              "relative outline-2 outline-offset-2 outline-transparent",
              /* The invisible native range gives the drawn waveform keyboard semantics. */
              "has-[input:focus-visible]:outline-brand",
            )}
          >
            {recording.waveform.kind === "stereo" ? (
              <CombinedWaveform
                human={recording.waveform.human}
                agent={recording.waveform.agent}
                progress={progress}
              />
            ) : (
              <MonoWaveform
                duration={limit}
                peaks={recording.waveform.peaks}
                progress={progress}
                speakerRanges={speakerRanges}
              />
            )}
            <input
              className={cn(
                "absolute inset-0 z-2 m-0 h-full w-full",
                "cursor-ew-resize appearance-none opacity-[0.001] disabled:cursor-default",
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
          </div>
          {showsSpeakerLegend ? (
            <div
              className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground"
              aria-label="Waveform speakers"
            >
              <span className="inline-flex items-center gap-2">
                <span
                  className="size-2.5 flex-none bg-foreground"
                  aria-hidden="true"
                />
                {human}
              </span>
              <span className="inline-flex items-center gap-2">
                <span
                  className="size-2.5 flex-none bg-brand"
                  aria-hidden="true"
                />
                {agent}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Every recorded tool call, once, in the order it happened. */
export function transcriptToolCalls(
  transcript: EvidenceTranscript,
): readonly EvidenceStep[] {
  const found = new Map<string, EvidenceStep>();
  const visit = (step: EvidenceStep): void => {
    if (step.kind === "tool") found.set(step.spanId, step);
    for (const nested of step.spans) visit(nested);
  };
  for (const turn of transcript.turns) visit(turn);
  for (const step of transcript.spans) visit(step);
  return [...found.values()].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  );
}

/** Every recorded tool call in one simulation, using the shared transcript walk. */
export function simulationToolCalls(
  evidence: SimulationEvidence,
): readonly EvidenceStep[] {
  return evidence.transcript === null
    ? []
    : transcriptToolCalls(evidence.transcript);
}

type ConversationEvent =
  | {
      readonly kind: "turn";
      readonly step: EvidenceStep;
      readonly turnNumber: number;
    }
  | {
      readonly kind: "tool";
      readonly step: EvidenceStep;
    };

type TimedConversationEvent = ConversationEvent & {
  readonly startedSeconds: number | null;
  readonly endedSeconds: number | null;
};

function conversationEvents(
  transcript: EvidenceTranscript,
  toolCalls: readonly EvidenceStep[],
): readonly ConversationEvent[] {
  return [
    ...transcript.turns.map(
      (step, at): ConversationEvent => ({
        kind: "turn",
        step,
        turnNumber: at + 1,
      }),
    ),
    ...toolCalls.map(
      (step): ConversationEvent => ({ kind: "tool", step }),
    ),
  ].sort((left, right) => {
    const byTime = Date.parse(left.step.startedAt) - Date.parse(right.step.startedAt);
    if (Number.isFinite(byTime) && byTime !== 0) return byTime;
    if (left.kind === right.kind) return 0;
    return left.kind === "turn" ? -1 : 1;
  });
}

function secondsInto(startedAt: string, transcriptStartedAt: string): number | null {
  const started = Date.parse(startedAt);
  const transcriptStarted = Date.parse(transcriptStartedAt);
  if (Number.isNaN(started) || Number.isNaN(transcriptStarted)) return null;
  return Math.max(0, (started - transcriptStarted) / 1000);
}

function timedConversationEvents(
  transcript: EvidenceTranscript,
  toolCalls: readonly EvidenceStep[],
  timelineStartedAt: string,
): readonly TimedConversationEvent[] {
  const events = conversationEvents(transcript, toolCalls);
  const starts = events.map((event) =>
    secondsInto(event.step.startedAt, timelineStartedAt),
  );
  const endedTranscript = secondsInto(transcript.endedAt, timelineStartedAt);
  const timed = new Array<TimedConversationEvent>(events.length);
  let nextKnownStart = endedTranscript;
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event === undefined) continue;
    const startedSeconds = starts[at] ?? null;
    timed[at] = {
      ...event,
      startedSeconds,
      endedSeconds: nextKnownStart ?? startedSeconds,
    };
    if (startedSeconds !== null) nextKnownStart = startedSeconds;
  }
  return timed;
}

type TranscriptSeek = (spanId: string, seconds: number) => void;

const TranscriptToolCall = memo(function TranscriptToolCall({
  step,
  timelineStartedAt,
  active,
  selected,
  onSeek,
}: {
  readonly step: EvidenceStep;
  readonly timelineStartedAt: string;
  readonly active: boolean;
  readonly selected: boolean;
  readonly onSeek?: TranscriptSeek;
}) {
  const failed = step.status === "error";
  const succeeded = step.status === "ok";
  const statusLabel = failed
    ? "Failed"
    : succeeded
      ? "Succeeded"
      : "Status not recorded";
  const name = step.toolName === "" ? humanizeIdentifier(step.name) : step.toolName;
  const seconds = secondsInto(step.startedAt, timelineStartedAt);
  const shownTime = seconds === null ? "Time unavailable" : clockText(seconds);

  return (
    <li
      className={cn(
        "relative grid min-w-0 grid-cols-[64px_minmax(0,1fr)] overflow-hidden border border-border bg-surface-soft",
        "max-[40rem]:grid-cols-[56px_minmax(0,1fr)]",
        selected && "bg-selected before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-brand",
        active && "after:absolute after:inset-y-0 after:right-0 after:w-0.5 after:bg-foreground",
      )}
      data-active={active ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      aria-label={`Tool call, ${name}`}
      aria-current={active ? "true" : undefined}
    >
      <div className="flex min-h-(--tap-target) flex-col items-start justify-center border-r border-border px-3 py-2">
        {onSeek === undefined || seconds === null ? (
          <time
            className="font-mono text-sm tabular-nums text-muted-foreground"
            dateTime={step.startedAt}
            title={asSecond(step.startedAt)}
          >
            {shownTime}
          </time>
        ) : (
          <button
            className="cursor-pointer border-0 bg-transparent p-0 font-mono text-sm tabular-nums text-foreground underline-offset-4 pointer-hover:underline pointer-hover:decoration-brand focus-visible:underline"
            type="button"
            aria-label={`Seek recording to tool call ${name} at ${shownTime}`}
            onClick={() => {
              onSeek(step.spanId, seconds);
            }}
          >
            {shownTime}
          </button>
        )}
      </div>
      <details className="group/details min-w-0">
        <summary
          className="grid min-h-(--tap-target) cursor-pointer list-none grid-cols-[12px_minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-3 text-foreground [&::-webkit-details-marker]:hidden"
          onClick={() => {
            if (onSeek !== undefined && seconds !== null) {
              onSeek(step.spanId, seconds);
            }
          }}
        >
          <StateMark kind={failed ? "error" : succeeded ? "complete" : "waiting"} />
          <span className="min-w-0">
            <span className="block truncate font-mono text-sm text-foreground">
              {name}
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">Tool call</span>
          </span>
          <span
            className={cn(
              "text-end text-sm text-muted-foreground",
              failed && "text-failure",
            )}
          >
            {statusLabel} · {howLong(step.durationNs)}
          </span>
          <ChevronRightIcon
            className="size-4 flex-none transition-transform duration-(--duration-hover) ease-out group-open/details:rotate-90 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <div className="grid min-w-0 grid-cols-2 gap-px border-t border-border bg-border max-[48rem]:grid-cols-1">
          <section
            className="min-w-0 bg-background p-4"
            aria-label={`${name} request`}
          >
            <p className="m-0 text-sm font-medium text-muted-foreground">Request</p>
            {step.toolArguments === "" ? (
              <p className="m-0 mt-1 text-sm text-faint">No request was recorded.</p>
            ) : (
              <pre className="m-0 mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-sm text-foreground">
                {step.toolArguments}
              </pre>
            )}
          </section>
          <section
            className="min-w-0 bg-background p-4"
            aria-label={`${name} response`}
          >
            <p className="m-0 text-sm font-medium text-muted-foreground">Response</p>
            {step.toolResult === "" ? (
              <p className="m-0 mt-1 text-sm text-faint">No response was recorded.</p>
            ) : (
              <pre className="m-0 mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-sm text-foreground">
                {step.toolResult}
              </pre>
            )}
          </section>
        </div>
      </details>
    </li>
  );
});

const TranscriptTurn = memo(function TranscriptTurn({
  turn,
  turnNumber,
  timelineStartedAt,
  active,
  selected,
  speakerLabels,
  onSeek,
}: {
  readonly turn: EvidenceStep;
  readonly turnNumber: number;
  readonly timelineStartedAt: string;
  readonly active: boolean;
  readonly selected: boolean;
  readonly speakerLabels: TranscriptSpeakerLabels;
  readonly onSeek?: TranscriptSeek;
}) {
  const human = turn.kind === "turn:human";
  const speaker = human ? speakerLabels.human : speakerLabels.agent;
  const seconds = secondsInto(turn.startedAt, timelineStartedAt);
  const shownTime = seconds === null ? "Time unavailable" : clockText(seconds);
  const content = (
    <>
      <div className="flex min-h-(--tap-target) flex-col items-start justify-center border-r border-border px-3 py-2">
        <time
          className="font-mono text-sm tabular-nums text-muted-foreground"
          dateTime={turn.startedAt}
          title={asSecond(turn.startedAt)}
        >
          {shownTime}
        </time>
      </div>
      <div className="min-w-0 px-4 py-3">
        <p
          className={cn(
            "m-0 mb-1 text-sm font-medium",
            human ? "text-foreground" : "text-brand",
          )}
        >
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
    </>
  );

  return (
    <li
      className="group w-full min-w-0 scroll-my-8"
      id={`transcript-turn-${String(turnNumber)}`}
      aria-label={`Turn ${String(turnNumber)}, ${speaker}`}
    >
      {onSeek === undefined || seconds === null ? (
        <div
          className={cn(
            "relative grid min-w-0 grid-cols-[64px_minmax(0,1fr)] overflow-hidden border border-border bg-surface max-[40rem]:grid-cols-[56px_minmax(0,1fr)]",
            "group-target:border-brand group-target:bg-selected",
            active && "after:absolute after:inset-y-0 after:right-0 after:w-0.5 after:bg-foreground",
          )}
          aria-current={active ? "true" : undefined}
        >
          {content}
        </div>
      ) : (
        <button
          className={cn(
            "relative grid min-w-0 w-full cursor-pointer grid-cols-[64px_minmax(0,1fr)] overflow-hidden border border-border bg-surface p-0 text-left max-[40rem]:grid-cols-[56px_minmax(0,1fr)]",
            "pointer-hover:bg-surface-soft group-target:border-brand group-target:bg-selected",
            selected && "bg-selected before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-brand",
            active && "after:absolute after:inset-y-0 after:right-0 after:w-0.5 after:bg-foreground",
          )}
          type="button"
          aria-current={active ? "true" : undefined}
          aria-pressed={selected}
          title={`Seek recording to ${shownTime}`}
          onClick={() => onSeek(turn.spanId, seconds)}
        >
          {content}
        </button>
      )}
    </li>
  );
});

export type TranscriptSpeakerLabels = {
  readonly human: string;
  readonly agent: string;
};

export type TranscriptEmptyState = {
  readonly title: string;
  readonly description: string;
};

const DEFAULT_TRANSCRIPT_SPEAKERS: TranscriptSpeakerLabels = {
  human: "User",
  agent: "Agent",
};

const DEFAULT_TRANSCRIPT_EMPTY_STATE: TranscriptEmptyState = {
  title: "Nothing was said",
  description: "Egma filed no spoken turns for this simulation.",
};

/**
 * Readable speech and tool calls on one time rail. A recording-backed row is a
 * real button: selecting it seeks the shared player without autoplay. Selection
 * stays put while the playhead independently marks the event currently playing.
 */
export function ChatTranscript({
  transcript,
  toolCalls = [],
  recordingStartedAt,
  currentTime,
  onSeek,
  speakerLabels = DEFAULT_TRANSCRIPT_SPEAKERS,
  emptyState = DEFAULT_TRANSCRIPT_EMPTY_STATE,
}: {
  readonly transcript: EvidenceTranscript;
  readonly toolCalls?: readonly EvidenceStep[];
  readonly recordingStartedAt?: string | null;
  readonly currentTime?: number;
  readonly onSeek?: (seconds: number) => void;
  readonly speakerLabels?: TranscriptSpeakerLabels;
  readonly emptyState?: TranscriptEmptyState;
}) {
  const timelineStartedAt = recordingStartedAt ?? transcript.startedAt;
  const events = useMemo(
    () => timedConversationEvents(transcript, toolCalls, timelineStartedAt),
    [timelineStartedAt, toolCalls, transcript],
  );
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const selectAndSeek = useCallback<TranscriptSeek>(
    (spanId, seconds) => {
      setSelectedSpanId(spanId);
      onSeek?.(seconds);
    },
    [onSeek],
  );
  if (events.length === 0) {
    return (
      <div className={EMPTY_STATE}>
        <strong className={EMPTY_STATE_TITLE}>{emptyState.title}</strong>
        <p className={EMPTY_STATE_LEAD}>{emptyState.description}</p>
      </div>
    );
  }

  return (
    <ol
      className="m-0 flex min-w-0 list-none flex-col gap-3 p-0"
      aria-label="Transcript messages"
    >
      {events.map((event) => {
        const started = event.startedSeconds;
        const ended = event.endedSeconds;
        const active =
          currentTime !== undefined &&
          started !== null &&
          currentTime >= started &&
          currentTime < Math.max(started + 0.05, ended ?? started);
        if (event.kind === "tool") {
          return (
            <TranscriptToolCall
              key={event.step.spanId}
              step={event.step}
              timelineStartedAt={timelineStartedAt}
              active={active}
              selected={selectedSpanId === event.step.spanId}
              {...(onSeek === undefined ? {} : { onSeek: selectAndSeek })}
            />
          );
        }
        return (
          <TranscriptTurn
            active={active}
            key={event.step.spanId}
            selected={selectedSpanId === event.step.spanId}
            speakerLabels={speakerLabels}
            timelineStartedAt={timelineStartedAt}
            turn={event.step}
            turnNumber={event.turnNumber}
            {...(onSeek === undefined
              ? {}
              : { onSeek: selectAndSeek })}
          />
        );
      })}
    </ol>
  );
}

/** The quiet mono kicker over a title: what kind of thing this block is. */
const PANE_KIND =
  "mb-1 block font-mono text-sm tracking-(--tracking-label) text-faint uppercase";

function GraderGroup({
  grader,
  stillGrading,
  evidence,
  onReadTurn,
}: {
  readonly grader: EvidenceGrader;
  readonly stillGrading: boolean;
  readonly evidence: SimulationEvidence;
  readonly onReadTurn: (turn: number) => void;
}) {
  const grade = grader.grade;
  const expected = evidence.test.expectedBehaviors ?? [];
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
            {gradeSummary({
              grade,
              ...(grader.plan?.passThreshold === undefined
                ? {}
                : { passThreshold: grader.plan.passThreshold }),
              ...(grader.plan?.graderDefinitionVersion === undefined
                ? {}
                : {
                    graderDefinitionVersion:
                      grader.plan.graderDefinitionVersion,
                  }),
            })}
          </p>
        </div>
        {grade === null ? (
          <Badge>
            <StateMark kind={stillGrading ? "active" : "waiting"} />
            {stillGrading ? "Grading" : "No grade"}
          </Badge>
        ) : (
          <GradeResultBadge result={grade.result} />
        )}
      </header>
      {grade === null ? (
        <p className="m-0 px-5 py-4 text-sm text-muted-foreground max-[40rem]:px-4">
          {stillGrading
            ? "Waiting for this grader to return a grade."
            : "No grade is available for this grader."}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-4 bg-background p-5 max-[40rem]:p-4">
          <GradeDetails
            grade={grade}
            assertionName={(assertion) => assertionName(assertion, expected)}
            renderCitations={(assertion) => {
              const citedTurns = citedTurnPositions(
                assertion.citedSpanIds ?? [],
                evidence.transcript?.turns ?? [],
              );
              if (citedTurns.length === 0) return null;
              return citedTurns.map((turn, turnAt) => (
                <span key={turn}>
                  {turnAt === 0 ? "" : ", "}
                  <button
                    className={cn(
                      "m-0 cursor-pointer border-0 bg-transparent p-0 text-foreground",
                      "underline decoration-brand underline-offset-[3px]",
                    )}
                    type="button"
                    onClick={() => onReadTurn(turn)}
                  >
                    Read turn {turn}
                  </button>
                </span>
              ));
            }}
          />
          {grader.history.length === 0 ? null : (
            <details className="text-sm text-muted-foreground">
              <summary className="w-fit cursor-pointer text-foreground">
                {grader.history.length} earlier grade
                {grader.history.length === 1 ? "" : "s"}
              </summary>
              <div className="mt-3 flex flex-col gap-2">
                {grader.history.map((older) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-2"
                    key={`${older.gradedAt}:${String(older.graderDefinitionVersion)}`}
                  >
                    <span className="font-mono text-muted-foreground">
                      {asSecond(older.gradedAt)} · score {scoreText(older.score)}
                    </span>
                    <GradeResultBadge result={older.result} />
                  </div>
                ))}
              </div>
            </details>
          )}
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

/** The immutable grader plan captured at run start. */
export function SimulationGradingPlan({
  evidence,
  className,
}: {
  readonly evidence: SimulationEvidence;
  readonly className?: string;
}) {
  return (
    <section
      className={cn("bg-background p-5 max-[40rem]:p-4", className)}
      aria-label="Frozen grading plan"
    >
      <h3 className="m-0 text-base font-medium text-foreground">
        Frozen grading plan
      </h3>
      {evidence.gradingPlan === null ? (
        <p className="m-0 mt-1 text-sm text-muted-foreground">
          No frozen grading plan was recorded for this simulation.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <p className="m-0 text-sm text-muted-foreground">
            {`Frozen when this run started at ${asSecond(evidence.gradingPlan.capturedAt)}.`}
          </p>
          <PlanItems items={evidence.gradingPlan.items} />
        </div>
      )}
    </section>
  );
}

/**
 * The one evidence review used while grading and after grading completes.
 * The grader review stays on the page. Audio and readable speech live in the
 * shared right-side sheet so a long recording never sets the page's height.
 */
function SimulationEvidencePanel({
  evidence,
  recording,
  evidenceOpen,
  onEvidenceChange,
}: {
  readonly evidence: SimulationEvidence;
  readonly recording: SimulationEvidenceRecording;
  readonly evidenceOpen: boolean;
  readonly onEvidenceChange: (open: boolean) => void;
}) {
  const stillGrading =
    evidence.gradingState === "pending" || evidence.gradingState === "running";
  const graders = evidenceGraders(evidence);
  const simulationActive = ["queued", "claimed", "running"].includes(
    evidence.status,
  );
  const toolCalls = useMemo(() => simulationToolCalls(evidence), [evidence]);
  const pendingTurn = useRef<number | null>(null);

  function revealTurn(turn: number): void {
    const target = document.getElementById(`transcript-turn-${String(turn)}`);
    target?.scrollIntoView({ block: "center" });
    window.history.replaceState(null, "", `#transcript-turn-${String(turn)}`);
    pendingTurn.current = null;
  }

  useEffect(() => {
    if (!evidenceOpen || pendingTurn.current === null) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const turn = pendingTurn.current;
      if (turn === null) return;
      revealTurn(turn);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [evidenceOpen]);

  function readTurn(turn: number): void {
    if (evidenceOpen) {
      revealTurn(turn);
      return;
    }
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
              Grades
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
        {stillGrading ? (
          <p className={NOTICE_LINE} role="status">
            Grading is still running. Grades appear here as they finish.
          </p>
        ) : null}
        {evidence.gradingState === "error" ? (
          <p
            className={cn(NOTICE_LINE, "border-s-failure bg-surface-soft")}
            role="alert"
          >
            Egma could not complete every requested grade. Completed grades stay
            available below.
          </p>
        ) : null}
        {evidence.gradingState === "not_requested" ? (
          <div className={EMPTY_STATE}>
            <strong className={EMPTY_STATE_TITLE}>
              No grading was requested
            </strong>
            <p className={EMPTY_STATE_LEAD}>
              No grader was asked to grade this simulation.
            </p>
          </div>
        ) : graders.length === 0 ? (
          <div className={EMPTY_STATE}>
            <strong className={EMPTY_STATE_TITLE}>
              {stillGrading ? "Graders are preparing" : "No grades are available"}
            </strong>
            <p className={EMPTY_STATE_LEAD}>
              {stillGrading
                ? "No grader has returned a grade yet."
                : "This simulation has no completed grade rows."}
            </p>
          </div>
        ) : (
          <div className="flex min-w-0 flex-auto flex-col">
            {graders.map((grader) => (
              <GraderGroup
                grader={grader}
                evidence={evidence}
                key={grader.key}
                stillGrading={stillGrading}
                onReadTurn={readTurn}
              />
            ))}
          </div>
        )}
        <SimulationGradingPlan
          className="border-t border-border"
          evidence={evidence}
        />
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
                speakerTimeline={
                  evidence.transcript === null
                    ? null
                    : {
                        startedAt:
                          recordingOriginOf(evidence.transcript) ??
                          evidence.transcript.startedAt,
                        endedAt: evidence.transcript.endedAt,
                        turns: evidence.transcript.turns,
                      }
                }
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
                  <ChatTranscript
                    transcript={evidence.transcript}
                    toolCalls={toolCalls}
                    recordingStartedAt={recordingOriginOf(evidence.transcript)}
                    {...(recording.status === "ready"
                      ? {
                          currentTime: recording.currentTime,
                          onSeek: recording.seek,
                        }
                      : {})}
                  />
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
}: {
  readonly evidence: SimulationEvidence;
  readonly recording: SimulationEvidenceRecording;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(true);

  useEffect(() => setEvidenceOpen(true), [evidence.id]);

  return (
    <div
      className={cn(
        REVIEW,
        /*
         * **The sheet is docked beside this page, so the page steps aside for
         * it.** That is what a non-modal reading surface promises — the test
         * covering this panel says it in as many words: "a panel docked beside
         * this page rather than a layer over it, so the grader results stay
         * reachable while the transcript is open". The panel is `position:
         * fixed` against the viewport's right edge, so nothing under it moves
         * on its own: at 1440 the transcript covered the grader findings it is
         * evidence *for*, and a reader had to close the transcript to read the
         * finding that cited it.
         *
         * **The room is reserved here, on the block that holds both halves**,
         * and not on the review panel alone. The summary strip is that panel's
         * sibling, so padding the panel left the strip running on under the
         * sheet — Duration cut in half and Total turns gone — while the panel
         * beside it sat clear of it. One ancestor pays, and every child is
         * inside what is left.
         *
         * The room is the sheet's own width from the theme plus one gutter,
         * and only where there is room to give: below 1100px the sheet is
         * most of the screen and reading it *is* the mode, so the page stays
         * where it is and the sheet covers it.
         *
         * It is not animated. `DESIGN.md` asks motion to run on `transform`
         * and `opacity`, and this is padding — a layout property, on a block
         * holding a whole review. The sheet's own entrance already explains
         * where the room went.
         */
        evidenceOpen &&
          "min-[1100px]:pe-[calc(var(--sheet-width-wide)+var(--page-gutter))]",
      )}
    >
      <SimulationEvidenceSummary evidence={evidence} />
      <SimulationMetrics metrics={evidence.metrics} />
      <SimulationEvidencePanel
        evidence={evidence}
        recording={recording}
        evidenceOpen={evidenceOpen}
        onEvidenceChange={setEvidenceOpen}
      />
    </div>
  );
}
