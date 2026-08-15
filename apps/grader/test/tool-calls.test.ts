import type { ToolCallsConfig } from "@egma/db";
import { describe, expect, it } from "vitest";

import type { Conversation } from "../src/conversation.ts";
import { execute, type Judgment } from "../src/graders/index.ts";
import { noJudgeWanted } from "./support/scripted-judge.ts";

/**
 * The rule shelf for tools, judged on its own.
 *
 * No database and no store: a deterministic grader is a function from a
 * conversation and a rule shelf to a verdict, and that is exactly what is under
 * test. What the engine does with the row is the acceptance suite's business.
 *
 * **The evidence is the observed calls and nothing else.** Every case below
 * leaves a transcript in which the agent says it did everything right, so a
 * check reading the words rather than the events would pass every one of them.
 */

/** What the agent said it did, which is never what this grader reads. */
const A_TRANSCRIPT = [
  { speaker: "persona", text: "Can you cancel order 4471 and refund me?" },
  {
    speaker: "agent",
    text: "I have looked up order 4471, cancelled it and issued the refund.",
  },
];

function conversation(events: unknown): Conversation {
  return {
    source: "simulation",
    traceId: "sim_01JQZ0000000000000000000AA",
    nothingToJudgeBecause: null,
    endingReason: "persona_concluded",
    transcript: A_TRANSCRIPT,
    events,
    metrics: {},
    runId: "run_01JQZ0000000000000000000AA",
    modality: "voice",
    agentId: "agt_01JQZ0000000000000000000AA",
  };
}

/** One tool call, as the simulation contract reports one. */
function called(tool: string, args?: unknown): Record<string, unknown> {
  return {
    kind: "tool_call",
    event_id: `evt-${tool}`,
    at: "2026-08-05T09:00:01.214000Z",
    name: tool,
    arguments: args === undefined ? null : JSON.stringify(args),
  };
}

async function judge(
  events: unknown,
  config: Partial<ToolCallsConfig> = {},
): Promise<Judgment> {
  const [only] = await execute({
    judgment: {
      type: "tool_calls",
      config: { required: [], forbidden: [], ...config },
    },
    conversation: conversation(events),
    judging: noJudgeWanted(),
  });
  if (only === undefined) throw new Error("the grader said nothing");
  return only;
}

describe("a required tool", () => {
  it("passes when it fired, and the rationale names what was checked", async () => {
    const judgment = await judge([called("lookup_order")], {
      required: [{ tool: "lookup_order", arguments: null }],
    });

    expect(judgment).toMatchObject({
      dimension: "tool_calls",
      verdict: "passed",
      score: 1,
      citedSpanIds: [],
    });
    expect(judgment.rationale).toBe("lookup_order fired.");
  });

  it("fails when it never fired, whatever the agent said in the transcript", async () => {
    const judgment = await judge([called("send_email")], {
      required: [{ tool: "lookup_order", arguments: null }],
    });

    expect(judgment).toMatchObject({ verdict: "failed", score: 0 });
    expect(judgment.rationale).toBe("lookup_order was never called.");
  });

  it("fails when nothing at all was recorded", async () => {
    for (const nothing of [[], null, undefined, "not a list"]) {
      expect((await judge(nothing, {
        required: [{ tool: "lookup_order", arguments: null }],
      })).verdict).toBe("failed");
    }
  });
});

describe("a forbidden tool", () => {
  it("passes when it never fired", async () => {
    const judgment = await judge([called("lookup_order")], {
      forbidden: [{ tool: "transfer_to_human", arguments: null }],
    });

    expect(judgment).toMatchObject({ verdict: "passed", score: 1 });
    expect(judgment.rationale).toBe("transfer_to_human never fired.");
  });

  it("fails when it fired, and says how often", async () => {
    const judgment = await judge(
      [called("transfer_to_human"), called("transfer_to_human")],
      { forbidden: [{ tool: "transfer_to_human", arguments: null }] },
    );

    expect(judgment).toMatchObject({ verdict: "failed", score: 0 });
    expect(judgment.rationale).toBe("transfer_to_human was called 2 times.");
  });
});

describe("an argument-constrained required tool", () => {
  const refundFor4471 = {
    required: [
      { tool: "issue_refund", arguments: { orderId: "4471" } },
    ],
  };

  it("passes only when a call carrying those arguments exists", async () => {
    expect(
      (await judge([called("issue_refund", { orderId: "4471" })], refundFor4471))
        .verdict,
    ).toBe("passed");
  });

  it("fails when the tool fired with different arguments", async () => {
    const judgment = await judge(
      [called("issue_refund", { orderId: "9999" })],
      refundFor4471,
    );

    expect(judgment.verdict).toBe("failed");
    expect(judgment.rationale).toBe(
      'issue_refund was called, but never with orderId="4471".',
    );
  });

  it("passes when one of several calls carries them", async () => {
    expect(
      (
        await judge(
          [
            called("issue_refund", { orderId: "9999" }),
            called("issue_refund", { orderId: "4471" }),
          ],
          refundFor4471,
        )
      ).verdict,
    ).toBe("passed");
  });

  /**
   * A constraint on the call, never a description of it. Somebody writing "the
   * refund fired for order 4471" did not mean "and the agent sent nothing else",
   * and an exact-match rule would break the first time a platform adds a field.
   */
  it("ignores arguments it did not name", async () => {
    expect(
      (
        await judge(
          [called("issue_refund", { orderId: "4471", reason: "damaged" })],
          refundFor4471,
        )
      ).verdict,
    ).toBe("passed");
  });

  it("reads a nested constraint as a value rather than as text", async () => {
    expect(
      (
        await judge([called("book", { when: { day: "tue", hour: 16 } })], {
          required: [
            { tool: "book", arguments: { when: { hour: 16, day: "tue" } } },
          ],
        })
      ).verdict,
    ).toBe("passed");
  });

  /**
   * A platform that reports the invocation and not its arguments leaves the
   * constraint unshown rather than unmet, and the rationale says which — "call
   * it differently" and "egma could not see how you called it" are two different
   * things to go and do about a red row.
   */
  it("fails and says so when the arguments were never observed", async () => {
    const judgment = await judge([called("issue_refund")], refundFor4471);

    expect(judgment.verdict).toBe("failed");
    expect(judgment.rationale).toBe(
      'issue_refund was called, but the platform reported no arguments, so orderId="4471" could not be shown.',
    );
  });
});

describe("an argument-constrained forbidden tool", () => {
  const neverFullRefund = {
    forbidden: [{ tool: "issue_refund", arguments: { amount: "full" } }],
  };

  it("is violated only by a call carrying those arguments", async () => {
    const judgment = await judge(
      [called("issue_refund", { amount: "full" })],
      neverFullRefund,
    );

    expect(judgment.verdict).toBe("failed");
    expect(judgment.rationale).toBe(
      'issue_refund was called with amount="full".',
    );
  });

  it("passes when the same tool fired with other arguments", async () => {
    expect(
      (
        await judge(
          [called("issue_refund", { amount: "partial" })],
          neverFullRefund,
        )
      ).verdict,
    ).toBe("passed");
  });

  /**
   * A check egma could not make is never a check the agent failed. Arguments
   * that were never observed cannot show the forbidden call happened.
   */
  it("passes when the arguments were never observed", async () => {
    expect((await judge([called("issue_refund")], neverFullRefund)).verdict).toBe(
      "passed",
    );
  });
});

describe("a shelf holding several rules", () => {
  const shelf: ToolCallsConfig = {
    required: [
      { tool: "lookup_order", arguments: null },
      { tool: "issue_refund", arguments: { orderId: "4471" } },
    ],
    forbidden: [{ tool: "transfer_to_human", arguments: null }],
  };

  /**
   * One dimension, whatever number of rules. A dimension name may derive nothing
   * from the config, so a per-rule dimension could only be named by the tool or
   * by its position — and either would leave an edited-away rule's row speaking
   * forever, with no later grading able to supersede it.
   */
  it("names one dimension and lands one row", async () => {
    const rows = await execute({
      judgment: { type: "tool_calls", config: shelf },
      conversation: conversation([called("lookup_order")]),
      judging: noJudgeWanted(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.dimension).toBe("tool_calls");
  });

  it("keeps the dimension when the shelf is edited, so a re-grade supersedes", async () => {
    const loose = await judge([called("lookup_order")], {
      required: [{ tool: "lookup_order", arguments: null }],
    });
    const tight = await judge([called("lookup_order")], shelf);

    expect(loose.verdict).toBe("passed");
    expect(tight.verdict).toBe("failed");
    expect(tight.dimension).toBe(loose.dimension);
  });

  /**
   * Two thirds of a compliance rule is not a pass, so the score is 0 rather
   * than 0.67 — and the granularity a developer needs is in the rationale,
   * which names every rule that was broken and nothing else.
   */
  it("names every broken rule and scores zero, not a fraction", async () => {
    const judgment = await judge(
      [called("transfer_to_human"), called("issue_refund", { orderId: "1" })],
      shelf,
    );

    expect(judgment.score).toBe(0);
    expect(judgment.rationale).toBe(
      'lookup_order was never called; issue_refund was called, but never with orderId="4471"; transfer_to_human was called once.',
    );
  });
});

describe("what it will not read", () => {
  /**
   * The agent's own account of what it did is exactly the failure this grader
   * exists to catch, so a transcript claiming the tool fired must not make it
   * pass — and an event that is not a tool call is not a tool call.
   */
  it("ignores everything in the events that is not an observed tool call", async () => {
    const judgment = await judge(
      [
        { kind: "turn", speaker: "agent", text: "I called lookup_order." },
        { kind: "timing", measure: "turn_response_latency", milliseconds: 900 },
        { kind: "tool_call", arguments: null },
        "lookup_order",
      ],
      { required: [{ tool: "lookup_order", arguments: null }] },
    );

    expect(judgment.verdict).toBe("failed");
  });

  it("reads arguments a plug handed over already decoded", async () => {
    expect(
      (
        await judge(
          [
            {
              kind: "tool_call",
              name: "issue_refund",
              arguments: { orderId: "4471" },
            },
          ],
          { required: [{ tool: "issue_refund", arguments: { orderId: "4471" } }] },
        )
      ).verdict,
    ).toBe("passed");
  });

  it("treats arguments that are not JSON as arguments nobody can constrain", async () => {
    expect(
      (
        await judge(
          [{ kind: "tool_call", name: "issue_refund", arguments: "{oops" }],
          { required: [{ tool: "issue_refund", arguments: { orderId: "4471" } }] },
        )
      ).rationale,
    ).toContain("reported no arguments");
  });
});
