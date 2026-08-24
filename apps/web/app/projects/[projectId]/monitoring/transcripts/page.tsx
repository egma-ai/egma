"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  listApiKeys,
  listGraders,
  listTraces,
} from "@egma/platform-api/client";

import type { Answer } from "../../../../../lib/api.ts";
import type { ProjectGradersPage } from "../../../../../lib/graders.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../../lib/platform-client.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { rowsIn, type ApiKeyList } from "../../../../../lib/settings.ts";
import { startMonitoringPath } from "../../../../../lib/monitoring.ts";
import {
  COLUMNS,
  DEFAULT_WINDOW,
  LIST,
  QUIET,
  WINDOWS,
  type WindowChoice,
} from "../../../../../lib/transcript-copy.ts";
import {
  agentPlatformLabel,
  howLong,
  isWidestWindow,
  namesWholeOrganization,
  quietState,
  recentWindow,
  transcriptPath,
  watchesProduction,
  WIDEST_WINDOW,
  WINDOW_PARAMETER,
  windowChoiceOf,
  type Listed,
  type ListPage,
  type Quiet,
  type Window,
} from "../../../../../lib/transcripts.ts";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Empty, Failure, Loading } from "../../../../../ui/page-state.tsx";
import {
  ListInstant,
} from "../../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { TOOLBAR_FILTER } from "../../../../../ui/section.tsx";
import { settingsPath } from "../../../../../ui/settings-nav.tsx";
import { useOrganizationRead } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
} from "../../../../../ui/shell.tsx";
import { Notice } from "../../../../ui.tsx";

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
  | {
      status: "loaded";
      pages: readonly {
        readonly rows: readonly Listed[];
        readonly nextCursor: string | null;
      }[];
      page: number;
      window: Window;
      pageFailure: string | null;
    };

export default function MonitoringTranscriptsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Transcripts projectId={projectId} />
    </AppShell>
  );
}

function Transcripts({ projectId }: { readonly projectId: string }) {
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

  /** Changes whenever the first page changes, so a late next page is ignored. */
  const requestGeneration = useRef(0);

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
  const { answer: graders } = useProjectRead<ProjectGradersPage>(
    (projectId) =>
      platformAnswer(listGraders({ projectId }, { client: platformClient })),
    projectId,
  );
  const { answer: keys } = useOrganizationRead<ApiKeyList>(() =>
    platformAnswer(listApiKeys({ client: platformClient })),
  );

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
    requestGeneration.current += 1;
    setChoice(chosen);
    const asked = new URLSearchParams(globalThis.location.search);
    asked.set(WINDOW_PARAMETER, chosen);
    globalThis.history.replaceState(null, "", `?${asked.toString()}`);
  }

  /**
   * One page of the list. `after` is the token the last answer stopped at, and
   * its absence is the first page — the same call either way, because a first
   * page and a next page differ only by where they start. `window` is created
   * once for the first page and reused for every cursor that follows it.
   */
  const ask = useCallback(
    async (
      window: Window,
      after: string | null,
    ): Promise<
      | { readonly status: "ready"; readonly page: ListPage }
      | { readonly status: "failed"; readonly why: string }
      | null
    > => {
      const answer = await platformAnswer(
        listTraces(
          {
            from: window.from,
            to: window.to,
            projectId,
            source: "production",
            ...(after === null ? {} : { pageToken: after }),
          },
          { client: platformClient },
        ),
      );

      if (answer.status === "signed-out") {
        globalThis.location.replace("/sign-in");
        return null;
      }
      if (answer.status !== "ready") {
        return { status: "failed", why: answer.refusal.message };
      }
      return { status: "ready", page: answer.value };
    },
    [projectId],
  );

  useEffect(() => {
    if (choice === null) return undefined;
    let current = true;
    const generation = ++requestGeneration.current;
    const window = recentWindow(choice, new Date());
    setBusy(false);
    setState({ status: "loading" });

    void ask(window, null)
      .then((answer) => {
        if (
          !current ||
          generation !== requestGeneration.current ||
          answer === null
        ) {
          return;
        }
        if (answer.status === "failed") {
          setState({ status: "failed", why: answer.why });
          return;
        }
        setState({
          status: "loaded",
          pages: [
            {
              rows: answer.page.traces,
              nextCursor: answer.page.nextPageToken,
            },
          ],
          page: 0,
          window,
          pageFailure: null,
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
   * Move to the next page. A page already visited is reused. A page not yet
   * visited is read with the cursor and the exact time window of page one.
   */
  async function showNext(): Promise<void> {
    if (state.status !== "loaded" || busy) return;
    const currentPage = state.pages[state.page];
    if (currentPage === undefined) return;
    if (state.pages[state.page + 1] !== undefined) {
      setState({ ...state, page: state.page + 1, pageFailure: null });
      return;
    }
    if (currentPage.nextCursor === null) return;

    const generation = requestGeneration.current;
    const asked = state;
    setBusy(true);
    setState({ ...state, pageFailure: null });
    try {
      const answer = await ask(asked.window, currentPage.nextCursor);
      if (answer === null || generation !== requestGeneration.current) return;
      if (answer.status === "failed") {
        setState((was) =>
          was.status === "loaded" && generation === requestGeneration.current
            ? { ...was, pageFailure: answer.why }
            : was,
        );
        return;
      }
      setState((was) =>
        was.status === "loaded" &&
        generation === requestGeneration.current &&
        was.page === asked.page &&
        was.window.from === asked.window.from &&
        was.window.to === asked.window.to
          ? {
              ...was,
              pages: [
                ...was.pages,
                {
                  rows: answer.page.traces,
                  nextCursor: answer.page.nextPageToken,
                },
              ],
              page: was.page + 1,
              pageFailure: null,
            }
          : was,
      );
    } catch {
      if (generation === requestGeneration.current) {
        setState((was) =>
          was.status === "loaded"
            ? { ...was, pageFailure: LIST.unreachable }
            : was,
        );
      }
    } finally {
      if (generation === requestGeneration.current) setBusy(false);
    }
  }

  function showPrevious(): void {
    if (busy) return;
    setState((was) =>
      was.status === "loaded" && was.page > 0
        ? { ...was, page: was.page - 1, pageFailure: null }
        : was,
    );
  }

  const shownPage =
    state.status === "loaded" ? (state.pages[state.page] ?? null) : null;
  const shownRows = shownPage?.rows ?? [];

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
  const emptyHere = state.status === "loaded" && shownRows.length === 0;
  const alreadyWidest = isWidestWindow(choice ?? DEFAULT_WINDOW);
  const [probed, setProbed] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    if (!emptyHere || alreadyWidest) {
      setProbed(undefined);
      return undefined;
    }

    let current = true;
    setProbed(undefined);

    const window = recentWindow(WIDEST_WINDOW, new Date());
    void platformAnswer(
      listTraces(
        {
          from: window.from,
          to: window.to,
          projectId,
          source: "production",
          pageSize: 1,
        },
        { client: platformClient },
      ),
    ).then((answer) => {
      if (!current) return;
      setProbed(answer.status === "ready" ? answer.value.traces.length : null);
    });

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
          listed: shownRows.length,
          everRecorded,
          organizationWideKeys: counted(
            keys,
            (page) => rowsIn(page.keys).filter(namesWholeOrganization).length,
          ),
          watchingProduction: counted(
            graders,
            (page) => page.graders.filter(watchesProduction).length,
          ),
        });

  /*
   * The window is a filter, so it sits where every list page in this product
   * keeps its filters: the left of the one strip under the title bar, opposite
   * the one action. A person moving between Runs and Monitoring should not
   * have to look in two places for the same kind of control.
   */
  const filters = (
    <Select
      id="window"
      className={TOOLBAR_FILTER}
      value={choice ?? DEFAULT_WINDOW}
      aria-label={LIST.window}
      onChange={(event) => choose(event.target.value as WindowChoice)}
    >
      {WINDOWS.map((one) => (
        <option key={one.id} value={one.id}>
          {one.label}
        </option>
      ))}
    </Select>
  );

  return (
    <ProductPage wide>
      {/*
        The title, the filter and the action, and nothing else above the list.
        The boards draw no label and no purpose sentence over a list screen
        (`71V-0`, `71N-0`): the sidebar already says which section this is and
        which project it belongs to, and the table under it says what it holds.
        The purpose sentence stays where a form needs one.
      */}
      <PageHeader
        title={LIST.title}
        toolbar={filters}
        action={
          <Button asChild>
            <Link href={startMonitoringPath(projectId)}>{LIST.startMonitoring}</Link>
          </Button>
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
            <Link href={projectPath(projectId, "graders")}>
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

        {quiet === "set-up-capture" ? <SetUp /> : null}

        {quiet === "key-names-the-organization" ? (
          <Empty
            title={QUIET.organizationKey.title}
            lead={QUIET.organizationKey.lead}
            action={
              <Button asChild>
                <Link href={settingsPath(projectId, "keys")}>
                  {QUIET.organizationKey.key}
                </Link>
              </Button>
            }
          />
        ) : null}

        {state.status === "loaded" && shownPage !== null && shownRows.length > 0 ? (
          <>
            {state.pageFailure === null ? null : (
              <p className="mb-3 text-sm text-destructive" role="alert">
                {state.pageFailure}
              </p>
            )}
            <DataTable
              label={LIST.tableLabel}
              columns={columnsFor(projectId)}
              rows={shownRows}
              keyOf={(row) => row.traceId}
              stretchPrimaryLink
              pagination={{
                page: state.page + 1,
                canPrevious: state.page > 0,
                canNext:
                  state.pages[state.page + 1] !== undefined ||
                  shownPage.nextCursor !== null,
                loading: busy,
                onPrevious: showPrevious,
                onNext: () => void showNext(),
                previousLabel: LIST.previousPage,
                pageLabel: LIST.page,
                nextLabel: LIST.nextPage,
                note: LIST.counted(shownRows.length),
              }}
            />
          </>
        ) : null}
      </PageBody>
    </ProductPage>
  );
}

/** Provider-specific teaching lives once, in the start-monitoring flow. */
function SetUp() {
  return (
    <Empty
      title={QUIET.setUp.title}
      lead={QUIET.setUp.lead}
    />
  );
}

/** Nothing recorded for this column, which is a different thing from a zero. */
function Nothing() {
  return <span className="text-muted-foreground">{LIST.nothing}</span>;
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
function columnsFor(projectId: string): readonly Column<Listed>[] {
  const order: readonly (readonly [string, (row: Listed) => ReactNode])[] = [
    [
      COLUMNS.started,
      (row) => (
        <Link href={transcriptPath(projectId, row)}>
          <ListInstant instant={row.startedAt} precision="second" />
        </Link>
      ),
    ],
    [COLUMNS.duration, (row) => howLong(row.durationNs)],
    [
      COLUMNS.turns,
      (row) => (
        <>
          {row.turnCounts.human} {LIST.human} · {row.turnCounts.agent}{" "}
          {LIST.agent}
        </>
      ),
    ],
    [
      COLUMNS.preview,
      (row) => (row.preview === "" ? <Nothing /> : <span>{row.preview}</span>),
    ],
    [COLUMNS.steps, (row) => row.spanCount],
    [
      COLUMNS.tools,
      (row) => (row.toolSpanCount === 0 ? <Nothing /> : row.toolSpanCount),
    ],
    [
      COLUMNS.errors,
      (row) =>
        row.erroredSpanCount === 0 ? (
          <Nothing />
        ) : (
          <strong className="text-failure">{row.erroredSpanCount}</strong>
        ),
    ],
    [COLUMNS.environment, (row) => row.environment],
    [
      COLUMNS.platform,
      (row) =>
        row.agentPlatform === "" ? (
          <Nothing />
        ) : (
          agentPlatformLabel(row.agentPlatform)
        ),
    ],
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
