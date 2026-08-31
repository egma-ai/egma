/** Values printed in the CLI's one-fact-per-line protocol must stay on one line. */

export const MAX_FACT_VALUE_LENGTH = 200;

const UNSAFE_FACT_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_FACT_TEXT_GLOBAL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export type FactValueIssue = "empty" | "too-long" | "unsafe";

/** Check text that must stay on one line but is not itself printed as a fact. */
export function oneLineValueIssue(
  value: string,
): Exclude<FactValueIssue, "too-long"> | null {
  if (value === "") return "empty";
  return UNSAFE_FACT_TEXT.test(value) ? "unsafe" : null;
}

/** Turn unknown error text into one bounded value for the fact protocol. */
export function oneLineFactText(value: string, fallback: string): string {
  const cleaned = value.replaceAll(UNSAFE_FACT_TEXT_GLOBAL, "").trim();
  return cleaned === "" ? fallback : cleaned.slice(0, MAX_FACT_VALUE_LENGTH);
}

/** Check caller-controlled text before it can become either a fact or a write. */
export function factValueIssue(value: string): FactValueIssue | null {
  const oneLineIssue = oneLineValueIssue(value);
  if (oneLineIssue !== null) return oneLineIssue;
  if (value.length > MAX_FACT_VALUE_LENGTH) return "too-long";
  return null;
}
