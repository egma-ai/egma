/**
 * The one keystroke between generated files and tests on the platform.
 *
 * The developer reads a list and presses one key. It is a pause to scan, not a
 * review: the files are in their repository either way, and deep review happens
 * there, in a pull request, on code. So the list says the two things worth
 * scanning — what each test is about, and who calls about it — and nothing else.
 *
 * One thing is decided before the list is drawn. **A test with no expected
 * behaviors can never fail**, so it blocks the complete suite. The file is
 * named on the screen and left exactly where it is. Nothing is pushed and no
 * smaller suite is offered; the developer fixes the file and tries again.
 *
 * Approval always names the complete suite. If any file is invalid, the wizard
 * stops before the atomic repository push. It never asks whether a smaller set
 * may continue.
 */

import type { FolderContents } from "../folder/egma-folder.ts";
import type { FilePersona } from "../folder/test-file.ts";

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
  /**
   * Absolute, for opening in an editor, exactly as a row carries one.
   *
   * A held-back file is the one a developer most wants to open: it is the one
   * with something wrong with it. So it is reachable by the same key, and the
   * screen does not have to explain why one line on it can be opened and the
   * line under it cannot.
   */
  readonly file: string;
  readonly reason: string;
};

/** Everything the gate screen draws, and everything enter acts on. */
export type TestGate = {
  readonly rows: readonly GateRow[];
  readonly heldBack: readonly HeldBack[];
  /** What the tests would run against, for the sentence above the keys. */
  readonly agentName: string;
  readonly connectionName: string;
  /** Human-facing label derived from the connection's technical axes. */
  readonly productLabel: string;
  readonly modality: string;
  /**
   * The number every simulation will dial, or `null` when nothing is dialled.
   *
   * This is the one fact on the screen that costs money. Enter over twelve
   * tests on a phone connection is twelve outbound calls to a real number on a
   * real carrier, and a developer who is about to authorise that should be
   * reading the number rather than inferring it from a connection's name. It is
   * not a secret and never was: a destination number is the public half of a
   * phone connection, which is what lets it be shown at all.
   */
  readonly destination: string | null;
  readonly suite: string;
};

/** The connection's public config, as the platform answered it. */
export type GateConnection = {
  readonly name: string;
  readonly productLabel: string;
  readonly modality: string;
  readonly config: Readonly<Record<string, string>>;
};

/**
 * Where a connection dials, when it dials anywhere.
 *
 * Read off the connection's own config rather than from its label, because the
 * config is what the platform stored and the label is only what it is called.
 * A connection that reaches an agent some other way answers nothing here and
 * the screen says nothing about dialling, which is the truth about it.
 */
export function destinationOf(connection: GateConnection): string | null {
  const number = (connection.config["phoneNumber"] ?? "").trim();
  return number === "" ? null : number;
}

import { NO_BEHAVIORS_REASON } from "../sync/push.ts";

export { NO_BEHAVIORS_REASON };

/**
 * The other way a file blocks the complete suite: egma could not read it at
 * all. It is named on the same list so the developer can open and fix it.
 */
export function unreadableReason(problem: string): string {
  return `Egma could not read it — ${problem}. Fix the file, then run egma push.`;
}

/**
 * Who calls, as one column of the list somebody agrees to.
 *
 * The display name, falling back to the identifier for a file that carries one
 * and no name — which is a file somebody hand-wrote, since everything egma
 * writes carries both. A screen is for reading, so the name comes first.
 */
function personaColumn(personas: readonly FilePersona[]): string {
  const named = personas
    .map((persona) => (persona.name.trim() === "" ? persona.id.trim() : persona.name.trim()))
    .filter((persona) => persona !== "");
  return named.length === 0 ? DEFAULT_PERSONA : named.join(", ");
}

/** The list, and what was kept out of it, from what is on disk. */
export function gateFrom(
  folder: FolderContents,
  about: {
    readonly agentName: string;
    readonly connectionName: string;
    readonly productLabel: string;
    readonly modality: string;
    readonly destination: string | null;
    readonly suite: string;
  },
): TestGate {
  const rows: GateRow[] = [];
  const heldBack: HeldBack[] = folder.unreadable.map((file) => ({
    shown: file.shown,
    file: file.file,
    reason: unreadableReason(file.reason),
  }));

  for (const held of folder.found) {
    if (held.test.expectedBehaviors.length === 0) {
      heldBack.push({ shown: held.shown, file: held.file, reason: NO_BEHAVIORS_REASON });
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
