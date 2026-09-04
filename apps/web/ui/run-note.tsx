"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * What this run's connection will and will not do with the tests' own data.
 *
 * **A test carries mock tools and env now, and a connection either uses them or
 * cannot.** A person about to start a run has to know which, because the
 * failure this exists to stop is somebody believing a call was mocked when it
 * reached their real backend. The support table below is the whole of the rule.
 *
 * **It is one quiet box, under the Connection field of the run-start sheet**
 * (founder, 2026-09-04): the house hairline, the surface fill, no corner, no
 * icon and no title. Muted text at the table's 14px, one short line per fact,
 * two of them in the ordinary case. The box's own edge carries the warning
 * colour where a connection cannot use what a test holds, so a "cannot use"
 * case is still read before an informative one without a coloured bar beside
 * every line. The words themselves say "cannot", so the colour stays
 * supporting information rather than the whole of the news.
 *
 * **The note is said once, where the choice is made.** It used to be drawn on
 * the run page as well, from the versions that run's simulations pinned. That
 * reading cost two walks of the run — every page of simulations, then every
 * version they named — to repeat a sentence the person had already read and
 * acted on, at the one moment they can no longer act on it. (Founder,
 * 2026-09-04.)
 *
 * **A fact is a title and the lines that explain it, and the ceiling drops a
 * fact whole.** Cutting the list wherever the last line fell left a title
 * standing with its explanation gone — a note that names a rule and never says
 * what the rule is.
 *
 * **Nothing here is stored.** The lines are computed from the connection and
 * the suite's tests every time they are drawn. Two runs of one suite can
 * therefore say different things, which is the truth.
 */

/** How loudly one line speaks, and the only three volumes there are. */
export type RunNoteAccent = "warning" | "brand" | "quiet";

/** One fact, and how loudly it is said. */
export type RunNoteLine = {
  readonly accent: RunNoteAccent;
  readonly text: ReactNode;
};

/** What each test in the run carries, which is all this note reads of it. */
export type RunNoteTest = {
  readonly mockTools: readonly unknown[];
  readonly env: {
    readonly retell_dynamic_variables?: unknown;
    readonly job_dispatch_metadata?: unknown;
  } | null;
};

/** The connection a run is conducted over, as this note reads it. */
export type RunNoteConnection = {
  readonly connectionType: string;
};

/**
 * At most this many lines, however many facts apply.
 *
 * Three is the ceiling rather than the ordinary case: the loud groups below are
 * two lines each and are mutually exclusive, so the box a person actually meets
 * is two lines, and a third arrives only when a quiet not-used fact stands
 * behind one of them. The ceiling stays because it is what keeps the box a box
 * when a fact is added to the table above.
 */
const LINES_AT_MOST = 3;

/**
 * One fact: the title that opens it, and the lines that explain it.
 *
 * A group is kept or dropped whole. The alternative — cutting at the ceiling
 * wherever the ceiling falls — leaves a title standing over nothing, so the
 * note names a rule and never says what the rule is.
 */
type RunNoteGroup = {
  readonly accent: RunNoteAccent;
  readonly lines: readonly ReactNode[];
};

/** Warning first, then information, then the quiet not-used facts. */
const VOLUME: Readonly<Record<RunNoteAccent, number>> = {
  warning: 0,
  brand: 1,
  quiet: 2,
};

/** A platform's own word, drawn as the identifier it is. */
function Key({ children }: { readonly children: string }) {
  return <code className="font-mono">{children}</code>;
}

/** `1 test carries`, `2 tests carry` — the quiet lines' own opening. */
function carry(count: number): string {
  return count === 1 ? "1 test carries" : `${String(count)} tests carry`;
}

/**
 * `1 of 3 tests carries`, `2 of 3 tests carry` — the counted lines' opening.
 *
 * The subject is the count, not the suite, so one test carries and two carry.
 */
function carryOf(count: number, total: number): string {
  return (
    `${String(count)} of ${String(total)} tests ` +
    (count === 1 ? "carries" : "carry")
  );
}

/**
 * Which of the tests carry something, counted once for every line below.
 *
 * The three facts are separate because a connection can support one and not
 * another: a Retell phone call passes neither mock tools nor dynamic
 * variables, while a LiveKit connection of either kind carries a test's
 * dispatch metadata — on its own dispatch where egma holds the key pair, and
 * inside the token request where the customer's endpoint mints the token.
 */
function counted(tests: readonly RunNoteTest[]): {
  readonly total: number;
  readonly mocks: number;
  readonly retellVars: number;
  readonly dispatch: number;
} {
  let mocks = 0;
  let retellVars = 0;
  let dispatch = 0;
  for (const test of tests) {
    if (test.mockTools.length > 0) mocks += 1;
    if (test.env?.retell_dynamic_variables !== undefined) retellVars += 1;
    if (test.env?.job_dispatch_metadata !== undefined) dispatch += 1;
  }
  return { total: tests.length, mocks, retellVars, dispatch };
}

/**
 * The lines this connection and these tests produce, in the order they are read.
 *
 * Exported on its own so the table itself can be asked questions in a test
 * without rendering anything.
 */
export function runNoteLines(
  connection: RunNoteConnection,
  tests: readonly RunNoteTest[],
): readonly RunNoteLine[] {
  const { total, mocks, retellVars, dispatch } = counted(tests);
  if (total === 0) return [];
  const groups: RunNoteGroup[] = [];

  const retell =
    connection.connectionType === "retell_text_mode" ||
    connection.connectionType === "retell_web_call" ||
    connection.connectionType === "retell_chat_api" ||
    connection.connectionType === "phone_number";
  const livekit = connection.connectionType === "livekit_room";

  /*
   * A phone call is the customer's own published number answered by Retell.
   *
   * There is no line above these saying that some data will not be used: each
   * line says "cannot" itself, and the box's warning edge says it again. A
   * summary sentence over two sentences that already summarize themselves is
   * the title this note is not allowed to have.
   */
  if (
    connection.connectionType === "phone_number" &&
    (mocks > 0 || retellVars > 0)
  ) {
    groups.push({
      accent: "warning",
      lines: [
        ...(mocks > 0
          ? [
              `${carryOf(mocks, total)} mock tools. A Retell phone connection cannot mock tools, so those simulations reach your real tools.`,
            ]
          : []),
        ...(retellVars > 0
          ? [
              `${carryOf(retellVars, total)} Retell dynamic variables. A phone call is answered by Retell, not created by Egma, so they cannot be passed.`,
            ]
          : []),
      ],
    });
  }

  /*
   * One temporary version per run, and only when some test mocks.
   *
   * Two lines: what the run does to the agent, then what that means for the
   * tools. The second line speaks of tests in general — "tools a test does not
   * mock" — so it covers the tests that mock nothing without a third line
   * counting them out loud.
   */
  if (connection.connectionType === "retell_web_call" && mocks > 0) {
    groups.push({
      accent: "brand",
      lines: [
        "This run creates one temporary version of your Retell agent and deletes it when the run ends. Your serving version is never changed.",
        `${carryOf(mocks, total)} mock tools. Tools a test does not mock reach your real backend.`,
      ],
    });
  }

  /* On LiveKit the customer's own agent serves the mock, through the SDK. */
  if (livekit && mocks > 0) {
    groups.push({
      accent: "brand",
      lines: [
        "Mock tools on LiveKit need the Egma SDK in your agent.",
        <>
          {`${carryOf(mocks, total)} mock tools. They are served only when your agent runs `}
          <Key>mockable(...)</Key>
          {". Tools a test does not mock run real."}
        </>,
      ],
    });
  }

  /*
   * And the two quiet facts: data the other platform simply has no use for.
   * Each is one line and its own group, because each says the whole of itself.
   */
  if (livekit && retellVars > 0) {
    groups.push({
      accent: "quiet",
      lines: [
        <>
          {`${carry(retellVars)} `}
          <Key>retell_dynamic_variables</Key>
          {", which a LiveKit connection does not use."}
        </>,
      ],
    });
  }
  if (retell && dispatch > 0) {
    groups.push({
      accent: "quiet",
      lines: [
        <>
          {`${carry(dispatch)} `}
          <Key>job_dispatch_metadata</Key>
          {", which a Retell connection does not use."}
        </>,
      ],
    });
  }

  /*
   * Loudest first, and never more than the ceiling. `toSorted` is stable, so
   * two groups at one volume stay in the order they were written here.
   *
   * **A group goes in whole or not at all**, and the note stops at the first
   * one that does not fit. Half a group is a fact with its explanation cut
   * off, and letting a quieter group in behind a dropped one would show the
   * lesser fact and hide the greater — the opposite of what the order is for.
   */
  const kept: RunNoteLine[] = [];
  for (const group of groups.toSorted(
    (left, right) => VOLUME[left.accent] - VOLUME[right.accent],
  )) {
    if (kept.length + group.lines.length > LINES_AT_MOST) break;
    for (const text of group.lines) kept.push({ accent: group.accent, text });
  }
  return kept;
}

/**
 * The note itself, or nothing at all when nothing applies.
 *
 * Nothing applying is the ordinary case — a suite of tests with no mock tools
 * and no env on a connection that would use them says nothing, because there
 * is nothing to say. The box is therefore drawn or not drawn; it never stands
 * open and empty under the Connection field.
 */
export function RunNote({
  className,
  connection,
  tests,
}: {
  /**
   * Where the note sits, which is the caller's business and not this file's.
   *
   * It is here rather than a margin of its own because the note draws nothing
   * at all when nothing applies, and a margin written inside would leave a gap
   * on every ordinary run.
   */
  readonly className?: string;
  readonly connection: RunNoteConnection;
  readonly tests: readonly RunNoteTest[];
}) {
  const lines = runNoteLines(connection, tests);
  if (lines.length === 0) return null;
  /* The lines are already loudest first, so the first one names the box. */
  const accent = lines[0]?.accent ?? "quiet";
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border bg-surface p-3",
        accent === "warning" ? "border-warning" : "border-border",
        className,
      )}
      data-accent={accent}
      data-slot="run-note"
      role="note"
    >
      {lines.map((line, at) => (
        <p
          className="m-0 text-sm leading-(--line-normal) text-faint"
          key={`run-note-${String(at)}`}
        >
          {line.text}
        </p>
      ))}
    </div>
  );
}
