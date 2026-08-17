/**
 * The facts the find-the-agent step brings back, in one place.
 *
 * The same list is said four ways: the name a marker line reports it under,
 * the label the card and the status line write, and the words a sentence asks
 * for it in. Keeping the three beside each other is what stops the screen, the
 * card and the message a developer pastes into a coding agent egma cannot
 * drive from drifting apart.
 *
 * This module is the source of truth. Prose that has to stay prose — the skill
 * that teaches the marker lines, and the README — repeats the list and carries
 * a comment pointing here.
 */

export type Fact = {
  /** The name the agent reports it under: `egma:found <name> <value>`. */
  readonly name: string;
  /** How the card and the status line label it. */
  readonly label: string;
  /** How a sentence asks for it. */
  readonly phrase: string;
};

export const FACTS: readonly Fact[] = [
  { name: "framework", label: "Framework", phrase: "which framework runs it" },
  { name: "agent-name", label: "Name", phrase: "what the voice agent is called" },
  { name: "prompts", label: "Prompts", phrase: "where its prompts live" },
  { name: "tools", label: "Tools", phrase: "where its tools are defined" },
  { name: "deploy", label: "Deploy", phrase: "how it reaches production" },
  { name: "agent-id", label: "Agent id", phrase: "where its identifier is written down" },
] as const;

/** Every label padded to this, so the values line up under each other. */
export const LABEL_WIDTH = Math.max(...FACTS.map((fact) => fact.label.length));

/** What this fact is called on screen, or `null` when it is not one egma asked for. */
export function labelFor(name: string): string | null {
  return FACTS.find((fact) => fact.name === name)?.label ?? null;
}

/** The facts as one English list, for a sentence that asks for all of them. */
export function factsAsked(): string {
  const phrases = FACTS.map((fact) => fact.phrase);
  const last = phrases[phrases.length - 1] as string;
  return phrases.length === 1 ? last : `${phrases.slice(0, -1).join(", ")}, and ${last}`;
}
