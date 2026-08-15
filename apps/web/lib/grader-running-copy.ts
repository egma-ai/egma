/**
 * Every word the Running-graders screen says out loud, in one file.
 *
 * The Library screen's arrangement, applied to its sibling and for the same
 * reason: collecting the copy here is what makes the vocabulary **checkable**.
 * One test reads every value below and holds it against the domain model's
 * banned list, so a word that should never have been typed fails the build
 * rather than shipping in a heading.
 *
 * The words this screen has to get right are the ones the redesign settled. A
 * **grader** here is the running copy — the row that judges, and the thing a
 * verdict names — and it is always a copy of a library entry. **Required** is
 * the flag saying whether a test can pass while this grader does not; `gate` was
 * considered for it and not chosen, and a grader that is not required is a
 * **diagnostic**. **Scope** is where it applies. What a copy holds of its own is
 * its filled-in values, one set per **assertion** — the word for one 0-or-1
 * check inside a grader, un-banned by the same redesign.
 *
 * The URL is deliberately not copy. `/api/graders` is a machine surface — it is
 * the endpoint's own path, and matching it is how somebody reading the network
 * tab finds the request — and no page ever prints it as a word.
 *
 * **Nothing here is a sentence the screen cannot reach**, for the reason its
 * sibling gives: a copy file holding words nobody renders reads as a screen
 * whose whole vocabulary is checked, and is not one.
 */

export const RUNNING = {
  title: "Running graders",
  lead: "What this project judges with. Every one of them is a copy of something on the library shelf.",
  /** What the page says it is waiting for, never merely that it is waiting. */
  loading: "running graders",
  /**
   * An empty list is a real state and a bad one: every project is given the
   * expected-behaviors grader when it is created, so nothing here means a run
   * would be reported with nothing judged. Saying so is the whole value of the
   * sentence.
   */
  empty:
    "Nothing is judging this project, so a run would finish with nothing " +
    "judged. Every project is given egma's expected-behaviors grader when it " +
    "is created — if it is gone, pick it from the library and press Use.",
} as const;

/** The table's headings. */
export const RUNNING_COLUMNS = {
  name: "Name",
  scope: "Applies to",
  required: "Required",
  config: "Assertions",
} as const;

/**
 * Where a grader applies, as a person reads it.
 *
 * The stored words are `simulations`, `production` and `both`, which are the
 * vocabulary the schema and the API speak. A screen shows what a developer
 * would say out loud instead, and an unknown word is shown as it arrived rather
 * than hidden — a platform newer than this page is a real thing, and a blank
 * cell would be a worse answer than an unfamiliar one.
 */
export const SCOPES: Readonly<Record<string, string>> = {
  simulations: "Tests",
  production: "Live traffic",
  both: "Tests and live traffic",
};

/**
 * The two things `required` can say.
 *
 * Not "yes" and "no": what the flag decides is whether a failure stops a test
 * passing, and a person scanning this column wants that answer rather than the
 * flag's own value. A grader that is not required still judges and is still
 * shown — it simply cannot fail anything.
 */
export const REQUIRED = {
  yes: "Blocks",
  no: "Diagnostic",
} as const;

/**
 * What a copy holds, summarised for one cell.
 *
 * **An empty set of values is a complete grader, not a half-finished one**, and
 * this is the sentence that stops it reading as a gap: the expected-behaviors
 * grader checks whatever the test in front of it says, so there is nothing for
 * anybody to fill in and there never will be.
 */
export const CONFIG = {
  fromTheTest: "Whatever the test says it expects",
  /**
   * **`assertion`, and never `check`.** `check` is a borrowed word for the
   * judging job and the domain model bans it; `assertion` is the word this
   * redesign un-banned for exactly this level — one 0-or-1 decision inside a
   * grader — and it is the word the verdict store's own column uses.
   */
  counted: (howMany: number): string =>
    `${howMany} ${howMany === 1 ? "assertion" : "assertions"}`,
} as const;

/**
 * Deleting a running copy: the one act on this screen, and every word it says.
 *
 * **Deleting the copy is how a grader is switched off, and there is no other
 * switch.** There is no enable flag, no `none` scope and no archive here:
 * pressing Use is the switching on, and this is the switching off. So the words
 * have to carry what a person is actually deciding — this project stops being
 * judged by it — rather than sounding like a row is being tidied away.
 *
 * **What has already been judged does not move**, and saying so is what makes
 * the act safe to take. A run froze its plan when it started, so it keeps
 * judging with what it froze; every verdict already written stays exactly as it
 * is, and its version rows stay where they are so it can still be read.
 *
 * **The last one gets its own sentence.** A project may run no graders at all —
 * that is a decision it is allowed to take, and the run door lets it through
 * rather than refusing — so nothing stops somebody deleting the last copy. What
 * a page owes them is the consequence in advance: the run still happens, and it
 * comes back with nothing judged.
 */
export const REMOVE = {
  open: "Delete",
  title: (name: string): string => `Delete ${name}?`,
  lead:
    "This project stops being judged by it. Runs already started keep the " +
    "graders they froze, and every verdict already written is unchanged. " +
    "Pressing Use on the library shelf starts a new copy whenever you want one.",
  /** Said above the two buttons when this copy is the only one left. */
  theLastOne:
    "This is the only grader running here. Delete it and runs still happen, " +
    "and come back with nothing judged.",
  confirm: "Delete grader",
  confirming: "Deleting…",
  cancel: "Keep it",
  gone: (name: string): string =>
    `${name} is no longer judging this project. What it already judged is unchanged.`,
  /** Why the control is not this person's, in their own role's words. */
  notYours: (role: string): string =>
    `Your ${role} role cannot delete a grader. Ask an organization admin.`,
} as const;

/** What a row says where the answer carried nothing. */
export const NOTHING = "—";
