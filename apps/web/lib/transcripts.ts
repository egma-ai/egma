import type {
  GetTraceResponse,
  ListTracesResponse,
  TraceSpan,
} from "@egma/platform-api/client";

import { projectPath } from "./project-context.ts";
import {
  DEFAULT_WINDOW,
  MEASURES,
  WINDOWS,
  type WindowChoice,
} from "./transcript-copy.ts";

/**
 * Trace response types, display formatting, and bounded query windows.
 * Preserve wire field names and decimal-string durations. Both read endpoints
 * require a time window: the list uses the last day, and detail uses the
 * record's known window.
 */

/** Trace-level facts, as both endpoints report them. */
export type Facts = GetTraceResponse["trace"];
export type Listed = ListTracesResponse["traces"][number];
export type ListPage = ListTracesResponse;
export type Step = TraceSpan;
export type Grade = GetTraceResponse["grades"][number];

/**
 * Metric samples, reductions, and units supplied by the API. Render these
 * values instead of recomputing the reductions in the browser.
 */
export type Measured = GetTraceResponse["metrics"][number];

/**
 * Framework-derived metrics have derived=true and no reportedBy.
 * Agent-platform reported values also set derived, so check both fields.
 */
export function workedOutMetric(one: Measured): boolean {
  return one.derived === true && one.reportedBy === undefined;
}

/**
 * Format the API's p90 rounded to a whole unit. For complete series, include
 * the sample count when greater than one; for partial series, label the limited
 * coverage instead. Add provenance only for framework-derived metrics.
 */
export function metricLine(one: Measured): string {
  const shown = `${String(Math.round(one.p90))} ${one.unit}`;
  const from = workedOutMetric(one) ? ` · ${MEASURES.derivedOne}` : "";
  if (one.partial === true) {
    return `${shown} · ${MEASURES.partialP90}${from}`;
  }
  return one.samples.length === 1
    ? `${shown}${from}`
    : `${shown} · ${MEASURES.p90} of ${MEASURES.counted(one.samples.length)}${from}`;
}
export type Detail = GetTraceResponse;

/** Turn a machine-written assertion key into a label without hiding its meaning. */
export function humanizeIdentifier(value: string): string {
  const words = value
    .replaceAll(/[_-]+/g, " ")
    .trim()
    // The stage acronyms read as acronyms — "LLM latency", never "Llm
    // latency". Spelled here, once, because both pages' labels come through
    // this one function.
    .replaceAll(/\b(llm|tts|asr)\b/g, (acronym) => acronym.toUpperCase());
  return words === "" ? value : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}

/** The platform vocabulary as a person reads it, with unknown values kept. */
export function agentPlatformLabel(value: string): string {
  switch (value) {
    case "retell":
      return "Retell";
    case "livekit":
      return "LiveKit";
    default:
      return humanizeIdentifier(value);
  }
}

/** The one monitoring latency figure, shown in seconds at useful precision. */
export function shownTurnLatency(
  milliseconds: number,
  partialLabel?: string,
): string {
  if (!Number.isFinite(milliseconds)) return "Not recorded";
  const shown = `${String(Number((Math.max(0, milliseconds) / 1000).toPrecision(3)))}s`;
  return partialLabel === undefined ? shown : `${shown} · ${partialLabel}`;
}

export type Window = { readonly from: string; readonly to: string };

/* ------------------------------------------------------------------ *
 * Windows.
 * ------------------------------------------------------------------ */

const HOUR = 60 * 60 * 1000;

/**
 * A minute of headroom on the near end of the list's window.
 *
 * The browser's clock and the clock that stamped the span are not the same
 * clock, and they are usually a second or two apart. Without this a trace
 * recorded moments ago can be stamped just after the `to` a page computed from
 * its own idea of now, and the one thing somebody looks for immediately after
 * pointing an agent at egma is the exchange they just had.
 */
const CLOCK_SKEW = 60 * 1000;

/**
 * Store the relative window choice in the URL so saved links remain relative
 * to the time they are opened, rather than freezing exact timestamps.
 */
export const WINDOW_PARAMETER = "window";

/**
 * Whichever of the offered windows the address named, and the default for
 * everything else — an absent parameter, a stale one, a mistyped one.
 *
 * `DEFAULT_WINDOW` is the only place that default is written down. The store
 * refuses a request naming no window and caps a wide one, and neither refusal
 * is worth reaching by editing a URL.
 */
export function windowChoiceOf(value: string | null): WindowChoice {
  const known = WINDOWS.find((choice) => choice.id === value);
  return known?.id ?? DEFAULT_WINDOW;
}

/** How many hours the offered window is, with the default's own as the floor. */
function hoursIn(choice: WindowChoice): number {
  const known = WINDOWS.find((one) => one.id === choice);
  const fallback = WINDOWS.find((one) => one.id === DEFAULT_WINDOW);
  return known?.hours ?? fallback?.hours ?? 24;
}

/**
 * The widest offered window, derived from the choices. It is bounded recent
 * history, not an all-time query.
 */
export const WIDEST_WINDOW: WindowChoice = WINDOWS.reduce((one, other) =>
  other.hours > one.hours ? other : one,
).id;

export function isWidestWindow(choice: WindowChoice): boolean {
  return choice === WIDEST_WINDOW;
}

/** The last day, or whichever span of time was chosen instead. */
export function recentWindow(choice: WindowChoice, now: Date): Window {
  const hours = hoursIn(choice);
  return {
    from: new Date(now.getTime() - hours * HOUR).toISOString(),
    to: new Date(now.getTime() + CLOCK_SKEW).toISOString(),
  };
}

/**
 * Pad detail-query bounds by one second to cover timestamp rounding and the
 * exclusive upper bound. Trace links carry this bounded lookup window.
 */
const PADDING = 1000;

export function windowAround(facts: {
  readonly startedAt: string;
  readonly endedAt: string;
}): Window {
  const opened = Date.parse(facts.startedAt);
  const closed = Date.parse(facts.endedAt);
  const from = Number.isNaN(opened) ? Date.now() : opened;
  const to = Number.isNaN(closed) ? from : Math.max(closed, from);

  return {
    from: new Date(from - PADDING).toISOString(),
    to: new Date(to + PADDING).toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * The monitoring section: where its pages are, and what they ask for.
 * ------------------------------------------------------------------ */

/**
 * The product area production traffic is read in, and the page inside it.
 *
 * **Both segments are glossary words.** The store files a trace made of spans
 * and the API's own paths say so; what a person navigates is *monitoring*, and
 * what they open is a *transcript*. `dashboard` is reserved beside this one and
 * nothing claims it — there is no constant for it here on purpose, because a
 * name in this file is a name something links to.
 */
export const MONITORING_SECTION = "monitoring";
export const TRANSCRIPTS_STEP = "transcripts";

/** The area's own address, which lands on the list below. */
export function monitoringPath(projectId: string): string {
  return projectPath(projectId, MONITORING_SECTION);
}

/** Every production conversation this project recorded. */
export function transcriptsPath(projectId: string): string {
  return projectPath(projectId, MONITORING_SECTION, TRANSCRIPTS_STEP);
}

/** Where a row in the list leads, project and window and all. */
export function transcriptPath(projectId: string, facts: Facts): string {
  const window = windowAround(facts);
  const query = new URLSearchParams({ from: window.from, to: window.to });
  return `${transcriptsPath(projectId)}/${encodeURIComponent(facts.traceId)}?${query.toString()}`;
}


/* ------------------------------------------------------------------ *
 * What to say when the page is quiet.
 * ------------------------------------------------------------------ */

/**
 * Choose one guidance state from available reads. An empty current window
 * uses wider recent history to choose between widening the window and setup.
 * A visible organization key takes precedence over general setup guidance.
 * With traffic present, suggest grading only when the production grader count
 * is known to be zero. null means unanswered, never zero. Despite its name,
 * everRecorded covers only the widest offered window.
 */
export type Quiet =
  | "nothing-in-this-window"
  | "set-up-capture"
  | "key-names-the-organization"
  | "nothing-watches-production";

export function quietState(seen: {
  /** How many production conversations this window holds. */
  readonly listed: number;
  /**
   * Count from the widest offered recent window, or null if the read failed.
   * Read only when the current window is empty; this is not an all-time count.
   */
  readonly everRecorded: number | null;
  /** Visible keys that name no project, or `null` where nothing answered. */
  readonly organizationWideKeys: number | null;
  /** Graders whose scope reaches production, or `null` where nothing answered. */
  readonly watchingProduction: number | null;
}): Quiet | null {
  if (seen.listed === 0) {
    // Nothing answered the wider question, so neither confident sentence is
    // earned. The window line is true either way.
    if (seen.everRecorded === null) return "nothing-in-this-window";
    if (seen.everRecorded > 0) return "nothing-in-this-window";

    return seen.organizationWideKeys !== null && seen.organizationWideKeys > 0
      ? "key-names-the-organization"
      : "set-up-capture";
  }
  return seen.watchingProduction === 0 ? "nothing-watches-production" : null;
}

/** Whether a project grader is configured to grade production traces. */
export function watchesProduction(grader: {
  readonly scope: { readonly production: unknown | null };
}): boolean {
  return grader.scope.production !== null;
}

/**
 * Keys minted against the whole organization, which customer OTLP rejects.
 *
 * **A revoked one is not one of them.** It authenticates nothing, so it can file
 * nothing anywhere — and a page that counted it would explain an empty list with
 * a key somebody already dealt with, which is a wrong answer that looks like a
 * knowledgeable one.
 */
export function namesWholeOrganization(key: {
  readonly projectId: string | null;
  readonly revokedAt: string | null;
}): boolean {
  return key.projectId === null && key.revokedAt === null;
}

/* ------------------------------------------------------------------ *
 * Reading the numbers the contract sends.
 * ------------------------------------------------------------------ */

const NANOSECONDS_IN_MILLISECOND = 1_000_000n;

/**
 * A nanosecond count as milliseconds.
 *
 * The contract sends a decimal string rather than a number on purpose — a
 * nanosecond count passes what JSON holds exactly inside a few months — so it
 * is read as a `bigint` and only narrowed once it is small enough to be a
 * millisecond figure nobody could lose digits from.
 */
export function milliseconds(nanoseconds: string): number {
  if (!/^-?\d+$/.test(nanoseconds)) return 0;
  const whole = BigInt(nanoseconds);
  const millis = whole / NANOSECONDS_IN_MILLISECOND;
  const remainder = whole % NANOSECONDS_IN_MILLISECOND;
  return Number(millis) + Number(remainder) / 1_000_000;
}

/**
 * How long something took, at a precision somebody can read.
 *
 * Each unit is chosen by what it would **print**, not by what it holds. 999.6
 * milliseconds is under a second and rounds to `1000 ms`, which is a unit
 * nobody uses; 59.96 seconds is under a minute and rounds to `60.0 s`, which is
 * a minute spelled wrong. So the comparison is made against the rounded figure,
 * and each of those falls through to the next unit up instead.
 */
export function howLong(nanoseconds: string): string {
  const millis = milliseconds(nanoseconds);
  if (Math.round(millis) < 1000) return `${Math.round(millis)} ms`;

  const seconds = millis / 1000;
  if (Number(seconds.toFixed(1)) < 60) return `${seconds.toFixed(1)} s`;

  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest === 60 ? `${minutes + 1}m 0s` : `${minutes}m ${rest}s`;
}

/**
 * How far into the exchange something happened.
 *
 * Relative to the opening, because on a transcript that is the question — a
 * wall-clock instant to the microsecond is on the raw view, where somebody
 * correlating with another system needs it.
 */
export function howFarIn(startedAt: string, openedAt: string): string {
  const at = Date.parse(startedAt);
  const opened = Date.parse(openedAt);
  if (Number.isNaN(at) || Number.isNaN(opened)) return "";
  const seconds = (at - opened) / 1000;
  return `+${seconds.toFixed(1)} s`;
}

/* ------------------------------------------------------------------ *
 * Reading the shape.
 * ------------------------------------------------------------------ */

/** One step and everything under it, however deep. */
export function everyStep(steps: readonly Step[]): Step[] {
  return steps.flatMap((step) => [step, ...everyStep(step.spans)]);
}

/** Whether anything under here failed, which is what marks a turn. */
export function somethingFailed(step: Step): boolean {
  return everyStep(step.spans).some((each) => each.status === "error");
}

/** How many timed steps a turn opens onto. Sparse coverage is a real answer. */
export function stepsInside(turn: Step): number {
  return everyStep(turn.spans).length;
}

export function isHuman(turn: Step): boolean {
  return turn.kind === "turn:human";
}
