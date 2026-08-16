"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { readJson } from "../../../../../lib/api.ts";
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
  howLong,
  namesWholeOrganization,
  productionListPath,
  quietState,
  recentWindow,
  transcriptPath,
  watchesProduction,
  whenItWas,
  WINDOW_PARAMETER,
  windowChoiceOf,
  type Listed,
  type ListPage,
  type Quiet,
} from "../../../../../lib/transcripts.ts";
import { ButtonLink, Select } from "../../../../../ui/controls.tsx";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Empty, Failure, Loading } from "../../../../../ui/page-state.tsx";
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
import setup from "./setup.module.css";

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
   * The graders answer is this project's; the keys answer is the
   * organization's, because a key is minted against the customer even when it
   * names one project. Neither is asked about a window: what each says is true
   * of the project rather than of the last day.
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
   * Which of the three quiet states this page is in, or none.
   *
   * Nothing at all while either supporting read is still out, and that wait is
   * deliberate: guessing would put the setup teaching on screen for a moment in
   * front of somebody whose real trouble is a key that names the organization,
   * and guidance that flickers between two different instructions is worse than
   * guidance that arrives a beat late.
   */
  const quiet: Quiet | null =
    state.status !== "loaded" || graders === null || keys === null
      ? null
      : quietState({
          listed: state.rows.length,
          organizationWideKeys:
            keys.status === "ready"
              ? rowsIn(keys.value.keys).filter(namesWholeOrganization).length
              : 0,
          watchingProduction:
            graders.status === "ready"
              ? graders.value.items.filter(watchesProduction).length
              : 0,
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
            columns={columnsFor(projectId)}
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
 */
function SetUp({ projectId }: { readonly projectId: string }) {
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(globalThis.location.origin);
  }, []);

  return (
    <Empty
      title={QUIET.setUp.title}
      lead={QUIET.setUp.lead}
      action={
        <div className={setup.setUp}>
          <p className={setup.note}>{QUIET.setUp.endpoint}</p>
          <pre className={setup.address}>{origin}</pre>
          <p className={setup.note}>{QUIET.setUp.variables}</p>
          <pre className={setup.exports}>{QUIET.setUp.exports(origin)}</pre>
          <p className={setup.note}>{QUIET.setUp.keyLead}</p>
          <ButtonLink weight="strong" href={settingsPath(projectId, "keys")}>
            {QUIET.setUp.key}
          </ButtonLink>
        </div>
      }
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
function columnsFor(projectId: string): readonly Column<Listed>[] {
  const order: readonly (readonly [string, (row: Listed) => ReactNode])[] = [
    [
      COLUMNS.started,
      (row) => (
        <Link href={transcriptPath(projectId, row)}>
          {whenItWas(row.started_at)}
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
    mono: index === 0,
  }));
}

/** Keep the exchange, when it happened, and any failure legible on a phone. */
const MOBILE_COLUMNS = new Set<string>([
  COLUMNS.started,
  COLUMNS.duration,
  COLUMNS.preview,
  COLUMNS.errors,
]);

const WINDOW_OPTIONS = WINDOWS.map((window) => ({
  value: window.id,
  label: window.label,
}));
