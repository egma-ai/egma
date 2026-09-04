"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * What this run's connection will and will not do with the tests' own data.
 *
 * **A test carries mock tools and env now, and a connection either uses them or
 * cannot.** A person about to start a run — or reading one that already ran —
 * has to know which, because the failure this exists to stop is somebody
 * believing a call was mocked when it reached their real backend. The support
 * table below is the whole of the rule, and the words are the ones agreed on
 * 2026-09-03.
 *
 * **It is never in the face** (founder, 2026-09-03): no coloured box, no icon,
 * no title bar. One quiet line per fact, muted text at the table's 14px, at
 * most three lines, with a thin left-edge accent — the warning colour for
 * "cannot use", the brand colour for information, and the plain hairline for a
 * fact about data this platform simply has no use for. The first line is the
 * agreed title in that same muted text rather than a heading, because a
 * heading would make a quiet note into a section of the page.
 *
 * **A fact is a title and the lines that explain it, and the three-line
 * ceiling drops a fact whole.** More facts than fit is an ordinary case on a
 * Retell lane whose suite also carries LiveKit's dispatch metadata, and
 * cutting the list at three lines wherever three lines fell left the last
 * title standing with its explanation gone — a note that names a rule and
 * never says what the rule is.
 *
 * **Nothing here is stored.** The lines are computed from the connection and
 * the tests every time they are drawn: on the run-start sheet from the suite's
 * current tests, on the run page from the versions its simulations pinned. Two
 * runs of one suite can therefore say different things, which is the truth.
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

/** At most this many lines, however many facts apply. */
const LINES_AT_MOST = 3;

/**
 * One fact: the title that opens it, and the lines that explain it.
 *
 * A group is kept or dropped whole. The alternative — cutting at three lines
 * wherever three lines fall — leaves a title standing over nothing, so the
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

const EDGE: Readonly<Record<RunNoteAccent, string>> = {
  warning: "border-warning",
  brand: "border-brand",
  quiet: "border-border",
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

/** What the tests that mock nothing do, said about one or about many. */
function theOthers(rest: number): string {
  return rest === 1
    ? "The other test runs on your serving version with all real tools."
    : `The other ${String(rest)} tests run on your serving version with all real tools.`;
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
 * Exported on its own so both surfaces read one function rather than two
 * copies of one table, and so the table itself can be asked questions in a
 * test without rendering anything.
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

  /* A phone call is the customer's own published number answered by Retell. */
  if (
    connection.connectionType === "phone_number" &&
    (mocks > 0 || retellVars > 0)
  ) {
    groups.push({
      accent: "warning",
      lines: [
        "Some test data will not be used on this connection.",
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

  /* One temporary version per run, and only when some test mocks. */
  if (connection.connectionType === "retell_web_call" && mocks > 0) {
    const rest = total - mocks;
    groups.push({
      accent: "brand",
      lines: [
        "This run creates one temporary version of your Retell agent.",
        "Egma makes it at run start, points only the mocked tools at Egma, and deletes it when the run ends. Your serving version is never changed.",
        `${carryOf(mocks, total)} mock tools. In those simulations, tools the test does not mock reach your real backend.` +
          // Said only when there are other tests to say it about. Every test in
          // the run mocking is not a case for "The other 0 tests".
          (rest > 0 ? ` ${theOthers(rest)}` : ""),
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
   * Loudest first, and never more than three lines. `toSorted` is stable, so
   * two groups at one volume stay in the order they were written here.
   *
   * **A group goes in whole or not at all**, and the note stops at the first
   * one that does not fit. Half a group is a title with its explanation cut
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
 * is nothing to say.
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
  return (
    <div
      className={cn("flex flex-col gap-1", className)}
      data-slot="run-note"
      role="note"
    >
      {lines.map((line, at) => (
        <p
          className={cn(
            "m-0 border-l-(length:--active-edge-width) ps-3",
            "text-sm leading-(--line-normal) text-faint",
            EDGE[line.accent],
          )}
          data-accent={line.accent}
          key={`run-note-${String(at)}`}
        >
          {line.text}
        </p>
      ))}
    </div>
  );
}
