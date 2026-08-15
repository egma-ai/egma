"use client";

import { useEffect, useState, type ReactNode } from "react";

import {
  CONFIG,
  NOTHING,
  REQUIRED,
  RUNNING,
  RUNNING_COLUMNS,
  SCOPES,
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
 * **Read-only, like its sibling, and for a different reason.** There is nothing
 * to author here because the act that makes a row is pressing Use on the
 * library screen. What this page is for is the question a developer actually
 * has: what is judging my project, does it block, and where does it apply.
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

type Copy = {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly required: boolean;
  readonly config: { readonly assertions?: readonly unknown[] } | null;
};

type Answer = {
  readonly items: readonly Copy[];
};

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "failed"; why: string }
  | { status: "loaded"; rows: readonly Copy[] };

export default function RunningGradersPage() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let current = true;

    void fetch("/api/graders")
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
          setState({ status: "failed", why: said.message ?? RUNNING.unreachable });
          return;
        }
        const page = (await answer.json()) as Answer;
        setState({ status: "loaded", rows: page.items });
      })
      .catch(() => {
        if (current) setState({ status: "failed", why: RUNNING.unreachable });
      });

    return () => {
      current = false;
    };
  }, []);

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

  return (
    // WAVE TWO. The `active` prop this used to pass is gone: the shell reads
    // where you are out of the address now. This screen is organization-wide,
    // so there is no project in its address for the shell to read, and no
    // navigation item points here — see `GRADER_TABS` in `lib/presentation.ts`
    // for why. Wave two rebuilds it project-scoped; until then it is the
    // working reference for this copy and this form, reachable only by typing
    // the address.
    <AppShell>
      <ProductPage wide>
        <PageHeader eyebrow="Current project" title={RUNNING.title} lead={RUNNING.lead} />
        <GraderTabs active="running" />
        {state.status === "failed" ? <Notice tone="error">{state.why}</Notice> : null}
        {state.status === "loading" ? <Notice>{RUNNING.loading}</Notice> : null}

        {state.status === "loaded" ? (
          state.rows.length === 0 ? <Notice tone="error">{RUNNING.empty}</Notice> : (
            <>
              <div className={styles.listMeta}>
                <span>{RUNNING.counted(state.rows.length)}</span>
                <span>{RUNNING.order}</span>
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
                    <span><span>{scopeOf(row)}</span><span className={styles.muted}>{requiredOf(row)}</span></span>
                    <strong>{row.name}</strong>
                    <p>{configOf(row)}</p>
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
 * The columns, in the order they are shown, each beside what fills it.
 *
 * One list rather than a header row and a body row kept in step by hand — a
 * table whose third heading names its fourth value is a bug nobody sees in a
 * diff. The order is a judgement about scanning: which grader this is, then
 * where it applies, then whether it can fail a run, and what it checks last
 * because it is the widest.
 */
const COLUMN_ORDER: readonly (readonly [string, (row: Copy) => ReactNode])[] = [
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
];
