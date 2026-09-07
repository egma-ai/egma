/**
 * Shared forbidden names for mock tools, used by the contract and platform
 * vocabulary tests. Context-dependent words still require manual review;
 * for example, session is valid for browser authentication.
 */

/** One word that must appear nowhere, and what to say in its place. */
export type BannedWord = {
  /** The pattern, without its word boundaries — those are added on use. */
  readonly pattern: string;
  readonly instead: string;
};

export const BANNED_MOCK_TOOL_WORDS: readonly BannedWord[] = [
  // The entity's name, inverted.
  { pattern: String.raw`tool[ _-]mocks?`, instead: "mock tool" },
  // Same job as `mock tool`, and one job takes one word.
  { pattern: String.raw`stubs?`, instead: "mock tool" },
  { pattern: String.raw`fakes?`, instead: "mock tool" },
  // Half the industry means the test by this, the other half the thing
  // scoring it. Ahead of the wider `eval` pattern below, which would also
  // match it and would answer with the wrong word to use instead.
  { pattern: String.raw`evaluators?`, instead: "grader" },
  // Everyone says it, nobody agrees what it points at — in every form it
  // inflects into, because `evaluating` is the same word wearing a suffix.
  {
    pattern: String.raw`eval(uat\w*|s)?`,
    instead: "nothing — say what is meant",
  },
];

/**
 * Allow names for LiveKit test doubles without exempting their entire files
 * from the vocabulary scan. They do not name mock tools.
 */
const EXEMPT = [
  /\bRoom_?Stubs?\b/gu,
  /\broom[ _-]stubs?\b/giu,
] as const;

/** What a banned word looks like when the scanner finds one. */
export type BannedWordFound = {
  /** The text as it actually appears, for a message that quotes it. */
  readonly found: string;
  readonly instead: string;
};

/**
 * The first banned word in some text, or nothing where there is none.
 *
 * Whole words, so `retrieval` is not read as an `eval` and `mock_tool_agent`
 * is not read as a `tool mock`. The exempt names are blanked first, so a file
 * naming the room-shaped double is scanned like any other rather than trusted
 * like no other.
 */
export function bannedWordIn(text: string): BannedWordFound | undefined {
  let scanned = text;
  for (const exempt of EXEMPT) scanned = scanned.replace(exempt, " ");

  for (const { pattern, instead } of BANNED_MOCK_TOOL_WORDS) {
    const found = new RegExp(String.raw`\b${pattern}\b`, "iu").exec(scanned);
    if (found !== null) return { found: found[0], instead };
  }
  return undefined;
}
