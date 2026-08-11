import { DEFAULT_WINDOW, WINDOWS, type WindowChoice } from "./transcript-copy.ts";

/**
 * What the two v1 read endpoints answer with, and the handful of pure decisions
 * the pages make about it.
 *
 * The types are the contract's own field names — snake case, storage words,
 * durations as decimal strings — because this is the wire and renaming it here
 * would mean two vocabularies to keep in step instead of one. Everything a
 * person reads is decided in `transcript-copy.ts`; nothing below returns a
 * sentence.
 *
 * The window functions are the load-bearing part. **Both endpoints require one
 * and neither defaults**, deliberately: the store is filed by time, so a read
 * that named no window would be a read of everything. That refusal is the
 * server's, and these are the pages' answer to it — a default of the last day
 * for the list, and, for one transcript, the window it was already known to
 * have happened in.
 */

export type TurnCounts = { readonly human: number; readonly agent: number };

/** Trace-level facts, as both endpoints report them. */
export type Facts = {
  readonly trace_id: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly duration_ns: string;
  readonly span_count: number;
  readonly turn_counts: TurnCounts;
  readonly tool_span_count: number;
  readonly errored_span_count: number;
  readonly source: string;
  readonly emitter: string;
  readonly environment: string;
  readonly connection_type: string;
  readonly provider_call_id: string;
  readonly run_id: string;
  readonly agent_id: string;
};

export type Listed = Facts & { readonly preview: string };

export type ListPage = {
  readonly traces: readonly Listed[];
  readonly next_cursor: string | null;
  readonly window: { readonly from: string; readonly to: string };
};

/** One timed step, with whatever happened inside it. */
export type Step = {
  readonly span_id: string;
  readonly parent_span_id: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly started_at: string;
  readonly duration_ns: string;
  readonly text: string;
  readonly audio_url: string;
  readonly tool_name: string;
  readonly tool_arguments: string;
  readonly tool_result: string;
  readonly spans: readonly Step[];
};

/** One judge's answer about this exchange, as the read hands it over. */
export type Judgment = {
  readonly grader_id: string;
  readonly dimension: string;
  readonly verdict: string;
  readonly score: number;
  readonly priority: string;
  readonly rationale: string;
  /** Turn positions, as `turn:1`. What the judge read, in the judge's terms. */
  readonly cited_turns: readonly string[];
  readonly judged_by: string;
  readonly judged_at: string;
};

export type VerdictCounts = {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly errored: number;
  readonly total: number;
};

export type Outcome = {
  readonly verdict: string;
  readonly score: number | null;
  readonly counts: VerdictCounts;
};

export type Detail = {
  readonly trace: Facts;
  readonly turns: readonly Step[];
  readonly spans: readonly Step[];
  readonly spans_truncated: boolean;
  /** Absent on a trace nothing has judged, and on one whose store is down. */
  readonly verdicts?: readonly Judgment[];
  /** The result folded over every judgment, or null before grading finishes. */
  readonly outcome: Outcome | null;
};

/**
 * Which turn a judgment is about, as a position.
 *
 * A judgment cites `turn:9` because the judge was shown a numbered transcript
 * and answered with the number it read. Positions survive spans ageing out of
 * the store, which ids do not — so the citation stays readable long after the
 * span it came on is gone.
 */
export function turnsCited(one: Judgment): readonly number[] {
  const at: number[] = [];
  for (const cited of one.cited_turns) {
    const [prefix, number] = cited.split(":");
    if (prefix !== "turn") continue;
    const parsed = Number(number);
    if (Number.isInteger(parsed) && parsed > 0) at.push(parsed);
  }
  return at;
}

/** Turn a machine-written dimension into a label without hiding its meaning. */
export function humanizeIdentifier(value: string): string {
  const words = value.replaceAll(/[_-]+/g, " ").trim();
  return words === "" ? value : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
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
 * What the list's window is called in the address.
 *
 * The chosen window rides there rather than living only in this page's state,
 * so that a reload, a bookmark and a link somebody was sent all stay on the
 * window they were looking at. It is deliberately the choice — `7d` — and not
 * the two instants it computes to: those are a moment's arithmetic and would
 * freeze the list at whenever the link was made, which is the opposite of what
 * "the last seven days" means.
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

/** The last day, or whichever span of time was chosen instead. */
export function recentWindow(choice: WindowChoice, now: Date): Window {
  const hours = hoursIn(choice);
  return {
    from: new Date(now.getTime() - hours * HOUR).toISOString(),
    to: new Date(now.getTime() + CLOCK_SKEW).toISOString(),
  };
}

/**
 * A second either side of when something happened.
 *
 * This is what lets one transcript be a link. The detail endpoint requires a
 * window too — a name is not a prefix of the store's filing order, so a lookup
 * naming only a name would have nothing to prune with — and the list already
 * knows when the exchange happened, so the row carries the answer into the URL
 * and the page deep-links from then on.
 *
 * Padded rather than exact because the end of a window is **open**: a `to` at
 * the closing instant excludes the very step that ended there. A second is far
 * more than the microsecond that would strictly be needed, and it costs a query
 * bounded by the same minute either way.
 */
const PADDING = 1000;

export function windowAround(facts: {
  readonly started_at: string;
  readonly ended_at: string;
}): Window {
  const opened = Date.parse(facts.started_at);
  const closed = Date.parse(facts.ended_at);
  const from = Number.isNaN(opened) ? Date.now() : opened;
  const to = Number.isNaN(closed) ? from : Math.max(closed, from);

  return {
    from: new Date(from - PADDING).toISOString(),
    to: new Date(to + PADDING).toISOString(),
  };
}

/** Where a row in the list leads, window and all. */
export function transcriptPath(facts: Facts): string {
  const window = windowAround(facts);
  const query = new URLSearchParams({ from: window.from, to: window.to });
  return `/traces/${encodeURIComponent(facts.trace_id)}?${query.toString()}`;
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

/**
 * An instant, in UTC and said so.
 *
 * Deliberately not the reader's own timezone. Traces are correlated against
 * logs, against a provider's dashboard and against somebody else's screen
 * share, and every one of those speaks UTC; a page that silently shifted the
 * numbers would make the two disagree with nothing on screen to say why.
 */
export function whenItWas(instant: string): string {
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return instant;
  return `${new Date(at).toISOString().slice(0, 19).replace("T", " ")} UTC`;
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
