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
 *
 * The other thing that holds a file back is the door itself, and it can only be
 * learned by knocking. A rule only the platform can check — today, a test naming
 * a persona the platform does not hold — is a refusal that arrives after the
 * keystroke. So the list is built a second time, carrying what the platform
 * said, and the same one keystroke is asked for over the list that would really
 * run. Nothing runs on a list the developer never read.
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
 * The other way a file in the folder is not a test: egma could not read it at
 * all. A coding agent writing twelve files writes a broken one sometimes, and
 * the eleven good ones are not forfeit because of it — so the broken one is
 * named on the same list, in the same place, for the same reason.
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
  /**
   * What the platform's own door turned away, from a push a keystroke has
   * already agreed to. Empty the first time the list is drawn, because nothing
   * has knocked on the door yet.
   *
   * These are files egma can read and would push again: they are kept off the
   * list rather than on it, so that the keystroke over this list agrees to what
   * would really run, and the platform's own sentence is on the screen beside
   * the file it is about.
   */
  refused: readonly HeldBack[] = [],
): TestGate {
  const rows: GateRow[] = [];
  const heldBack: HeldBack[] = folder.unreadable.map((file) => ({
    shown: file.shown,
    file: file.file,
    reason: unreadableReason(file.reason),
  }));

  const refusedFiles = new Set(refused.map((held) => held.file));
  for (const held of folder.found) {
    if (refusedFiles.has(held.file)) continue;
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

  // One line per file. A file the door refused and egma can no longer read —
  // the developer went in to fix it and left it half-written — is named in what
  // egma can see about it now, which is the newer of the two answers and the
  // one that says what to do next.
  const named = new Set(heldBack.map((held) => held.file));
  heldBack.push(...refused.filter((held) => !named.has(held.file)));

  // Both lists read in the folder's own order, whichever reason a file was
  // held back for, so the screen is the folder rather than egma's bookkeeping.
  heldBack.sort((a, b) => (a.shown < b.shown ? -1 : a.shown > b.shown ? 1 : 0));

  return { rows, heldBack, ...about };
}
