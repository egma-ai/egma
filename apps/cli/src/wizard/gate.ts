/**
 * The one keystroke between generated files and tests on the platform.
 *
 * The developer reads a list and presses one key. It is a pause to scan, not a
 * review: the files are in their repository either way, and deep review happens
 * there, in a pull request, on code. So the list says the two things worth
 * scanning — what each test is about, and who calls about it — and nothing else.
 *
 * One thing is decided before the list is drawn. **A test with no expected
 * behaviors can never fail**, so egma will not put one on the platform. The
 * platform refuses it at its own door and would say so in its own words, and
 * that is still the authority — but a wizard that uploaded twelve files to be
 * told one of them was rubbish would have wasted the developer's time to learn
 * something it could see. So the file is held back here, named on the screen,
 * and left exactly where it is: it is the developer's file now, and deleting
 * their file to tidy up egma's own report would be the worse of the two.
 */

import type { FolderContents } from "../folder/egma-folder.ts";

/** What a persona column says for a test that names nobody. */
export const DEFAULT_PERSONA = "default persona";

/** One line of the list. */
export type GateRow = {
  readonly name: string;
  /** Who is on the other end of it, or the default persona's own words. */
  readonly persona: string;
  /** `egma/tests/…`, as every report says a path. */
  readonly shown: string;
  /** Absolute, for opening in an editor and for the push. */
  readonly file: string;
};

/** A file egma will not push, and why, in words a developer can act on. */
export type HeldBack = {
  readonly shown: string;
  readonly reason: string;
};

/** Everything the gate screen draws, and everything enter acts on. */
export type TestGate = {
  readonly rows: readonly GateRow[];
  readonly heldBack: readonly HeldBack[];
  /** What the tests would run against, for the sentence above the keys. */
  readonly agentName: string;
  readonly connectionName: string;
  readonly modality: string;
  readonly suite: string;
};

export const NO_BEHAVIORS_REASON =
  "no expected behaviors, so it could never fail. Add one, then run egma push.";

/**
 * The other way a file in the folder is not a test: egma could not read it at
 * all. A coding agent writing twelve files writes a broken one sometimes, and
 * the eleven good ones are not forfeit because of it — so the broken one is
 * named on the same list, in the same place, for the same reason.
 */
export function unreadableReason(problem: string): string {
  return `egma could not read it — ${problem}. Fix the file, then run egma push.`;
}

function personaColumn(personas: readonly string[]): string {
  const named = personas.map((persona) => persona.trim()).filter((persona) => persona !== "");
  return named.length === 0 ? DEFAULT_PERSONA : named.join(", ");
}

/** The list, and what was kept out of it, from what is on disk. */
export function gateFrom(
  folder: FolderContents,
  about: {
    readonly agentName: string;
    readonly connectionName: string;
    readonly modality: string;
    readonly suite: string;
  },
): TestGate {
  const rows: GateRow[] = [];
  const heldBack: HeldBack[] = folder.unreadable.map((file) => ({
    shown: file.shown,
    reason: unreadableReason(file.reason),
  }));

  for (const held of folder.found) {
    if (held.test.expectedBehaviors.length === 0) {
      heldBack.push({ shown: held.shown, reason: NO_BEHAVIORS_REASON });
      continue;
    }
    rows.push({
      name: held.test.name,
      persona: personaColumn(held.test.personas),
      shown: held.shown,
      file: held.file,
    });
  }

  // Both lists read in the folder's own order, whichever reason a file was
  // held back for, so the screen is the folder rather than egma's bookkeeping.
  heldBack.sort((a, b) => (a.shown < b.shown ? -1 : a.shown > b.shown ? 1 : 0));

  return { rows, heldBack, ...about };
}
