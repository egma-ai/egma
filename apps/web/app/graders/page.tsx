"use client";

import { useEffect, useState, type ReactNode } from "react";

import {
  COLUMNS,
  LIBRARY,
  NOTHING,
  OWNERS,
  TYPES,
  USE,
} from "../../lib/grader-library-copy.ts";
import { AppShell, Notice, PageHeader, ProductPage, StatePage, styles } from "../ui.tsx";
import { GraderTabs } from "./tabs.tsx";
import { UseForm, type Parameter } from "./use-form.tsx";

/**
 * The grader library: the shelf of definitions a developer picks from.
 *
 * **Nothing here is authored, and one thing here is pressed.** v0 ships a small
 * set of graders egma maintains, so there is nothing on this page to create and
 * nothing to edit — a team meets judgment logic that already works instead of
 * being asked to design some on their first day. What a developer does here is
 * press **Use**, which puts a running copy of an entry on their project; the
 * screen beside it lists those copies, and the strip under the heading is how
 * somebody gets between the two.
 *
 * **The Use form is drawn from the entry it is opened on.** Every entry
 * declares what pressing Use asks for, and that declaration arrives on this
 * answer — so latency draws a measure dropdown and a bound, expected behaviors
 * draws nothing at all, and this page has no opinion about either. A form
 * written per grader would be a copy of the platform's own declaration, drifting
 * the first time one changed.
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
  /**
   * What pressing Use asks for, as this entry declares it. Absent on an answer
   * from an older platform, which is an entry whose form asks nothing rather
   * than a page that breaks.
   */
  readonly params?: readonly Parameter[];
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
  /** The entry whose form is open, and nothing while none is. */
  const [using, setUsing] = useState<Entry | null>(null);
  /** What the last press came to, kept after the form closes so it can be read. */
  const [started, setStarted] = useState<string | null>(null);

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

        {/*
          What the last press came to, and it stays until the next one. A copy
          is judging from the moment it exists, so the sentence says that and
          points at the screen where it now appears.
        */}
        {started === null ? null : (
          <Notice tone="success">
            {USE.started(started)} <a href="/graders/running">{USE.seeRunning}</a>
          </Notice>
        )}

        {/*
          The form, opened on one entry at a time and drawn from that entry's own
          declaration. Inline rather than in a dialog: it is the one act on this
          screen, and a modal over a two-row table hides the thing being acted
          on for no benefit.

          **Keyed by the entry, which is what makes switching between two of them
          safe.** The form's state is the answers to *this* entry's questions —
          which measure is chosen, what was typed — and React keeps a component's
          state across a re-render when only its props change. So pressing Use on
          a second entry while the first one's form was open would draw the second
          entry's controls over the first entry's answers: the measure dropdown
          would exist with nothing selected, and a bound typed under it would be
          submitted with the measure missing, which the write door refuses with a
          message about a field the person can see is filled in.

          The key makes the two forms two components, so the second one starts
          from its own entry's defaults. It is one attribute instead of an effect
          that re-initialises state after the wrong thing has already rendered.
        */}
        {using === null ? null : (
          <section className={styles.settingsPanel} aria-labelledby="use-title">
            <h2 id="use-title">{USE.title(using.name)}</h2>
            <UseForm
              key={using.id}
              entry={using}
              onCancel={() => setUsing(null)}
              onStarted={(name) => {
                setUsing(null);
                setStarted(name);
              }}
            />
          </section>
        )}

        {state.status === "loaded" ? (
          state.rows.length === 0 ? <Notice>{LIBRARY.empty}</Notice> : (
            <>
              <div className={styles.listMeta}>
                <span>{LIBRARY.counted(state.rows.length)}</span>
                <span>{LIBRARY.order}</span>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.dataTable}>
                  <thead><tr>{columnsOf(setUsing).map(([heading]) => <th key={heading} scope="col">{heading}</th>)}</tr></thead>
                  <tbody>{state.rows.map((row) => <tr key={row.id}>{columnsOf(setUsing).map(([heading, fill]) => <td key={heading}><span className={styles.tableCell}>{fill(row)}</span></td>)}</tr>)}</tbody>
                </table>
              </div>
              <div className={styles.mobileRows}>
                {state.rows.map((row) => (
                  <div className={styles.mobileRow} key={row.id}>
                    <span><span>{typeOf(row)}</span><span className={styles.muted}>{ownerOf(row)}</span></span>
                    <strong>{row.name}</strong>
                    <p>{row.description ?? NOTHING}</p>
                    <UseButton entry={row} onUse={setUsing} />
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
 * The one act on this screen: start judging with this entry.
 *
 * It opens the form rather than writing anything, because every entry decides
 * for itself what pressing Use asks for — and an entry that asks nothing still
 * opens it, so that switching a grader on is always the same two steps and
 * never a button that quietly did something.
 */
function UseButton({
  entry,
  onUse,
}: {
  entry: Entry;
  onUse: (entry: Entry) => void;
}) {
  return (
    <button
      className={styles.buttonSecondary}
      type="button"
      onClick={() => onUse(entry)}
    >
      {USE.open}
    </button>
  );
}

/**
 * The columns, in the order they are shown, each beside what fills it.
 *
 * One list rather than a header row and a body row kept in step by hand — a
 * table whose third heading names its fourth value is a bug nobody sees in a
 * diff. The order is a judgement about scanning: what somebody looking down
 * this list wants is which grader this is, then what kind of thing it does,
 * then whose it is, then the sentence because it is the widest, and the action
 * last where a reader's eye ends up.
 *
 * A function rather than a constant because the last column presses something,
 * and what it presses belongs to the page's state rather than to this module.
 */
function columnsOf(
  onUse: (entry: Entry) => void,
): readonly (readonly [string, (row: Entry) => ReactNode])[] {
  return [
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
    [COLUMNS.use, (row) => <UseButton entry={row} onUse={onUse} />],
  ];
}
