/**
 * The words the mocked world is not described in, and the one exemption.
 *
 * One entity, one word: a **mock tool**. The inverted form and the two
 * near-synonyms each read as a different thing to somebody arriving from
 * another tool, and a schema property, a wire field or a refusal sentence
 * carrying one of them is the version that sticks — a column is renamed by a
 * migration, and a refusal sentence a client branches on is renamed by nobody
 * at all.
 *
 * **Here rather than in either suite that scans with it.** Two guards were
 * written independently, one over this package's own documents and one over
 * the platform's mock-tool surface, and they had already drifted into two word
 * lists — so a word banned by one was a word the other let through, which is
 * the failure a vocabulary guard exists to prevent happening to itself. The
 * list lives beside the contract because that is where a word becomes
 * permanent: a schema property outlives the prose that explained it.
 *
 * **What this deliberately cannot catch.** Only the words with no legitimate
 * use anywhere are here. The rest of the settled vocabulary is about which
 * *meaning* a word may carry — `session` is wrong for a conversation and right
 * for a signed-in one, `call` is wrong for a simulation and right in
 * `tool_call` — and a scanner that flagged those would cry wolf on every page
 * until somebody turned it off. Those stay a reading job. This is the floor,
 * not the ceiling.
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
  // Everyone says it, nobody agrees what it points at.
  { pattern: String.raw`evals?`, instead: "nothing — say what is meant" },
  {
    pattern: String.raw`evaluations?`,
    instead: "nothing — say what is meant",
  },
  { pattern: String.raw`evaluators?`, instead: "grader" },
];

/**
 * The one carve-out, and it is the glossary's rather than this scanner's.
 *
 * `stub` and `fake` are banned **as names for a mock tool**. The room-shaped
 * test double that both Python suites hold this seam against is not one: it
 * stands in for a LiveKit room, not for one of the agent's tools, and it keeps
 * the name it has always had. So the exemption is written down here and
 * applied before the scan, rather than by leaving the files that mention it
 * out — a file skipped for one word is a file unguarded for all of them.
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
