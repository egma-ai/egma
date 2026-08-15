import { readVerdicts, type RecordedVerdict } from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aConversation,
  aLatencyCopy,
  conductSimulation,
  jobFor,
  makeWorld,
  oneServiceAtATime,
  seedGrader,
  seedJudge,
  seedTest,
  theSeededGrader,
  verdictsOn,
  type World,
} from "./support/world.ts";
import {
  cannotDetermine,
  met,
  notMet,
  type Scripted,
  type ScriptedJudge,
} from "./support/scripted-judge.ts";

/**
 * The expected-behaviors grader: a test's expected behaviors, judged one at a
 * time.
 *
 * **It is an ordinary running copy now.** It used to be implicit — never a row,
 * never resolved, and writing the word `expected_behaviors` where a verdict row
 * wants a grader id. Every project is created with an active copy of the
 * library entry instead, so it is resolved like anything else and its rows name
 * a real grader and the version that decided them.
 *
 * **The contract is the seam.** A finished conversation and a test's behaviors
 * go in; the assertions are on the verdict rows and on the folded answer over
 * them. Nothing here asserts how many times anything was called or in what
 * order — the one thing this file does look at behind the seam is *what each
 * judge was shown*, because per-behavior isolation is a claim about the input
 * and there is no way to see it from the rows.
 *
 * **No key and no network.** The scripted judge stands in at the provider seam;
 * everything on this side of it — the project's judge configuration, the sealed
 * key, the resolution through the one door — is the real path.
 */

let world: World;
const service = oneServiceAtATime();

const FIRST = "confirms the new time back before finishing";
const SECOND = "never quotes a price";
const THIRD = "offers to send a reminder";

/** The three behaviors, in the authored order — plain sentences, all three. */
const THREE = [FIRST, SECOND, THIRD];

/**
 * The behaviors' rows, in key order, whatever else judged the same run.
 *
 * Found by the grader they name, which is the project's own copy of the library
 * entry — the id a verdict row carries now that the built-in is a row like
 * everything else.
 */
async function behaviorRows(
  verdicts: readonly RecordedVerdict[],
): Promise<readonly RecordedVerdict[]> {
  const seeded = await theSeededGrader(world);
  return [...verdicts]
    .filter((verdict) => verdict.graderId === seeded)
    .sort((left, right) => left.assertion.localeCompare(right.assertion));
}

/**
 * One conversation, judged by a judge that answers as scripted.
 *
 * A service per case rather than one for the file, because each case's judge is
 * its own — and the previous one is stopped first, so exactly one copy is ever
 * claiming and a case's answers can never land on another case's conversation.
 */
async function judgedWith(
  answers: Readonly<Record<string, Scripted>>,
  landing: Parameters<typeof conductSimulation>[1] = {},
): Promise<{
  readonly simulationId: string;
  readonly judge: ScriptedJudge;
  readonly verdicts: readonly RecordedVerdict[];
}> {
  const judge = await service.judgingWith(answers);

  const testId = await seedTest(world, [], THREE);
  const { simulationId } = await conductSimulation(world, {
    testId,
    spans: aConversation(),
    ...landing,
  });

  const verdicts = await verdictsOn(world, simulationId, THREE.length);
  // Waited out before the case returns, so the job is finished rather than
  // merely written: a job still claimable when the next case starts its own
  // copy would be judged a second time, by a judge scripted for another test.
  await jobFor(world, { simulationId }, "graded");

  return { simulationId, judge, verdicts };
}

beforeAll(async () => {
  world = await makeWorld("grader_expected_behaviors");
  await seedJudge(world);
});

afterAll(async () => {
  await service.stop();
  await world.drop();
});

describe("a test with three expected behaviors", () => {
  it("produces one verdict row per behavior, from three isolated judge inputs", async () => {
    const { judge, verdicts } = await judgedWith({
      [FIRST]: met("the agent read the new time back at turn 5.", [5]),
      [SECOND]: met("no price was mentioned."),
      [THIRD]: notMet("no reminder was offered."),
    });

    const rows = await behaviorRows(verdicts);
    expect(rows.map((row) => row.assertion)).toEqual([
      "behavior_1",
      "behavior_2",
      "behavior_3",
    ]);
    expect(rows.map((row) => row.verdict)).toEqual([
      "passed",
      "passed",
      "failed",
    ]);

    // Three calls, three criteria, each the behavior at its own position.
    expect(judge.asked.map((question) => question.criterion)).toEqual([
      FIRST,
      SECOND,
      THIRD,
    ]);

    /**
     * The acceptance box, stated as an assertion: **no behavior's text appears
     * in another behavior's judge input.** It holds structurally — the evidence
     * type has nowhere for a second criterion to be — and it is asserted here
     * because that is the property a future refactor could quietly lose.
     */
    for (const question of judge.asked) {
      const shown = JSON.stringify(question);
      for (const other of [FIRST, SECOND, THIRD]) {
        if (other === question.criterion) continue;
        expect(shown, `${question.criterion} was shown ${other}`).not.toContain(
          other,
        );
      }
    }
  });

  it("shows each judge the declared set — the transcript, the outcome, the tools, the measures", async () => {
    const { judge } = await judgedWith({ [FIRST]: met("read back at turn 5.", [5]) });

    const [shown] = judge.asked;
    expect(shown?.evidence.transcript).toHaveLength(5);
    expect(shown?.evidence.transcript[0]).toMatchObject({
      at: 1,
      speaker: "agent",
    });
    expect(shown?.evidence.outcome).toMatchObject({
      happened: true,
      endingReason: "persona_concluded",
      turns: 5,
    });
    // Named and present even when empty, because "no tool calls were recorded"
    // is evidence and a missing section is not.
    expect(shown?.evidence.toolCalls).toEqual([]);
    expect(shown?.evidence.measures).toEqual([
      { measure: "turn_response_latency", samples: [900, 1_100] },
    ]);
  });

  it("lands the turns each judge cited, and the reason it gave", async () => {
    const { verdicts } = await judgedWith({
      [FIRST]: met("the agent read the new time back at turn 5.", [5]),
      [SECOND]: met("no price was mentioned."),
      [THIRD]: notMet("no reminder was offered.", [3, 5]),
    });

    const rows = await behaviorRows(verdicts);
    // **Nothing on a row says how loudly it speaks**, and there is nothing left
    // to put there: scoring is binary, so every behavior of a required grader
    // has to hold. Whether this grader can fail a test at all is `required` on
    // the copy, and it is asked of the copy rather than of a row.
    expect(rows[0]?.citedSpanIds).toEqual(["turn:5"]);
    expect(rows[2]?.citedSpanIds).toEqual(["turn:3", "turn:5"]);
    expect(rows[0]?.rationale).toBe(
      "the agent read the new time back at turn 5.",
    );
  });

  it("drops a citation pointing at a turn the conversation does not have", async () => {
    const { verdicts } = await judgedWith({
      [FIRST]: met("cited past the end.", [5, 99]),
    });

    expect((await behaviorRows(verdicts))[0]?.citedSpanIds).toEqual(["turn:5"]);
  });
});

describe("a behavior the judge cannot determine", () => {
  it("is skipped, and leaves the score's denominator", async () => {
    const { simulationId, verdicts } = await judgedWith({
      [FIRST]: met("read back at turn 5."),
      [SECOND]: cannotDetermine("the conversation never reached prices."),
      [THIRD]: notMet("no reminder was offered."),
    });

    expect((await behaviorRows(verdicts)).map((row) => row.verdict)).toEqual([
      "passed",
      "skipped",
      "failed",
    ]);

    const read = await readVerdicts(world.auth, simulationId);
    expect(read.outcome.counts).toMatchObject({
      passed: 1,
      failed: 1,
      skipped: 1,
      total: 3,
    });
    // One passed out of the two that were actually judged, not out of three.
    expect(read.outcome.score).toBe(0.5);
    expect(read.outcome.verdict).toBe("failed");
  });
});

describe("a judge call that fails after its retries", () => {
  /**
   * The reason the fan-out is N independent calls rather than one. A judge that
   * fell over on the second behavior must not cost the first and third their
   * answers, and the row it leaves behind must say egma could not make the
   * check rather than that the agent failed it.
   */
  it("errors that behavior alone and leaves its siblings' verdicts intact", async () => {
    const { verdicts } = await judgedWith({
      [FIRST]: met("read back at turn 5.", [5]),
      [SECOND]: new Error("the judge model answered 503: upstream unavailable"),
      [THIRD]: notMet("no reminder was offered."),
    });

    const rows = await behaviorRows(verdicts);
    expect(rows.map((row) => row.verdict)).toEqual([
      "passed",
      "errored",
      "failed",
    ]);
    expect(rows[1]?.rationale).toContain("could not be judged");
    expect(rows[1]?.rationale).toContain("503");
    expect(rows[1]?.score).toBe(0);
  });
});

describe("a simulation that never ran", () => {
  /**
   * The many-assertion case, and the one that matters most: a page must show
   * the same three behaviors whether the conversation happened or not — a test that could not run should look like a test that could not
   * run, not like a test with nothing in it.
   */
  it("is errored once per behavior, with no judge asked at all", async () => {
    const { judge, verdicts } = await judgedWith(
      { [FIRST]: met("never reached.") },
      { failedBecause: "agent_never_joined" },
    );

    const rows = await behaviorRows(verdicts);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.verdict).toBe("errored");
      expect(row.rationale).toContain("no conversation to judge");
    }
    expect(judge.asked).toEqual([]);
  });
});

describe("a simulation born from no test", () => {
  /**
   * An ordinary case rather than a gap: somebody proving a connection with a
   * smoke call wrote down no expectations, so there is nothing to judge them
   * against — and the project's other graders still judge the conversation. A
   * latency copy is here so there is a row to wait for, which is what makes
   * "no behavior rows" an observation rather than a timeout.
   */
  it("has no behavior rows at all, which is not the same as failing any", async () => {
    const judge = await service.judgingWith({});
    await seedGrader(
      world,
      aLatencyCopy({ name: "Latency, on an untested call" }),
    );

    const { simulationId } = await conductSimulation(world, {
      spans: aConversation(),
    });
    const verdicts = await verdictsOn(world, simulationId, 1);

    expect(await behaviorRows(verdicts)).toEqual([]);
    expect(verdicts.map((verdict) => verdict.assertion)).toEqual(["latency"]);
    expect(judge.asked).toEqual([]);
  });
});
