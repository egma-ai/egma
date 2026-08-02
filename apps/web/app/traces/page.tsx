"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  COLUMNS,
  LIST,
  WINDOWS,
  type WindowChoice,
} from "../../lib/transcript-copy.ts";
import {
  howLong,
  recentWindow,
  transcriptPath,
  whenItWas,
  type Listed,
  type ListPage,
} from "../../lib/transcripts.ts";
import { Card, Screen, styles } from "../ui.tsx";

/**
 * Everything your organization recorded, newest first.
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
  const [choice, setChoice] = useState<WindowChoice>("24h");
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState(false);

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
    let current = true;
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

  /** The next page, appended — the token says where the last one stopped. */
  async function showMore(after: string): Promise<void> {
    setBusy(true);
    try {
      const page = await ask(choice, after);
      if (page === null) return;
      setState((was) =>
        was.status === "loaded"
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
        value={choice}
        onChange={(event) => setChoice(event.target.value as WindowChoice)}
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
