import { GRADER_LIBRARY_CATALOG } from "@egma/db";
import { describe, expect, it } from "vitest";

import { DECISIONS } from "../src/judge/contract.ts";
import { SYSTEM_PROMPT } from "../src/judge/openai.ts";

/**
 * The one prompt, in the two places it currently lives.
 *
 * The `expected_behaviors` library entry carries the judge prompt so a
 * developer can read on the Library screen the words their conversations are
 * judged by. The engine still holds its own copy, because it does not yet
 * resolve its prompt through a running copy's `library_id`. Two copies of one
 * text is a drift waiting to happen, and the drift would be silent in the worst
 * possible way: the screen would go on showing words that had stopped being the
 * words a judge is sent.
 *
 * **This test is scaffolding and is meant to be deleted.** The moment the engine
 * reads the prompt off the entry there is one copy, nothing to compare, and
 * this file goes with the second copy.
 */

const EXPECTED_BEHAVIORS = GRADER_LIBRARY_CATALOG.find(
  (entry) => entry.name === "expected_behaviors",
);

describe("the expected-behaviors judge prompt", () => {
  it("is on the library entry egma ships", () => {
    expect(EXPECTED_BEHAVIORS?.type).toBe("llm_as_judge");
    expect(EXPECTED_BEHAVIORS?.prompt).toBeTypeOf("string");
  });

  it("is byte-for-byte the words the engine actually sends", () => {
    // Not "contains", not "looks like": a prompt differing by one clause is a
    // judge being asked a different question from the one on screen.
    expect(EXPECTED_BEHAVIORS?.prompt).toBe(SYSTEM_PROMPT);
  });

  it("promises exactly the decisions the engine will accept", () => {
    // The entry's reply shape is what the Library screen says a judge must
    // answer; the engine refuses any word outside `DECISIONS`. A fourth word
    // on one side and not the other would be a promise egma breaks at parse
    // time, with `errored` rows and nothing saying why.
    expect(EXPECTED_BEHAVIORS?.outputDefinition?.decision.oneOf).toEqual([
      ...DECISIONS,
    ]);
    for (const decision of DECISIONS) {
      expect(SYSTEM_PROMPT).toContain(decision);
    }
  });
});
