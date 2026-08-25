import { GRADER_DEFINITION_CATALOG, PREDEFINED_GRADERS } from "@egma/db";
import { describe, expect, it } from "vitest";

import { openaiJudge } from "../src/judge/openai.ts";
import type { JudgeInput } from "../src/judge/index.ts";

/**
 * One real question put to a real OpenAI judge — opt-in.
 *
 * Everything else in this suite runs on the scripted judge, which proves egma's
 * side of the seam: the fan-out, the isolation, the skipped denominator, the
 * errored sibling. It proves nothing at all about the wire. This file is the
 * other half — the provider, the request shape, the answer shape — against the
 * real endpoint, so that a change at OpenAI is something a test can find rather
 * than something a customer finds.
 *
 * It is opt-in because CI holds no OpenAI account. With no key in the
 * environment it skips — visibly, never failing, never waiting on anybody:
 *
 *     TEST_OPENAI_API_KEY=sk-... npx vitest run apps/grader/test/live-openai
 *
 * `TEST_OPENAI_MODEL` picks the model; the default is the model in the shipped
 * Expected behaviors definition. Nothing here touches a database or service:
 * one function, one request, one answer, so the pass-with-key path is as small
 * as it can be and a failure names the provider rather than the harness.
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
if (
  EXPECTED_BEHAVIORS?.prompt === null ||
  EXPECTED_BEHAVIORS?.prompt === undefined ||
  EXPECTED_BEHAVIORS.judgeModel === null
) {
  throw new Error("Expected behaviors has no executable judge definition");
}

const API_KEY = process.env["TEST_OPENAI_API_KEY"]?.trim() ?? "";
const MODEL = process.env["TEST_OPENAI_MODEL"]?.trim() ??
  EXPECTED_BEHAVIORS.judgeModel.model;
const THE_PROMPT = EXPECTED_BEHAVIORS.prompt;

/** One short conversation, plainly settling one thing and plainly not another. */
const EVIDENCE: JudgeInput = {
  transcript: [
    { at: 1, speaker: "agent", text: "Thanks for calling Lakeside Dental." },
    { at: 2, speaker: "persona", text: "I need to move my cleaning to Thursday." },
    { at: 3, speaker: "agent", text: "Thursday at four works. Shall I move it?" },
    { at: 4, speaker: "persona", text: "Yes please." },
    { at: 5, speaker: "agent", text: "Booked for Thursday at four. Anything else?" },
  ],
  outcome: { happened: true, endingReason: "persona_concluded", turns: 5 },
  toolCalls: [{ tool: "reschedule_appointment", arguments: '{"to":"Thursday"}' }],
  measures: [{ measure: "turn_response_latency", samples: [900, 1_100] }],
};

describe.skipIf(API_KEY === "")(
  "a real OpenAI judge, asked one criterion",
  () => {
    const judge = openaiJudge({ provider: "openai", model: MODEL, key: API_KEY });

    it("answers met, with a reason and a turn it rests on", async () => {
      const answer = await judge({
        prompt: THE_PROMPT,
        criterion: "the agent confirms the new time back before finishing",
        evidence: EVIDENCE,
      });

      expect(answer.decision).toBe("met");
      expect(answer.rationale.trim()).not.toBe("");
      for (const cited of answer.citedTurns) {
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
      const answer = await judge({
        prompt: THE_PROMPT,
        criterion: "the agent quotes the price of the cleaning in dollars",
        evidence: EVIDENCE,
      });

      expect(answer.decision).not.toBe("met");
      expect(["not_met", "cannot_determine"]).toContain(answer.decision);
    });
  },
);
