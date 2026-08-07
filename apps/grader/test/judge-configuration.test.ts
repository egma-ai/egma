import {
  getGrader,
  getJudgeConfiguration,
  listGradingJobsForSimulation,
  readVerdicts,
  type AuthContext,
  type RecordedVerdict,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aConversation,
  capturedLog,
  conductSimulation,
  eventually,
  makeWorld,
  runService,
  seedGrader,
  seedJudge,
  seedTest,
  testConfig,
  THE_JUDGE_KEY,
  type World,
} from "./support/world.ts";
import { met, scriptedJudge } from "./support/scripted-judge.ts";
import { projectJudge, NoJudge } from "../src/judge/index.ts";
import type { Service } from "../src/service.ts";

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
let service: Service | undefined;

const BEHAVIOR = "confirms the new time back before finishing";

async function stopService(): Promise<void> {
  if (service === undefined) return;
  service.stop();
  await service.finished;
  service = undefined;
}

function behaviorRows(
  verdicts: readonly RecordedVerdict[],
): readonly RecordedVerdict[] {
  return verdicts.filter((verdict) => verdict.graderId === "expected_behaviors");
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
  await stopService();
  await world.drop();
});

describe("a project that configured no judge", () => {
  it("says so on every behavior, and never quietly passes one", async () => {
    const judge = scriptedJudge({ answers: {} });
    service = runService(testConfig(), { makers: judge.makers });

    const testId = await seedTest(world, [], [BEHAVIOR, "never quotes a price"]);
    const { simulationId } = await conductSimulation(world, {
      testId,
      transcript: aConversation(),
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

    await stopService();
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
   * It cannot be seen in a verdict row yet, and the reason is worth stating: the
   * only grader type that carries a judge model is `llm_rubric`, and egma does
   * not execute that type until the ticket that adds its executor. The resolution
   * is what this ticket owns, so the resolution is what this asserts — against a
   * real grader version read back out of Postgres, with the project's real key
   * behind it.
   */
  it("is overridden by a grader that names its own provider and model", async () => {
    const graderId = await seedGrader(world, {
      name: "Was the agent empathetic",
      type: "llm_rubric",
      config: { rubric: "The agent acknowledged the caller's frustration." },
      judgeModel: { provider: "openai", model: "gpt-4.1" },
    });

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
    await stopService();

    const judge = scriptedJudge({
      answers: { [BEHAVIOR]: met("the new time was read back at turn 5.", [5]) },
    });
    const captured = capturedLog();
    service = runService(testConfig({ logLevel: "DEBUG" }), {
      makers: judge.makers,
      log: captured.log,
    });

    const testId = await seedTest(world, [], [BEHAVIOR]);
    const { simulationId } = await conductSimulation(world, {
      testId,
      transcript: aConversation(),
    });

    const verdicts = await eventually("a behavior verdict", async () => {
      const read = await readVerdicts(world.auth, simulationId);
      const rows = behaviorRows(read.verdicts);
      return rows.length > 0 ? rows : undefined;
    });
    await eventually("the job to be graded", async () => {
      const [only] = await listGradingJobsForSimulation(world.auth, simulationId);
      return only?.status === "graded" ? only : undefined;
    });

    expect(verdicts[0]).toMatchObject({
      graderId: "expected_behaviors",
      dimension: "behavior_1",
      judgedBy: "openai/gpt-4.1-mini",
      verdict: "passed",
      priority: "P0",
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
