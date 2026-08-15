import {
  getGrader,
  getJudgeConfiguration,
  readVerdicts,
  type AuthContext,
  type RecordedVerdict,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aConversation,
  aJudgedCopy,
  capturedLog,
  conductSimulation,
  eventually,
  jobFor,
  makeWorld,
  oneServiceAtATime,
  seedGrader,
  seedJudge,
  seedTest,
  testConfig,
  theSeededGrader,
  THE_JUDGE_KEY,
  type World,
} from "./support/world.ts";
import { met, scriptedJudge } from "./support/scripted-judge.ts";
import { projectJudge, NoJudge } from "../src/judge/index.ts";

/**
 * Which judge answers, where its key comes from, and where the key never goes.
 *
 * **The order of this file matters and is deliberate.** The first case is a
 * project that has configured no judge at all, and it has to run before
 * anything sets one — a project's judge is one row, and there is no way to
 * un-set it once it is there. Everything after seeds the judge first.
 *
 * A grading `AuthContext` is built by the queue and never by a caller, so where
 * a case needs one it is written out here exactly as `claimGradingJobs` builds
 * it: no person, the job's own tenancy, and `engine` on its face.
 */

let world: World;
const service = oneServiceAtATime();

const BEHAVIOR = "confirms the new time back before finishing";

/**
 * The behaviors' rows, found by the grader they name — the project's own copy
 * of the `expected_behaviors` library entry, which is what a verdict row
 * carries now that the built-in is a row like everything else.
 */
async function behaviorRows(
  verdicts: readonly RecordedVerdict[],
): Promise<readonly RecordedVerdict[]> {
  const seeded = await theSeededGrader(world);
  return verdicts.filter((verdict) => verdict.graderId === seeded);
}

/** What a grading claim resolves to, as the queue builds it. */
function theEngine(): AuthContext {
  return {
    userId: "engine",
    organizationId: world.organizationId,
    projectId: world.projectId,
    role: "viewer",
    via: "engine",
  };
}

beforeAll(async () => {
  world = await makeWorld("grader_judge_configuration");
});

afterAll(async () => {
  await service.stop();
  await world.drop();
});

describe("a project that configured no judge", () => {
  it("says so on every behavior, and never quietly passes one", async () => {
    const judge = await service.judgingWith({});

    const testId = await seedTest(world, [], [BEHAVIOR, "never quotes a price"]);
    const { simulationId } = await conductSimulation(world, {
      testId,
      spans: aConversation(),
    });

    const rows = await eventually("the behaviors to be errored", async () => {
      const read = await readVerdicts(world.auth, simulationId);
      return read.verdicts.length >= 2 ? behaviorRows(read.verdicts) : undefined;
    });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // `errored`, deliberately not `skipped`: the check applies perfectly well
      // and egma did not make it. A page going green because a judge was never
      // configured is the exact false trust this product exists to kill.
      expect(row.verdict).toBe("errored");
      expect(row.rationale).toContain("configured no judge");
      expect(row.judgedBy).toBe("engine");
    }
    expect(judge.asked).toEqual([]);

    await service.stop();
  });

  it("is what the resolver says, before anything else asks", async () => {
    expect(await getJudgeConfiguration(world.auth)).toBeUndefined();
    expect(await projectJudge(theEngine())).toBeInstanceOf(NoJudge);
  });
});

describe("the project's default judge", () => {
  beforeAll(async () => {
    await seedJudge(world, { model: "gpt-4.1-mini" });
  });

  it("resolves out of the credential store and reaches the provider seam", async () => {
    const resolved = await projectJudge(theEngine());
    expect(resolved).not.toBeInstanceOf(NoJudge);
    if (resolved instanceof NoJudge) throw resolved;

    // The key is not a field anything outside `src/judge/` can read, so it is
    // observed where it is actually spent: at the provider seam, which is what
    // the scripted maker stands in for.
    const judge = scriptedJudge({ answers: {} });
    const asked = resolved.judging(null, judge.makers);

    expect(asked.name).toBe("openai/gpt-4.1-mini");
    expect(judge.configured.at(-1)).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini",
      // Asserted present on purpose: "the key is nowhere else" means nothing if
      // the key was never resolved in the first place.
      key: THE_JUDGE_KEY,
    });
  });

  /**
   * The per-grader override, resolved at its own seam.
   *
   * This is the resolution alone, against a real grader version read back out
   * of Postgres with the project's real key behind it. What the override looks
   * like once it has reached a verdict row is the case below, through the whole
   * service.
   */
  it("is overridden by a grader that names its own provider and model", async () => {
    const graderId = await seedGrader(
      world,
      aJudgedCopy({
        name: "A second opinion, on a stronger model",
        judgeModel: { provider: "openai", model: "gpt-4.1" },
      }),
    );

    const grader = await getGrader(world.auth, graderId);
    const resolved = await projectJudge(theEngine());
    if (resolved instanceof NoJudge) throw resolved;

    const judge = scriptedJudge({ answers: {} });
    const overridden = resolved.judging(grader?.judgeModel ?? null, judge.makers);

    // The name a verdict row would carry is the grader's model, not the
    // project's — which is how "decided by this model" stays readable after the
    // project's default moves on.
    expect(overridden.name).toBe("openai/gpt-4.1");
    expect(judge.configured.at(-1)).toEqual({
      provider: "openai",
      // The grader's, not the project's.
      model: "gpt-4.1",
      // And the project's key, always: an override names a provider and a model
      // and never a key, so no grader can move a project's judging onto an
      // account nobody configured.
      key: THE_JUDGE_KEY,
    });

    // A grader with no override of its own judges on the project's judge.
    expect(resolved.judging(null, judge.makers).name).toBe(
      "openai/gpt-4.1-mini",
    );
  });

  it("names itself on every row it judged, and never the account behind it", async () => {
    const judge = scriptedJudge({
      answers: { [BEHAVIOR]: met("the new time was read back at turn 5.", [5]) },
    });
    const captured = capturedLog();
    await service.start(testConfig({ logLevel: "DEBUG" }), {
      makers: judge.makers,
      log: captured.log,
    });

    const testId = await seedTest(world, [], [BEHAVIOR]);
    const { simulationId } = await conductSimulation(world, {
      testId,
      spans: aConversation(),
    });

    const verdicts = await eventually("a behavior verdict", async () => {
      const read = await readVerdicts(world.auth, simulationId);
      const rows = await behaviorRows(read.verdicts);
      return rows.length > 0 ? rows : undefined;
    });
    await jobFor(world, { simulationId }, "graded");

    expect(verdicts[0]).toMatchObject({
      graderId: await theSeededGrader(world),
      dimension: "behavior_1",
      judgedBy: "openai/gpt-4.1-mini",
      verdict: "passed",
    });

    /**
     * The acceptance box: **the key never appears in any verdict, log, or
     * report.** It reached the provider seam — asserted just below, so this is
     * not a claim about a key that was never resolved — and it is in none of
     * the three places anything downstream reads.
     */
    expect(judge.configured.at(-1)?.key).toBe(THE_JUDGE_KEY);

    const everything = await readVerdicts(world.auth, simulationId);
    // Every field of every row, flattened — the microsecond stamps are BigInts,
    // which is what the replacer is for.
    const written = JSON.stringify(everything, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(written).not.toContain(THE_JUDGE_KEY);
    // And not a fragment of it either — a rationale that quoted half a key
    // would be a leak nobody grepped for.
    expect(written).not.toContain("NEVERLEAKME");

    expect(captured.lines.length).toBeGreaterThan(0);
    for (const line of captured.lines) {
      expect(line).not.toContain("NEVERLEAKME");
    }

    // The read a page makes, which is the report anybody outside the engine
    // ever sees: a reference and a hint, and nothing to reconstruct a key from.
    const configuration = await getJudgeConfiguration(world.auth);
    expect(JSON.stringify(configuration)).not.toContain("NEVERLEAKME");
    expect(configuration?.keyHint).toBe(THE_JUDGE_KEY.slice(-4));
  });
});
