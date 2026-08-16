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
    "judged. Every project is given Egma's expected-behaviors grader when it " +
    "is created — if it is gone, pick it from the library and press Use.",
} as const;

/** The table's headings. The last one is blank, because it holds the buttons. */
export const RUNNING_COLUMNS = {
  name: "Name",
  scope: "Applies to",
  required: "Required",
  config: "Assertions",
  actions: "",
} as const;

/**
 * Changing a running copy: every word the edit form says.
 *
 * **The one thing this copy has to make plain is that an edit is two acts.**
 * Changing a filled-in value changes what the grader *is*, so it starts the
 * next version and the version behind it stays exactly as it was, which is what
 * keeps last week's result meaning what it meant. Somebody who did not know
 * that would read a tightened bound as a rewriting of history.
 *
 * **And the one sentence it must not shorten is what `required` does.** Turning
 * a blocker into a diagnostic rewrites no verdict — and it does change what
 * those verdicts add up to, because whether a grader can fail a run is read
 * fresh every time somebody opens the page. A run that failed on this grader
 * alone reads as passed from the moment the flag turns. That is the flag's
 * whole job, and "nothing already judged changes" is the tempting short version
 * that says the opposite of what the person will see next.
 *
 * The labels and the help text for the filled-in values are **not** here: they
 * ride the library entry, and the form renders what it was handed. A list of
 * measures typed into this file would be a second copy of egma's own catalog,
 * wrong the first time one joined or left.
 */
export const EDIT = {
  open: "Edit",
  title: (name: string): string => `Edit ${name}`,
  lead:
    "What this grader judges by, and where it applies. Values are what a " +
    "verdict is made of, so changing one starts the next version and leaves " +
    "everything already judged saying exactly what it said.",
  /** An entry whose assertions come from the test has nothing to fill in. */
  asksNothing:
    "This grader has nothing to fill in. Its assertions are each test's own " +
    "expected behaviors, read at the moment it judges.",
  name: "Name",
  nameMeans: "What this project calls its copy.",
  description: "Notes",
  descriptionMeans: "Why your team switched it on. Leave it empty for none.",
  scope: "Applies to",
  scopeMeans: "Where this grader judges. Live traffic is sampled below.",
  required: "Can fail a run",
  /**
   * Both positions carry the same warning, because turning the flag either way
   * has the same reach: no verdict is rewritten, and every run already read is
   * re-counted the next time somebody opens it.
   */
  requiredOn:
    "A test cannot pass while this grader does not. Turning this off rewrites " +
    "no verdict, and it does change what past ones add up to: a run that " +
    "failed on this grader alone reads as passed from then on.",
  requiredOff:
    "A diagnostic: judged and shown with its fraction, and never able to fail " +
    "anything. Turning this back on rewrites no verdict, and it does change " +
    "what past ones add up to: a run this grader failed reads as failed again.",
  sampleRate: "Share of live traffic judged",
  sampleRateMeans:
    "A whole percentage from 0 to 100. It counts only where this grader " +
    "reaches live traffic, and it moves forward: raising it judges sooner and " +
    "lowering it judges later, and neither reaches back.",
  submit: "Save",
  submitting: "Saving…",
  cancel: "Cancel",
  /**
   * **Narrow on purpose.** It used to say "what has already been judged is
   * unchanged", which is true of the verdicts and false of the runs they add
   * up to — and it was shown at the exact moment somebody had turned `required`
   * off, which is when it was most wrong. It now claims only what it can: no
   * verdict was rewritten.
   */
  saved: (name: string): string =>
    `${name} is saved. It judges everything in its scope from here on, and no verdict it has already written was rewritten.`,
  /** Why the control is not this person's, in their own role's words. */
  notYours: (role: string): string =>
    `Your ${role} role cannot change a grader. Ask an organization admin.`,
} as const;

/**
 * Switching a running copy off: every word the delete says.
 *
 * **Delete is the off switch, because there is no other one.** There is no
 * enable flag and no "applies to nothing" setting — a grader either exists and
 * judges everything in its scope, or it is gone. So this act has to read as
 * switching off rather than as destroying something, and the two sentences
 * below are how: one says what stops, and one says what stays.
 *
 * The second is the one that must never be dropped. Everything this grader
 * already judged keeps saying exactly what it said, because the versions it
 * judged by outlive it — so a result somebody read last week reads the same
 * today. Without that sentence a person weighing this button is being asked to
 * choose between a grader they cannot live with and a history they cannot lose.
 *
 * **The last one gets a sentence of its own.** A project may judge with nothing
 * at all — that is a decision it is allowed to take, and the run door lets it
 * through rather than refusing — so nothing stops somebody switching off the
 * last copy. What a page owes them is the consequence in advance: the run still
 * happens, and it comes back with nothing judged.
 */
export const SWITCH_OFF = {
  open: "Switch off",
  title: (name: string): string => `Switch ${name} off`,
  stops: "Nothing this project runs from now on is judged by it.",
  keeps:
    "Everything it has already judged keeps exactly what it said. Every " +
    "verdict it wrote stays readable, so a run you have already read still " +
    "reads the same.",
  again:
    "There is no switching it back on. Pick the same grader from the library " +
    "and press Use, which starts a fresh copy with its own settings.",
  /** Said above the two buttons when this copy is the only one left. */
  theLastOne:
    "This is the only grader running here. Switch it off and runs still " +
    "happen, and come back with nothing judged.",
  confirm: "Switch it off",
  confirming: "Switching off…",
  cancel: "Keep it",
  done: (name: string): string =>
    `${name} is switched off. Nothing new is judged by it, and everything it already judged reads exactly as it did.`,
  /** Why the control is not this person's, in their own role's words. */
  notYours: (role: string): string =>
    `Your ${role} role cannot switch a grader off. Ask an organization admin.`,
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
 * grader judges whatever the test in front of it says it expects, so there is
 * nothing for anybody to fill in and there never will be.
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

/** What a row says where the answer carried nothing. */
export const NOTHING = "—";
