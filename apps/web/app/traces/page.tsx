"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  COLUMNS,
  DEFAULT_WINDOW,
  LIST,
  WINDOWS,
  type WindowChoice,
} from "../../lib/transcript-copy.ts";
import {
  howLong,
  recentWindow,
  transcriptPath,
  whenItWas,
  WINDOW_PARAMETER,
  windowChoiceOf,
  type Listed,
  type ListPage,
} from "../../lib/transcripts.ts";
import { Card, Screen, styles } from "../ui.tsx";

/**
 * Everything this project recorded, newest first.
 *
 * *This project* rather than this organization, and the distinction is the
 * store's rather than this page's: a browser is always acting inside one
 * project, so this list is that project's. Telemetry exported with a key that
 * names the whole organization files outside every project, and `LIST.empty`
 * says so where somebody would otherwise conclude their exporter is broken.
 *
 * The first page of the dashboard, and deliberately the **first consumer of the
 * public v1 contract** rather than of a private one built for it: what a
 * customer integrates against is what egma's own screen is drawn from, so a
 * contract that cannot answer a question a person actually has fails here
 * first, while it is still cheap to change.
 *
 * Two things about the request are the store's discipline showing through, and
 * both are load-bearing:
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
  | { status: "signed-out" }
  | { status: "failed"; why: string }
  | { status: "loaded"; rows: readonly Listed[]; more: string | null };

export default function TranscriptsPage() {
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
  const [busy, setBusy] = useState(false);

  /**
   * Which window the rows on screen belong to, readable from inside a promise
   * that was started under a different one. See `showMore`.
   */
  const showing = useRef<WindowChoice | null>(null);

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
      window: WindowChoice,
      after: string | null,
    ): Promise<ListPage | null> => {
      const asked = new URLSearchParams(recentWindow(window, new Date()));
      if (after !== null) asked.set("cursor", after);

      const answer = await fetch(`/v1/traces?${asked.toString()}`);
      if (answer.status === 401) {
        setState({ status: "signed-out" });
        return null;
      }
      if (!answer.ok) {
        const said = (await answer.json().catch(() => ({}))) as {
          message?: string;
        };
        setState({ status: "failed", why: said.message ?? LIST.unreachable });
        return null;
      }
      return (await answer.json()) as ListPage;
    },
    [],
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
  }, [ask, choice]);

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

  if (state.status === "signed-out") {
    return (
      <Card title={LIST.signedOut} lead={LIST.signedOutLead}>
        <p style={styles.aside}>
          <a href="/sign-in">{LIST.signIn}</a> ·{" "}
          <a href="/signup">{LIST.setUp}</a>
        </p>
      </Card>
    );
  }

  // Where the last page stopped, hoisted so it is a value the button below can
  // close over rather than a field that might have changed by the time it does.
  const more = state.status === "loaded" ? state.more : null;

  const chooser = (
    <span style={{ fontSize: "0.875rem" }}>
      <label style={{ color: "#666", marginRight: "0.5rem" }} htmlFor="window">
        {LIST.window}
      </label>
      <select
        id="window"
        style={{ fontFamily: "inherit" }}
        value={choice ?? DEFAULT_WINDOW}
        onChange={(event) => {
          choose(windowChoiceOf(event.target.value));
        }}
      >
        {WINDOWS.map((one) => (
          <option key={one.id} value={one.id}>
            {one.label}
          </option>
        ))}
      </select>
    </span>
  );

  return (
    <Screen title={LIST.title} lead={LIST.lead} aside={chooser}>
      {state.status === "failed" ? (
        <p style={styles.problem}>{state.why}</p>
      ) : null}

      {state.status === "loading" ? <p style={styles.lead}>{LIST.loading}</p> : null}

      {state.status === "loaded" ? (
        state.rows.length === 0 ? (
          <p style={styles.lead}>{LIST.empty}</p>
        ) : (
          <>
            <div style={styles.scroller}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {COLUMN_ORDER.map(([heading]) => (
                      <th key={heading} scope="col" style={styles.columnHeading}>
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.rows.map((row) => (
                    <tr key={row.trace_id}>
                      {COLUMN_ORDER.map(([heading, fill]) => (
                        <td key={heading} style={styles.cell}>
                          {fill(row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p style={styles.aside}>
              {LIST.counted(state.rows.length)}
              {more === null ? null : (
                <>
                  {" · "}
                  <button
                    type="button"
                    disabled={busy}
                    style={{ fontFamily: "inherit" }}
                    onClick={() => {
                      void showMore(more);
                    }}
                  >
                    {busy ? LIST.loadingMore : LIST.showMore}
                  </button>
                </>
              )}
            </p>
          </>
        )
      ) : null}

      <p style={styles.aside}>
        <a href="/">{LIST.back}</a>
      </p>
    </Screen>
  );
}

/** Nothing recorded for this column, which is a different thing from a zero. */
function Nothing() {
  return <span style={styles.muted}>{LIST.nothing}</span>;
}

/**
 * The columns, in the order they are shown, each beside what fills it.
 *
 * One list rather than a header row and a body row that have to be kept in the
 * same order by hand — a table whose ninth heading names its tenth value is a
 * bug nobody sees in a diff.
 *
 * The order is a judgement about scanning. What somebody looking down this list
 * is trying to find is the exchange they mean, so when it happened, how long it
 * ran, how much was said and **what the human opened with** come first; how it
 * was recorded and reached comes after.
 *
 * The link is on the first column and it carries the window this exchange
 * happened in, taken from the two instants this very row is showing. That is
 * what makes the transcript a place somebody can be sent: the endpoint under it
 * requires a window, and this row already knows the answer, so nobody has to.
 */
const COLUMN_ORDER: readonly (readonly [
  string,
  (row: Listed) => ReactNode,
])[] = [
  [
    COLUMNS.started,
    (row) => <a href={transcriptPath(row)}>{whenItWas(row.started_at)}</a>,
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
    (row) =>
      row.preview === "" ? (
        <Nothing />
      ) : (
        <span style={{ whiteSpace: "normal" }}>{row.preview}</span>
      ),
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
        <strong style={styles.wrong}>{row.errored_span_count}</strong>
      ),
  ],
  [COLUMNS.source, (row) => row.source],
  [COLUMNS.environment, (row) => row.environment],
  [COLUMNS.connection, (row) => row.connection_type],
];
