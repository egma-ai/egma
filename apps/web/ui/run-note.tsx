"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Describe connection support for the selected tests' mock tools and env at
 * run setup. Include LiveKit SDK requirements and unsupported capabilities.
 * Compute notes from current selections; if limiting output, omit whole facts
 * rather than separating a title from its explanation.
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
 * two lines at most and are mutually exclusive, so the box a person actually
 * meets is one or two lines, and a third arrives only when a quiet not-used
 * fact stands behind a two-line one. The ceiling stays because it is what keeps
 * the box a box when a fact is added to the table above.
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

  /*
   * On LiveKit the SDK is the run itself, not an extra that mocking asks for.
   *
   * A LiveKit simulation whose agent never reports to egma fails, so the person
   * about to start the run has to read the requirement whether or not any test
   * mocks a tool. The requirement is therefore said on every LiveKit run, and
   * the mock-tools sentence joins it only when some test carries one — on
   * LiveKit the customer's own agent serves the mock, through that same SDK.
   */
  if (livekit) {
    groups.push({
      accent: "brand",
      lines: [
        "A LiveKit simulation needs the Egma SDK in your agent.",
        ...(mocks > 0
          ? [
              <>
                {`${carryOf(mocks, total)} mock tools. They are served only when your agent runs `}
                <Key>simulation(...)</Key>
                {". Tools a test does not mock run real, and every call is on the transcript."}
              </>,
            ]
          : []),
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
 * Nothing applying is an ordinary case — a Retell suite with no mock tools and
 * no env that connection would use says nothing, because there is nothing to
 * say. A LiveKit run always has the SDK requirement to say. The box is
 * therefore drawn or not drawn; it never stands open and empty under the
 * Connection field.
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
    <NoteBox
      accent={accent}
      slot="run-note"
      {...(className === undefined ? {} : { className })}
    >
      {lines.map((line, at) => (
        <NoteLine key={`run-note-${String(at)}`}>{line.text}</NoteLine>
      ))}
    </NoteBox>
  );
}

/**
 * The box a quiet fact about a run is drawn in, and the only one there is.
 *
 * The house hairline, the surface fill, no corner, no icon and no title, with
 * the edge carrying the warning colour where a fact is one a person has to
 * read before they act (founder, 2026-09-04). It is exported because a second
 * surface says a second kind of fact in it — why a run's queued work is
 * waiting — and two copies of a box is how a product ends up with two box
 * looks: the next change to this one reaches only one of them.
 *
 * The words always say the news themselves, so the colour stays supporting
 * information, as `DESIGN.md` requires.
 */
export function NoteBox({
  accent,
  slot,
  className,
  children,
}: {
  readonly accent: RunNoteAccent;
  /** What this box is, for the stylesheet and for a test. */
  readonly slot: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border bg-surface p-3",
        accent === "warning" ? "border-warning" : "border-border",
        className,
      )}
      data-accent={accent}
      data-slot={slot}
      role="note"
    >
      {children}
    </div>
  );
}

/** One line inside a note box. Quiet ink at the product's own reading size. */
export function NoteLine({ children }: { readonly children: ReactNode }) {
  return (
    <p className="m-0 text-sm leading-(--line-normal) text-faint">{children}</p>
  );
}
