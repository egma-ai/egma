import { createHmac } from "node:crypto";

import { GRADER_LIBRARY_CATALOG, PREDEFINED_GRADERS } from "@egma/db";
import { describe, expect, it } from "vitest";

import type { JudgeInput } from "../src/judge/index.ts";
import { openaiJudge } from "../src/judge/openai.ts";

/**
 * The grader's own provider client, on both paths a release ships — opt-in.
 *
 * **Why this exists beside `live-openai.test.ts`.** That file asks whether a
 * real model answers the shape this judge sends. This one asks a different
 * question: whether the *same* judge, unchanged, reaches its provider both ways
 * a customer's organization can be configured — straight at the provider with
 * the organization's own credential, and through the deployed Egma model
 * gateway with an inference credential. The specification asks for every
 * visible LLM entry to be proved for persona work and grader work separately
 * unless the two callers share one tested client, and they do not: the
 * simulator's client is a Python one and this is four fields and a `fetch`.
 *
 * **Nothing is mocked and nothing is stubbed.** The judge is built exactly as
 * `judgesOnce` builds it — the same maker, the same resolved shape — and the
 * only difference between the two cases is the endpoint and the key, which is
 * the whole claim managed model access makes about the grader.
 *
 * It is opt-in because CI holds no OpenAI account and no deployed gateway, and
 * each half skips on its own credentials:
 *
 *     OPENAI_API_KEY=... \
 *     EGMA_GATEWAY_ORIGIN=https://... EGMA_GATEWAY_INTERNAL_KEY=... \
 *     EGMA_GATEWAY_ORGANIZATION_ID=org_... \
 *     npx vitest run apps/grader/test/live-catalog
 */

/** The catalog's recommended default for the one visible LLM entry. */
const MODEL = process.env["TEST_OPENAI_MODEL"]?.trim() ?? "gpt-4o-mini";

const PROVIDER_KEY =
  process.env["TEST_OPENAI_API_KEY"]?.trim() ?? process.env["OPENAI_API_KEY"]?.trim() ?? "";

const GATEWAY_ORIGIN = (process.env["EGMA_GATEWAY_ORIGIN"]?.trim() ?? "").replace(/\/+$/, "");

/**
 * What this run presents to the Egma model gateway.
 *
 * **Two shapes, because the product has two.** A self-hosted deployment holds a
 * real inference key and sends it as it stands. Hosted Egma holds no key at
 * all: it signs a short-lived assertion of the organization it is acting for
 * with the key it shares with the gateway, and the gateway checks that on its
 * own without asking anybody. Either one authorizes the same routes, so either
 * one proves the same thing about this path.
 */
function gatewayCredential(): string {
  const held = process.env["EGMA_GATEWAY_INFERENCE_KEY"]?.trim() ?? "";
  if (held !== "") return held;

  const signing = process.env["EGMA_GATEWAY_INTERNAL_KEY"]?.trim() ?? "";
  const organization = process.env["EGMA_GATEWAY_ORGANIZATION_ID"]?.trim() ?? "";
  if (signing === "" || organization === "") return "";

  const payload = Buffer.from(
    JSON.stringify({ o: organization, x: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  const signature = createHmac("sha256", signing).update(payload).digest("base64url");
  return `egma_ig_${payload}.${signature}`;
}

const THE_PROMPT =
  GRADER_LIBRARY_CATALOG.find((entry) => entry.id === PREDEFINED_GRADERS.expectedBehaviors)
    ?.prompt ?? "";

/** One short conversation, plainly settling one thing. Short, because spend. */
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

const CRITERION = "the agent confirms the new time back before finishing";

describe("the grader's judge, reaching its provider", () => {
  it.skipIf(PROVIDER_KEY === "")(
    "answers with the organization's own credential, straight at the provider",
    async () => {
      const judge = openaiJudge({ provider: "openai", model: MODEL, key: PROVIDER_KEY });
      const answer = await judge({
        prompt: THE_PROMPT,
        criterion: CRITERION,
        evidence: EVIDENCE,
      });

      expect(answer.decision).toBe("met");
      expect(answer.rationale.trim()).not.toBe("");
    },
    60_000,
  );

  it.skipIf(GATEWAY_ORIGIN === "" || gatewayCredential() === "")(
    "answers with an Egma credential, through the deployed Egma model gateway",
    async () => {
      /**
       * The one difference from the case above, and it is the whole point: an
       * endpoint and a key. The judge is the same function, the request is the
       * same request, and the grader needs no second provider adapter for
       * managed access — which is what the endpoint being a field rather than
       * a branch is there to make true.
       */
      const judge = openaiJudge({
        provider: "openai",
        model: MODEL,
        key: gatewayCredential(),
        endpoint: `${GATEWAY_ORIGIN}/openai/v1`,
      });
      const answer = await judge({
        prompt: THE_PROMPT,
        criterion: CRITERION,
        evidence: EVIDENCE,
      });

      expect(answer.decision).toBe("met");
      expect(answer.rationale.trim()).not.toBe("");
    },
    60_000,
  );
});
