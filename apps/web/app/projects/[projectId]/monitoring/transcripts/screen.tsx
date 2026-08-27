"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listApiKeys, listTraces } from "@egma/platform-api/client";

import type { Answer } from "../../../../../lib/api.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../../lib/platform-client.ts";
import { rowsIn, type ApiKeyList } from "../../../../../lib/settings.ts";
import {
  AGENT_PARAMETER,
  MONITOR_SHEET,
  monitorAgentPath,
  SHEET_PARAMETER,
} from "../../../../../lib/monitoring.ts";
import {
  DEFAULT_WINDOW,
  LIST,
  QUIET,
  TRACE_COLUMNS,
  TRACE_SHEET,
  WINDOWS,
  type WindowChoice,
} from "../../../../../lib/transcript-copy.ts";
import {
  howLong,
  isWidestWindow,
  namesWholeOrganization,
  quietState,
  recentWindow,
  shownTurnLatency,
  transcriptPath,
  transcriptsPath,
  WIDEST_WINDOW,
  WINDOW_PARAMETER,
  windowAround,
  windowChoiceOf,
  type Listed,
  type ListPage,
  type Quiet,
  type Window,
} from "../../../../../lib/transcripts.ts";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { MenuItem } from "../../../../../ui/menu.tsx";
import { Empty, Failure, Loading } from "../../../../../ui/page-state.tsx";
import {
  ListInstant,
} from "../../../../../ui/relative-time.tsx";
import { roleOf } from "../../../../../lib/me.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import { TOOLBAR_FILTER } from "../../../../../ui/section.tsx";
import { settingsPath } from "../../../../../ui/settings-nav.tsx";
import { useOrganizationRead } from "../../../../../ui/settings-read.ts";
import {
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import { RowMenu } from "../../../../../ui/row-menu.tsx";
import { MonitorAgentSheet } from "../monitor-sheet.tsx";
import { TraceSheet, type OpenTrace } from "./trace-sheet.tsx";

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

const TRACE_PARAMETER = "trace";
const TRACE_FROM_PARAMETER = "traceFrom";
const TRACE_TO_PARAMETER = "traceTo";

function traceInAddress(): OpenTrace | null {
  const asked = new URLSearchParams(globalThis.location.search);
  const traceId = asked.get(TRACE_PARAMETER);
  const from = asked.get(TRACE_FROM_PARAMETER);
  const to = asked.get(TRACE_TO_PARAMETER);
  return traceId === null || from === null || to === null
    ? null
    : { traceId, from, to };
}

/** This list's current address, with only the opened trace removed. */
function traceFreeAddress(address: URL): string {
  const list = new URL(address.href);
  list.searchParams.delete(TRACE_PARAMETER);
  list.searchParams.delete(TRACE_FROM_PARAMETER);
  list.searchParams.delete(TRACE_TO_PARAMETER);
  return `${list.pathname}${list.search}${list.hash}`;
}

/**
 * The screen, which is not the route.
 *
 * **It lives beside `page.tsx` rather than inside it**, the way `agents` and
 * `tests` already arrange theirs. Next validates the export list of a route
 * module and refuses one that exports anything but its own reserved fields, so
 * a second entry point for the retired Start-monitoring address cannot live in
 * a page file — and the convention it was breaking is the reason there is a
 * convention.
 *
 * Two addresses render it: the transcripts list, and the retired
 * Start-monitoring address, which passes `forced` because the address it *is*
 * names the panel outright.
 */
export function TranscriptsScreen({
  projectId,
  forced,
}: {
  readonly projectId: string;
  /** The picker a route insists on, whatever the query string says. */
  readonly forced?: { readonly agentId: string | null };
}) {
  const router = useRouter();
  const query = useSearchParams();
  const { me } = useShellSession();
  /*
   * Null until the session read answers. A page that guessed would tell an
   * admin their role cannot do something it can, on every load.
   */
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);
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
  const [openedTrace, setOpenedTrace] = useState<OpenTrace | null>(null);
  const [traceOpener, setTraceOpener] = useState<HTMLElement | null>(null);
  const traceWasPushed = useRef(false);
  const traceReturnAddress = useRef<string | null>(null);

  /** Changes whenever the first page changes, so a late next page is ignored. */
  const requestGeneration = useRef(0);

  /** Keys decide which first-day guidance an empty project needs. */
  const { answer: keys } = useOrganizationRead<ApiKeyList>(() =>
    platformAnswer(listApiKeys({ client: platformClient })),
  );

  useEffect(() => {
    const followAddress = () => {
      const nextTrace = traceInAddress();
      setChoice(
        windowChoiceOf(
          new URLSearchParams(globalThis.location.search).get(WINDOW_PARAMETER),
        ),
      );
      setOpenedTrace(nextTrace);
      if (nextTrace === null) {
        traceWasPushed.current = false;
        traceReturnAddress.current = null;
      }
    };
    followAddress();
    globalThis.addEventListener("popstate", followAddress);
    return () => globalThis.removeEventListener("popstate", followAddress);
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

  function openTrace(row: Listed, opener: HTMLElement | null = null): void {
    const exact = windowAround(row);
    const next = { traceId: row.traceId, ...exact };
    const at = new URL(globalThis.location.href);
    const returnAddress = traceFreeAddress(at);
    at.searchParams.set(TRACE_PARAMETER, next.traceId);
    at.searchParams.set(TRACE_FROM_PARAMETER, next.from);
    at.searchParams.set(TRACE_TO_PARAMETER, next.to);
    const address = `${at.pathname}${at.search}${at.hash}`;
    if (openedTrace === null) {
      globalThis.history.pushState(null, "", address);
      traceWasPushed.current = true;
      traceReturnAddress.current = returnAddress;
    } else {
      globalThis.history.replaceState(null, "", address);
    }
    setTraceOpener(opener);
    setOpenedTrace(next);
  }

  function closeTrace(): void {
    setOpenedTrace(null);
    const current = traceFreeAddress(new URL(globalThis.location.href));
    if (
      traceWasPushed.current &&
      traceReturnAddress.current === current
    ) {
      traceWasPushed.current = false;
      traceReturnAddress.current = null;
      globalThis.history.back();
      return;
    }
    traceWasPushed.current = false;
    traceReturnAddress.current = null;
    globalThis.history.replaceState(null, "", current);
  }

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
          /* Grader setup belongs inside an opened trace, not above this list. */
          watchingProduction: null,
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

  /**
   * Whether the picker is open, and which agent a link named for it.
   *
   * **Which panel is open is in the address, and nowhere else.** That is the
   * whole of the blanket rule here: the action is a link to this same path with
   * `sheet=monitor` on it, so opening reloads nothing, Back closes it, and a
   * copied link reopens it. A route that names the panel outright — the retired
   * Start-monitoring address — wins over the query, because that address *is*
   * the panel.
   */
  const monitoring =
    forced !== undefined || query.get(SHEET_PARAMETER) === MONITOR_SHEET;
  const askedFor = forced?.agentId ?? query.get(AGENT_PARAMETER);

  /**
   * Close by taking the sheet out of the address and leaving everything else in
   * it — the chosen window above all, which this page keeps in the address of
   * its own accord. Replaced rather than pushed, so Back still means the page
   * before this one rather than the sheet again.
   */
  function closeSheet(): void {
    const asked = new URLSearchParams(globalThis.location.search);
    asked.delete(SHEET_PARAMETER);
    asked.delete(AGENT_PARAMETER);
    const rest = asked.toString();
    const home = transcriptsPath(projectId);
    router.replace(rest === "" ? home : `${home}?${rest}`);
  }

  /**
   * The address the action points at: **this one, whole.**
   *
   * The router's query plus the window this page keeps in the address itself.
   * The window is written with `history.replaceState`, which the router's own
   * hook never sees, so merging the page's settled choice back in is what stops
   * the sheet from throwing away a widened window on its way open.
   */
  const here = new URLSearchParams(query.toString());
  if (choice !== null) here.set(WINDOW_PARAMETER, choice);

  /**
   * The one action this screen offers, and the same control wherever it sits.
   *
   * **One page for every role, and the control that changes data is disabled
   * rather than removed.** Starting monitoring is `configure_monitoring`, which
   * a viewer does not have — the server refuses them either way, and that is
   * where the boundary actually is, but finding out after typing a Retell key
   * into a form is a poor way to be told. So a viewer sees what egma can do
   * here and is told plainly that this part is not theirs.
   *
   * **While the role is unknown there is no control at all.** A disabled one
   * would have to say why, and every sentence it could say would be a claim
   * about somebody egma has not identified yet.
   */
  const whyNotMonitor = `Your ${String(role)} role cannot start monitoring. Ask an organization admin to change your role.`;
  const monitorAnAgent =
    role === null ? undefined : mayAuthor ? (
      <Button asChild>
        <Link href={monitorAgentPath(projectId, here)}>{LIST.monitorAgent}</Link>
      </Button>
    ) : (
      <Button type="button" disabled why={whyNotMonitor}>
        {LIST.monitorAgent}
      </Button>
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
      <PageHeader title={LIST.title} toolbar={filters} action={monitorAnAgent} />
      <PageBody>
        {state.status === "failed" ? (
          <Failure
            message={state.why}
            onRetry={() => setAttempt((one) => one + 1)}
          />
        ) : null}
        {state.status === "loading" ? <Loading what={LIST.loadingWhat} /> : null}

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

        {quiet === "set-up-capture" ? <SetUp action={monitorAnAgent} /> : null}

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
              columns={columnsFor(projectId, openTrace)}
              rows={shownRows}
              keyOf={(row) => row.traceId}
              currentKey={openedTrace?.traceId}
              narrowLayout="scroll"
              tableMinWidth="62rem"
              onRowActivate={(row, opener) => openTrace(row, opener)}
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

      {monitoring ? (
        <MonitorAgentSheet
          projectId={projectId}
          askedFor={askedFor}
          /*
           * The gate travels with the panel. A viewer who opens the address
           * directly — a copied link, a bookmark — reaches the sheet, so the
           * sheet has to be the thing that refuses rather than the button that
           * usually opens it.
           */
          role={role}
          mayAuthor={mayAuthor}
          whyNot={whyNotMonitor}
          onClose={closeSheet}
          /*
           * Something started pulling, so this list is stale: the thirty-day
           * import the first switch-on runs lands behind it. Asking again is
           * the whole of the refresh — the read is the page.
           */
          onStarted={() => setAttempt((one) => one + 1)}
        />
      ) : null}

      {openedTrace === null ? null : (
        <TraceSheet
          projectId={projectId}
          opened={openedTrace}
          returnFocusTo={traceOpener}
          onClose={closeTrace}
        />
      )}
    </ProductPage>
  );
}

/**
 * Nothing has ever arrived here, which is the state monitoring exists for — so
 * it is where the one monitoring verb lives (board `JGS-0`). The
 * provider-specific teaching is inside the picker, once.
 */
function SetUp({ action }: { readonly action: ReactNode }) {
  return (
    <Empty title={QUIET.setUp.title} lead={QUIET.setUp.lead} action={action} />
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
 * The order is a judgement about scanning. The agent leads because it is the
 * quickest way to find the family of calls somebody means. The call's time,
 * duration and turn latency follow as one compact timing story, then the exact
 * trace id. The id remains the row's primary control: it opens the sheet and is
 * where focus returns when that sheet closes.
 *
 * The trace-id control carries the project and the window this exchange
 * happened in, taken from the two instants this very row is showing. That is
 * what makes the transcript a place somebody can be sent: the endpoint under
 * it requires both, and this row already knows the answers, so nobody has to.
 */
function columnsFor(
  projectId: string,
  openTrace: (row: Listed, opener?: HTMLElement | null) => void,
): readonly Column<Listed>[] {
  return [
    {
      key: "agent",
      header: TRACE_COLUMNS.agent,
      width: "203px",
      cell: (row) => {
        const name =
          row.platformAgentName.trim() ||
          row.platformAgentId.trim() ||
          row.agentId.trim();
        return name === "" ? <Nothing /> : name;
      },
    },
    {
      key: "time",
      header: TRACE_COLUMNS.time,
      width: "260px",
      mono: true,
      cell: (row) => (
        <ListInstant instant={row.startedAt} precision="second" />
      ),
    },
    {
      key: "duration",
      header: TRACE_COLUMNS.duration,
      width: "95px",
      mono: true,
      cell: (row) => howLong(row.durationNs),
    },
    {
      key: "p90-turn-latency",
      header: TRACE_COLUMNS.p90TurnLatency,
      width: "150px",
      mono: true,
      cell: (row) =>
        row.turnResponseLatencyP90Milliseconds === null ? (
          <Nothing />
        ) : (
          shownTurnLatency(
            row.turnResponseLatencyP90Milliseconds,
            row.turnResponseLatencyP90Partial
              ? TRACE_SHEET.overview.partial
              : undefined,
          )
        ),
    },
    {
      key: "trace-id",
      header: TRACE_COLUMNS.traceId,
      width: "240px",
      mono: true,
      primary: true,
      cell: (row) => (
        <button
          className="block max-w-full cursor-pointer truncate border-0 bg-transparent p-0 font-inherit text-left text-foreground underline decoration-border underline-offset-4 pointer-hover:decoration-foreground"
          type="button"
          title={row.traceId}
          onClick={(event) => openTrace(row, event.currentTarget)}
        >
          {row.traceId}
        </button>
      ),
    },
    {
      key: "actions",
      header: TRACE_COLUMNS.actions,
      action: true,
      cell: (row) => (
        <RowMenu label={`Actions for trace ${row.traceId}`}>
          {(close) => (
            <MenuItem
              href={transcriptPath(projectId, row)}
              onClick={close}
            >
              {TRACE_SHEET.actions.openFullTranscript}
            </MenuItem>
          )}
        </RowMenu>
      ),
    },
  ];
}
