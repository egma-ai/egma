"use client";

import { Fragment, use, useEffect, useState, type CSSProperties } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { readJson } from "../../../../../../lib/api.ts";
import { GRADING } from "../../../../../../lib/grading-copy.ts";
import { asSecond } from "../../../../../../lib/instants.ts";
import {
  DETAIL,
  FACTS,
  LIST,
  MEASURES,
  RECORDING,
  UNKNOWN_STEP_LABEL,
  stepLabel,
} from "../../../../../../lib/transcript-copy.ts";
import {
  everyStep,
  howFarIn,
  howLong,
  humanizeIdentifier,
  isHuman,
  milliseconds,
  somethingFailed,
  stepsInside,
  transcriptReadPath,
  transcriptsPath,
  turnsCited,
  type Detail,
  type Facts as TraceFacts,
  type Measured,
  type Outcome,
  type Step,
} from "../../../../../../lib/transcripts.ts";
/*
 * Two things this page used to keep its own copy of, taken from where the rest
 * of the product already keeps them.
 *
 * `SPEAKERS` labelled a transcript's two sides here and in `ui/evidence.tsx`,
 * with the same two words written out twice. `shownScore` turned a score into
 * a figure here and in `ui/run-status.tsx`, with the same rounding and the
 * same dash for a proportion of nothing. Two copies of a rule about how a
 * verdict reads is two chances for a simulation's page and a production
 * transcript's page to start saying it differently.
 */
import { SPEAKERS } from "../../../../../../ui/evidence.tsx";
import { shownScore } from "../../../../../../ui/run-status.tsx";
import { JudgmentCard } from "../../../../../judgment-card.tsx";
import { RecordingPlayer } from "../../../../../recording-player.tsx";
import { PageNavigation } from "../../../../../../ui/page-navigation.tsx";
import { Loading } from "../../../../../../ui/page-state.tsx";
import {
  RelativeInstant,
  useMinuteClock,
} from "../../../../../../ui/relative-time.tsx";
import {
  AppShell,
  LinkLine,
  Notice,
  PageHeader,
  ProductPage,
  ProductStatePage,
  StatePage,
} from "../../../../../ui.tsx";

/* ------------------------------------------------------------------------ *
 * The page's own layout, which is the only thing it styles for itself.
 *
 * These were 54 class names in `app/ui.module.css`, the last CSS Module in the
 * application. Everything a shared component owns is now composed rather than
 * dressed — the header, the chips, the arrows, the notice — and what is left
 * here is the arrangement of one wide evidence page: strips of facts, a
 * transcript beside an inspector, and three readings of the same steps.
 *
 * They are constants rather than repeated class lists because each one is
 * applied in three or more places and a strip that agreed with its neighbour in
 * four rules out of five would look right.
 * ------------------------------------------------------------------------ */

/** The word above one fact: the compact uppercase caption, in the mono face. */
const FACT_LABEL =
  "font-mono text-sm tracking-(--tracking-label) text-muted-foreground uppercase";

/** The figure under it, which is a value rather than a heading. */
const FACT_VALUE = "text-sm font-normal [overflow-wrap:anywhere]";

/**
 * One fact inside a strip: a label over a figure, with the hairline that
 * separates it from the fact beside it.
 */
const FACT = "flex min-w-0 flex-col gap-1 border-e border-border p-4 last:border-e-0";

/**
 * The five facts above the exchange, and the measures beside them.
 *
 * Below 620px it is two columns, and the hairlines turn from a row of uprights
 * into a grid: every fact grows a top edge, the two on the first row give
 * theirs back, and the second of each pair drops the upright it no longer has a
 * neighbour for. An odd count leaves one fact alone on the last row, and it
 * takes the whole row rather than half of it.
 *
 * Every width is written out rather than composed, because Tailwind finds class
 * names by reading this file as text: a class built from a template literal is
 * a class that is never generated.
 */
const SUMMARY_STRIP = cn(
  "mt-6 grid grid-cols-5 overflow-clip rounded-card border border-border bg-surface",
  "max-[620px]:grid-cols-2",
);

const SUMMARY_FACT = cn(
  FACT,
  "max-[620px]:border-t",
  "max-[620px]:nth-[2n]:border-e-0",
  "max-[620px]:nth-[-n+2]:border-t-0",
  "max-[620px]:last:col-span-full max-[620px]:last:border-e-0",
);

/**
 * What egma made of the exchange, on the quieter surface a result sits on.
 *
 * It stacks earlier than the strip above it — 900px rather than 620px — because
 * a tally reads as a sentence and needs the width a duration does not.
 */
const OUTCOME_STRIP = cn(
  "mt-6 grid grid-cols-3 overflow-clip rounded-card border border-border bg-surface-soft",
  "max-[900px]:grid-cols-2",
);

const OUTCOME_FACT = cn(
  FACT,
  /*
   * The diagnostic lane is a fourth fact in three columns, so it wraps onto a
   * row of its own — and a wrapped row with no rule above it reads as part of
   * the fact it sits under, which for a lane that must never colour the verdict
   * beside it is exactly the wrong reading.
   */
  "nth-[n+4]:border-t",
  "max-[900px]:border-t",
  "max-[900px]:nth-[2n]:border-e-0",
  "max-[900px]:nth-[-n+2]:border-t-0",
);

/**
 * The colour a verdict paints the figure it is the verdict of.
 *
 * Read off `data-verdict` on the fact above it, so the attribute is what does
 * the painting rather than a label nothing reads. A verdict word nobody has a
 * colour for leaves the figure in the ordinary text colour, which is the safe
 * direction: a new word is legible before anyone has decided what it means.
 */
const VERDICT_COLOUR = cn(
  "[[data-verdict=passed]_&]:text-success",
  "[[data-verdict=failed]_&]:text-failure",
  "[[data-verdict=errored]_&]:text-failure",
);

/** A disclosure's own marker is replaced by one this page draws. */
const DISCLOSURE = "cursor-pointer list-none [&::-webkit-details-marker]:hidden";

/** Steps under a turn, or under a step: a column with one gap between them. */
const STEP_STACK = "flex min-w-0 flex-col gap-2";

/** The bordered surface a list of turns, steps or timings is read on. */
const LIST_SURFACE =
  "min-w-0 overflow-clip rounded-card border border-border bg-surface";

/**
 * A row that is one press: a whole-width button that reads as a line.
 *
 * The transition names the one property that moves. Tailwind's `transition-colors`
 * includes `outline-color`, which fades the focus ring in over 140ms on every
 * Tab step — motion on keyboard navigation, which `DESIGN.md` forbids outright.
 */
const ROW = cn(
  "flex w-full min-w-0 cursor-pointer items-center border-0 border-t border-border",
  "min-h-14 bg-transparent py-2 pe-3 text-left text-foreground",
  "transition-[background-color] duration-(--duration-hover) ease-out",
  "pointer-hover:bg-surface-soft",
  "motion-reduce:transition-none",
);

/**
 * The mark on a selected row, turn or step.
 *
 * Ember Wash behind it and a narrow Ember edge along its leading side, which is
 * what `DESIGN.md` asks for: "Selected or active rows use Ember Wash plus a
 * non-color state mark." The edge is an inset shadow rather than a border so
 * that lighting a row does not move the words in it sideways by three pixels.
 */
const SELECTED = "bg-selected shadow-[inset_3px_0_var(--accent)]";

/** A name that has to end somewhere: one line, cut with an ellipsis. */
const ONE_LINE = "overflow-hidden text-sm text-ellipsis whitespace-nowrap text-muted-foreground";

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "no-window" }
  | { status: "missing" }
  | { status: "failed"; why: string }
  | { status: "read"; detail: Detail };

type View = "transcript" | "timeline" | "execution";
type PositionedStep = { readonly step: Step; readonly depth: number };

const VIEWS: readonly { readonly id: View; readonly label: string }[] = [
  { id: "transcript", label: DETAIL.views.transcript },
  { id: "timeline", label: DETAIL.views.timeline },
  { id: "execution", label: DETAIL.views.execution },
];

/**
 * One production exchange, read as a **transcript**.
 *
 * Re-homed under the project with the rest of the monitoring section, and
 * unchanged in everything it draws: the turns with their timings, the steps
 * inside each one, the measures above and the verdicts below.
 *
 * **Two things have to be in the address for this page to open at all**, and
 * both are now there. The window, because a name is not a prefix of the store's
 * filing order and the read endpoint refuses a lookup that bounded nothing —
 * the row in the list carries the answer, so nobody types it. And the project,
 * because a transcript belongs to one: the address names it, the request sends
 * it, and a link somebody was sent opens the same page for them.
 */
export default function TranscriptPage({
  params,
}: {
  params: Promise<{ projectId: string; transcriptId: string }>;
}) {
  const { projectId, transcriptId } = use(params);
  const now = useMinuteClock();
  const [state, setState] = useState<State>({ status: "loading" });
  const [view, setView] = useState<View>("transcript");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const asked = new URLSearchParams(globalThis.location.search);
    const from = asked.get("from");
    const to = asked.get("to");
    if (from === null || to === null) {
      setState({ status: "no-window" });
      return undefined;
    }

    void readJson<Detail>(
      transcriptReadPath({
        traceId: transcriptId,
        window: { from, to },
        projectId,
      }),
    )
      .then((answer) => {
        if (!current) return;
        if (answer.status === "signed-out") {
          setState({ status: "signed-out" });
          return;
        }
        if (answer.status === "missing") {
          setState({ status: "missing" });
          return;
        }
        if (answer.status === "failed") {
          setState({ status: "failed", why: answer.refusal.message });
          return;
        }
        setState({ status: "read", detail: answer.value });
      })
      .catch(() => {
        if (current) setState({ status: "failed", why: DETAIL.unreachable });
      });

    return () => {
      current = false;
    };
  }, [projectId, transcriptId]);

  if (state.status === "loading") {
    // The same frame the route boundary draws, so the wait for the API reads
    // as one continued state rather than a second, static loading language.
    return (
      <ProductStatePage
        title={DETAIL.title}
        breadcrumbs={[
          { label: LIST.title, href: transcriptsPath(projectId) },
          { label: DETAIL.title },
        ]}
      >
        <Loading what="this transcript" />
      </ProductStatePage>
    );
  }

  if (state.status === "signed-out") {
    return (
      <StatePage title={LIST.signedOut} lead={LIST.signedOutLead}>
        <LinkLine>
          <a href="/sign-in">{LIST.signIn}</a> ·{" "}
          <a href="/signup">{LIST.setUp}</a>
        </LinkLine>
      </StatePage>
    );
  }

  if (state.status === "no-window") {
    return (
      <ProductStatePage
        title={DETAIL.needsWindow}
        lead={DETAIL.needsWindowLead}
        breadcrumbs={[
          { label: LIST.title, href: transcriptsPath(projectId) },
          { label: DETAIL.title },
        ]}
      />
    );
  }

  if (state.status === "missing") {
    return (
      <ProductStatePage
        title={DETAIL.missing}
        lead={DETAIL.missingLead}
        breadcrumbs={[
          { label: LIST.title, href: transcriptsPath(projectId) },
          { label: DETAIL.title },
        ]}
      />
    );
  }

  if (state.status === "failed") {
    return (
      <ProductStatePage
        title={DETAIL.title}
        breadcrumbs={[
          { label: LIST.title, href: transcriptsPath(projectId) },
          { label: DETAIL.title },
        ]}
      >
        <Notice tone="error">{state.why}</Notice>
      </ProductStatePage>
    );
  }

  const { detail } = state;
  const openedAt = detail.trace.started_at;
  const positioned = positionedSteps(detail);
  const selected = positioned.find(({ step }) => step.span_id === selectedId)?.step
    ?? detail.turns[0]
    ?? detail.spans[0]
    ?? null;
  const failures = positioned
    .map(({ step }) => step)
    .filter((step) => step.status === "error");

  function select(step: Step): void {
    setSelectedId(step.span_id);
  }

  function moveBetweenFailures(direction: -1 | 1): void {
    if (failures.length === 0) return;
    const selectedFailure = failures.findIndex((step) => step.span_id === selected?.span_id);
    const from = selectedFailure < 0 ? (direction > 0 ? -1 : 0) : selectedFailure;
    const next = (from + direction + failures.length) % failures.length;
    setSelectedId(failures[next]?.span_id ?? null);
    setView("execution");
  }

  const errored = detail.trace.errored_span_count;

  return (
    <AppShell>
      <ProductPage wide>
        <PageNavigation
          items={[
            { label: LIST.title, href: transcriptsPath(projectId) },
            { label: DETAIL.title },
          ]}
        />
        {/*
          The product's own page header, rather than one this page drew for
          itself. It used to carry a heading that grew to 56px — type
          `DESIGN.md` reserves for auth, onboarding and public pages — so the
          settled transcript did not even match its own loading state, which
          has always been drawn by the shared header underneath
          `ProductStatePage`.
        */}
        <PageHeader
          eyebrow={`${detail.trace.source} / ${detail.trace.environment}`}
          title={DETAIL.title}
          lead={
            <>
              <RelativeInstant instant={openedAt} now={now} precision="second" />
              {" · "}
              {howLong(detail.trace.duration_ns)}
            </>
          }
          action={
            <Badge variant={errored > 0 ? "failure" : "success"}>
              {/*
                The dot the hand-drawn chip carried as `::before`, kept. It is
                `bg-current` and the same circle either way, so it separates
                nothing on its own — `Recorded` and `1 error` are what say which
                state this is. It is the chip's mark, not its meaning.
              */}
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-chip bg-current"
              />
              {errored === 0 ? DETAIL.recorded : DETAIL.errors(errored)}
            </Badge>
          }
        />

        <Summary facts={detail.trace} />
        <Measures measured={detail.measures ?? []} />
        {detail.outcome ? (
          <OutcomeSummary
            outcome={detail.outcome}
            diagnostics={detail.diagnostics ?? null}
          />
        ) : null}

        {/*
          The audio of this exchange, where egma is the one who had it.

          **Beside the turns, because this is where the doubt is.** Somebody
          reading a transcript who cannot tell a misbehaving agent from a bad
          transcription is already looking at the turn; sending them to the run
          to hear it would put the evidence a page away from the doubt.

          Above the views rather than inside the transcript one, so that
          switching to the timeline never leaves audio playing behind a panel
          with no controls on it — a hidden `<audio>` keeps going, and a person
          hunting for the sound would have no way to stop it.

          `simulation_id` is present only for an exchange egma conducted, which
          is the one question this page can answer for itself; whether that
          conversation recorded anything is the recording route's answer, and a
          refusal there shows nothing at all rather than a control that does
          nothing.
        */}
        {typeof detail.simulation_id === "string" ? (
          <RecordingPlayer
            simulationId={detail.simulation_id}
            words={RECORDING}
            knownToExist={false}
          />
        ) : null}

        {/*
          The views, and the way through the problems.

          On a phone the two do not fit on one line — three tab labels and a
          pair of 44px targets is wider than the screen, and the toolbar was
          pushing the whole document sideways whenever an exchange had
          something wrong in it. So the strip becomes a reversed column: the
          tabs keep the rule they sit on, and the navigator takes the line
          above them rather than being squeezed into the same one.
        */}
        <div
          className={cn(
            "mt-8 flex items-center justify-between gap-5 border-b border-border",
            "max-[620px]:flex-col-reverse max-[620px]:items-stretch max-[620px]:gap-3",
          )}
        >
          <div
            className="flex gap-6 max-[620px]:gap-5"
            role="tablist"
            aria-label={DETAIL.viewLabel}
          >
            {VIEWS.map((item) => (
              <button
                key={item.id}
                className={cn(
                  /*
                   * The rule under the current tab sits *on* the toolbar's own
                   * hairline rather than above it, which is what the negative
                   * margin buys. Two lines a pixel apart read as a mistake.
                   */
                  "-mb-px min-h-(--tap-target) cursor-pointer px-1",
                  "border-0 border-b-2 border-b-transparent bg-transparent",
                  "text-sm text-muted-foreground",
                  /*
                   * One duration for the colour and the press, and it is the
                   * shorter of the two: "Choose the shorter token when two
                   * would both explain the change."
                   */
                  "transition-[color,border-color,transform] duration-(--duration-press) ease-out",
                  "pointer-hover:text-foreground",
                  "[&:active:not(:focus-visible)]:scale-97",
                  /* The movement goes; the colour feedback stays. */
                  "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
                  view === item.id && "border-b-brand text-foreground",
                )}
                type="button"
                role="tab"
                aria-selected={view === item.id}
                onClick={() => setView(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {failures.length === 0 ? null : (
            <div className="flex items-center gap-2 text-sm text-foreground max-[620px]:self-end">
              <span>{DETAIL.problems(failures.length)}</span>
              {/*
                The product's button, held at the quieter edge this strip wants.
                It brings the 44px target, the focus ring and the press
                feedback with it, which is three decisions this page no longer
                keeps its own copy of.
              */}
              <Button
                className="border-border pointer-hover:border-border-strong"
                variant="secondary"
                size="icon"
                type="button"
                aria-label={DETAIL.previousProblem}
                onClick={() => moveBetweenFailures(-1)}
              >
                ←
              </Button>
              <Button
                className="border-border pointer-hover:border-border-strong"
                variant="secondary"
                size="icon"
                type="button"
                aria-label={DETAIL.nextProblem}
                onClick={() => moveBetweenFailures(1)}
              >
                →
              </Button>
            </div>
          )}
        </div>

        {detail.spans_truncated ? (
          <div className="mt-5">
            <Notice tone="error">{DETAIL.truncated}</Notice>
          </div>
        ) : null}

        <div
          className={cn(
            "mt-8 grid min-w-0 items-start gap-8",
            "grid-cols-[minmax(0,1fr)_360px]",
            "max-[1100px]:grid-cols-[minmax(0,1fr)]",
          )}
        >
          <section className="min-w-0">
            <div role="tabpanel" hidden={view !== "transcript"}>
              <TranscriptView detail={detail} selectedId={selected?.span_id ?? null} onSelect={select} />
            </div>
            <div role="tabpanel" hidden={view !== "timeline"}>
              <TimelineView detail={detail} steps={positioned} selectedId={selected?.span_id ?? null} onSelect={select} />
            </div>
            <div role="tabpanel" hidden={view !== "execution"}>
              <ExecutionView detail={detail} selectedId={selected?.span_id ?? null} onSelect={select} />
            </div>
          </section>
          <Inspector selected={selected} facts={detail.trace} openedAt={openedAt} />
        </div>
      </ProductPage>
    </AppShell>
  );
}

/** One label over one figure, wherever a strip of facts is drawn. */
function Fact({
  label,
  value,
  className,
  valueClassName,
  ...rest
}: {
  readonly label: string;
  readonly value: string;
  readonly className: string;
  readonly valueClassName?: string;
  readonly "data-verdict"?: string;
  readonly title?: string;
}) {
  return (
    <div className={className} {...rest}>
      <span className={FACT_LABEL}>{label}</span>
      <strong className={cn(FACT_VALUE, valueClassName)}>{value}</strong>
    </div>
  );
}

function Summary({ facts }: { facts: TraceFacts }) {
  const primary: readonly (readonly [string, string, boolean])[] = [
    [FACTS.duration, howLong(facts.duration_ns), false],
    [FACTS.turns, `${facts.turn_counts.human} ${LIST.human} · ${facts.turn_counts.agent} ${LIST.agent}`, false],
    [FACTS.steps, String(facts.span_count), false],
    [FACTS.tools, String(facts.tool_span_count), false],
    [FACTS.errors, String(facts.errored_span_count), facts.errored_span_count > 0],
  ];

  return (
    <section className={SUMMARY_STRIP} aria-label={DETAIL.summary}>
      {primary.map(([label, value, wrong]) => (
        <Fact
          className={SUMMARY_FACT}
          key={label}
          label={label}
          value={value}
          valueClassName={wrong ? "text-failure" : undefined}
        />
      ))}
    </section>
  );
}

/**
 * What this exchange measured — the metrics display.
 *
 * **Above the verdicts and apart from them, because a measure measures and a
 * grader judges.** Nothing here is green or red: a duration is not good or bad
 * until somebody has written down a bound, and the section below is where that
 * decision shows up. Putting them in one block would make every number look like
 * a check that passed.
 *
 * **Every number here came off the platform's one shared measure module**, which
 * is the same module a `latency` grader is judged through — and that includes
 * the **reduction**, the single measurement a bound is held against. This page
 * renders what it was handed and derives nothing. Taking the maximum here would
 * look harmless and would be a second implementation of exactly the number a
 * verdict rests on: correct while both happen to take the maximum, silently
 * wrong the first day a grader reduces by p90 instead. A developer who found the
 * page and the verdict disagreeing would be right to stop believing both.
 *
 * A measure the spans do not carry is absent rather than shown empty, and an
 * exchange with none says so in a sentence — "nothing was measured" is a fact
 * about the telemetry that arrived, and a blank strip would read as a page that
 * failed to load.
 */
function Measures({ measured }: { measured: readonly Measured[] }) {
  return (
    <section className={SUMMARY_STRIP} aria-label={MEASURES.label}>
      {measured.length === 0 ? (
        <Fact
          className={SUMMARY_FACT}
          label={MEASURES.label}
          value={MEASURES.none}
          valueClassName="text-muted-foreground"
        />
      ) : (
        measured.map((one) => (
          <Fact
            className={SUMMARY_FACT}
            key={one.measure}
            label={humanizeIdentifier(one.measure)}
            value={measurement(one)}
          />
        ))
      )}
      {measured.some(workedOut) ? (
        <div className={SUMMARY_FACT}>
          <span className={FACT_LABEL} />
          <strong className={cn(FACT_VALUE, "text-muted-foreground")}>
            {MEASURES.derived}
          </strong>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Whether Egma worked this figure out from the framework's own timings — the
 * one origin the page still says anything about.
 *
 * **`derived` alone does not answer it.** A figure an agent platform reported
 * arrives derived as well, because Egma did not time it either; `reported_by`
 * beside it is what tells the two apart. Without that second half the page would
 * tell a developer their platform's number was "worked out from your framework's
 * own timings", which is a claim about an observation Egma never made. So the
 * platform's field is read here as a gate and nothing else: a figure carrying it
 * is neither marked nor caveated, and reads exactly as a figure Egma timed.
 *
 * The rest of the provenance is on the record rather than on the page, by a
 * product decision this predicate is the whole of on this screen. Any figure's
 * origin is still there to be asked for the day a surface asks.
 */
function workedOut(one: Measured): boolean {
  return one.derived === true && one.reported_by === undefined;
}

/**
 * One measure as a person reads it: the number the platform reduced to, its
 * unit, and — where there was more than one measurement — that this is the worst
 * of them and how many there were.
 *
 * **Nothing is worked out here.** `worst` arrives on the answer, reduced by the
 * same code a verdict was decided by; this reads it. The series is used for one
 * thing only, which is saying how many measurements there were.
 *
 * **A prefix says so.** A reading over the store's limit holds the first part of
 * a long exchange, and the worst measurement in it is the worst of that part —
 * the worst turn of the call may be past the cut. Showing it unqualified would
 * be the page asserting something about a conversation it has only some of.
 */
function measurement(one: Measured): string {
  // Unreachable: a measure with no measurement is absent from the answer
  // rather than present and empty. Said rather than assumed, because the
  // alternative is this page printing a figure nobody measured.
  if (one.worst === null) return DETAIL.notReported;

  const shown = `${String(one.worst.value)} ${one.unit}`;
  // Said on the figure itself as well as once for the panel, because a page
  // mixing timed and worked-out numbers must let a reader tell which is which
  // without counting rows.
  //
  // **One predicate decides it, the same one the panel's caveat uses**, so the
  // mark and the sentence can never come to disagree about a figure — and a
  // figure a platform reported takes neither, rather than taking the worked-out
  // wording about an observation Egma never made.
  const from = workedOut(one) ? ` · ${MEASURES.derivedOne}` : "";
  if (one.partial === true) return `${shown} · ${MEASURES.partialWorst}${from}`;
  return one.samples.length === 1
    ? `${shown}${from}`
    : `${shown} · ${MEASURES.worst} of ${MEASURES.counted(one.samples.length)}${from}`;
}

/** What was judged, in the words a tally is read in. Written once, so the two
 * lanes below cannot come to count the same rows two ways. */
function tallyOf(counts: Outcome["counts"]): string {
  const said = [`${counts.passed}/${counts.total} passed`];
  if (counts.failed > 0) said.push(`${counts.failed} failed`);
  if (counts.skipped > 0) said.push(`${counts.skipped} skipped`);
  if (counts.errored > 0) said.push(`${counts.errored} errored`);
  return said.join(" · ");
}

/**
 * What egma made of this exchange: the verdict, the number, and what was
 * counted — over the graders that can fail something.
 *
 * **The diagnostics sit beside it and never in it**, which is the same
 * arrangement a run's results make and for the same reason. A grader carrying
 * `required: false` is judged exactly as a blocking one is and reports the same
 * fraction, and it can never change the word to its left. Folded in, it would
 * move a verdict it is not allowed to move; left out altogether, it would be a
 * grader somebody switched on that judges in silence — and the failures on the
 * cards further down the page would have nothing up here to belong to.
 *
 * One figure rather than the run page's grid, because this page is one exchange:
 * three cards of one row each would be furniture around a single number.
 */
function OutcomeSummary({
  outcome,
  diagnostics,
}: {
  outcome: Outcome;
  diagnostics: Outcome | null;
}) {
  return (
    <section className={OUTCOME_STRIP} aria-label="Grading outcome">
      <Fact
        className={OUTCOME_FACT}
        data-verdict={outcome.verdict}
        label="Verdict"
        value={outcome.verdict}
        valueClassName={VERDICT_COLOUR}
      />
      <Fact className={OUTCOME_FACT} label="Score" value={shownScore(outcome.score)} />
      <Fact className={OUTCOME_FACT} label="Checks" value={tallyOf(outcome.counts)} />
      {/*
        **The fraction is the point of this lane, so it is on the line.** A
        diagnostic is switched on to be read rather than to decide, and passed ÷
        counted is the number that reading produces — the counts beside it are a
        different true statement, because a skipped assertion leaves the
        denominator and stays in the count.

        Deliberately uncoloured, whatever it says. `data-verdict` is what paints
        a fact red, and a red diagnostic here would read as a reason the verdict
        to its left is red — which is the one thing it can never be.
      */}
      {diagnostics === null ? null : (
        <Fact
          className={OUTCOME_FACT}
          title={GRADING.diagnosticAside}
          label={GRADING.diagnosticLane}
          value={
            `${diagnostics.verdict} · ${GRADING.diagnosticScore} ` +
            `${shownScore(diagnostics.score)} · ${tallyOf(diagnostics.counts)}`
          }
        />
      )}
    </section>
  );
}

/** The name of a view, and the sentence saying what it is a reading of. */
function ViewHeading({
  title,
  lead,
}: {
  readonly title: string;
  readonly lead: string;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex items-baseline justify-between gap-6",
        "max-[620px]:flex-col max-[620px]:items-start max-[620px]:gap-2",
      )}
    >
      <h2 className="m-0 flex-none text-lg font-normal">{title}</h2>
      <p
        className={cn(
          "m-0 max-w-[470px] text-right text-sm text-muted-foreground",
          "max-[620px]:text-left",
        )}
      >
        {lead}
      </p>
    </div>
  );
}

function TranscriptView({
  detail,
  selectedId,
  onSelect,
}: {
  detail: Detail;
  selectedId: string | null;
  onSelect: (step: Step) => void;
}) {
  const openedAt = detail.trace.started_at;

  return (
    <div>
      {/*
        The heading is above the card rather than inside it, which is where the
        timeline's and the execution view's have always been. Inside, with the
        card's own zero padding, the words sat hard against the border on both
        sides — and so did the disclosure at the foot of it.
      */}
      <ViewHeading title={DETAIL.transcript} lead={DETAIL.transcriptLead} />
      {detail.turns.length === 0 ? (
        <Notice>{DETAIL.noTurns}</Notice>
      ) : (
        <div className={LIST_SURFACE}>
          {detail.turns.map((turn, position) => (
            <Fragment key={turn.span_id}>
              <Turn
                turn={turn}
                openedAt={openedAt}
                selectedId={selectedId}
                onSelect={onSelect}
              />
              {(detail.verdicts ?? [])
                .filter((judgment) => turnsCited(judgment).includes(position + 1))
                .map((judgment) => (
                  <JudgmentCard
                    key={`${judgment.grader_id}:${judgment.assertion}:${judgment.judged_at}`}
                    judgment={judgment}
                  />
                ))}
            </Fragment>
          ))}
        </div>
      )}
      {detail.spans.length === 0 ? null : (
        <details className="mt-6 border-t border-border py-4">
          <summary
            className={cn(
              "cursor-pointer font-normal",
              "pointer-coarse:min-h-(--tap-target) pointer-coarse:py-3",
            )}
          >
            {DETAIL.otherSteps}
          </summary>
          <p className="mt-2 mb-4 text-sm text-muted-foreground">{DETAIL.otherStepsLead}</p>
          <div className={STEP_STACK}>
            {detail.spans.map((step) => (
              <Timed key={step.span_id} step={step} openedAt={openedAt} selectedId={selectedId} onSelect={onSelect} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Turn({
  turn,
  openedAt,
  selectedId,
  onSelect,
}: {
  turn: Step;
  openedAt: string;
  selectedId: string | null;
  onSelect: (step: Step) => void;
}) {
  const inside = stepsInside(turn);
  const failed = turn.status === "error" || somethingFailed(turn);
  const human = isHuman(turn);
  const selected = turn.span_id === selectedId;

  return (
    <details
      className={cn(
        "group m-0 overflow-clip border-0 border-t border-border bg-surface first:border-t-0",
        selected && SELECTED,
      )}
      data-turn="true"
      onToggle={(event) => {
        if (event.currentTarget.open) onSelect(turn);
      }}
    >
      <summary
        className={cn(
          DISCLOSURE,
          "grid items-stretch gap-4 p-4",
          "grid-cols-[80px_minmax(0,1fr)_32px]",
          "active:bg-surface-soft",
          "max-[620px]:grid-cols-[52px_minmax(0,1fr)_28px] max-[620px]:gap-3 max-[620px]:p-3",
        )}
      >
        {/*
          The rail: when this turn began, and the line down to the next one, so
          a conversation reads as a column of moments rather than a stack of
          cards. The dot is drawn rather than typed, because a character would
          arrive at whatever size and colour the face decided.
        */}
        <span className="relative flex min-w-0 flex-col gap-2 font-mono text-sm text-muted-foreground">
          <span className="[overflow-wrap:anywhere]">
            {howFarIn(turn.started_at, openedAt)}
          </span>
          <span
            aria-hidden="true"
            className={cn(
              "relative ms-[3px] w-px min-h-5 flex-1 bg-border",
              "before:absolute before:top-0 before:-left-[3px] before:size-[7px]",
              "before:rounded-chip before:bg-foreground before:content-['']",
            )}
          />
        </span>
        <span className="min-w-0">
          <span
            className={cn(
              "flex items-center justify-between gap-4",
              "max-[620px]:flex-col max-[620px]:items-start max-[620px]:gap-1",
            )}
          >
            <strong className="text-sm font-normal tracking-(--tracking-label)">
              {human ? SPEAKERS.human : SPEAKERS.agent}
            </strong>
            <small className="font-mono text-sm text-muted-foreground">
              {howLong(turn.duration_ns)} · {DETAIL.steps(inside)}
            </small>
          </span>
          <span className="mt-2 block max-w-[720px] text-base leading-(--line-body) [overflow-wrap:anywhere]">
            {turn.text === "" ? <span className="text-muted-foreground">{DETAIL.nothingSaid}</span> : turn.text}
          </span>
          {failed ? (
            <small className="mt-2 block text-sm text-failure">{DETAIL.failedInside}</small>
          ) : null}
        </span>
        {/*
          The plus that becomes a cross. `transform` and nothing else, at a
          motion token, and immediate for a keyboard: "no motion delays input",
          and somebody who pressed Enter has already moved on.
        */}
        <span
          aria-hidden="true"
          className={cn(
            "grid size-(--control-sm) place-items-center",
            "rounded-chip border border-border bg-surface",
            "transition-transform duration-(--duration-hover) ease-in-out",
            "group-open:rotate-45",
            "[summary:focus-visible_&]:transition-none",
            "motion-reduce:transition-none",
          )}
        >
          +
        </span>
      </summary>
      {/*
        The body lines up under what was said rather than under the rail, so a
        turn's steps sit in the same column as its words. The number is the
        summary's own arithmetic — padding, plus the rail, plus the gap — at
        each of the two widths.
      */}
      <div
        className={cn(
          "pt-0 pe-4 pb-4 ps-28 text-muted-foreground",
          "max-[620px]:pe-3 max-[620px]:pb-3 max-[620px]:ps-19",
        )}
      >
        {turn.spans.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">{DETAIL.noSteps}</p>
        ) : (
          <div className={STEP_STACK}>
            {turn.spans.map((step) => (
              <Timed key={step.span_id} step={step} openedAt={openedAt} selectedId={selectedId} onSelect={onSelect} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function Timed({
  step,
  openedAt,
  selectedId,
  onSelect,
}: {
  step: Step;
  openedAt: string;
  selectedId: string | null;
  onSelect: (step: Step) => void;
}) {
  const failed = step.status === "error";
  const marked = failed || everyStep(step.spans).some((one) => one.status === "error");

  return (
    <details
      className={cn(
        "min-w-0 overflow-clip rounded-input border border-border bg-surface",
        marked && "border-failure-border",
        selectedId === step.span_id && SELECTED,
      )}
      onToggle={(event) => {
        if (event.currentTarget.open) onSelect(step);
      }}
    >
      <summary
        className={cn(
          DISCLOSURE,
          "grid min-w-0 items-center gap-4 p-3",
          "grid-cols-[minmax(0,1fr)_auto]",
          "active:bg-surface-soft",
          "pointer-coarse:min-h-(--tap-target)",
          "max-[620px]:grid-cols-[minmax(0,1fr)] max-[620px]:items-start max-[620px]:gap-2",
        )}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <strong className="flex-none font-mono text-sm font-medium text-foreground">
            {presentedStepLabel(step)}
          </strong>
          <span className={cn(ONE_LINE, "font-mono")}>{step.name}</span>
        </span>
        <span className="font-mono text-sm whitespace-nowrap text-muted-foreground max-[620px]:whitespace-normal">
          {howFarIn(step.started_at, openedAt)} · {howLong(step.duration_ns)}
          {failed ? <span className="text-failure"> · {DETAIL.failed}</span> : null}
        </span>
      </summary>
      <div className="min-w-0 border-t border-border px-3 pt-0 pb-3">
        <Recorded step={step} openedAt={openedAt} />
        {step.spans.length === 0 ? null : (
          <div className={cn(STEP_STACK, "mt-2")}>
            {step.spans.map((child) => (
              <Timed key={child.span_id} step={child} openedAt={openedAt} selectedId={selectedId} onSelect={onSelect} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function TimelineView({
  detail,
  steps,
  selectedId,
  onSelect,
}: {
  detail: Detail;
  steps: readonly PositionedStep[];
  selectedId: string | null;
  onSelect: (step: Step) => void;
}) {
  const total = Math.max(milliseconds(detail.trace.duration_ns), 1);
  const openedAt = Date.parse(detail.trace.started_at);

  return (
    <div>
      <ViewHeading title={DETAIL.views.timeline} lead={DETAIL.timelineLead} />
      {steps.length === 0 ? <Notice>{DETAIL.noStepsAtAll}</Notice> : (
        <div className={LIST_SURFACE}>
          {steps.map(({ step, depth }) => {
            const offset = Math.max(Date.parse(step.started_at) - openedAt, 0);
            const duration = Math.max(milliseconds(step.duration_ns), 0);
            const left = Math.min((offset / total) * 100, 100);
            const width = Math.max(Math.min((duration / total) * 100, 100 - left), .8);
            const style = {
              "--timeline-indent": `${Math.min(depth, 6) * 12}px`,
              "--timeline-left": `${left}%`,
              "--timeline-width": `${width}%`,
            } as CSSProperties;

            return (
              <button
                key={step.span_id}
                className={cn(
                  ROW,
                  /*
                   * A grid rather than the row's own flex, because the bar in
                   * the middle has to start at the same place on every line
                   * whatever the name to its left is called.
                   */
                  "grid grid-cols-[minmax(150px,30%)_minmax(120px,1fr)_72px] gap-3",
                  "ps-[calc(var(--space-3)+var(--timeline-indent))]",
                  "first:border-t-0",
                  "max-[620px]:grid-cols-[minmax(0,1fr)_56px]",
                  selectedId === step.span_id && SELECTED,
                )}
                type="button"
                style={style}
                onClick={() => onSelect(step)}
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <strong className="font-mono text-sm font-medium">
                    {presentedStepLabel(step)}
                  </strong>
                  <span className={ONE_LINE}>{step.name}</span>
                </span>
                <span
                  className={cn(
                    "relative block h-5 overflow-hidden rounded-button bg-background",
                    "max-[620px]:col-span-full max-[620px]:row-start-2",
                  )}
                  aria-hidden="true"
                >
                  <span
                    className={cn(
                      "absolute inset-y-[5px] left-(--timeline-left) w-(--timeline-width)",
                      "min-w-[2px] rounded-chip",
                      step.status === "error" ? "bg-failure" : "bg-foreground",
                    )}
                  />
                </span>
                <span
                  className={cn(
                    "font-mono text-sm text-right text-muted-foreground",
                    "max-[620px]:col-start-2 max-[620px]:row-start-1",
                  )}
                >
                  {howLong(step.duration_ns)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ExecutionView({
  detail,
  selectedId,
  onSelect,
}: {
  detail: Detail;
  selectedId: string | null;
  onSelect: (step: Step) => void;
}) {
  const groups = [
    ...detail.turns.map((turn) => ({
      id: turn.span_id,
      label: `${isHuman(turn) ? SPEAKERS.human : SPEAKERS.agent} ${howFarIn(turn.started_at, detail.trace.started_at)}`,
      steps: flatten(turn.spans),
    })),
    ...(detail.spans.length === 0 ? [] : [{ id: "outside", label: DETAIL.otherSteps, steps: flatten(detail.spans) }]),
  ].filter((group) => group.steps.length > 0);

  return (
    <div>
      <ViewHeading title={DETAIL.views.execution} lead={DETAIL.executionLead} />
      {groups.length === 0 ? <Notice>{DETAIL.noStepsAtAll}</Notice> : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <section className={LIST_SURFACE} key={group.id}>
              <h3
                className={cn(
                  "m-0 border-b border-border bg-background px-4 py-3",
                  "text-sm font-normal uppercase",
                )}
              >
                {group.label}
              </h3>
              {group.steps.map(({ step, depth }) => (
                <button
                  key={step.span_id}
                  className={cn(
                    ROW,
                    "justify-between gap-5",
                    "ps-[calc(var(--space-3)+var(--execution-indent))]",
                    /* The first row sits under the group's own rule, not a second one. */
                    "[h3+&]:border-t-0",
                    selectedId === step.span_id && SELECTED,
                  )}
                  type="button"
                  style={{ "--execution-indent": `${Math.min(depth, 6) * 14}px` } as CSSProperties}
                  onClick={() => onSelect(step)}
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <strong className="text-sm font-normal">{presentedStepLabel(step)}</strong>
                    <small className={cn(ONE_LINE, "font-mono")}>{step.name}</small>
                  </span>
                  <span
                    className={cn(
                      "flex-none font-mono text-sm",
                      step.status === "error" ? "text-failure" : "text-muted-foreground",
                    )}
                  >
                    {step.status === "error" ? DETAIL.failed : howLong(step.duration_ns)}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** A disclosure inside the inspector, where the detail is one press away. */
const INSPECTOR_SUMMARY = cn(
  "cursor-pointer text-sm",
  "pointer-coarse:min-h-(--tap-target) pointer-coarse:py-3",
);

function Inspector({
  selected,
  facts,
  openedAt,
}: {
  selected: Step | null;
  facts: TraceFacts;
  openedAt: string;
}) {
  return (
    <aside
      className={cn(
        /*
         * It follows the reader down a long transcript and keeps a screen's
         * worth of room, because a panel taller than the window is a panel
         * whose foot nobody can reach. Below 1100px there is one column and
         * nothing to follow, so it stops being sticky rather than pinning a
         * full-width panel over the turns.
         */
        "sticky top-6 max-h-[calc(100svh-var(--space-9))] overflow-auto",
        "min-w-0 rounded-card border border-border bg-surface p-5",
        "max-[1100px]:static max-[1100px]:max-h-none",
      )}
      aria-label={DETAIL.inspector}
    >
      {selected === null ? (
        <p className="m-0 text-sm text-muted-foreground">{DETAIL.nothingSelected}</p>
      ) : (
        <>
          <div className="min-w-0 border-b border-border pb-4">
            <p className={cn(FACT_LABEL, "mt-0 mb-3")}>{presentedStepLabel(selected)}</p>
            <h2 className="m-0 text-lg font-normal [overflow-wrap:anywhere]">
              {selected.text || selected.tool_name || selected.name}
            </h2>
            <p className="mt-2 mb-0 text-sm text-muted-foreground">
              {howFarIn(selected.started_at, openedAt)} · {howLong(selected.duration_ns)}
            </p>
          </div>

          <dl
            className={cn(
              "m-0",
              "[&>div]:flex [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-4",
              "[&>div]:border-b [&>div]:border-border [&>div]:py-3",
              "[&_dt]:text-sm [&_dt]:text-muted-foreground",
              "[&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:text-right [&_dd]:text-sm",
              "[&_dd]:[overflow-wrap:anywhere]",
            )}
          >
            <div><dt>{FACTS.status}</dt><dd className={selected.status === "error" ? "text-failure" : undefined}>{readableStatus(selected.status)}</dd></div>
            <div><dt>{FACTS.started}</dt><dd>{asSecond(selected.started_at)}</dd></div>
            <div><dt>{FACTS.duration}</dt><dd>{howLong(selected.duration_ns)}</dd></div>
          </dl>

          {selected.tool_name === "" ? null : (
            <section className="border-b border-border py-4">
              <h3 className="mt-0 mb-2 text-base font-normal">{DETAIL.toolWork}</h3>
              <p className="m-0 font-mono text-sm [overflow-wrap:anywhere]">{selected.tool_name}</p>
              {selected.tool_arguments === "" ? null : <Payload label={FACTS.toolArguments} value={selected.tool_arguments} />}
              {selected.tool_result === "" ? null : <Payload label={FACTS.toolResult} value={selected.tool_result} />}
            </section>
          )}

          {selected.audio_url === "" ? null : (
            <p className="mt-4 mb-0 text-sm">
              <a
                className={cn(
                  "inline-block text-foreground",
                  "transition-transform duration-(--duration-press) ease-out",
                  "[&:active:not(:focus-visible)]:scale-97",
                  "pointer-coarse:inline-flex pointer-coarse:items-center",
                  "pointer-coarse:min-h-(--tap-target)",
                  "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
                )}
                href={selected.audio_url}
              >
                {DETAIL.openAudio}
              </a>
            </p>
          )}

          <details className="mt-4 border-t border-border pt-4">
            <summary className={INSPECTOR_SUMMARY}>{DETAIL.technicalDetails}</summary>
            <Recorded step={selected} openedAt={openedAt} />
          </details>
        </>
      )}

      <details className="mt-4 border-t border-border pt-4">
        <summary className={INSPECTOR_SUMMARY}>{DETAIL.whereItCameFrom}</summary>
        <WhereItCameFrom facts={facts} />
      </details>
    </aside>
  );
}

function Payload({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <pre
        className={cn(
          "mt-2 mb-0 max-h-50 overflow-auto p-3",
          "rounded-input border border-border bg-background",
          "font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]",
        )}
      >
        {value}
      </pre>
    </div>
  );
}

/** A list of recorded facts: a mono label, and the value it was filed under. */
const RECORDED_LIST = cn(
  "mt-3 mb-0 text-sm",
  "[&>div]:grid [&>div]:min-w-0 [&>div]:gap-2 [&>div]:py-1",
  "[&>div]:grid-cols-[minmax(80px,max-content)_minmax(0,1fr)]",
  "[&_dt]:font-mono [&_dt]:text-muted-foreground",
  "[&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:font-mono [&_dd]:[overflow-wrap:anywhere]",
);

/**
 * Where this exchange came from and when — the disclosure whose label stopped
 * saying "Recording" the day this page grew an audio player. The component
 * carries the same name as the words on the screen, so nobody reading the code
 * goes looking for the recording in it.
 */
function WhereItCameFrom({ facts }: { facts: TraceFacts }) {
  const shown: readonly (readonly [string, string])[] = [
    [FACTS.started, asSecond(facts.started_at)],
    [FACTS.ended, asSecond(facts.ended_at)],
    [FACTS.source, facts.source],
    [FACTS.environment, facts.environment],
    [FACTS.connection, facts.connection_type],
    [FACTS.reference, facts.provider_call_id],
  ];

  return (
    <dl className={RECORDED_LIST}>
      {shown.filter(([, value]) => value !== "").map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Recorded({ step, openedAt }: { step: Step; openedAt: string }) {
  const shown: readonly (readonly [string, string])[] = [
    [FACTS.kind, stepLabel(step.kind)],
    [FACTS.name, step.name],
    [FACTS.status, step.status],
    [FACTS.started, `${asSecond(step.started_at)} (${howFarIn(step.started_at, openedAt)})`],
    [FACTS.duration, howLong(step.duration_ns)],
    [FACTS.nanoseconds, step.duration_ns],
    [FACTS.identifier, step.span_id],
    [FACTS.within, step.parent_span_id],
    [FACTS.toolName, step.tool_name],
    [FACTS.toolArguments, step.tool_arguments],
    [FACTS.toolResult, step.tool_result],
    [FACTS.audio, step.audio_url],
  ];

  return (
    <dl className={RECORDED_LIST}>
      {shown.filter(([, value]) => value !== "").map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function flatten(steps: readonly Step[], depth = 0): PositionedStep[] {
  return steps.flatMap((step) => [
    { step, depth },
    ...flatten(step.spans, depth + 1),
  ]);
}

function positionedSteps(detail: Detail): PositionedStep[] {
  const seen = new Set<string>();
  return [...flatten(detail.turns), ...flatten(detail.spans)].filter(({ step }) => {
    if (seen.has(step.span_id)) return false;
    seen.add(step.span_id);
    return true;
  });
}

function readableStatus(status: string): string {
  return status === "" || status === "unset" ? DETAIL.notReported : status;
}

function presentedStepLabel(step: Step): string {
  const known = stepLabel(step.kind);
  if (known !== UNKNOWN_STEP_LABEL || step.name === "") return known;
  const words = step.name.replaceAll(/[_-]+/g, " ").trim();
  return words === "" ? known : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}
