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
