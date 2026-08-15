/**
 * Every word the Library screen says out loud, in one file.
 *
 * The transcript pages' arrangement, applied to the second product screen and
 * for the same reason: collecting the copy here is what makes the vocabulary
 * **checkable**. One test reads every value below and holds it against the
 * domain model's banned list, so a word that should never have been typed fails
 * the build rather than shipping in a heading.
 *
 * The words this screen has to get right are the redesign's own. A **grader**
 * is the running copy that judges; the **grader library** is the shelf of
 * definitions it is made from; an entry egma owns and ships is a **predefined
 * grader**, never a *built-in* one; and **owner** is what the shelf shows,
 * derived from who the entry belongs to. `evaluator`, `scorer` and the borrowed
 * word for one criterion inside a grader are all on the banned list, and this
 * screen is exactly where somebody arriving from another product would type
 * one.
 *
 * The URL is deliberately not copy. `/api/grader-library` is a machine surface
 * — it is the endpoint's own path, and matching it is how somebody reading the
 * network tab finds the request — and no page ever prints it as a word.
 */

export const LIBRARY = {
  navigation: "Graders",
  title: "Grader library",
  lead: "The graders egma ships, and the ones your team writes. Every project starts with egma's.",
  loading: "Loading…",
  signedOut: "Sign in first",
  signedOutLead: "This page is about your project.",
  signIn: "Sign in",
  setUp: "Set up egma",
  unreachable: "egma could not be reached. Is the API running?",
  /**
   * An empty shelf is a deployment that has not finished starting, not a team
   * with nothing set up: egma writes its own graders on every boot. Saying so
   * is what stops somebody looking for a button that does not exist.
   */
  empty:
    "The library is empty, which egma never leaves it. Its own graders are " +
    "written at start-up, so a platform still booting shows nothing here for " +
    "a moment. Reload in a few seconds.",
  counted: (howMany: number): string =>
    `${howMany} ${howMany === 1 ? "entry" : "entries"}`,
  order: "Newest first",
} as const;

/** The table's headings. */
export const COLUMNS = {
  name: "Name",
  type: "Type",
  owner: "Owner",
  description: "What it judges",
  use: "",
} as const;

/**
 * Pressing **Use**: the one act on this screen, and every word it says.
 *
 * **The form is drawn from the entry, not from this file.** What a grader asks
 * for is the library entry's own declaration — a measure and a bound for
 * latency, nothing at all for expected behaviors — and it arrives on the answer
 * beside the entry. So the labels, the help text and the values in the dropdown
 * are the platform's, and this file holds only the words around them: the
 * heading, the two buttons, and what to say when a write is refused. A list of
 * measures typed here would be a second copy of egma's measure catalog, wrong
 * the first time a measure joined or left.
 *
 * **`required` is a word this screen has to get right.** It is the only
 * loudness switch v0 has: on, and a test cannot pass while this grader does
 * not; off, and it is a **diagnostic** — judged, shown with its fraction, never
 * able to fail anything. Neither reading is obvious from the flag's name alone,
 * so both are spelled out beside the control rather than left to a tooltip.
 */
export const USE = {
  open: "Use",
  title: (name: string): string => `Use ${name}`,
  /** Said above the form, because pressing Use is what switching on means. */
  lead:
    "This puts a running copy of the grader on your project. It starts " +
    "judging everything in its scope straight away; nothing else has to be " +
    "switched on.",
  /** An entry whose assertions come from the test asks for nothing at all. */
  asksNothing:
    "This grader asks for nothing. Its assertions are each test's own expected " +
    "behaviors, read at the moment it judges.",
  required: "Can fail a run",
  requiredOn:
    "A test cannot pass while this grader does not.",
  requiredOff:
    "A diagnostic: judged and shown with its fraction, and never able to fail " +
    "anything.",
  submit: "Start judging",
  submitting: "Starting…",
  cancel: "Cancel",
  started: (name: string): string =>
    `${name} is running on this project now. It judges everything in its scope from here on; what has already been judged is unchanged.`,
  seeRunning: "See the running graders",
  /** A refusal the platform did not explain — the network, or a proxy. */
  unreachable:
    "egma could not be reached, so nothing was switched on. Is the API running?",
} as const;

/**
 * The two words a type can be, as a person reads them.
 *
 * The stored words are `llm_as_judge` and `code`, which are the vocabulary the
 * schema and the API speak. A screen shows what a developer would say out loud
 * instead, and an unknown word is shown as it arrived rather than hidden —
 * a platform newer than this page is a real thing, and a blank cell would be a
 * worse answer than an unfamiliar one.
 */
export const TYPES: Readonly<Record<string, string>> = {
  llm_as_judge: "Model judged",
  code: "Computed",
};

/**
 * The two owners, as a person reads them.
 *
 * `egma` is an entry egma ships and maintains; anything else belongs to the
 * team looking at it, because the list is already narrowed to their own
 * organization. Owner is derived from who the entry belongs to and never from a
 * flag, which is why there is no third word here for anybody to set.
 */
export const OWNERS: Readonly<Record<string, string>> = {
  egma: "egma",
  organization: "Your team",
};

/** What a row says where the answer carried nothing. */
export const NOTHING = "—";
