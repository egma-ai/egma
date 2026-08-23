/**
 * Every word these two pages say out loud, in one file.
 *
 * The store underneath them files a *trace* made of *spans*, and both of those
 * are storage words that never reach a person — `product-docs` puts them on the
 * reserved list precisely so that the row in ClickHouse and the thing somebody
 * reads never end up sharing a name. What a person reads is a **transcript**:
 * the record of the exchange, turns labelled `human:` and `agent:`, each with
 * what happened inside it.
 *
 * Collecting the copy here rather than scattering it through the markup is not
 * tidiness. It is what makes the vocabulary **checkable**: one test reads every
 * value below and holds it against the banned list, so a word that should never
 * have been typed fails the build rather than shipping in a heading. Any string
 * a page renders belongs in here.
 *
 * The URLs are deliberately not copy. The v1 endpoint's own path is a machine
 * surface — matching it is how somebody reading the network tab finds the
 * request — and no page ever prints it as a word. What a person navigates is
 * **Monitoring**, and what they open there is a **transcript**.
 */

/** The list page. */
export const LIST = {
  eyebrow: "Project",
  /**
   * The heading, and deliberately not the navigation label: the sidebar reads
   * its words from `lib/navigation.ts`, which is where a navigation item is
   * decided. Two copies of "Monitoring" that could disagree would be one too
   * many, and this is the one the page renders.
   */
  title: "Monitoring",
  lead: "What your agents did in production, newest first.",
  /** What the table is called where somebody hears it rather than sees it. */
  tableLabel: "Production transcripts in this project",
  loadingWhat: "this project's production transcripts",
  signedOut: "Sign in first",
  signedOutLead: "This page is about your project.",
  signIn: "Sign in",
  setUp: "Set up Egma",
  back: "Back",
  unreachable: "Egma could not be reached. Is the API running?",
  window: "Window",
  previousPage: "Previous",
  nextPage: "Next",
  page: (number: number) => `Page ${number}`,
  counted: (shown: number) =>
    shown === 1
      ? "1 transcript on this page"
      : `${shown} transcripts on this page`,
  /** The two speakers, where a count rather than a transcript names them. */
  human: "human",
  agent: "agent",
  /** Nothing to show in this column, which is different from a zero. */
  nothing: "—",
} as const;

/**
 * What each column of the list is called. The **order** they are shown in is
 * the page's, decided beside the cell that fills each one so that a heading and
 * the values under it can never drift apart.
 *
 * **There is no source column, and there is no name here for one.** Every row on
 * this surface is production by definition — a simulation is read under the run
 * that produced it — so a column repeating that on every line would be furniture
 * around a constant. The word is still a fact about one exchange and it is still
 * shown on the transcript, under `FACTS` below.
 */
export const COLUMNS = {
  started: "Started",
  duration: "Duration",
  turns: "Turns",
  preview: "First human line",
  steps: "Steps",
  tools: "Tools",
  errors: "Errors",
  environment: "Environment",
  platform: "Platform",
} as const;

/**
 * What a quiet Monitoring page says, in four states that never overlap.
 *
 * A page with nothing on it is where a developer decides whether egma works.
 * Each of these answers a different question, and the wrong one costs an
 * afternoon:
 *
 * 1. **Nothing in this window.** The list is empty because of the window rather
 *    than because of the project — a week of traffic read at the last hour. One
 *    line and the way out, and none of the teaching below: greeting a working
 *    export with a setup tutorial tells somebody their export is broken. It is
 *    also what a page says when it could not find out which of the two it was
 *    looking at, because this line is true either way.
 * 2. **Nothing has arrived, at any window.** The whole export setup, in the
 *    shortest form there is: the address this deployment listens on, the two
 *    variables that point an agent at it, where to mint the key they carry, and
 *    the caution about the key scope. Whichever window is
 *    selected — a developer on their first day lands on the default one, and
 *    this is the page written for them.
 * 3. **Nothing has arrived, and a key that names the whole organization is
 *    visible.** Customer OTLP rejects that scope because no project would own
 *    the evidence. Pointing somebody back to generic export setup would miss
 *    the specific key change they need, so this replaces the teaching.
 * 4. **Traffic is arriving and nothing judges it.** Every grader starts scoped
 *    to simulations and the seeded one can only ever judge a simulation, so an
 *    absence of verdicts here is the ordinary first state rather than a fault.
 */
export const QUIET = {
  narrowWindow: {
    title: "Nothing in this window",
    lead: "Widen the window above to look further back.",
  },
  setUp: {
    title: "Nothing has been recorded here yet",
    lead:
      "Open an agent and start monitoring it. Egma reads a Retell agent's " +
      "production traffic for you; a LiveKit agent sends its own.",
    action: "Start monitoring an agent",
  },
  organizationKey: {
    title: "A key here names the whole organization",
    lead:
      "The key that export uses has to name this project. Egma rejects an " +
      "organization-wide key for production telemetry.",
    key: "Mint a key for this project",
  },
  unwatched: {
    lead: "No grader watches production, so nothing here is judged.",
    graders: "Open Graders",
  },
} as const;

/** How long a window the list is asking about. Basic on purpose. */
export const WINDOWS = [
  { id: "1h", label: "Last hour", hours: 1 },
  { id: "24h", label: "Last 24 hours", hours: 24 },
  { id: "7d", label: "Last 7 days", hours: 24 * 7 },
  { id: "30d", label: "Last 30 days", hours: 24 * 30 },
] as const;

export type WindowChoice = (typeof WINDOWS)[number]["id"];

export const DEFAULT_WINDOW: WindowChoice = "24h";

/** The detail page. */
export const DETAIL = {
  title: "Transcript",
  back: "All transcripts",
  recorded: "Recorded",
  errors: (howMany: number) => howMany === 1 ? "1 error" : `${howMany} errors`,
  summary: "Exchange summary",
  viewLabel: "Transcript views",
  views: {
    transcript: "Transcript",
    timeline: "Timeline",
    execution: "Execution",
  },
  transcriptLead: "What each person said, with the work that happened between turns.",
  timelineLead: "Where time was spent across every recorded step.",
  executionLead: "Recorded work in its original hierarchy, grouped by turn when the provider reported it.",
  noStepsAtAll: "No timed work was recorded here.",
  problems: (howMany: number) => howMany === 1 ? "1 problem" : `${howMany} problems`,
  previousProblem: "Previous problem",
  nextProblem: "Next problem",
  inspector: "Selected step details",
  nothingSelected: "Select a turn or step to read its details.",
  notReported: "Not reported",
  toolWork: "Tool work",
  /**
   * Audio a **step** carries, which is audio the agent's own telemetry attached
   * to it — and it is named for whose it is, because the other audio on this
   * page is egma's own. See `RECORDING` below: two different things, one word
   * between them, and a reader has to know which one they are opening. It used
   * to read "Open recorded audio", which named neither.
   */
  openAudio: "Open the audio your agent's telemetry attached",
  technicalDetails: "Technical details",
  /**
   * The facts about how this exchange reached egma — when, from where, over
   * what. It used to read "Recording details", which was unambiguous until a
   * page with an audio player on it made "recording" a noun again. The key and
   * the component behind it were renamed with the words, so that reading the
   * code and reading the screen give the same answer.
   */
  whereItCameFrom: "Where this came from",
  citedTurns: "Read from",
  missing: "That transcript is not here",
  missingLead:
    "Nothing by that name was recorded in this organization, inside the " +
    "window this page was opened on. Look at the window before the name — the " +
    "two answers are the same one.",
  needsWindow: "Open this from the list",
  needsWindowLead:
    "A transcript is found by when it happened as well as by its name, so " +
    "this page needs the window it was recorded in. Opening it from the list " +
    "carries that along.",
  unreachable: LIST.unreachable,
  transcript: "The exchange",
  nothingSaid: "(no speech in this turn)",
  noTurns:
    "No turns were recorded here. Not every provider reports who spoke and " +
    "when — what did arrive is below.",
  noSteps: "Nothing timed was recorded inside this turn.",
  /**
   * Every timed step inside this turn, however deeply nested — which is not
   * the number of things expanding it puts on screen, because a model request
   * nests four adapters deep and only the outermost is a direct child. So the
   * label says what it counts rather than promising a row per unit: **recorded
   * inside this turn**, at any depth.
   */
  steps: (howMany: number) =>
    howMany === 1 ? "1 step recorded" : `${howMany} steps recorded`,
  otherSteps: "Everything else recorded",
  otherStepsLead:
    "What the framework did around the exchange rather than inside a turn.",
  truncated:
    "This is the beginning of what was recorded. The counts above are the " +
    "whole of it.",
  failed: "failed",
  failedInside: "something failed inside",
} as const;

/** The facts shown above the exchange, and the labels the raw view uses. */
export const FACTS = {
  started: COLUMNS.started,
  ended: "Ended",
  duration: COLUMNS.duration,
  turns: COLUMNS.turns,
  steps: COLUMNS.steps,
  tools: COLUMNS.tools,
  errors: COLUMNS.errors,
  /** A fact about one exchange, and never a column — see `COLUMNS` above. */
  source: "Source",
  environment: COLUMNS.environment,
  platform: COLUMNS.platform,
  platformAgentName: "Platform agent name",
  platformAgentId: "Platform agent ID",
  platformAgentVersion: "Platform agent version",
  reference: "Provider reference",
  identifier: "Identifier",
  within: "Inside",
  name: "Reported name",
  kind: "Step",
  status: "Status",
  toolName: "Tool",
  toolArguments: "Asked with",
  toolResult: "Answered",
  /** Named for whose it is, for the same reason `DETAIL.openAudio` is. */
  audio: "Audio from your telemetry",
  nanoseconds: "Nanoseconds",
} as const;

/**
 * What this exchange measured — the metrics display, in words.
 *
 * **A measure measures and a grader judges**, and the two are shown apart on
 * this page for exactly that reason: the numbers below say what happened, and
 * the verdicts above say what somebody decided about it. Nothing here is green
 * or red, because a duration is not good or bad until a grader has been asked.
 *
 * The numbers are the same ones a `latency` grader is judged on, computed once
 * by egma's shared measure module and read here through it — so a developer
 * reading "1100 ms at its worst" on this page and a verdict row saying a bound
 * was missed are the same arithmetic, and the page can never be the reason
 * somebody distrusts the judgment.
 *
 * A measure the spans do not carry is **absent** rather than shown as nothing:
 * an empty row would read as a measurement of zero, and a chat exchange has no
 * audio to have measured.
 */
export const MEASURES = {
  label: "What was measured",
  /** Nothing measured is an ordinary answer, and it says which two ways. */
  none:
    "Nothing was measured here. Egma's own simulations time their turns; an " +
    "exchange your agent had carries whatever its telemetry emitted, which " +
    "for most frameworks is no timings at all.",
  /**
   * Where the numbers came from, said once and only when it applies.
   *
   * **A verdict's provenance must never be a surprise.** Some of these figures
   * were not timed by anybody: Egma worked them out from the timings your
   * agent's own framework already records. A developer whose latency check
   * suddenly starts failing is owed that sentence on the same screen as the
   * number, not in a document they would have to go and find.
   *
   * Shown only when at least one figure on this page was worked out that way.
   * A page whose every number was timed outright says nothing here, because a
   * caveat about something that did not happen is noise.
   */
  derived:
    "Some figures here were worked out from your framework's own timings " +
    "rather than timed by Egma. Each says which.",
  /**
   * The mark beside one worked-out figure, so a reader need not guess which.
   *
   * **It belongs to that one origin and no other.** A figure an agent platform
   * measured and handed over was not worked out from any framework's timings,
   * so this wording is false about it — and a caveat that is itself untrue is
   * worse than none, because it is the sentence a developer decides how much to
   * believe a verdict on. A platform-reported figure therefore takes no mark and
   * no caveat at all; where it came from stays on the record, not on the page.
   */
  derivedOne: "from your framework's timings",
  /** One measurement is the number; several are the worst of them. */
  worst: "worst",
  counted: (howMany: number): string =>
    howMany === 1 ? "1 measurement" : `${howMany} measurements`,
  /**
   * Said instead of the count when the reading is a prefix of a long exchange.
   *
   * The worst measurement of the first part is not the worst measurement of the
   * call — the slowest turn is as likely to be past the cut as before it — so
   * the figure is qualified rather than shown as though it were the whole. A
   * count would be worse than useless here: it would say how many measurements
   * arrived, which is not how many there were.
   */
  partialWorst: "worst of the part Egma holds",
} as const;

/**
 * The audio **egma** recorded, and the words that keep it apart from the audio
 * a step carries.
 *
 * Two different things share one word on this page, and the confusion is not
 * hypothetical: a step can carry an `audioUrl` the agent's own telemetry
 * attached to it — somebody else's file, at somebody else's address, of
 * whatever that framework decided to keep. What is below is egma's own: both
 * sides of a voice conversation egma drove, the human on one channel and the
 * agent on the other, so either can be heard alone when a turn reads wrong.
 *
 * Neither is ever named just "audio". Each says whose it is, everywhere it
 * appears, so a reader never has to hold two labels side by side to work out
 * which one they are hearing.
 *
 * `persona` is the word for the human side in a **run's** results, and it is
 * deliberately not used here: a transcript may be a production exchange that
 * nobody simulated, where there is no persona to name. `human` and `agent` are
 * the two speakers a transcript labels, and they are what this says.
 */
export const RECORDING = {
  label: "What Egma heard",
  caption:
    "Egma's own audio of this exchange. Left channel is the human side, " +
    "right channel is the agent.",
  /**
   * For a browser that cannot play the element at all. It names an owner like
   * every other line here: a reader whose browser refuses one of the two
   * audios on this page still has to know which one it refused.
   */
  fallback: "Your browser cannot play Egma's own audio.",
  /**
   * Said only once a player has been on screen, and it names whose audio it is
   * for the same reason every other label here does — "this audio could not be
   * played" would leave a reader wondering which of the two failed.
   */
  unplayable:
    "Egma's own audio of this exchange could not be played. The store it " +
    "lives in may be unreachable.",
  /**
   * Reached only when egma itself is at fault. A transcript shows nothing for a
   * conversation that recorded nothing — but a deployment that cannot answer is
   * not that, and a broken egma that looked exactly like a product working
   * correctly is the failure this whole effort exists to end.
   */
  unreachable: LIST.unreachable,
  refused: (status: number) =>
    `Egma answered ${String(status)} for the audio it recorded here.`,
} as const;

/**
 * What each stored `kind` is called where a person can read it.
 *
 * The keys are the store's vocabulary and the values are the product's, and the
 * mapping is deliberate rather than a prettified passthrough:
 *
 * - `model` → **Model** — the language model answering.
 * - `tts` → **Speech** — turning the answer into audio. Not "TTS": an acronym
 *   is a word only to whoever already knows it.
 * - `stt` → **Speech recognition** — turning what was heard into words. No
 *   provider egma has met emits it: LiveKit puts what was heard on the turn
 *   itself rather than on a step of its own. It is here because the ticket
 *   names the step, and a framework that does emit one should meet a word for
 *   it rather than **Other**.
 * - `tool` → **Tool** — the agent reaching for something outside itself.
 * - `end-of-turn` → **Turn detection** — deciding the speaker had finished.
 * - `speaking` → **Speaking** — how long somebody's audio ran.
 * - `root` → **Overview** — the one step everything else happened inside. It is
 *   never part of the exchange, and it is reachable rather than displayed.
 * - `other` → **Other** — a provider egma has no vocabulary for yet. It renders
 *   rather than disappearing, because a step nobody named still took time.
 *
 * An unknown kind falls through to **Other** for the same reason: coverage is
 * not uniform across providers, and a page that hid what it could not classify
 * would quietly under-report the very frameworks egma has not met yet.
 */
export const STEP_LABELS: Readonly<Record<string, string>> = {
  root: "Overview",
  "turn:human": "Human turn",
  "turn:agent": "Agent turn",
  model: "Model",
  tts: "Speech",
  // No provider egma has met emits this one yet; see above.
  stt: "Speech recognition",
  tool: "Tool",
  "end-of-turn": "Turn detection",
  speaking: "Speaking",
  other: "Other",
};

export const UNKNOWN_STEP_LABEL = "Other";

export function stepLabel(kind: string): string {
  return STEP_LABELS[kind] ?? UNKNOWN_STEP_LABEL;
}
