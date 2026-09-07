/**
 * Shared copy for the production evidence list and transcript detail.
 * Keep spoken turns and tool calls named consistently; API paths remain
 * machine identifiers rather than display copy.
 */

/** The list page. */
export const LIST = {
  /** Page heading. Navigation labels are defined in lib/navigation.ts. */
  title: "Traces",
  /** What the table is called where somebody hears it rather than sees it. */
  tableLabel: "Production transcripts in this project",
  loadingWhat: "this project's production transcripts",
  signedOut: "Sign in first",
  signedOutLead: "This page is about your project.",
  signIn: "Sign in",
  setUp: "Set up Egma",
  /** The one action this page offers. Agents owns the shared setup flow. */
  monitorAgent: "Set up monitoring",
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

/** Trace-list column labels; the page owns their order. */
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

/** The compact production-call index approved for the Monitoring list. */
export const TRACE_COLUMNS = {
  time: "Time",
  duration: "Duration",
  p90TurnLatency: "P90 turn latency",
  traceId: "Trace ID",
  agent: "Agent",
  actions: "Actions",
} as const;

/** One opened production trace, as a continuous summary and transcript sheet. */
export const TRACE_SHEET = {
  title: "Trace",
  completed: "Completed",
  pending: "Pending",
  navigation: "Trace sections",
  sections: {
    summary: "Summary",
    transcript: "Transcript",
  },
  overview: {
    title: "Call overview",
    started: "Started",
    duration: "Duration",
    turns: "Turns",
    p90TurnLatency: "P90 turn latency",
    notRecorded: "Not recorded",
    partial: "partial",
  },
  grading: {
    title: "Grading",
    emptyTitle: "No grades for this trace",
    emptyLead:
      "No project grader was active when this trace was recorded.",
    pendingTitle: "Grading is still running",
    pendingLead: "Project grades appear here as they finish.",
    errorTitle: "Grading could not be completed",
    errorLead: "Egma could not complete the requested grades for this trace.",
  },
  recording: {
    sectionTitle: "Recording",
    title: "Call recording",
    caller: "Caller",
    agent: "Agent",
    absent: "No audio recording is available for this trace.",
  },
  transcript: {
    title: "Transcript",
    nothingTitle: "Nothing was said",
    nothingLead: "Egma recorded no spoken turns for this trace.",
  },
  actions: {
    openFullTranscript: "Open full transcript",
  },
} as const;

/**
 * Guidance for an empty window, empty recent history, a visible organization
 * key, or traffic with no production grader. The history probe covers only
 * the widest offered window; it does not establish all-time absence.
 */
export const QUIET = {
  narrowWindow: {
    title: "Nothing in this window",
    lead: "Widen the window above to look further back.",
  },
  setUp: {
    /** Exact empty state from Paper board 26. */
    title: "No production traces yet",
    lead:
      "Set up monitoring for an agent. Traces appear here after Egma receives " +
      "production traffic.",
  },
  organizationKey: {
    title: "A key here names the whole organization",
    lead:
      "The key that export uses has to name this project. Egma rejects an " +
      "organization-wide key for production telemetry.",
    key: "Mint a key for this project",
  },
  unwatched: {
    lead: "No project grader grades production transcripts, so no grades appear here.",
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
 * Metric display text. Metrics describe observations; grades contain scores.
 * Use API reductions and catalog units, and omit absent metrics instead of
 * showing zero. metricLine displays p90; other surfaces can choose another reduction.
 */
export const MEASURES = {
  label: "What was measured",
  /** Nothing measured is an ordinary answer, and it says which two ways. */
  none:
    "Nothing was measured here. Egma's own simulations time their turns; an " +
    "exchange your agent had carries whatever its telemetry emitted, which " +
    "for most frameworks is no timings at all.",
  /** Show when at least one displayed metric was derived from framework timings. */
  derived:
    "Some figures here were worked out from your framework's own timings " +
    "rather than timed by Egma. Each says which.",
  /**
   * Mark framework-derived metrics only. Agent-platform reported values have
   * a different origin and must not receive this label.
   */
  derivedOne: "from your framework's timings",
  /** One measurement is the number; several are read at the p90 — the figure
   * the slow tail of the call is felt in. */
  p90: "p90",
  counted: (howMany: number): string =>
    howMany === 1 ? "1 measurement" : `${howMany} measurements`,
  /**
   * Said instead of the count when the reading is a prefix of a long exchange.
   *
   * The p90 of the first part is not the p90 of the call — the turns past the
   * cut moved it, and nobody holds them — so the figure is qualified rather
   * than shown as though it were the whole. A count would be worse than
   * useless here: it would say how many measurements arrived, which is not how
   * many there were.
   */
  partialP90: "p90 of the part Egma holds",
} as const;

/**
 * Distinguish Egma's simulation recording from external audio URLs on spans.
 * Transcript speaker labels use human and agent because the same surface
 * also reads production traces, which have no persona.
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

/** Display labels for stored span kinds. Unknown kinds remain visible as Other. */
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
