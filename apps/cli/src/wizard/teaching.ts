/**
 * The words egma uses, taught while a coding agent writes the first tests.
 *
 * Writing a suite takes a couple of minutes. In that time a developer either
 * learns what egma is talking about or does not, and every screen after this one
 * assumes they did: the gate says "suite", the exit line says "tests", the
 * results show grade scores and grading progress. So the
 * wait teaches the vocabulary, one card at a time, beside the files as they
 * land.
 *
 * The deck is plain data and it is read by the screen alone. Nothing in the
 * walk waits on it, reads it, or is delayed by it — a developer on a fast
 * machine sees one card and a developer on a slow one sees six, and the tests
 * that get written are the same either way.
 *
 * The words are the glossary's own, deliberately. A card that taught a near
 * synonym would be teaching a developer to say something egma does not answer
 * to, which is worse than teaching nothing. So the deck is held to the same ban
 * list as the text egma puts in front of a coding agent, and to no weaker one:
 * a word egma will not say to a model is a word it will not put on a screen.
 *
 * The shape — a card beside a wait, turning on its own — is the PostHog
 * wizard's idea. None of its code is here and none of these words are theirs.
 */

/** One card: a short heading and lines already broken to the pane's width. */
export type LearnCard = {
  readonly heading: string;
  readonly lines: readonly string[];
};

/** How wide a card's lines are written to be, so the pane never rewraps them. */
export const CARD_WIDTH = 32;

/**
 * The deck, in the order a developer meets the ideas: what they are authoring,
 * who is on the other end of it, what happens when it runs, and what comes back.
 */
export const LEARN_CARDS: readonly LearnCard[] = [
  {
    heading: "A test",
    lines: [
      "One situation to put your agent",
      "in: what the person on the other",
      "end wants, and the expected",
      "behaviors that say what should",
      "happen.",
      "",
      "At least one behavior, always —",
      "a test that cannot fail is not",
      "a test.",
    ],
  },
  {
    heading: "A persona",
    lines: [
      "The synthetic person on the",
      "other end: their manner, their",
      "patience, how they behave when",
      "things go wrong.",
      "",
      "A test names the personas it",
      "should be run with. Naming none",
      "takes your default one.",
    ],
  },
  {
    heading: "A run",
    lines: [
      "One execution of a selection of",
      "tests, against one agent, over",
      "one connection.",
      "",
      "A run pins the versions it used,",
      "so what last week's results mean",
      "can never change underneath you.",
    ],
  },
  {
    heading: "A simulation",
    lines: [
      "One test executed once inside a",
      "run: your agent and one persona,",
      "start to finish.",
      "",
      "A run produces one simulation",
      "per test per persona. Each one",
      "leaves a transcript, an outcome",
      "and metrics behind it.",
    ],
  },
  {
    heading: "Measured, or judged",
    lines: [
      "A metric measures: how long it",
      "took, how many turns, how late",
      "the replies were.",
      "",
      "A grader judges. It reads the",
      "transcript, the outcome, or a",
      "metric, and returns one score",
      "from 0 to 1.",
    ],
  },
  {
    heading: "Grade results",
    lines: [
      "Each grade is compared with",
      "that grader's pass threshold.",
      "",
      "Several grades can have one",
      "display-only combined score.",
      "It is not a run result.",
    ],
  },
];

/**
 * The card at this turn of the deck, whichever turn it is.
 *
 * Total rather than bounded: the screen counts up for as long as the writing
 * lasts, and a deck that ran out would leave the pane empty exactly when the
 * developer has been waiting longest.
 */
export function cardAt(turn: number): LearnCard {
  const cards = LEARN_CARDS;
  const at = ((turn % cards.length) + cards.length) % cards.length;
  return cards[at] as LearnCard;
}
