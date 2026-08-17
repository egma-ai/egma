import { projectPath } from "./project-context.ts";
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
  /**
   * Which 0-or-1 check inside the grader this answers, as its key — never the
   * sentence, which is read from the pinned test version.
   */
  readonly assertion: string;
  /**
   * The words behind that key, resolved by the read from the version this
   * conversation was executed against.
   *
   * `null` where nothing could place the key — a grader whose keys are its own
   * business, a conversation with no test — and absent from an older answer that
   * never resolved one. Both mean the same thing here and the key is shown
   * instead: a bare `behavior_3` is terse, and an invented sentence would be
   * unfalsifiable.
   */
  readonly assertion_text?: string | null;
  /**
   * Whether this judgment can fail anything — `false` for a diagnostic copy,
   * which reports and never decides. Absent on a read that does not carry lanes.
   */
  readonly required?: boolean;
  readonly verdict: string;
  readonly score: number;
  readonly rationale: string;
  /** Turn positions, as `turn:1`. What the judge read, in the judge's terms. */
  readonly cited_turns: readonly string[];
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

/**
 * One measure this exchange produced, as the read hands it over.
 *
 * **Computed by the platform, never here — the reduction included.** The
 * samples arrive already worked out by egma's one shared measure module, and so
 * does `worst`: the single number a grader holds against a bound. Both are the
 * platform's arithmetic, so this page renders figures rather than deriving any.
 *
 * The reduction is the part that matters. Taking the maximum here would look
 * harmless and would be a second implementation of the exact number a verdict
 * rests on — right up to the day a grader reduces by p90 instead, when the page
 * would go on showing the maximum with nothing failing anywhere. A developer who
 * found this page and a verdict disagreeing would be right to stop believing
 * both, so the page is not allowed to be capable of it.
 *
 * The unit rides each measure because the measure catalog owns it: a page that
 * assumed milliseconds would be wrong the moment somebody bounds a measure
 * counted in something else.
 */
export type Measured = {
  readonly measure: string;
  readonly unit: string;
  /**
   * True when Egma did not time the number itself — either it worked the figure
   * out from the framework's own timings, or the agent platform handed it over.
   * `reported_by` beside this is what tells the two apart.
   *
   * Optional because an answer from an older platform does not carry it, which
   * is a page that says nothing about provenance rather than one that breaks.
   */
  readonly derived?: boolean;
  /**
   * The agent platform that measured this figure — `retell` — on the figures a
   * platform reported rather than Egma measured.
   *
   * **Absent on everything else, and that absence is the whole signal.** Egma
   * working a number out from your framework's spans and a platform reporting
   * its own number are different claims, and the page must not word one as the
   * other: `derived` alone cannot tell them apart, so a figure carrying this
   * field is said differently from one that does not.
   */
  readonly reported_by?: string;
  /** One sample, or the series a per-turn measure produced. Never empty. */
  readonly samples: readonly number[];
  /** The span each sample came off, in the same order. */
  readonly span_ids: readonly string[];
  /**
   * The measurement a bound is held against, reduced by the platform. Null
   * only on an answer that carried no measurement at all.
   */
  readonly worst: { readonly value: number; readonly span_id: string } | null;
  /**
   * True when this reading is a prefix of the exchange, so the figure is the
   * worst of what egma holds rather than the worst of the call.
   */
  readonly partial?: boolean;
};

export type Detail = {
  readonly trace: Facts;
  readonly turns: readonly Step[];
  readonly spans: readonly Step[];
  readonly spans_truncated: boolean;
  /**
   * What this exchange measured. Absent on an answer from an older platform,
   * which is a page with no measures rather than a page that breaks.
   */
  readonly measures?: readonly Measured[];
  /**
   * The simulation this exchange is, when egma conducted it, and `null` when a
   * customer's own agent did.
   *
   * The two identifiers are the same 128 bits written two ways, so the read
   * derives one from the other and says so here rather than making this page
   * ask a second question. It is what lets a transcript resolve its own
   * recording: everything else about audio is settled by asking for a link,
   * which is refused where there is nothing to hear.
   */
  readonly simulation_id?: string | null;
  /** Absent on a trace nothing has judged, and on one whose store is down. */
  readonly verdicts?: readonly Judgment[];
  /**
   * The result folded over the **required** graders, or null before grading
   * finishes. What a diagnostic said is never in here — see below.
   */
  readonly outcome: Outcome | null;
  /**
   * The same fold over the graders that only report, or null where none of them
   * judged this exchange.
   *
   * It is carried on the model rather than left to the page to reach for,
   * because the two are one answer: the outcome above was folded *without*
   * these, so a page that showed one and not the other would be showing a
   * headline with a piece of its own arithmetic missing.
   */
  readonly diagnostics?: Outcome | null;
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

/** Turn a machine-written assertion key into a label without hiding its meaning. */
export function humanizeIdentifier(value: string): string {
  const words = value.replaceAll(/[_-]+/g, " ").trim();
  return words === "" ? value : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
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
  const said = one.assertion_text ?? null;
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
  return `${transcriptsPath(projectId)}/${encodeURIComponent(facts.trace_id)}?${query.toString()}`;
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
export const SOURCE_PARAMETER = "source";
export const PRODUCTION = "production";

/** Which project a read is about, as the v1 contract spells it. */
export const PROJECT_PARAMETER = "project_id";

const TRACES_ENDPOINT = "/v1/traces";

/**
 * One page of this project's production conversations.
 *
 * Three things ride in the address and each is load-bearing: the **window**,
 * because the store is filed by time and refuses a read that bounded nothing;
 * the **project**, read from the page's own address rather than assumed from
 * whoever is signed in, so that a copied link opens the project it names; and
 * the **source**, because this surface is production traffic only.
 */
export function productionListPath(asking: {
  readonly window: Window;
  readonly projectId: string;
  readonly cursor?: string | null;
  /**
   * How many rows are wanted at most. Left out for a page of the list, which
   * takes whatever the endpoint's own page size is; sent as `1` by the probe
   * below, which only asks whether anything is there.
   */
  readonly limit?: number;
}): string {
  const asked = new URLSearchParams({
    from: asking.window.from,
    to: asking.window.to,
    [SOURCE_PARAMETER]: PRODUCTION,
    [PROJECT_PARAMETER]: asking.projectId,
  });
  if (asking.cursor != null && asking.cursor !== "") {
    asked.set("cursor", asking.cursor);
  }
  if (asking.limit !== undefined) asked.set("limit", String(asking.limit));
  return `${TRACES_ENDPOINT}?${asked.toString()}`;
}

/**
 * The one question a quiet page cannot answer from the window it is on: **has
 * this project ever recorded anything at all?**
 *
 * One row is the whole answer — *some* or *none* is the branch, and a count is
 * not wanted — so it asks for one and reads whether it came back. It is fired
 * only when the window on screen is empty, and not even then when that window
 * is already the widest, because the list read has just answered the same
 * question.
 */
export function everRecordedPath(projectId: string, now: Date): string {
  return productionListPath({
    window: recentWindow(WIDEST_WINDOW, now),
    projectId,
    limit: 1,
  });
}

/**
 * One conversation, in the window it happened in and the project it belongs to.
 *
 * No source here, and deliberately: the name already picks out one row, and a
 * filter on a lookup could only ever turn a transcript somebody was sent into a
 * page that says it is not there.
 */
export function transcriptReadPath(asking: {
  readonly traceId: string;
  readonly window: Window;
  readonly projectId: string;
}): string {
  const asked = new URLSearchParams({
    from: asking.window.from,
    to: asking.window.to,
    [PROJECT_PARAMETER]: asking.projectId,
  });
  return `${TRACES_ENDPOINT}/${encodeURIComponent(asking.traceId)}?${asked.toString()}`;
}

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
 *   the address, the two variables and a key — and the caution about the key
 *   that fails silently, which rides with the teaching so that every role meets
 *   it. It does not matter which window is selected: a developer whose first
 *   ever page is empty is the person this teaching exists for, and the default
 *   window is where they land.
 * - `key-names-the-organization` — the same emptiness, with a key that names no
 *   project actually **visible** to this reader. That key is the one step of
 *   the setup path that fails in silence: everything is accepted and stored,
 *   and none of it is in any project, so a correct-looking export shows nothing
 *   here. Saying "point an export at Egma" to somebody who already did is the
 *   unhelpful answer, so this replaces the teaching rather than joining it.
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
  return grader.scope === PRODUCTION || grader.scope === "both";
}

/**
 * Keys minted against the whole organization, which file outside every project.
 *
 * **A revoked one is not one of them.** It authenticates nothing, so it can file
 * nothing anywhere — and a page that counted it would explain an empty list with
 * a key somebody already dealt with, which is a wrong answer that looks like a
 * knowledgeable one.
 */
export function namesWholeOrganization(key: {
  readonly project_id: string | null;
  readonly revoked_at: string | null;
}): boolean {
  return key.project_id === null && key.revoked_at === null;
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
