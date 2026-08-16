import { afterEach, describe, expect, it, vi } from "vitest";

import { GRADER_LIBRARY_CATALOG, PREDEFINED_GRADERS } from "@egma/db";

import { openaiJudge } from "../src/judge/openai.ts";
import type { JudgeInput, JudgeQuestion } from "../src/judge/index.ts";

/**
 * The OpenAI provider's wire, without the wire.
 *
 * The live smoke beside this file asks a real model and needs a real account;
 * this one asserts everything about the request and the answer that does not
 * need one — the endpoint, the header the key rides in, the shape of the body,
 * what a malformed answer comes to, and which refusals are worth asking again
 * about. `fetch` is replaced rather than intercepted, because what is under
 * test is the one function that calls it.
 */

const EVIDENCE: JudgeInput = {
  transcript: [
    { at: 1, speaker: "agent", text: "Thanks for calling." },
    { at: 2, speaker: "persona", text: "Move my cleaning to Thursday." },
  ],
  outcome: { happened: true, endingReason: "persona_concluded", turns: 2 },
  toolCalls: [],
  measures: [],
};

/**
 * The words a judge is told it is working under, off the library entry that
 * carries them.
 *
 * **This adapter holds no prompt of its own**, and that is the property worth
 * stating here: what a judge is told is the definition on the shelf, read
 * through the running copy's pointer at judging time, so the Library screen and
 * the request are one row. A prompt written into this file would be a second
 * copy, and the day the two disagreed the screen would go on describing a
 * judgment nobody was making.
 */
const THE_PROMPT =
  GRADER_LIBRARY_CATALOG.find(
    (entry) => entry.id === PREDEFINED_GRADERS.expectedBehaviors,
  )?.prompt ?? "";

const QUESTION: JudgeQuestion = {
  prompt: THE_PROMPT,
  criterion: "the agent confirms the new time",
  evidence: EVIDENCE,
};

const A_KEY = "sk-openai-test-NEVERLEAKME";

/**
 * A response per attempt rather than one response reused: a body can only be
 * read once, and the retry cases ask for the same refusal three times.
 */
type Answering = () => Response;

function answering(content: unknown): Answering {
  return () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

function refusing(status: number, body = "no"): Answering {
  return () => new Response(body, { status });
}

function judgeWith(...responses: readonly Answering[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let at = 0;

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const response = responses[Math.min(at, responses.length - 1)];
    at += 1;
    if (response === undefined) throw new Error("nothing left to answer with");
    return response();
  });

  return {
    calls,
    judge: openaiJudge({ provider: "openai", model: "gpt-4.1-mini", key: A_KEY }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("one judge call", () => {
  it("asks the version-pinned chat completions endpoint, with the key in the header", async () => {
    const { calls, judge } = judgeWith(
      answering({ decision: "met", rationale: "read back.", cited_turns: [2] }),
    );

    await judge(QUESTION);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${A_KEY}`);

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("gpt-4.1-mini");
    // The same conversation and the same criterion should get the same verdict
    // twice, as far as a model can promise that at all.
    expect(body["temperature"]).toBe(0);
    expect(body["response_format"]).toEqual({ type: "json_object" });
  });

  it("shows the judge the one criterion and the declared set, and nothing else", async () => {
    const { calls, judge } = judgeWith(
      answering({ decision: "met", rationale: "read back.", cited_turns: [] }),
    );

    await judge(QUESTION);

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      messages: { role: string; content: string }[];
    };
    const asked = body.messages.at(-1)?.content ?? "";

    expect(asked).toContain("## Criterion");
    expect(asked).toContain("the agent confirms the new time");
    expect(asked).toContain("## Transcript");
    expect(asked).toContain("[2] persona: Move my cleaning to Thursday.");
    expect(asked).toContain("## Outcome");
    expect(asked).toContain("## Tool calls");
    expect(asked).toContain("(no tool calls were recorded)");
    expect(asked).toContain("## Measures");
  });

  it("reads back the decision, the reason and the turns it cited", async () => {
    const { judge } = judgeWith(
      answering({
        decision: "not_met",
        rationale: "the agent never said the day back.",
        cited_turns: [1, 2],
      }),
    );

    expect(await judge(QUESTION)).toEqual({
      decision: "not_met",
      rationale: "the agent never said the day back.",
      citedTurns: [1, 2],
    });
  });

  it("takes cannot_determine as the answer it is", async () => {
    const { judge } = judgeWith(
      answering({
        decision: "cannot_determine",
        rationale: "the conversation never reached the subject.",
        cited_turns: [],
      }),
    );

    expect((await judge(QUESTION)).decision).toBe("cannot_determine");
  });
});

describe("a provider that does not answer", () => {
  it("asks again after a rate limit, and answers when it lands", async () => {
    const { calls, judge } = judgeWith(
      refusing(429, "slow down"),
      answering({ decision: "met", rationale: "read back.", cited_turns: [] }),
    );

    expect((await judge(QUESTION)).decision).toBe("met");
    expect(calls).toHaveLength(2);
  });

  it("gives up after three attempts, saying what the provider said", async () => {
    const { calls, judge } = judgeWith(refusing(503, "upstream unavailable"));

    await expect(judge(QUESTION)).rejects.toThrow(/503/);
    expect(calls).toHaveLength(3);
  });

  /**
   * A rejected key and a model that does not exist are not transient. Asking
   * again would spend the same seconds to be told the same thing, and the
   * assertion is `errored` either way with the provider's own words on it.
   */
  it("does not ask again about a refusal asking again cannot fix", async () => {
    const { calls, judge } = judgeWith(refusing(401, "invalid api key"));

    await expect(judge(QUESTION)).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);
  });

  it("treats an answer it cannot read as no answer, and not as cannot_determine", async () => {
    const { judge } = judgeWith(
      answering({ decision: "probably", rationale: "hmm", cited_turns: [] }),
    );

    await expect(judge(QUESTION)).rejects.toThrow(/decision Egma does not know/);
  });

  it("never puts the request — and so never the key — in what it throws", async () => {
    const { judge } = judgeWith(refusing(401, "invalid api key"));

    await expect(judge(QUESTION)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("NEVERLEAKME") as unknown as string,
      }),
    );
  });
});
