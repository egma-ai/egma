"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { readJson, type Answer } from "../../../../../lib/api.ts";
import { GRADERS_PATH, type RunningPage } from "../../../../../lib/graders.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import {
  API_KEYS_PATH,
  rowsIn,
  type ApiKeyList,
} from "../../../../../lib/settings.ts";
import {
  COLUMNS,
  DEFAULT_WINDOW,
  LIST,
  QUIET,
  WINDOWS,
  type WindowChoice,
} from "../../../../../lib/transcript-copy.ts";
import {
  everRecordedPath,
  howLong,
  isWidestWindow,
  namesWholeOrganization,
  productionListPath,
  quietState,
  recentWindow,
  transcriptPath,
  watchesProduction,
  WINDOW_PARAMETER,
  windowChoiceOf,
  type Listed,
  type ListPage,
  type Quiet,
} from "../../../../../lib/transcripts.ts";
import { ButtonLink, Select } from "../../../../../ui/controls.tsx";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import {
  ExportSetUp,
  useDeploymentOrigin,
} from "../../../../../ui/export-setup.tsx";
import { Empty, Failure, Loading } from "../../../../../ui/page-state.tsx";
import {
  RelativeInstant,
  useMinuteClock,
} from "../../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { settingsPath } from "../../../../../ui/settings-nav.tsx";
import { useOrganizationRead } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
} from "../../../../../ui/shell.tsx";
import { Notice, styles } from "../../../../ui.tsx";

/**
 * **Monitoring**: what this project's agents did in production, newest first.
 *
 * *This project* is read out of the address and sent with the request, so a
 * copied link opens the project it names rather than whichever one the reader's
 * browser happened to be resolved into.
 *
 * **Production and nothing else.** A simulation is read under the run that
 * produced it, beside the frozen test, the persona, the graders and the
 * mock-tools record — drawing it a second time and poorer, in a mixed list,
 * would be a wrong door. So the request narrows to production at the server and
 * the table carries no column saying so: every row here is production by
 * definition, and a column repeating a constant is furniture.
 *
 * The first consumer of the **public v1 contract** rather than of a private one
 * built for it: what a customer integrates against is what egma's own screen is
 * drawn from, so a contract that cannot answer a question a person actually has
 * fails here first, while it is still cheap to change.
 *
 * Three things about the request are the store's discipline showing through,
 * and each is load-bearing:
 *
 * - **A window is always sent.** The read surface refuses a request that names
 *   none, because the store is filed by time and a read that bounded nothing
 *   would be a read of everything. The last day is this page's answer to that,
 *   not the endpoint's default — there is no default, on purpose.
 * - **Paging is by token.** The answer carries where it stopped, and asking for
 *   more means handing that back. An offset would re-sort and re-scan the rows
 *   already read, and would skip or repeat one the moment something arrived
 *   mid-page.
 * - **The chosen window lives in the address**, the same way one transcript's
 *   window does. Somebody who widened to thirty days and reloaded should still
 *   be looking at thirty days, and somebody sending "look at last week" should
 *   be able to send the address they are looking at.
 *
 * Signed in with a browser session like every other page here, on the origin
 * the page was served from. There is no API key in a browser and there never
 * will be.
 */

type State =
  | { status: "loading" }
  | { status: "failed"; why: string }
  | { status: "loaded"; rows: readonly Listed[]; more: string | null };

export default function MonitoringTranscriptsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Transcripts projectId={projectId} />
    </AppShell>
  );
}

function Transcripts({ projectId }: { readonly projectId: string }) {
  const now = useMinuteClock();
  /**
   * Which window this page is on, read out of the address.
   *
   * `null` until it has been: the address exists only in a browser, and this
   * component is rendered on the server first, so a choice guessed there and
   * corrected here would be a hydration mismatch and a wasted first read. The
   * control shows the default meanwhile, which is the choice it will settle on
   * for every address that names none.
   */
  const [choice, setChoice] = useState<WindowChoice | null>(null);
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  /**
   * Which window the rows on screen belong to, readable from inside a promise
   * that was started under a different one. See `showMore`.
   */
  const showing = useRef<WindowChoice | null>(null);

  /**
   * The two reads that decide what a quiet page says, beside the list itself.
   *
   * The graders answer is this project's. The keys answer names no project,
   * because a key is minted against the customer even when it is scoped to one
   * — but it is **what this reader may see rather than what the organization
   * holds**: the server shows an ordinary member their own keys and an admin
   * everybody's. So an empty answer is not proof that no organization-wide key
   * exists, which is why the caution about one rides with the setup teaching as
   * well as having a state of its own.
   *
   * Neither is asked about a window: what each says is true of the project
   * rather than of the last day.
   */
  const { answer: graders } = useProjectRead<RunningPage>(GRADERS_PATH, projectId);
  const { answer: keys } = useOrganizationRead<ApiKeyList>(API_KEYS_PATH);

  useEffect(() => {
    setChoice(
      windowChoiceOf(
        new URLSearchParams(globalThis.location.search).get(WINDOW_PARAMETER),
      ),
    );
  }, []);

  /** Chosen, remembered in the address, and read back on the next visit. */
  function choose(chosen: WindowChoice): void {
    // At the click rather than only in the effect below, so that a request
    // already in flight cannot answer into the gap between the two.
    showing.current = chosen;
    setChoice(chosen);
    const asked = new URLSearchParams(globalThis.location.search);
    asked.set(WINDOW_PARAMETER, chosen);
    globalThis.history.replaceState(null, "", `?${asked.toString()}`);
  }

  /**
   * One page of the list. `after` is the token the last answer stopped at, and
   * its absence is the first page — the same call either way, because a first
   * page and a next page differ only by where they start.
   */
  const ask = useCallback(
    async (
      chosen: WindowChoice,
      after: string | null,
    ): Promise<ListPage | null> => {
      const answer = await readJson<ListPage>(
        productionListPath({
          window: recentWindow(chosen, new Date()),
          projectId,
          cursor: after,
        }),
      );

      if (answer.status === "signed-out") {
        globalThis.location.replace("/sign-in");
        return null;
      }
      if (answer.status !== "ready") {
        setState({ status: "failed", why: answer.refusal.message });
        return null;
      }
      return answer.value;
    },
    [projectId],
  );

  useEffect(() => {
    if (choice === null) return undefined;
    let current = true;
    showing.current = choice;
    setState({ status: "loading" });

    void ask(choice, null)
      .then((page) => {
        if (!current || page === null) return;
        setState({
          status: "loaded",
          rows: page.traces,
          more: page.next_cursor,
        });
      })
      .catch(() => {
        if (current) setState({ status: "failed", why: LIST.unreachable });
      });

    return () => {
      current = false;
    };
  }, [ask, choice, attempt]);

  /**
   * The next page, appended — the token says where the last one stopped.
   *
   * The window is captured at the click and checked again at the append,
   * because the two can disagree. Somebody clicks **Show more** on the last
   * hour, then picks the last thirty days while that request is still out; the
   * effect above starts the thirty-day list, that one answers first, and then
   * the hour's second page arrives and appends rows from an hour to a list of
   * a month — silently, and in the wrong order, since both are newest-first
   * within themselves. Guarding on `state.status` alone does not catch it: by
   * the time the late answer lands the new window has usually already loaded,
   * so the status is `loaded` again.
   */
  async function showMore(after: string): Promise<void> {
    const asked = choice;
    if (asked === null) return;
    setBusy(true);
    try {
      const page = await ask(asked, after);
      if (page === null) return;
      setState((was) =>
        was.status === "loaded" && showing.current === asked
          ? {
              status: "loaded",
              rows: [...was.rows, ...page.traces],
              more: page.next_cursor,
            }
          : was,
      );
    } catch {
      setState({ status: "failed", why: LIST.unreachable });
    } finally {
      setBusy(false);
    }
  }

  // Where the last page stopped, hoisted so it is a value the button below can
  // close over rather than a field that might have changed by the time it does.
  const more = state.status === "loaded" ? state.more : null;

  /**
   * Whether this project has **ever** recorded anything, asked only when the
   * window on screen holds nothing.
   *
   * It is the difference between the two confident sentences a quiet page can
   * say, and the window alone cannot tell them apart. An empty last hour means
   * *nothing in this hour* for a project with a week of traffic and *set up your
   * export* for a project on its first day, and a developer who has just signed
   * up lands on the default window rather than on the widest — so deciding by
   * the window alone would put a click between them and the one page written
   * for them.
   *
   * One row is the whole answer, so it asks for one. It is not asked at all
   * unless the page is empty, and not even then when the window on screen is
   * already the widest — the list read has just answered the same question.
   *
   * `undefined` is still out, `null` is a read that refused, and a number is an
   * answer. The three are kept apart because `quietState` may never read a
   * refusal as a zero.
   */
  const emptyHere = state.status === "loaded" && state.rows.length === 0;
  const alreadyWidest = isWidestWindow(choice ?? DEFAULT_WINDOW);
  const [probed, setProbed] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    if (!emptyHere || alreadyWidest) {
      setProbed(undefined);
      return undefined;
    }

    let current = true;
    setProbed(undefined);

    void readJson<ListPage>(everRecordedPath(projectId, new Date())).then(
      (answer) => {
        if (!current) return;
        setProbed(answer.status === "ready" ? answer.value.traces.length : null);
      },
    );

    return () => {
      current = false;
    };
  }, [emptyHere, alreadyWidest, projectId, attempt]);

  /**
   * What the probe settled on, with the two cases that need no probe folded in:
   * a page with rows on it never asks, and a page already on the widest window
   * has its answer in the list read it just made.
   */
  const everRecorded: number | null | undefined = !emptyHere
    ? 0
    : alreadyWidest
      ? 0
      : probed;

  /**
   * Which of the four quiet states this page is in, or none.
   *
   * Nothing at all while either supporting read is still out, and that wait is
   * deliberate: guessing would put the setup teaching on screen for a moment in
   * front of somebody whose real trouble is a key that names the organization,
   * and guidance that flickers between two different instructions is worse than
   * guidance that arrives a beat late.
   *
   * **A read that answered a refusal counts as nothing, never as a zero.** An
   * `Answer` that is not `ready` is `null` here, and `quietState` reads `null`
   * as "no answer" — so a failed grader read means this page says one thing
   * less, rather than announcing that no grader watches production on the
   * strength of an answer it never got. That is the same rule `ui/page-state`
   * states between failed and empty, applied to the reads that only decide what
   * a page says about itself.
   */
  const counted = <T,>(answer: Answer<T> | null, count: (value: T) => number) =>
    answer !== null && answer.status === "ready" ? count(answer.value) : null;

  const quiet: Quiet | null =
    state.status !== "loaded" ||
    graders === null ||
    keys === null ||
    everRecorded === undefined
      ? null
      : quietState({
          listed: state.rows.length,
          everRecorded,
          organizationWideKeys: counted(
            keys,
            (page) => rowsIn(page.keys).filter(namesWholeOrganization).length,
          ),
          watchingProduction: counted(
            graders,
            (page) => page.items.filter(watchesProduction).length,
          ),
        });

  return (
    <ProductPage wide>
      <PageHeader
        eyebrow={LIST.eyebrow}
        title={LIST.title}
        lead={LIST.lead}
        action={
          <Select
            id="window"
            value={choice ?? DEFAULT_WINDOW}
            label={LIST.window}
            options={WINDOW_OPTIONS}
            onChange={choose}
          />
        }
      />
      <PageBody>
        {state.status === "failed" ? (
          <Failure
            message={state.why}
            onRetry={() => setAttempt((one) => one + 1)}
          />
        ) : null}
        {state.status === "loading" ? <Loading what={LIST.loadingWhat} /> : null}

        {quiet === "nothing-watches-production" ? (
          <Notice>
            {QUIET.unwatched.lead}{" "}
            <Link href={projectPath(projectId, "graders", "running")}>
              {QUIET.unwatched.graders}
            </Link>
          </Notice>
        ) : null}

        {/*
          The list is empty because of the window rather than because of the
          project, so the way out is the control above and nothing else is
          known to be wrong. A setup tutorial here would tell somebody with a
          week of traffic that their working export is broken.
        */}
        {quiet === "nothing-in-this-window" ? (
          <Empty
            title={QUIET.narrowWindow.title}
            lead={QUIET.narrowWindow.lead}
          />
        ) : null}

        {quiet === "set-up-capture" ? <SetUp projectId={projectId} /> : null}

        {quiet === "key-names-the-organization" ? (
          <Empty
            title={QUIET.organizationKey.title}
            lead={QUIET.organizationKey.lead}
            action={
              <ButtonLink weight="strong" href={settingsPath(projectId, "keys")}>
                {QUIET.organizationKey.key}
              </ButtonLink>
            }
          />
        ) : null}

        {state.status === "loaded" && state.rows.length > 0 ? (
          <DataTable
            label={LIST.tableLabel}
            columns={columnsFor(projectId, now)}
            rows={state.rows}
            keyOf={(row) => row.trace_id}
            stretchPrimaryLink
            {...(more === null
              ? {}
              : {
                  more: {
                    onMore: () => void showMore(more),
                    loading: busy,
                    note: LIST.counted(state.rows.length),
                  },
                })}
          />
        ) : null}
      </PageBody>
    </ProductPage>
  );
}

/**
 * What a developer with nothing on this page needs: the address, the two
 * variables, and where the key comes from.
 *
 * **The address is this deployment's own**, read off the page rather than
 * written down anywhere, because a self-hoster's egma is wherever they put it
 * and a printed example would be somebody else's. The exporter appends the
 * signal's own path, so what is shown is the base and nothing after it.
 *
 * **Nothing is drawn until that address is known.** It only exists in a
 * browser, so it arrives one render after this component mounts — and the
 * render before it would print `OTEL_EXPORTER_OTLP_ENDPOINT=` with nothing after
 * the sign, which is a variable somebody could copy and an instruction that is
 * wrong for as long as it is on screen. Teaching arrives once and complete.
 */
function SetUp({ projectId }: { readonly projectId: string }) {
  const origin = useDeploymentOrigin();

  if (origin === null) return null;

  return (
    <Empty
      title={QUIET.setUp.title}
      lead={QUIET.setUp.lead}
      action={<ExportSetUp projectId={projectId} origin={origin} />}
    />
  );
}

/** Nothing recorded for this column, which is a different thing from a zero. */
function Nothing() {
  return <span className={styles.muted}>{LIST.nothing}</span>;
}

/**
 * The columns, in the order they are shown, each beside what fills it.
 *
 * One list rather than a header row and a body row that have to be kept in the
 * same order by hand — a table whose eighth heading names its ninth value is a
 * bug nobody sees in a diff.
 *
 * The order is a judgement about scanning. What somebody looking down this list
 * is trying to find is the exchange they mean, so when it happened, how long it
 * ran, how much was said and **what the human opened with** come first; how it
 * was recorded and reached comes after.
 *
 * The link is on the first column and it carries the project and the window
 * this exchange happened in, taken from the two instants this very row is
 * showing. That is what makes the transcript a place somebody can be sent: the
 * endpoint under it requires both, and this row already knows the answers, so
 * nobody has to.
 */
function columnsFor(projectId: string, now: number): readonly Column<Listed>[] {
  const order: readonly (readonly [string, (row: Listed) => ReactNode])[] = [
    [
      COLUMNS.started,
      (row) => (
        <Link href={transcriptPath(projectId, row)}>
          <RelativeInstant
            instant={row.started_at}
            now={now}
            precision="second"
          />
        </Link>
      ),
    ],
    [COLUMNS.duration, (row) => howLong(row.duration_ns)],
    [
      COLUMNS.turns,
      (row) => (
        <>
          {row.turn_counts.human} {LIST.human} · {row.turn_counts.agent}{" "}
          {LIST.agent}
        </>
      ),
    ],
    [
      COLUMNS.preview,
      (row) => (row.preview === "" ? <Nothing /> : <span>{row.preview}</span>),
    ],
    [COLUMNS.steps, (row) => row.span_count],
    [
      COLUMNS.tools,
      (row) => (row.tool_span_count === 0 ? <Nothing /> : row.tool_span_count),
    ],
    [
      COLUMNS.errors,
      (row) =>
        row.errored_span_count === 0 ? (
          <Nothing />
        ) : (
          <strong className={styles.wrong}>{row.errored_span_count}</strong>
        ),
    ],
    [COLUMNS.environment, (row) => row.environment],
    [COLUMNS.connection, (row) => row.connection_type],
  ];

  return order.map(([header, cell], index) => ({
    key: header,
    header,
    cell,
    hideOnMobile: !MOBILE_COLUMNS.has(header),
    primary: index === 0,
    mono: MEASURED_COLUMNS.has(header),
  }));
}

/** Keep the exchange, when it happened, and any failure legible on a phone. */
const MOBILE_COLUMNS = new Set<string>([
  COLUMNS.started,
  COLUMNS.duration,
  COLUMNS.preview,
  COLUMNS.errors,
]);

/**
 * The columns somebody scans down rather than reads across.
 *
 * `DESIGN.md` asks for tabular numerals on metrics, dates and durations, and
 * the mono face is where this table gets them. A count and a duration are worth
 * nothing on their own — what they are for is the row that is three times the
 * others — and a proportional face puts every figure at a different width, so
 * the eye has to read each one instead of seeing the shape of the column.
 *
 * Turns is deliberately out: it is a sentence with two numbers in it rather
 * than a figure. So are the two words at the end.
 */
const MEASURED_COLUMNS = new Set<string>([
  COLUMNS.started,
  COLUMNS.duration,
  COLUMNS.steps,
  COLUMNS.tools,
  COLUMNS.errors,
]);

const WINDOW_OPTIONS = WINDOWS.map((window) => ({
  value: window.id,
  label: window.label,
}));
