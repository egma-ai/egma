import type { Phrase, PhraseSpeaker } from "@egma/db";

import { judgeInputOf, turnReference, type Turn } from "../judge/index.ts";
import { theOneCheck, type ExecutionOf, type Judgment } from "./contract.ts";

/**
 * The disclosure that had to be said and the promise that must not have been —
 * looked for in the transcript, and no model is asked anything.
 *
 * Compliance checks are the case for a deterministic type at its strongest. "Did
 * the agent read the recording disclosure" has one right answer, a judge would
 * cost a model call to agree with a substring search, and a judge that
 * occasionally disagreed with itself about a fixed sentence would be worse than
 * useless on the one check an auditor will actually ask about.
 *
 * ## Whose turns are searched
 *
 * The default is the agent's, and that is the product's line rather than a
 * convenience: the agent is what is under test, and the persona is egma's own
 * synthetic caller — judging what egma made it say would be judging egma. A
 * grader may name `persona` or `either` deliberately, which is what makes "the
 * caller was never told a price" answerable when the price came from the persona.
 *
 * The labels are the transcript's own. The simulator writes `agent` for the
 * agent under test and its own word for the other side, and a speaker this
 * grader is not scoped to is simply not searched.
 *
 * ## One grader, one dimension
 *
 * A `phrase_match` grader names one dimension — its own type — however many
 * phrases it holds, and the rationale names every phrase that broke the rule,
 * with the turns it was found in cited.
 *
 * **Because a dimension name may derive nothing from the config.** The fold
 * counts one dimension once, keyed by the conversation, the grader and the
 * name, and prefers the latest grading of it. A per-phrase dimension could only
 * be named out of the config — by the phrase's text, which an edit changes, or
 * by its position, which a reorder changes — so a grader edited from three
 * banned phrases to two would leave the third phrase's row behind, speaking
 * forever about a phrase nobody is checking any more, with no later grading able
 * to supersede it.
 *
 * **And because a phrase list is one policy.** "Say the disclosure, never
 * promise a refund" is one thing a compliance team decided; two thirds of it is
 * not a pass, and a score of 0.67 would say it was.
 *
 * ## A pattern that will not compile
 *
 * `errored`, never `failed`. A regular expression is stored as text, and a
 * pattern written before the write door tightened around it — or hand-edited
 * into the row since — is a check egma cannot make rather than a check the agent
 * failed. Saying `failed` there would mark down an agent for egma's own broken
 * config, which is the one thing a test product must never do.
 */
export function executePhraseMatch(
  execution: ExecutionOf<"phrase_match">,
): readonly Judgment[] {
  const { config } = execution.judgment;
  const dimension = theOneCheck("phrase_match");
  // The transcript as the judge reads it, so this grader and a judge looking at
  // one conversation see one list of turns, numbered identically. A citation
  // here and a citation on a rubric's verdict then point at the same turn.
  const turns = judgeInputOf(execution.conversation).transcript.filter((turn) =>
    spokenBy(turn, config.speaker),
  );

  // Every pattern compiled before any of them is applied, so a grader holding
  // one broken pattern says it could not make the check rather than answering
  // about the phrases it happened to reach first.
  const required = compileAll(config.required);
  const banned = compileAll(config.banned);
  const uncompilable = required.broken ?? banned.broken;
  if (uncompilable !== undefined) {
    return [
      {
        dimension,
        verdict: "errored",
        score: 0,
        rationale: `"${uncompilable.text}" is not a regular expression egma can compile, so this check was not made.`,
        citedSpanIds: [],
      },
    ];
  }

  const broken: string[] = [];
  const cited = new Set<number>();

  for (const looking of required.searches) {
    const found = turns.filter((turn) => looking.pattern.test(turn.text));
    if (found.length === 0) {
      broken.push(
        `${describing(looking.phrase)} was never ${said(config.speaker)}`,
      );
      continue;
    }
    for (const turn of found) cited.add(turn.at);
  }

  for (const looking of banned.searches) {
    const found = turns.filter((turn) => looking.pattern.test(turn.text));
    if (found.length === 0) continue;
    broken.push(
      `${describing(looking.phrase)} was ${said(config.speaker)} at ${turnsInWords(found)}`,
    );
    for (const turn of found) cited.add(turn.at);
  }

  const passed = broken.length === 0;

  return [
    {
      dimension,
      verdict: passed ? "passed" : "failed",
      score: passed ? 1 : 0,
      rationale: passed ? heldRationale(config) : `${broken.join("; ")}.`,
      // The turns this judgment is actually about: where a required phrase was
      // found, and where a banned one was. A reader clicks straight to the
      // sentence rather than searching the transcript for it.
      citedSpanIds: [...cited]
        .sort((left, right) => left - right)
        .map(turnReference),
    },
  ];
}

/**
 * Whether this turn is one the grader was scoped to search.
 *
 * `agent` is the agent under test, exactly as the transcript labels it.
 * Everything else in a simulation's transcript is egma's own caller, so
 * `persona` is "not the agent" rather than a second label to match — a plug that
 * writes `human` and one that writes `persona` are both the caller, and a
 * compliance grader that silently searched nothing because of a label is the
 * failure this reading exists to avoid.
 */
function spokenBy(turn: Turn, speaker: PhraseSpeaker): boolean {
  switch (speaker) {
    case "agent":
      return turn.speaker === "agent";
    case "persona":
      return turn.speaker !== "agent";
    case "either":
      return true;
  }
}

/**
 * The phrase as something to search with, or `undefined` for a pattern that
 * will not compile.
 *
 * `contains` is looked for as written and case-insensitively: a disclosure read
 * back in a different case is the disclosure, and a compliance check that turned
 * on capitalisation would fail on transcription rather than on conduct. A
 * grader that needs the case to matter writes a regular expression, which is
 * what the second word is for — compiled without the `i` flag, so `regex` means
 * exactly what its author wrote.
 */
function compile(phrase: Phrase): RegExp | undefined {
  if (phrase.match === "contains") {
    return new RegExp(escaped(phrase.text), "i");
  }
  try {
    return new RegExp(phrase.text);
  } catch {
    return undefined;
  }
}

/** Every character a regular expression reads as syntax, made literal. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One phrase, ready to be looked for. */
type Search = { readonly phrase: Phrase; readonly pattern: RegExp };

/** A whole list compiled, or the first phrase in it that would not compile. */
type Compiled = {
  readonly searches: readonly Search[];
  readonly broken: Phrase | undefined;
};

function compileAll(phrases: readonly Phrase[]): Compiled {
  const searches: Search[] = [];
  for (const phrase of phrases) {
    const pattern = compile(phrase);
    if (pattern === undefined) return { searches, broken: phrase };
    searches.push({ phrase, pattern });
  }
  return { searches, broken: undefined };
}

/** A phrase as the rationale names it. */
function describing(phrase: Phrase): string {
  return phrase.match === "regex"
    ? `the pattern /${phrase.text}/`
    : `"${phrase.text}"`;
}

/** Who was searched, as somebody reads it in a sentence. */
function said(speaker: PhraseSpeaker): string {
  switch (speaker) {
    case "agent":
      return "said by the agent";
    case "persona":
      return "said by the persona";
    case "either":
      return "said";
  }
}

function turnsInWords(turns: readonly Turn[]): string {
  const numbers = turns.map((turn) => `turn ${turn.at}`);
  if (numbers.length <= 2) return numbers.join(" and ");
  return `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
}

/**
 * What a list that held says about itself — the phrases by name, because a
 * verdict read a week later has to say what was checked, and a bare "passed" is
 * a row nobody can audit against the config it came from.
 */
function heldRationale(config: {
  readonly required: readonly Phrase[];
  readonly banned: readonly Phrase[];
  readonly speaker: PhraseSpeaker;
}): string {
  const where = said(config.speaker);
  const parts: string[] = [];
  if (config.required.length > 0) {
    parts.push(`${config.required.map(describing).join(", ")} was ${where}`);
  }
  if (config.banned.length > 0) {
    parts.push(`${config.banned.map(describing).join(", ")} was never ${where}`);
  }
  // The write door refuses a list naming neither, because one that names
  // neither can never fail. A row hand-edited past it says so out loud rather
  // than passing with an empty sentence.
  if (parts.length === 0) {
    return "this grader names no phrases, so nothing was checked.";
  }
  return `${parts.join(", and ")}.`;
}
