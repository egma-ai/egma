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
 * The URLs are deliberately not copy. `/traces/…` is a machine surface — it is
 * the v1 endpoint's own path, and matching it is how somebody reading the
 * network tab finds the request — and no page ever prints it as a word.
 */

/** The list page. */
export const LIST = {
  navigation: "Transcripts",
  title: "Transcripts",
  lead: "What your agents did, newest first.",
  loading: "Loading…",
  signedOut: "Sign in first",
  signedOutLead: "This page is about your project.",
  signIn: "Sign in",
  setUp: "Set up egma",
  back: "Back",
  unreachable: "egma could not be reached. Is the API running?",
  /**
   * The third sentence is the one that saves an afternoon.
   *
   * A browser always acts inside one project, and this page shows that
   * project. A key minted for a whole organization names none, so what it
   * exports files outside every project and cannot be reached from here — an
   * empty list that looks exactly like an exporter that was never pointed at
   * egma at all. The only place somebody meets that is here, so it is said
   * here rather than only in the README.
   */
  empty:
    "Nothing was recorded in this window. Point an agent's OpenTelemetry " +
    "export at egma, or widen the window above. The key that export uses has " +
    "to name this project — a key minted for the whole organization files " +
    "its telemetry outside every project, and none of it appears here.",
  window: "Window",
  showMore: "Show more",
  loadingMore: "Loading…",
  counted: (shown: number) =>
    shown === 1 ? "1 transcript" : `${shown} transcripts`,
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
 */
export const COLUMNS = {
  started: "Started",
  duration: "Duration",
  turns: "Turns",
  preview: "First human line",
  steps: "Steps",
  tools: "Tools",
  errors: "Errors",
  source: "Source",
  environment: "Environment",
  connection: "Connection",
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
  loading: "Loading…",
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
  graders: "What the graders decided",
  gradersLead:
    "One judgment per check, each with the turns it read. The exchange is on " +
    "the left; nothing here is mixed into it.",
  nothingJudged: "Nothing has judged this exchange.",
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
  judgedBy: "Judged by",
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
  source: COLUMNS.source,
  environment: COLUMNS.environment,
  connection: COLUMNS.connection,
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
 * The audio **egma** recorded, and the words that keep it apart from the audio
 * a step carries.
 *
 * Two different things share one word on this page, and the confusion is not
 * hypothetical: a step can carry an `audio_url` the agent's own telemetry
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
  label: "What egma heard",
  caption:
    "egma's own audio of this exchange. Left channel is the human side, " +
    "right channel is the agent.",
  /**
   * Two bands are two units — the narrow band a telephone carries strips what
   * an audio grader reads — so a reader listening is told which one this is.
   */
  band: (hertz: number) => `Heard at ${String(hertz)} Hz.`,
  /**
   * For a browser that cannot play the element at all. It names an owner like
   * every other line here: a reader whose browser refuses one of the two
   * audios on this page still has to know which one it refused.
   */
  fallback: "Your browser cannot play egma's own audio.",
  /**
   * Said only once a player has been on screen, and it names whose audio it is
   * for the same reason every other label here does — "this audio could not be
   * played" would leave a reader wondering which of the two failed.
   */
  unplayable:
    "egma's own audio of this exchange could not be played. The store it " +
    "lives in may be unreachable.",
  /**
   * Reached only when egma itself is at fault. A transcript shows nothing for a
   * conversation that recorded nothing — but a deployment that cannot answer is
   * not that, and a broken egma that looked exactly like a product working
   * correctly is the failure this whole effort exists to end.
   */
  unreachable: LIST.unreachable,
  refused: (status: number) =>
    `egma answered ${String(status)} for the audio it recorded here.`,
} as const;

/**
 * The two speakers, exactly as the domain model labels them in a transcript.
 * `human` is the caller's side and `agent` is the agent under test, and neither
 * word is ever borrowed for the other.
 */
export const SPEAKERS = { human: "human:", agent: "agent:" } as const;

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
