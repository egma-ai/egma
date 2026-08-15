"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  CONFIG,
  EDIT,
  NOTHING,
  REQUIRED,
  RUNNING,
  RUNNING_COLUMNS,
  SCOPES,
  SWITCH_OFF,
} from "../../../lib/grader-running-copy.ts";
import {
  AppShell,
  Notice,
  PageHeader,
  ProductPage,
  StatePage,
  styles,
} from "../../ui.tsx";
import { GraderTabs } from "../tabs.tsx";
import type { Parameter } from "../use-form.tsx";
import { EditForm, SwitchOffPanel, type Copy } from "./edit-form.tsx";

/**
 * The running graders: the copies this project is actually judged by.
 *
 * **The sibling of the library screen, and the difference between them is the
 * whole redesign.** The shelf holds definitions nobody is judging with; this
 * holds the copies that are. Every row here points back at an entry over there,
 * and the definition — the judge prompt, the words a model is sent — is read
 * through that pointer rather than shown here, because it lives in exactly one
 * place and this screen is not it.
 *
 * **Two acts, and they are the ones the shelf cannot do.** Pressing Use over
 * there makes a copy; changing what that copy judges by and switching it off
 * are decisions about a grader that already exists, so they belong here. Before
 * they did, a bound typed too tight was permanent — every run red for ever,
 * with no way back short of somebody editing the database by hand.
 *
 * **The edit form is drawn from the library entry, not from this page.** What a
 * grader asks for is the entry's own declaration, so this screen reads the
 * shelf beside the copies and hands each copy its entry's parameters. That is
 * why there is no measure name and no bound anywhere in this file: a form
 * written per grader would be a second copy of the platform's declaration,
 * drifting the first time one changed.
 *
 * **It reads the first page and stops there**, which is honest for a list that
 * starts at one row and grows by however many graders a team switches on. The
 * endpoint pages like every other list and hands back where it stopped; this
 * screen ignores that, and the day a project has more graders than a page is
 * the day it grows the button, with the answer already carrying what that
 * needs.
 *
 * Signed in with a browser session on the origin the page was served from, like
 * every other page here. There is no API key in a browser and there never will
 * be.
 */

type Answer = {
  readonly items: readonly Copy[];
};

/** One entry on the shelf, read for the one thing this screen needs off it. */
type Entry = {
  readonly id: string;
  readonly params?: readonly Parameter[];
};

type Shelf = {
  readonly items: readonly Entry[];
};

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "failed"; why: string }
  | {
      status: "loaded";
      rows: readonly Copy[];
      /** What each entry asks for, by the entry's own id. */
      asks: ReadonlyMap<string, readonly Parameter[]>;
    };

/** Which copy has a panel open under the heading, and which panel it is. */
type Open =
  | { readonly act: "edit"; readonly copy: Copy }
  | { readonly act: "switch-off"; readonly copy: Copy }
  | null;

export default function RunningGradersPage() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [open, setOpen] = useState<Open>(null);
  /** What the last act came to, kept after the panel closes so it can be read. */
  const [said, setSaid] = useState<string | null>(null);

  /**
   * The copies and the shelf behind them, together.
   *
   * Both, because a row cannot be edited without knowing what its entry asks
   * for — and one state rather than two, because a page that had the copies and
   * not yet their entries would draw an edit form with no controls in it and
   * look like a grader that asks nothing.
   */
  const read = useCallback(async (): Promise<void> => {
    try {
      const [listed, shelf] = await Promise.all([
        fetch("/api/graders"),
        fetch("/api/grader-library"),
      ]);

      if (listed.status === 401 || shelf.status === 401) {
        setState({ status: "signed-out" });
        return;
      }
      if (!listed.ok || !shelf.ok) {
        const refused = listed.ok ? shelf : listed;
        const why = (await refused.json().catch(() => ({}))) as {
          message?: string;
        };
        setState({ status: "failed", why: why.message ?? RUNNING.unreachable });
        return;
      }

      const page = (await listed.json()) as Answer;
      const entries = (await shelf.json()) as Shelf;
      setState({
        status: "loaded",
        rows: page.items,
        asks: new Map(
          entries.items.map((entry) => [entry.id, entry.params ?? []] as const),
        ),
      });
    } catch {
      setState({ status: "failed", why: RUNNING.unreachable });
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  if (state.status === "signed-out") {
    return (
      <StatePage title={RUNNING.signedOut} lead={RUNNING.signedOutLead}>
        <p className={styles.linkLine}>
          <a href="/sign-in">{RUNNING.signIn}</a> ·{" "}
          <a href="/signup">{RUNNING.setUp}</a>
        </p>
      </StatePage>
    );
  }

  const settled = (sentence: string): void => {
    setOpen(null);
    setSaid(sentence);
    void read();
  };

  return (
    <AppShell active="graders">
      <ProductPage wide>
        <PageHeader eyebrow="Current project" title={RUNNING.title} lead={RUNNING.lead} />
        <GraderTabs active="running" />
        {state.status === "failed" ? <Notice tone="error">{state.why}</Notice> : null}
        {state.status === "loading" ? <Notice>{RUNNING.loading}</Notice> : null}

        {/*
          What the last act came to, and it stays until the next one. Both
          sentences say what changed *and* what did not, because the question
          somebody has after saving a tighter bound or switching a grader off is
          always about the runs they have already read.
        */}
        {said === null ? null : <Notice tone="success">{said}</Notice>}

        {/*
          The panel, opened on one copy at a time and keyed by it — the Use
          form's rule, for the Use form's reason. The form's state is *this*
          copy's answers, and React keeps a component's state across a re-render
          when only its props change, so opening a second row's form over the
          first would draw the second grader's controls over the first grader's
          values.
        */}
        {open === null ? null : (
          <section className={styles.settingsPanel} aria-labelledby="act-title">
            <h2 id="act-title">
              {open.act === "edit"
                ? EDIT.title(open.copy.name)
                : SWITCH_OFF.title(open.copy.name)}
            </h2>
            {open.act === "edit" ? (
              <EditForm
                key={`edit-${open.copy.id}`}
                copy={open.copy}
                params={
                  (state.status === "loaded"
                    ? state.asks.get(open.copy.library_id)
                    : undefined) ?? []
                }
                onCancel={() => setOpen(null)}
                onSaved={(name) => settled(EDIT.saved(name))}
              />
            ) : (
              <SwitchOffPanel
                key={`off-${open.copy.id}`}
                copy={open.copy}
                onCancel={() => setOpen(null)}
                onSwitchedOff={(name) => settled(SWITCH_OFF.done(name))}
              />
            )}
          </section>
        )}

        {state.status === "loaded" ? (
          state.rows.length === 0 ? <Notice tone="error">{RUNNING.empty}</Notice> : (
            <>
              <div className={styles.listMeta}>
                <span>{RUNNING.counted(state.rows.length)}</span>
                <span>{RUNNING.order}</span>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.dataTable}>
                  <thead><tr>{columnsOf(setOpen).map(([heading]) => <th key={heading} scope="col">{heading}</th>)}</tr></thead>
                  <tbody>{state.rows.map((row) => <tr key={row.id}>{columnsOf(setOpen).map(([heading, fill]) => <td key={heading}><span className={styles.tableCell}>{fill(row)}</span></td>)}</tr>)}</tbody>
                </table>
              </div>
              <div className={styles.mobileRows}>
                {state.rows.map((row) => (
                  <div className={styles.mobileRow} key={row.id}>
                    <span><span>{scopeOf(row)}</span><span className={styles.muted}>{requiredOf(row)}</span></span>
                    <strong>{row.name}</strong>
                    <p>{configOf(row)}</p>
                    <Acts copy={row} onOpen={setOpen} />
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
function scopeOf(copy: Copy): string {
  return SCOPES[copy.scope] ?? copy.scope;
}

function requiredOf(copy: Copy): string {
  return copy.required ? REQUIRED.yes : REQUIRED.no;
}

/**
 * What this copy checks, in one cell.
 *
 * **No filled-in values is a complete answer here.** A grader whose assertions
 * are the test's own expected behaviors has nothing for anybody to type, so the
 * cell says what it checks instead of showing a zero — a count of nought would
 * read as a grader somebody forgot to finish.
 */
function configOf(copy: Copy): string {
  const assertions = copy.config?.assertions;
  if (!Array.isArray(assertions) || assertions.length === 0) {
    return CONFIG.fromTheTest;
  }
  return CONFIG.counted(assertions.length);
}

/**
 * The two acts on a row, side by side and both opening a panel rather than
 * doing anything.
 *
 * Switching off opens one for the same reason Use does: it says what stops and
 * what stays before anybody presses the button, and a delete that happened on
 * the first click would be a button that quietly removed a project's judging.
 */
function Acts({
  copy,
  onOpen,
}: {
  copy: Copy;
  onOpen: (open: Open) => void;
}) {
  return (
    <span className={styles.buttonRow}>
      <button
        className={styles.buttonSecondary}
        type="button"
        onClick={() => onOpen({ act: "edit", copy })}
      >
        {EDIT.open}
      </button>
      <button
        className={styles.buttonDanger}
        type="button"
        onClick={() => onOpen({ act: "switch-off", copy })}
      >
        {SWITCH_OFF.open}
      </button>
    </span>
  );
}

/**
 * The columns, in the order they are shown, each beside what fills it.
 *
 * One list rather than a header row and a body row kept in step by hand — a
 * table whose third heading names its fourth value is a bug nobody sees in a
 * diff. The order is a judgement about scanning: which grader this is, then
 * where it applies, then whether it can fail a run, then what it checks because
 * it is the widest, and the buttons last where a reader's eye ends up.
 *
 * A function rather than a constant because the last column presses something,
 * and what it presses belongs to the page's state rather than to this module.
 */
function columnsOf(
  onOpen: (open: Open) => void,
): readonly (readonly [string, (row: Copy) => ReactNode])[] {
  return [
    [RUNNING_COLUMNS.name, (row) => <strong>{row.name}</strong>],
    [RUNNING_COLUMNS.scope, (row) => scopeOf(row)],
    [RUNNING_COLUMNS.required, (row) => requiredOf(row)],
    [
      RUNNING_COLUMNS.config,
      (row) =>
        row.config === null ? (
          <span className={styles.muted}>{NOTHING}</span>
        ) : (
          <span>{configOf(row)}</span>
        ),
    ],
    [RUNNING_COLUMNS.actions, (row) => <Acts copy={row} onOpen={onOpen} />],
  ];
}
