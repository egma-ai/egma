import {
  GRADER_DEFINITION_CATALOG,
  PREDEFINED_GRADERS,
  RECOMMENDED_GRADER_MODEL,
} from "@egma/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  judgeFor,
  type Judge,
  type JudgeInput,
  type JudgeQuestion,
  type JudgeUsage,
  type ResolvedJudge,
} from "../src/judge/index.ts";
import { openaiJudge } from "../src/judge/openai.ts";

/**
 * Replace fetch to test request shape, authentication, parsing, and retry rules.
 * The live smoke test separately checks compatibility with the provider.
 */

const EVIDENCE: JudgeInput = {
  transcript: [
    { at: 1, speaker: "agent", text: "Thanks for calling." },
    { at: 2, speaker: "persona", text: "Move my cleaning to Thursday." },
  ],
  toolCalls: [],
  measures: [{ measure: "turn_response_latency", samples: [420, 630] }],
};

/**
 * The words a judge is told it is working under, off the library entry that
 * carries them.
 *
 * **This adapter holds no prompt of its own**, and that is the property worth
 * stating here: what a judge is told comes from the immutable Library revision
 * pinned by the grader version. A prompt written into this adapter would be a
 * second owner, and a catalog update would no longer have one place to version.
 */
const THE_PROMPT =
  GRADER_DEFINITION_CATALOG.find(
    (entry) => entry.id === PREDEFINED_GRADERS.expectedBehaviors,
  )?.prompt ?? "";

const QUESTION: JudgeQuestion = {
  prompt: THE_PROMPT,
  criterion: "the agent confirms the new time",
  evidence: EVIDENCE,
  expectedBehaviors: [],
};

const A_KEY = "sk-openai-test-NEVERLEAKME";

/**
 * A response per attempt rather than one response reused: a body can only be
 * read once, and the retry cases ask for the same refusal three times.
 */
type Answering = () => Response;

function answering(content: unknown): Answering {
  const response = typeof content === "object" && content !== null && "decision" in content
    ? { results: [{ id: "instruction_1", ...content }] } : content;
  return () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

function refusing(status: number, body = "no"): Answering {
  return () => new Response(body, { status });
}

function judgeWith(...responses: readonly Answering[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const spent: JudgeUsage[] = [];
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
    spent,
    judge: openaiJudge({
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoningEffort: "none",
      key: A_KEY,
      usage: (usage) => { spent.push(usage); },
    }),
  };
}

/** A provider answer that also says what it consumed, as OpenAI's does. */
function answeringWithUsage(
  content: unknown,
  usage: Record<string, unknown>,
  id = "chatcmpl-1",
): Answering {
  const response = typeof content === "object" && content !== null && "decision" in content
    ? { results: [{ id: "instruction_1", ...content }] } : content;
  return () =>
    new Response(
      JSON.stringify({
        id,
        model: "gpt-5.6-terra-2026-08-01",
        choices: [{ message: { content: JSON.stringify(response) } }],
        usage,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("one judge call", () => {
  it("resolves the release default and its provider settings from one catalog entry", () => {
    const configured: ResolvedJudge[] = [];
    const neverAsked: Judge = async () => {
      throw new Error("this test only resolves the judge");
    };

    judgeFor(
      RECOMMENDED_GRADER_MODEL,
      { openai: A_KEY },
      {
        openai(resolved) {
          configured.push(resolved);
          return neverAsked;
        },
      },
    );

    expect(configured).toEqual([
      {
        provider: "openai",
        model: "gpt-5.6-terra",
        reasoningEffort: "none",
        key: A_KEY,
      },
    ]);
  });

  it("shows the judge the one criterion and the declared set, and nothing else", async () => {
    const { calls, judge } = judgeWith(
      answering({ decision: "met", rationale: "read back.", cited_turns: [] }),
    );

    await judge(QUESTION);

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      messages: { role: string; content: string }[];
    };
    const declared = body.messages.at(0)?.content ?? "";
    const asked = body.messages.at(-1)?.content ?? "";

    expect(declared).toContain("met, not_met, or cannot_determine");
    expect(asked).toContain("## Instruction (instruction_1)");
    expect(asked).toContain("the agent confirms the new time");
    expect(asked).toContain("## Transcript");
    expect(asked).toContain("[2] persona: Move my cleaning to Thursday.");
    expect(asked).not.toContain("## Outcome");
    expect(asked).not.toContain("persona_concluded");
    expect(asked).toContain("## Tool calls");
    expect(asked).toContain("(no tool calls were recorded)");
    expect(asked).toContain("## Measures");
    expect(asked).toContain("turn_response_latency: 420, 630");
  });

});

describe("a provider that does not answer", () => {
  it("asks again after a rate limit, and answers when it lands", async () => {
    const { calls, judge } = judgeWith(
      refusing(429, "slow down"),
      answering({ decision: "met", rationale: "read back.", cited_turns: [] }),
    );

    expect((await judge(QUESTION)).results[0]?.decision).toBe("met");
    expect(calls).toHaveLength(2);
  });

  it("gives up after three attempts, saying what the provider said", async () => {
    const { calls, judge } = judgeWith(refusing(503, "upstream unavailable"));

    await expect(judge(QUESTION)).rejects.toThrow(/503/);
    expect(calls).toHaveLength(3);
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

/**
 * What a judge call cost, read off the same answer the decision comes from.
 *
 * The provider is the only witness to what it charged, so every claim here is
 * about reading its own numbers faithfully rather than about counting
 * anything. The one piece of arithmetic — separating the cached half of the
 * prompt — exists because OpenAI's `prompt_tokens` includes tokens it served
 * from its cache at a tenth of the price, and a record that rated the gross
 * figure at the uncached rate would overcharge every repeated prompt.
 */
describe("what one judge call consumed", () => {
  it("records one paid request when one response grades several behaviors", async () => {
    const results = ["behavior_1", "behavior_2"].map((id) => ({
      id, decision: "met", rationale: "the evidence confirms it", cited_turns: [],
    }));
    const { judge, calls, spent } = judgeWith(answeringWithUsage(
      { results }, { prompt_tokens: 100, completion_tokens: 10 },
    ));
    await expect(judge({ ...QUESTION, expectedBehaviors: [
      { id: "behavior_1", text: "confirms the date" },
      { id: "behavior_2", text: "confirms the time" },
    ] })).resolves.toEqual({ results });
    expect(calls).toHaveLength(1);
    expect(spent).toHaveLength(1);
    expect(spent[0]?.quantities).toEqual({ input_tokens: 100, output_tokens: 10 });
  });

  it("is reported once per answered request, with the cached prompt separated", async () => {
    const { judge, spent } = judgeWith(
      answeringWithUsage(
        { decision: "met", rationale: "read back.", cited_turns: [2] },
        {
          prompt_tokens: 1_400,
          completion_tokens: 48,
          total_tokens: 1_448,
          prompt_tokens_details: { cached_tokens: 1_024 },
        },
      ),
    );

    await judge(QUESTION);

    expect(spent).toHaveLength(1);
    expect(spent[0]?.quantities).toEqual({
      // 1,400 prompt tokens of which 1,024 came from the cache.
      input_tokens: 376,
      cached_input_tokens: 1_024,
      output_tokens: 48,
    });
    expect(spent[0]?.httpAttempt).toBe(1);
    expect(spent[0]?.providerRef).toBe("chatcmpl-1");
    // The provider's own object, whole, so a wrong reading can be re-rated
    // later rather than re-measured.
    expect(spent[0]?.rawUsage).toMatchObject({ total_tokens: 1_448 });
  });

  it("counts a second attempt that also answered as a second request", async () => {
    // A rate limit, then an answer. The provider generated nothing the first
    // time, so there is one bill and not two.
    const rateLimited = judgeWith(
      refusing(429, "slow down"),
      answeringWithUsage(
        { decision: "met", rationale: "read back.", cited_turns: [] },
        { prompt_tokens: 100, completion_tokens: 10 },
        "chatcmpl-b",
      ),
    );
    await rateLimited.judge(QUESTION);
    expect(rateLimited.spent).toHaveLength(1);
    expect(rateLimited.spent[0]?.httpAttempt).toBe(2);

    vi.unstubAllGlobals();

    // And an attempt that came back with a body Egma could not read still
    // cost money: the provider generated it. It is measured, then the judge
    // gives up — spending is not conditional on Egma liking the answer.
    const unreadable = judgeWith(
      answeringWithUsage("not an answer object", {
        prompt_tokens: 100,
        completion_tokens: 10,
      }),
    );
    await expect(unreadable.judge(QUESTION)).rejects.toThrow();
    expect(unreadable.spent).toHaveLength(1);
  });

});

describe("paid attempt persistence", () => {
  it("waits for usage durability before validating the answer", async () => {
    let release: () => void = () => undefined;
    let began: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { began = resolve; });
    vi.stubGlobal("fetch", async () => answeringWithUsage({ broken: "answer" }, { prompt_tokens: 10, completion_tokens: 1 })());
    const judge = openaiJudge({ provider: "openai", model: "gpt-5.6-terra", key: A_KEY, usage: async () => { began(); await pending; } });
    let settled = false;
    const asked = judge(QUESTION).finally(() => { settled = true; });
    const rejection = expect(asked).rejects.toThrow();
    await entered;
    expect(settled).toBe(false);
    release();
    await rejection;
  });

  it("keeps the obtained grade when accounting fails and does not purchase another reply", async () => {
    const fetch = vi.fn(async () => answeringWithUsage({ decision: "met", rationale: "yes", cited_turns: [1] }, { prompt_tokens: 10, completion_tokens: 1 })());
    vi.stubGlobal("fetch", fetch);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const judge = openaiJudge({ provider: "openai", model: "gpt-5.6-terra", key: A_KEY, usage: async () => { throw new Error("store unavailable"); } });
    await expect(judge(QUESTION)).resolves.toMatchObject({ results: [{ decision: "met" }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});
