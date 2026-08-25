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
 * What the two v1 read endpoints answer with, and the handful of pure decisions
 * the pages make about it.
 *
 * The types use the contract's own lower-camel field names and storage words.
 * Durations stay as decimal strings because this is the wire; renaming it here
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

/** Trace-level facts, as both endpoints report them. */
export type Facts = GetTraceResponse["trace"];
export type Listed = ListTracesResponse["traces"][number];
export type ListPage = ListTracesResponse;
export type Step = TraceSpan;
export type Judgment = GetTraceResponse["verdicts"][number];
export type Outcome = NonNullable<GetTraceResponse["outcome"]>;

/**
 * One measure this exchange produced, as the read hands it over.
 *
 * **Computed by the platform, never here — the reduction included.** The
 * samples arrive already worked out by egma's one shared measure module, and
 * so do the reductions — `mean`, `p50` and `p90`, each computed once in that
 * module. All of it is the platform's arithmetic, so this application renders
 * figures rather than deriving any.
 *
 * The reduction is the part that matters. Averaging the samples here would look
 * harmless and would be a second implementation of the exact number the page
 * leads with — correct until the day the rounding or the samples change under
 * one of them. A developer who found this page and the platform disagreeing
 * would be right to stop believing both, so the page is not allowed to be
 * capable of it.
 *
 * The unit rides each measure because the measure catalog owns it: a page that
 * assumed milliseconds would be wrong the moment somebody bounds a measure
 * counted in something else.
 */
export type Measured = GetTraceResponse["metrics"][number];

/**
 * Whether Egma worked this figure out from the framework's own timings — the
 * one origin the pages say anything about.
 *
 * **`derived` alone does not answer it.** A figure an agent platform reported
 * arrives derived as well, because Egma did not time it either; `reportedBy`
 * beside it is what tells the two apart. Without that second half a page would
 * tell a developer their platform's number was "worked out from your
 * framework's own timings", which is a claim about an observation Egma never
 * made. A platform-reported figure takes no mark and no caveat; the rest of
 * its provenance stays on the record.
 */
export function workedOutMetric(one: Measured): boolean {
  return one.derived === true && one.reportedBy === undefined;
}

/**
 * One metric as a person reads it, the same words on every surface that shows
 * one: the p90 the platform reduced to, its unit, and — where there was more
 * than one measurement — how many the figure stands over.
 *
 * **The p90 leads because the tail is what a caller feels.** The wire also
 * carries the median and the mean, computed by the same module; which of the
 * three a surface shows is a display decision, and today's is the p90. One
 * measurement is simply the number — every reduction of one sample is that
 * sample, so naming a statistic over it would be dressing.
 *
 * **Nothing is worked out here.** `p90` arrives on the answer, nearest-rank
 * from the shared measure module; this reads it. The series is used for one
 * thing only, which is saying how many measurements there were. A prefix says
 * so instead of the count, because the p90 of the part Egma holds is not the
 * p90 of the call.
 *
 * Written once and imported by the transcript page and the simulation
 * evidence, so the two surfaces that show one conversation's metrics cannot
 * come to word the same figure two ways.
 */
export function metricLine(one: Measured): string {
  const shown = `${String(one.p90)} ${one.unit}`;
  const from = workedOutMetric(one) ? ` · ${MEASURES.derivedOne}` : "";
  if (one.partial === true) {
    return `${shown} · ${MEASURES.partialP90}${from}`;
  }
  return one.samples.length === 1
    ? `${shown}${from}`
    : `${shown} · ${MEASURES.p90} of ${MEASURES.counted(one.samples.length)}${from}`;
}
export type Detail = GetTraceResponse;

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
  for (const cited of one.citedTurns) {
    const [prefix, number] = cited.split(":");
    if (prefix !== "turn") continue;
    const parsed = Number(number);
    if (Number.isInteger(parsed) && parsed > 0) at.push(parsed);
  }
  return at;
}

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
    case "livekit_agents":
      return "LiveKit Agents";
    default:
      return humanizeIdentifier(value);
  }
}

/**
 * What to head a judgment with: the sentence somebody wrote, where the read
 * resolved one, and the key itself where it did not.
 *
 * The fallback is the whole reason this is a function. A key that could not be
 * placed is shown as the key — `Behavior 3` — which says exactly as much as egma
 * actually knows. Putting the live test's third sentence there instead would be
 * a plausible sentence that might be about a different check entirely, and
 * nobody looking at the page could tell.
 */
export function assertionHeading(one: Judgment): string {
  const said = one.assertionText ?? null;
  return said === null || said.trim() === ""
    ? humanizeIdentifier(one.assertion)
    : said;
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

/**
 * Whether this is the widest window the control offers.
 *
 * It is what separates *nothing here* from *nothing in this hour*. A project
 * with a week of traffic read at the last hour is an empty list and a healthy
 * project, and the widest choice is as close to "everything" as this page can
 * ask for — the store caps a read at thirty-one days, so nothing wider exists
 * to offer.
 *
 * Derived from the offered windows rather than written down, so adding a wider
 * one moves this with it.
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

/**
 * What the store calls the two kinds of traffic, and the one this surface asks
 * for.
 *
 * **Monitoring is production and nothing else.** A simulation has a richer page
 * of its own inside the run that produced it — the frozen test, the persona, the
 * graders, the mock tools — so drawing it a second time and poorer, in a mixed
 * list, is a wrong door. The filter is the server's, in the address of the
 * request: narrowing what came back would answer differently depending on what
 * had already been fetched, and would quietly break paging.
 */
/* ------------------------------------------------------------------ *
 * What to say when the page is quiet.
 * ------------------------------------------------------------------ */

/**
 * Which guidance a quiet Monitoring page owes its reader — one of four, and
 * never two at once.
 *
 * Each answers a different question, and showing the wrong one sends somebody
 * the wrong way for an afternoon:
 *
 * - `nothing-in-this-window` — the list is empty because of the **window**, not
 *   because of the project: something *is* recorded further back. A week of
 *   traffic read at the last hour is an empty page and a healthy project, and
 *   greeting it with a setup tutorial tells somebody their working export is
 *   broken. One line and the way out; nothing else, because nothing else is
 *   known to be wrong.
 * - `set-up-capture` — nothing has arrived **anywhere**, at any window this page
 *   can ask about. The reader has an agent and no export, so what they need is
 *   the address, the two variables and a project key. It does not matter which
 *   window is selected: a developer whose first
 *   ever page is empty is the person this teaching exists for, and the default
 *   window is where they land.
 * - `key-names-the-organization` — the same emptiness, with a key that names no
 *   project actually **visible** to this reader. Customer OTLP rejects that
 *   scope because no project would own the evidence. This state points to the
 *   specific key change instead of repeating generic export setup.
 * - `nothing-watches-production` — traffic is arriving and no grader is scoped
 *   to it, so verdicts will stay absent. Every new grader defaults to
 *   simulations, and the seeded expected-behaviors copy is structurally
 *   simulations-only, so this is the ordinary state rather than the odd one.
 *
 * Nothing at all is the fifth answer, and it is the one a healthy project gets:
 * traffic arriving, something judging it.
 *
 * The order is the point. With no traffic, telling somebody that no grader
 * watches production is noise about a problem they do not have yet.
 *
 * **A count nobody answered is `null`, and it is never read as a zero.** A
 * failed grader read folded into "no grader watches production" would put a
 * claim on screen that egma has no answer for — the same collapse
 * `ui/page-state.tsx` forbids between failed and empty — so a supporting read
 * that did not land means one less thing this page says, and never one more.
 *
 * `everRecorded` is that rule at its sharpest, because both of the sentences it
 * decides between are confident ones. Unanswered, the page falls back to the
 * window line: *nothing here, try a wider window* is true whatever the answer
 * would have been, while the teaching would be telling somebody with a working
 * export to go and build one.
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
   * How many this project holds at the widest window there is — the answer to
   * *has anything ever arrived* — or `null` where nothing answered.
   *
   * Only read when the window on screen is empty, which is the only time the
   * question is asked.
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

/**
 * Whether a running grader's verdicts can ever appear beside production
 * traffic.
 *
 * `both` counts, because a copy scoped to both judges production as well as
 * simulations. `simulations` does not, whatever its sampling rate says.
 */
export function watchesProduction(grader: { readonly scope: string }): boolean {
  return grader.scope === "production" || grader.scope === "both";
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
