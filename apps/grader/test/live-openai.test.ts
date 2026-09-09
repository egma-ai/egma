import { GRADER_DEFINITION_CATALOG, PREDEFINED_GRADERS, RECOMMENDED_GRADER_MODEL } from "@egma/db";
import { describe, expect, it } from "vitest";

import { judgeFor, type JudgeInput } from "../src/judge/index.ts";

/**
 * Opt-in live test of the shipped Expected behaviors model and provider settings.
 * Skips without TEST_OPENAI_API_KEY; makes one model request and uses no stores.
 * Run: TEST_OPENAI_API_KEY=... npx vitest run apps/grader/test/live-openai
 */

/**
 * The words a real judge is told it is working under: the ones on the
 * `expected_behaviors` library entry, which is where the only judge prompt egma
 * ships lives. Asking a real model with anything else would be smoke-testing a
 * prompt no deployment sends.
 */
const EXPECTED_BEHAVIORS =
  GRADER_DEFINITION_CATALOG.find(
    (entry) => entry.id === PREDEFINED_GRADERS.expectedBehaviors,
  );
const JUDGE_MODEL = RECOMMENDED_GRADER_MODEL;
if (
  EXPECTED_BEHAVIORS?.prompt === null ||
  EXPECTED_BEHAVIORS?.prompt === undefined ||
  JUDGE_MODEL === null ||
  JUDGE_MODEL === undefined
) {
  throw new Error("Expected behaviors has no executable judge definition");
}

const API_KEY = process.env["TEST_OPENAI_API_KEY"]?.trim() ?? "";
const THE_PROMPT = "Judge instruction_1. Return one result with id instruction_1, decision met/not_met/cannot_determine, rationale, and cited_turns.";

/** One short conversation, plainly settling one thing and plainly not another. */
const EVIDENCE: JudgeInput = {
  transcript: [
    { at: 1, speaker: "agent", text: "Thanks for calling Lakeside Dental." },
    { at: 2, speaker: "persona", text: "I need to move my cleaning to Thursday." },
    { at: 3, speaker: "agent", text: "Thursday at four works. Shall I move it?" },
    { at: 4, speaker: "persona", text: "Yes please." },
    { at: 5, speaker: "agent", text: "Booked for Thursday at four. Anything else?" },
  ],
  toolCalls: [{ tool: "reschedule_appointment", arguments: '{"to":"Thursday"}' }],
  measures: [{ measure: "turn_response_latency", samples: [900, 1_100] }],
};

describe.skipIf(API_KEY === "")(
  "a real OpenAI judge, asked one criterion",
  () => {
    const judge = judgeFor(
      JUDGE_MODEL,
      { openai: API_KEY },
    ).ask;

    it("answers met, with a reason and a turn it rests on", async () => {
      const response = await judge({
        prompt: THE_PROMPT,
        criterion: "the agent confirms the new time back before finishing",
        evidence: EVIDENCE,
        expectedBehaviors: [],
      });

      const answer = response.results[0]!;
      expect(answer.decision).toBe("met");
      expect(answer.rationale.trim()).not.toBe("");
      for (const cited of answer.cited_turns) {
        expect(cited).toBeGreaterThanOrEqual(1);
        expect(cited).toBeLessThanOrEqual(EVIDENCE.transcript.length);
      }
    });

    /**
     * The other half of the answer shape, and the one a judge has to be able to
     * reach: a criterion this conversation says nothing about. Asserted as "not
     * met" rather than as one exact word, because whether a model calls silence
     * `not_met` or `cannot_determine` is its judgment to make — what egma needs
     * is that it never calls it met.
     */
    it("does not call a criterion met when the conversation never touched it", async () => {
      const response = await judge({
        prompt: THE_PROMPT,
        criterion: "the agent quotes the price of the cleaning in dollars",
        evidence: EVIDENCE,
        expectedBehaviors: [],
      });

      const answer = response.results[0]!;
      expect(answer.decision).not.toBe("met");
      expect(["not_met", "cannot_determine"]).toContain(answer.decision);
    });
  },
);
