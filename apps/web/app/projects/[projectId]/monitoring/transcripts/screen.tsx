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
import { monitoringSetupPath } from "../setup-path.ts";
import { TraceSheet, type OpenTrace } from "./trace-sheet.tsx";

/**
 * List this project's production traces newest first through the public API.
 * Send source=production, projectId, a bounded window, and page tokens. Keep
 * window selection in the URL; the page supplies the default 24-hour window.
 * Authenticate requests with the browser session.
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
 * Keep the reusable screen outside the Next route module's restricted exports.
 * Agent setup is owned by the Agents flow.
 */
export function TranscriptsScreen({
  projectId,
}: {
  readonly projectId: string;
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
   * When the selected window is empty, probe one production row in the widest
   * supported window. This checks recent history, not all-time history.
   * Keep pending, failed, and zero-result reads distinct.
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
   * Wait for supporting reads before selecting empty-state guidance. A refused
   * read is unknown, not a zero count.
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

  /*
   * A copied legacy `sheet=monitor` link cannot reopen the retired picker.
   * It forwards to the same Agents-owned flow as the visible action and keeps
   * an agent the old link named.
   */
  const legacySetup = query.get(SHEET_PARAMETER) === MONITOR_SHEET;
  const legacyAgentId = query.get(AGENT_PARAMETER);
  const replace = router.replace;
  useEffect(() => {
    if (!legacySetup) return;
    replace(
      monitoringSetupPath(
        projectId,
        legacyAgentId === null ? undefined : legacyAgentId,
      ),
    );
  }, [legacyAgentId, legacySetup, projectId, replace]);

  /**
   * Open agent setup with the monitoring goal. Hide the action while role is
   * unknown, then disable it with a reason when configure_monitoring is unavailable.
   */
  const whyNotMonitor = `Your ${String(role)} role cannot set up monitoring. Ask an organization admin to change your role.`;
  const setUpMonitoring =
    role === null ? undefined : mayAuthor ? (
      <Button asChild>
        <Link href={monitoringSetupPath(projectId)}>{LIST.monitorAgent}</Link>
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
      <PageHeader
        title={LIST.title}
        toolbar={filters}
        action={quiet === "set-up-capture" ? undefined : setUpMonitoring}
      />
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

        {quiet === "set-up-capture" ? <SetUp action={setUpMonitoring} /> : null}

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

/** Offer monitoring setup when the bounded recent-history probe finds no traces. */
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
 * Define headers and cells together to keep their order aligned. The trace-ID
 * control opens the sheet and restores focus on close; its detail URL carries
 * the project and the trace's time window.
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
