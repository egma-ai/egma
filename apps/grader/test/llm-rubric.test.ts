import { readVerdicts, type RecordedVerdict } from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Conversation } from "../src/conversation.ts";
import { execute, type Judgment } from "../src/graders/index.ts";
import { NoJudge, type JudgeResolution } from "../src/judge/index.ts";
import {
  cannotDetermine,
  met,
  notMet,
  scriptedJudging,
} from "./support/scripted-judge.ts";
import {
  aConversation,
  aRubric,
  aThreshold,
  conductSimulation,
  eventually,
  jobFor,
  makeWorld,
  oneServiceAtATime,
  seedGrader,
  seedJudge,
  A_RUBRIC,
  THE_JUDGE_KEY,
  type World,
} from "./support/world.ts";

/**
 * A team's own criteria, decided by a judge.
 *
 * **The same judge seam the built-in grader uses**, and this file is where the
 * one thing that seam has that the built-in cannot use is finally visible in a
 * verdict row: the per-grader override. A grader version may name its own
 * provider and model — a stronger judge on the subtle rubric, a cheap one on the
 * routine checks — and it never names a key, so the account stays the project's.
 *
 * **No key and no network.** The scripted judge stands in at the provider seam;
 * everything on this side of it — the project's judge configuration, the sealed
 * key, the resolution through the one door, the override layered over the top —
 * is the real path.
 */

let world: World;
const service = oneServiceAtATime();

/** The rows one grader wrote, once the conversation has been judged. */
async function rowsFrom(
  simulationId: string,
  graderId: string,
  atLeast = 1,
): Promise<readonly RecordedVerdict[]> {
  const found = await eventually(
    `${atLeast} verdicts from ${graderId} on ${simulationId}`,
    async () => {
      const read = await readVerdicts(world.auth, simulationId);
      const rows = read.verdicts.filter((row) => row.graderId === graderId);
      return rows.length >= atLeast ? rows : undefined;
    },
  );
  // Waited out before the case returns, so the job is finished rather than
  // merely written: a job still claimable when the next case starts its own
  // copy would be judged again, by a judge scripted for another case.
  await jobFor(world, { simulationId }, "graded");
  return found;
}

beforeAll(async () => {
  world = await makeWorld("grader_llm_rubric");
  await seedJudge(world, { model: "gpt-4.1-mini" });
});

afterAll(async () => {
  await service.stop();
  await world.drop();
});

describe("a rubric judged on the project's own judge", () => {
  it("is one call, one dimension and one row naming the judge that answered", async () => {
    const graderId = await seedGrader(world, aRubric());
    const judge = await service.judgingWith({
      [A_RUBRIC]: met("the agent said sorry at turn 3.", [3]),
    });

    const { simulationId } = await conductSimulation(world, {
      transcript: aConversation(),
    });
    const rows = await rowsFrom(simulationId, graderId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dimension: "llm_rubric",
      verdict: "passed",
      score: 1,
      rationale: "the agent said sorry at turn 3.",
      citedSpanIds: ["turn:3"],
      // The judge, not `engine`: a model decided this, and which model is part
      // of the row's identity.
      judgedBy: "openai/gpt-4.1-mini",
      priority: "P0",
    });

    // One rubric is one criterion, so it is one question — never the text split
    // on whatever punctuation looked like a list.
    expect(judge.asked.map((question) => question.criterion)).toEqual([A_RUBRIC]);
    // The declared set, shared with every other judged check on this
    // conversation rather than assembled again for this one.
    expect(judge.asked[0]?.evidence.transcript).toHaveLength(5);
    // And the project's key reached the provider seam, which is the only place
    // it is ever spent.
    expect(judge.configured.at(-1)?.key).toBe(THE_JUDGE_KEY);
  });

  it("is skipped when the judge could not tell, and leaves the denominator", async () => {
    const graderId = await seedGrader(
      world,
      aRubric({ name: "Undecidable", config: { rubric: "Was it warm enough?" } }),
    );
    await service.judgingWith({
      "Was it warm enough?": cannotDetermine("the caller never said."),
      [A_RUBRIC]: met("sorry at turn 3.", [3]),
    });

    const { simulationId } = await conductSimulation(world, {
      transcript: aConversation(),
    });
    const [only] = await rowsFrom(simulationId, graderId);

    expect(only).toMatchObject({ verdict: "skipped", score: 0 });

    const read = await readVerdicts(world.auth, simulationId);
    expect(read.outcome.counts.skipped).toBeGreaterThan(0);
    // Out of the denominator: the score is over what was actually judged.
    expect(read.outcome.counts.total - read.outcome.counts.skipped).toBe(
      read.outcome.counts.passed +
        read.outcome.counts.failed +
        read.outcome.counts.errored,
    );
  });

  /**
   * One grader falling over is one `errored` row, not a conversation with no
   * verdicts on it — and the row says egma could not make the check rather than
   * that the agent failed it.
   */
  it("errors that grader alone when the judge call fails after its retries", async () => {
    const graderId = await seedGrader(
      world,
      aRubric({
        name: "Refused by the provider",
        config: { rubric: "Did the agent stay on policy?" },
      }),
    );
    const alsoJudging = await seedGrader(
      world,
      aThreshold({ name: "Latency beside a broken judge" }),
    );
    await service.judgingWith({
      "Did the agent stay on policy?": new Error(
        "the judge model answered 503: upstream unavailable",
      ),
      [A_RUBRIC]: met("sorry at turn 3."),
      "Was it warm enough?": cannotDetermine("the caller never said."),
    });

    const { simulationId } = await conductSimulation(world, {
      transcript: aConversation(),
    });
    const [broken] = await rowsFrom(simulationId, graderId);

    expect(broken).toMatchObject({ verdict: "errored", score: 0 });
    expect(broken?.rationale).toContain("this check could not be made");
    expect(broken?.rationale).toContain("503");
    // Never the model that could not answer: nothing decided this row, so
    // nothing is named on it.
    expect(broken?.judgedBy).toBe("engine");

    const [beside] = await rowsFrom(simulationId, alsoJudging);
    expect(beside?.verdict).toBe("passed");
  });
});

describe("a rubric on a grader that names its own judge", () => {
  /**
   * The acceptance box. The override lives on the immutable grader version
   * beside the rubric, so a verdict decided by it stays readable as "decided by
   * this model" long after the project's default moves on — and it names a
   * provider and a model and never a key, so the account is still the project's.
   */
  it("judges on that model, on the project's key, and says so on the row", async () => {
    const overridden = await seedGrader(
      world,
      aRubric({
        name: "The subtle one",
        config: { rubric: "Did the agent handle the objection gracefully?" },
        judgeModel: { provider: "openai", model: "gpt-4.1" },
      }),
    );
    const judge = await service.judgingWith({
      "Did the agent handle the objection gracefully?": notMet(
        "the objection was talked over.",
      ),
      [A_RUBRIC]: met("sorry at turn 3."),
      "Was it warm enough?": cannotDetermine("the caller never said."),
      "Did the agent stay on policy?": met("nothing off policy was said."),
    });

    const { simulationId } = await conductSimulation(world, {
      transcript: aConversation(),
    });
    const [only] = await rowsFrom(simulationId, overridden);

    expect(only).toMatchObject({
      dimension: "llm_rubric",
      verdict: "failed",
      score: 0,
      judgedBy: "openai/gpt-4.1",
    });

    // The grader's model reached the provider seam with the project's key
    // behind it, which is the whole shape of the override.
    const asOverridden = judge.configured.filter(
      (configured) => configured.model === "gpt-4.1",
    );
    expect(asOverridden.length).toBeGreaterThan(0);
    for (const configured of asOverridden) {
      expect(configured.key).toBe(THE_JUDGE_KEY);
    }

    // And the graders with no override of their own still judged on the
    // project's default, in the same grading, on one account.
    const read = await readVerdicts(world.auth, simulationId);
    const byDefault = read.verdicts.filter(
      (row) => row.dimension === "llm_rubric" && row.graderId !== overridden,
    );
    expect(byDefault.length).toBeGreaterThan(0);
    for (const row of byDefault) {
      expect(row.judgedBy).toBe("openai/gpt-4.1-mini");
    }
  });
});

/**
 * The two answers the executor gives without a store behind it. The whole path
 * from a project's configuration to a resolved key is asserted above, through
 * the real service; what is asserted here is only what the executor does with a
 * resolution it was handed.
 */
describe("a rubric with no judge to ask", () => {
  function conversation(): Conversation {
    return {
      source: "simulation",
      traceId: "sim_01JQZ0000000000000000000AA",
      happened: true,
      endingReason: "persona_concluded",
      transcript: [{ speaker: "agent", text: "Booked for Thursday at four." }],
      events: [],
      metrics: {},
      runId: "run_01JQZ0000000000000000000AA",
      agentId: "agt_01JQZ0000000000000000000AA",
    };
  }

  it("errors saying why, and never quietly passes", async () => {
    const noJudge: JudgeResolution = async () =>
      new NoJudge(
        "this project has configured no judge, so there was nothing to ask.",
      );

    const [only] = await execute({
      judgment: { type: "llm_rubric", config: { rubric: A_RUBRIC } },
      conversation: conversation(),
      judging: { judge: noJudge, makers: scriptedJudging({ answers: {} }).judging.makers, model: null },
    });

    expect(only).toMatchObject({
      dimension: "llm_rubric",
      verdict: "errored",
      score: 0,
      citedSpanIds: [],
    });
    expect(only?.rationale).toBe(
      "this project has configured no judge, so there was nothing to ask.",
    );
    // Absent, so the engine writes `engine`: no model decided this.
    expect(only?.judgedBy).toBeUndefined();
  });

  it("drops a citation pointing at a turn the conversation does not have", async () => {
    const { judging } = scriptedJudging({
      answers: { [A_RUBRIC]: met("cited past the end.", [1, 99]) },
    });

    const [only] = (await execute({
      judgment: { type: "llm_rubric", config: { rubric: A_RUBRIC } },
      conversation: conversation(),
      judging,
    })) as readonly Judgment[];

    expect(only?.citedSpanIds).toEqual(["turn:1"]);
  });

  /**
   * A dimension name may derive nothing from the config: the fold counts one
   * dimension once per grader and prefers the latest grading of it, so a rubric
   * reworded and re-graded must land on the row it supersedes rather than beside
   * it forever with both of them speaking.
   */
  it("names the same dimension whatever the rubric says", async () => {
    const first = await execute({
      judgment: { type: "llm_rubric", config: { rubric: A_RUBRIC } },
      conversation: conversation(),
      judging: scriptedJudging({ answers: { [A_RUBRIC]: met("yes.") } }).judging,
    });
    const reworded = "The agent named the caller's frustration back to them.";
    const second = await execute({
      judgment: { type: "llm_rubric", config: { rubric: reworded } },
      conversation: conversation(),
      judging: scriptedJudging({ answers: { [reworded]: notMet("no.") } }).judging,
    });

    expect(first[0]?.verdict).toBe("passed");
    expect(second[0]?.verdict).toBe("failed");
    expect(second[0]?.dimension).toBe(first[0]?.dimension);
  });
});
