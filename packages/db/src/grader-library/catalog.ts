import { CATALOGED_MEASURES } from "@egma/simulation-contract";

import type { LibraryType } from "../schema/graders.ts";

/**
 * The catalog of predefined graders: every grader definition egma ships,
 * written down in egma's code rather than inserted by hand.
 *
 * **A code file, not a table, and not a migration.** The rows it produces are
 * seeded by a deterministic upsert on every boot (`seedGraderLibrary`), so
 * changing an entry here and shipping a release upgrades every project on every
 * deployment — the reference implementation's managed-evaluator mechanism,
 * adopted whole. A migration would write the words of one release into the
 * history of the schema, where improving them is an `update` somebody has to
 * remember to write twice.
 *
 * **The identifiers are fixed, and that is what makes the upsert deterministic
 * rather than a merge by name.** A predefined entry keeps one identifier for
 * its whole life, so running copies point at it across upgrades, verdict rows
 * stay interpretable, and renaming the entry is a rename rather than a new
 * grader with the old one orphaned beside it. They are ordinary egma
 * identifiers, minted once on the day this catalog was written and then never
 * minted again.
 *
 * **`created_at` is written here too**, for the same reason: a predefined entry
 * was born the day egma shipped it, and a timestamp taken from whichever
 * machine booted first would say instead when somebody ran `docker compose up`.
 * `updated_at` is deliberately *not* here — it is stamped by the upsert, and
 * only when the definition actually changed, so it answers "when did these
 * words last move" without depending on a catalog author remembering to touch
 * it. Two runs of an unchanged catalog leave the row byte for byte identical.
 *
 * **Nothing here carries tenancy.** A predefined entry is owned by egma, which
 * the schema says by leaving both tenancy columns null — see the table's own
 * note, where that one exception is argued out.
 */

/**
 * One value **Use** asks a developer for, as the Library entry declares it.
 *
 * The declaration is the *schema*, never the answer: what a developer types
 * lands on their own running copy, in its versioned config, one filled-in set
 * per assertion. The entry says what the form must ask; the copy holds what was
 * said.
 *
 * `kind` decides the control and the check behind it:
 *
 * - `measure` — a name from the measure catalog. It is its own kind rather than
 *   a string with a note attached, because a measure egma does not compute is a
 *   grader that reads nothing, judges nothing, and is `skipped` forever. The
 *   catalog is the only list the form may offer and the only list a write may
 *   accept, so the dropdown and the check can never drift apart.
 * - `number` — a figure a person types. **Deliberately unitless here**, because
 *   the unit belongs to the measure beside it: the catalog says whether a
 *   measure is counted in milliseconds, in turns or in hertz, so a form that
 *   named a unit of its own would be a second opinion about one that is already
 *   written down — and it would be wrong the moment somebody bounds a measure
 *   that is not a duration.
 */
export type LibraryParameterKind = "measure" | "number";

export type LibraryParameter = {
  /** The key the filled-in value is stored under on a running copy. */
  readonly name: string;
  /** The words a person reads on the Use form. */
  readonly label: string;
  readonly kind: LibraryParameterKind;
  /** What it is for, in the one line a form shows under the control. */
  readonly means: string;
};

/**
 * The shape an `llm_as_judge` entry's judge must **reply** in.
 *
 * **This is the judge's answer, not the verdict row.** The two are different
 * documents and the difference is load-bearing: a judge answers `decision`,
 * `rationale` and `cited_turns`, and the engine turns that into a verdict row
 * carrying a verdict, a score and cited spans. A row is written for an
 * assertion nobody could judge at all, which no reply corresponds to; and
 * `cannot_determine` is a real reply that becomes `skipped` rather than a
 * number. Describing the row here would put a shape on the entry that the
 * prompt beside it does not command and the engine does not parse — three
 * statements about one exchange, two of them wrong.
 *
 * It rides the entry so the Library screen can show what a judge is asked to
 * produce, and so the day a second judged entry wants a different reply it says
 * so in its own row instead of silently getting this one.
 */
export type LibraryOutputDefinition = {
  readonly decision: {
    readonly type: "string";
    /** The only three words an answer may be. */
    readonly oneOf: readonly string[];
    readonly means: string;
  };
  readonly rationale: { readonly type: "string"; readonly means: string };
  readonly cited_turns: { readonly type: "number[]"; readonly means: string };
};

/** The reply shape, written once for every judged entry. */
const A_JUDGES_REPLY: LibraryOutputDefinition = {
  decision: {
    type: "string",
    // The engine reads these three words and nothing else; a fourth is an
    // answer egma refuses rather than guesses at.
    oneOf: ["met", "not_met", "cannot_determine"],
    means:
      "whether the one criterion held. cannot_determine is a real answer for evidence that does not settle it, and never a polite way of saying no",
  },
  rationale: {
    type: "string",
    means: "one sentence saying why, in the judge's own words",
  },
  cited_turns: {
    type: "number[]",
    means:
      "the turns the rationale rests on, by their numbers in the transcript; empty where the criterion is about something nobody said",
  },
};

/**
 * The judge prompt the expected-behaviors grader is asked with.
 *
 * **Deliberately spare.** The criterion and the evidence carry the judgment,
 * and a prompt full of encouragement is a prompt that moves the answer without
 * anybody being able to say how.
 *
 * Two instructions earn their place. **Decide only the one criterion** — the
 * fan-out's isolation is worth nothing if the model helpfully judges the whole
 * conversation. And **`cannot_determine` is available** — a judge that believes
 * it must choose between met and not-met will guess, and a guess dressed as a
 * judgment is the false trust this product exists to kill.
 *
 * These were the engine's own words and this row is now the only place they
 * live. The engine reads them through its running copy's `library_id` at
 * judging time, so what the Library screen shows and what a judge is sent are
 * one string with no copy to drift from — the whole reason the definition is
 * never written down onto a copy.
 */
const EXPECTED_BEHAVIORS_PROMPT = [
  "You judge one criterion about one recorded conversation between a customer's",
  "agent and a synthetic caller. You are shown the transcript, how the",
  "conversation ended, the tools the agent called, and what was measured.",
  "",
  "Decide only the criterion you are given. Do not judge anything else about the",
  "conversation, however obvious it seems.",
  "",
  "Answer with a JSON object and nothing else:",
  '  {"decision": "met" | "not_met" | "cannot_determine",',
  '   "rationale": "one sentence",',
  '   "cited_turns": [<turn numbers from the transcript>]}',
  "",
  "Use cannot_determine when the evidence does not settle the criterion — a",
  "conversation that never reached the subject, or a criterion about something",
  "the record does not show. It is a real answer, not a failure, and guessing",
  "instead of using it is the one thing you must not do.",
  "",
  "Cite the turns your rationale rests on, by their numbers in the transcript.",
  "Cite none when the criterion is about something nobody said.",
].join("\n");

/** One predefined entry, exactly as the catalog writes it down. */
export type PredefinedGrader = {
  /** Fixed for the entry's whole life. Never minted again. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type: LibraryType;
  /** The judge prompt for a judged entry; null for one egma executes. */
  readonly prompt: string | null;
  /** What Use asks for. Empty where Use asks nothing. */
  readonly params: readonly LibraryParameter[];
  /** The reply shape a judge must answer in; null for one nobody asks. */
  readonly outputDefinition: LibraryOutputDefinition | null;
  /** The day egma shipped this entry. See the file's note. */
  readonly createdAt: Date;
};

/** The day this catalog was written, and both entries' birthday. */
const SHIPPED = new Date("2026-08-14T00:00:00.000Z");

/**
 * The identifiers of the entries egma ships, by the name a person calls them.
 *
 * They are written here as names rather than left as characters in the list
 * below because three other places point at one: the copy every project is
 * seeded with, the backfill that gives one to every project that has none, and
 * the engine's roster of what it knows how to execute. A repeated literal in
 * any of those would be an identifier somebody could mistype into a pointer at
 * nothing — and the whole reason these identifiers are fixed is so that a
 * pointer at one keeps meaning what it meant across every upgrade.
 */
export const PREDEFINED_GRADERS = {
  expectedBehaviors: "grl_01M01MH8KAE8ZB19B0YJ7Z7EYW",
  latency: "grl_01M01MH8KBE00TESCGQHVH0T8G",
} as const;

/**
 * The two predefined graders v0 ships.
 *
 * They are the whole shelf on purpose: users should meet a small set of graders
 * they switch on rather than an authoring surface asking them to design
 * judgment logic on their first day. Custom authoring returns as a surface
 * later, inserting into this same table with tenancy set.
 */
export const GRADER_LIBRARY_CATALOG: readonly PredefinedGrader[] = [
  {
    id: PREDEFINED_GRADERS.expectedBehaviors,
    name: "expected_behaviors",
    description:
      "Judges a simulation against its test's own expected behaviors — one isolated judge call per sentence, one verdict row each. Every new project runs a copy of it, so a first run is judged with no setup at all.",
    type: "llm_as_judge",
    prompt: EXPECTED_BEHAVIORS_PROMPT,
    // Nothing. Its assertions are the test's own sentences, supplied per test
    // at judging time, so pressing Use asks for nothing and there is no form.
    params: [],
    outputDefinition: A_JUDGES_REPLY,
    createdAt: SHIPPED,
  },
  {
    id: PREDEFINED_GRADERS.latency,
    name: "latency",
    description:
      "Checks a measure of how fast the agent answered against a bound you choose. Computed from the conversation's spans by egma's own engine, with no model call anywhere — the same numbers the metrics display shows.",
    type: "code",
    prompt: null,
    params: [
      {
        name: "metric",
        label: "Measure",
        kind: "measure",
        means: `which measure to read, from the measure catalog: ${CATALOGED_MEASURES.join(", ")}`,
      },
      {
        name: "bound",
        label: "Bound",
        kind: "number",
        means:
          "the most the measure may be for this assertion to pass, in the measure's own unit; anything above it fails",
      },
    ],
    outputDefinition: null,
    createdAt: SHIPPED,
  },
];
