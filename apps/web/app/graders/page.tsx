"use client";

import { useEffect, useState, type ReactNode } from "react";

import {
  COLUMNS,
  LIBRARY,
  NOTHING,
  OWNERS,
  TYPES,
} from "../../lib/grader-library-copy.ts";
import { AppShell, Notice, PageHeader, ProductPage, StatePage, styles } from "../ui.tsx";
import { GraderTabs } from "./tabs.tsx";

/**
 * The grader library: the shelf of definitions a developer picks from.
 *
 * **Read-only, and that is the product decision rather than an unfinished
 * screen.** v0 ships a small set of graders egma maintains, so there is nothing
 * on this page to create and nothing to edit — a team meets judgment logic that
 * already works instead of being asked to design some on their first day. The
 * screen beside it is the running graders: the copies a developer switches on,
 * each pointing back at an entry here, and the strip under the heading is how
 * somebody gets between the two.
 *
 * **Owner is the entry's own answer, printed rather than worked out.** The API
 * derives it from who the entry belongs to — egma's own entries belong to
 * nobody in particular, which is what makes them everybody's — so a row saying
 * `egma` and a row a team wrote can never be confused by anything this page
 * decides.
 *
 * **It reads the first page and stops there**, which is honest for a shelf that
 * holds exactly what egma ships. The endpoint pages like every other list and
 * hands back where it stopped; this screen ignores that, because a **Show more**
 * button under two rows would be a control nobody could ever press. The day the
 * shelf grows past a page — custom entries, which is the same change that gives
 * this screen something to author — is the day it grows the button, and the
 * answer already carries what that needs.
 *
 * Signed in with a browser session on the origin the page was served from, like
 * every other page here. There is no API key in a browser and there never will
 * be.
 */

type Entry = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: string;
  readonly owner: string;
};

type Answer = {
  readonly items: readonly Entry[];
};

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "failed"; why: string }
  | { status: "loaded"; rows: readonly Entry[] };

export default function GraderLibraryPage() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let current = true;

    void fetch("/api/grader-library")
      .then(async (answer) => {
        if (!current) return;
        if (answer.status === 401) {
          setState({ status: "signed-out" });
          return;
        }
        if (!answer.ok) {
          const said = (await answer.json().catch(() => ({}))) as {
            message?: string;
          };
          setState({ status: "failed", why: said.message ?? LIBRARY.unreachable });
          return;
        }
        const page = (await answer.json()) as Answer;
        setState({ status: "loaded", rows: page.items });
      })
      .catch(() => {
        if (current) setState({ status: "failed", why: LIBRARY.unreachable });
      });

    return () => {
      current = false;
    };
  }, []);

  if (state.status === "signed-out") {
    return (
      <StatePage title={LIBRARY.signedOut} lead={LIBRARY.signedOutLead}>
        <p className={styles.linkLine}>
          <a href="/sign-in">{LIBRARY.signIn}</a> ·{" "}
          <a href="/signup">{LIBRARY.setUp}</a>
        </p>
      </StatePage>
    );
  }

  return (
    <AppShell active="graders">
      <ProductPage wide>
        <PageHeader eyebrow="Current project" title={LIBRARY.title} lead={LIBRARY.lead} />
        <GraderTabs active="library" />
        {state.status === "failed" ? <Notice tone="error">{state.why}</Notice> : null}
        {state.status === "loading" ? <Notice>{LIBRARY.loading}</Notice> : null}

        {state.status === "loaded" ? (
          state.rows.length === 0 ? <Notice>{LIBRARY.empty}</Notice> : (
            <>
              <div className={styles.listMeta}>
                <span>{LIBRARY.counted(state.rows.length)}</span>
                <span>{LIBRARY.order}</span>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.dataTable}>
                  <thead><tr>{COLUMN_ORDER.map(([heading]) => <th key={heading} scope="col">{heading}</th>)}</tr></thead>
                  <tbody>{state.rows.map((row) => <tr key={row.id}>{COLUMN_ORDER.map(([heading, fill]) => <td key={heading}><span className={styles.tableCell}>{fill(row)}</span></td>)}</tr>)}</tbody>
                </table>
              </div>
              <div className={styles.mobileRows}>
                {state.rows.map((row) => (
                  <div className={styles.mobileRow} key={row.id}>
                    <span><span>{typeOf(row)}</span><span className={styles.muted}>{ownerOf(row)}</span></span>
                    <strong>{row.name}</strong>
                    <p>{row.description ?? NOTHING}</p>
                  </div>
                ))}
              </div>
            </>
          )
        ) : null}
      </ProductPage>
    </AppShell>
  );
}

/**
 * The stored word turned into the one a person reads — and left alone when it
 * is a word this page has never heard of.
 *
 * A platform newer than the page it is being read by is an ordinary thing on a
 * self-hosted product, and an unfamiliar word is a better answer than a blank
 * cell: one says "this is something you have not met", the other says "this row
 * has nothing in it".
 */
function typeOf(entry: Entry): string {
  return TYPES[entry.type] ?? entry.type;
}

function ownerOf(entry: Entry): string {
  return OWNERS[entry.owner] ?? entry.owner;
}

/**
 * The columns, in the order they are shown, each beside what fills it.
 *
 * One list rather than a header row and a body row kept in step by hand — a
 * table whose third heading names its fourth value is a bug nobody sees in a
 * diff. The order is a judgement about scanning: what somebody looking down
 * this list wants is which grader this is, then what kind of thing it does,
 * then whose it is, and the sentence last because it is the widest.
 */
const COLUMN_ORDER: readonly (readonly [string, (row: Entry) => ReactNode])[] = [
  [COLUMNS.name, (row) => <strong>{row.name}</strong>],
  [COLUMNS.type, (row) => typeOf(row)],
  [COLUMNS.owner, (row) => ownerOf(row)],
  [
    COLUMNS.description,
    (row) =>
      row.description === null ? (
        <span className={styles.muted}>{NOTHING}</span>
      ) : (
        <span>{row.description}</span>
      ),
  ],
];
