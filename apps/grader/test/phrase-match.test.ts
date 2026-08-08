import type { PhraseMatchConfig } from "@egma/db";
import { describe, expect, it } from "vitest";

import type { Conversation } from "../src/conversation.ts";
import { execute, type Judgment } from "../src/graders/index.ts";
import { noJudgeWanted } from "./support/scripted-judge.ts";

/**
 * The rule shelf for words, judged on its own.
 *
 * No database, no store and no model: a compliance check is a search over the
 * transcript, and the whole reason it is its own type is that a judge would cost
 * a model call to agree with one — and would occasionally disagree with itself
 * about a fixed sentence, on the one check an auditor will actually ask about.
 */

/**
 * One conversation with both speakers saying something worth searching for. The
 * agent reads the disclosure; the persona is the one who says "guarantee".
 */
const A_CONVERSATION = [
  { speaker: "agent", text: "Thanks for calling Lakeside Dental." },
  { speaker: "agent", text: "This call is recorded for quality purposes." },
  { speaker: "persona", text: "Can you guarantee it will be fixed today?" },
  { speaker: "agent", text: "I can book you in for Thursday at four." },
  { speaker: "persona", text: "Yes please." },
];

function conversation(transcript: unknown = A_CONVERSATION): Conversation {
  return {
    source: "simulation",
    traceId: "sim_01JQZ0000000000000000000AA",
    nothingToJudgeBecause: null,
    endingReason: "persona_concluded",
    transcript,
    events: [],
    metrics: {},
    runId: "run_01JQZ0000000000000000000AA",
    agentId: "agt_01JQZ0000000000000000000AA",
  };
}

async function judge(
  config: Partial<PhraseMatchConfig> = {},
  transcript: unknown = A_CONVERSATION,
): Promise<Judgment> {
  const [only] = await execute({
    judgment: {
      type: "phrase_match",
      config: { required: [], banned: [], speaker: "agent", ...config },
    },
    conversation: conversation(transcript),
    judging: noJudgeWanted(),
  });
  if (only === undefined) throw new Error("the grader said nothing");
  return only;
}

describe("a required phrase", () => {
  it("passes when the agent said it, and cites the turn it was in", async () => {
    const judgment = await judge({
      required: [{ text: "This call is recorded", match: "contains" }],
    });

    expect(judgment).toMatchObject({
      dimension: "phrase_match",
      verdict: "passed",
      score: 1,
      citedSpanIds: ["turn:2"],
    });
    expect(judgment.rationale).toBe(
      '"This call is recorded" was said by the agent.',
    );
  });

  it("fails when nobody said it", async () => {
    const judgment = await judge({
      required: [{ text: "your call may be monitored", match: "contains" }],
    });

    expect(judgment).toMatchObject({ verdict: "failed", score: 0 });
    expect(judgment.rationale).toBe(
      '"your call may be monitored" was never said by the agent.',
    );
  });

  /**
   * A disclosure read back in a different case is the disclosure. A compliance
   * check that turned on capitalisation would fail on transcription rather than
   * on conduct.
   */
  it("looks for words without caring about case", async () => {
    expect(
      (await judge({ required: [{ text: "THIS CALL IS RECORDED", match: "contains" }] }))
        .verdict,
    ).toBe("passed");
  });

  it("looks for the words as written, not as a pattern", async () => {
    expect(
      (await judge({ required: [{ text: "recorded (for quality", match: "contains" }] }))
        .verdict,
    ).toBe("failed");
  });
});

describe("a banned phrase", () => {
  it("passes when it was never said", async () => {
    const judgment = await judge({
      banned: [{ text: "free of charge", match: "contains" }],
    });

    expect(judgment).toMatchObject({ verdict: "passed", score: 1 });
    expect(judgment.rationale).toBe(
      '"free of charge" was never said by the agent.',
    );
  });

  it("fails when it was said, naming and citing the turns", async () => {
    const judgment = await judge({
      banned: [{ text: "book you in", match: "contains" }],
    });

    expect(judgment).toMatchObject({ verdict: "failed", score: 0 });
    expect(judgment.rationale).toBe(
      '"book you in" was said by the agent at turn 4.',
    );
    expect(judgment.citedSpanIds).toEqual(["turn:4"]);
  });
});

describe("the speaker the grader is scoped to", () => {
  const guarantee: Partial<PhraseMatchConfig> = {
    banned: [{ text: "guarantee", match: "contains" }],
  };

  /**
   * The default, and the product's line rather than a convenience: the agent is
   * what is under test, and the persona is egma's own synthetic caller — judging
   * what egma made it say would be judging egma.
   */
  it("searches the agent's turns alone by default", async () => {
    expect((await judge({ ...guarantee, speaker: "agent" })).verdict).toBe(
      "passed",
    );
  });

  it("searches the persona's when it is asked to", async () => {
    const judgment = await judge({ ...guarantee, speaker: "persona" });

    expect(judgment.verdict).toBe("failed");
    expect(judgment.rationale).toBe(
      '"guarantee" was said by the persona at turn 3.',
    );
  });

  it("searches both when it is asked to", async () => {
    const judgment = await judge({ ...guarantee, speaker: "either" });

    expect(judgment.verdict).toBe("failed");
    expect(judgment.rationale).toBe('"guarantee" was said at turn 3.');
  });

  /**
   * Everything in a simulation's transcript that is not the agent is egma's own
   * caller, whatever the plug labelled it. A compliance grader that silently
   * searched nothing because a plug writes `human` is the failure this reading
   * exists to avoid.
   */
  it("treats every label that is not the agent's as the caller", async () => {
    const judgment = await judge({ ...guarantee, speaker: "persona" }, [
      { speaker: "human", text: "Can you guarantee that?" },
    ]);

    expect(judgment.verdict).toBe("failed");
  });
});

describe("a phrase looked for as a regular expression", () => {
  it("matches what the pattern says and nothing else", async () => {
    expect(
      (
        await judge({
          required: [{ text: "Thursday at (four|4)", match: "regex" }],
        })
      ).verdict,
    ).toBe("passed");
  });

  it("means exactly what its author wrote, case included", async () => {
    expect(
      (await judge({ required: [{ text: "THURSDAY", match: "regex" }] })).verdict,
    ).toBe("failed");
  });

  /**
   * `errored`, never `failed`. A pattern stored before the write door tightened
   * around it is a check egma cannot make rather than a check the agent failed,
   * and marking an agent down for egma's own broken config is the one thing a
   * test product must never do.
   */
  it("errors rather than failing when the pattern will not compile", async () => {
    const judgment = await judge({
      required: [{ text: "This call is recorded", match: "contains" }],
      banned: [{ text: "(unclosed", match: "regex" }],
    });

    expect(judgment).toMatchObject({ verdict: "errored", score: 0 });
    expect(judgment.rationale).toBe(
      '"(unclosed" is not a regular expression egma can compile, so this check was not made.',
    );
  });

  it("errors rather than crashing the whole conversation's grading", async () => {
    await expect(
      judge({ required: [{ text: "[a-", match: "regex" }] }),
    ).resolves.toMatchObject({ verdict: "errored" });
  });

  /**
   * The pattern compiles and never finishes: catastrophic backtracking against
   * a near-match. Nothing can interrupt a regular expression mid-`test`, so the
   * containment is a worker thread with a deadline — this asserts the deadline
   * answers `errored` for this grader while the process stays free to grade
   * everything else, rather than one authored pattern stalling every heartbeat
   * the service owes.
   */
  it("errors a pattern that backtracks past the deadline, rather than stalling the service", async () => {
    const judgment = await judge(
      { required: [{ text: "(a+)+$", match: "regex" }] },
      [{ speaker: "agent", text: `${"a".repeat(64)}b` }],
    );

    expect(judgment).toMatchObject({ verdict: "errored", score: 0 });
    expect(judgment.rationale).toContain("took longer than");
  }, 15_000);
});

describe("a list holding several phrases", () => {
  const shelf: PhraseMatchConfig = {
    required: [{ text: "This call is recorded", match: "contains" }],
    banned: [
      { text: "book you in", match: "contains" },
      { text: "no charge", match: "contains" },
    ],
    speaker: "agent",
  };

  /**
   * One dimension, whatever number of phrases. A dimension name may derive
   * nothing from the config, so a per-phrase dimension could only be named by the
   * text or by its position — and either would leave an edited-away phrase's row
   * speaking forever, with no later grading able to supersede it.
   */
  it("names one dimension and lands one row", async () => {
    const rows = await execute({
      judgment: { type: "phrase_match", config: shelf },
      conversation: conversation(),
      judging: noJudgeWanted(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.dimension).toBe("phrase_match");
  });

  it("names every broken rule and scores zero, not a fraction", async () => {
    const judgment = await judge({
      ...shelf,
      required: [{ text: "your call may be monitored", match: "contains" }],
    });

    expect(judgment.score).toBe(0);
    expect(judgment.rationale).toBe(
      '"your call may be monitored" was never said by the agent; "book you in" was said by the agent at turn 4.',
    );
  });

  it("keeps the dimension when the list is edited, so a re-grade supersedes", async () => {
    const loose = await judge({
      required: [{ text: "This call is recorded", match: "contains" }],
    });
    const tight = await judge(shelf);

    expect(loose.verdict).toBe("passed");
    expect(tight.verdict).toBe("failed");
    expect(tight.dimension).toBe(loose.dimension);
  });
});

describe("a transcript that is not there", () => {
  /**
   * A required phrase nobody could have said is a phrase that was not said. The
   * conversation happened — the engine refuses to execute anything for one that
   * did not — so this is an agent that said nothing, not a check egma could not
   * make.
   */
  it("fails a required phrase and passes a banned one", async () => {
    for (const nothing of [[], null, "not a transcript"]) {
      expect(
        (await judge({ required: [{ text: "hello", match: "contains" }] }, nothing))
          .verdict,
      ).toBe("failed");
      expect(
        (await judge({ banned: [{ text: "hello", match: "contains" }] }, nothing))
          .verdict,
      ).toBe("passed");
    }
  });
});
