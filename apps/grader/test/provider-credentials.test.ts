import {
  PROVIDERS_BY_JOB,
  deleteGrader,
  listGradingJobsForSimulation,
  readVerdicts,
  validGraderModel,
} from "@egma/db";
import {
  ProviderCredentialSourceUnavailableError,
  type ProviderCredentialSource,
} from "@egma/provider-credentials";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JUDGE_MAKERS } from "../src/judge/index.ts";

import {
  aLatencyCopy,
  aJudgedCopy,
  conductSimulation,
  eventually,
  makeWorld,
  oneServiceAtATime,
  seedGrader,
  seedTest,
  THE_PROVIDER_KEY,
  theSeededGrader,
  type World,
} from "./support/world.ts";
import { met, scriptedJudge } from "./support/scripted-judge.ts";

const BEHAVIOR = "confirms the new time back before finishing";

let world: World;
const service = oneServiceAtATime();

describe("the grader model catalog", () => {
  it("has one authoring rule and one runtime adapter for every LLM pair", () => {
    const providers = [
      ...new Set(PROVIDERS_BY_JOB.llm.map((entry) => entry.provider)),
    ].sort();
    expect(Object.keys(JUDGE_MAKERS).sort()).toEqual(providers);

    for (const entry of PROVIDERS_BY_JOB.llm) {
      expect(
        validGraderModel({ provider: entry.provider, model: entry.model }),
      ).toEqual({ provider: entry.provider, model: entry.model });
    }
  });
});

beforeEach(async () => {
  world = await makeWorld("grader_provider_credentials");
});

afterEach(async () => {
  await service.stop();
  await world.drop();
});

describe("provider credentials for one claimed grading job", () => {
  it("does not read a model credential bundle for code-only work", async () => {
    await deleteGrader(world.auth, await theSeededGrader(world));
    await seedGrader(world, aLatencyCopy());
    let loads = 0;
    await service.start(undefined, {
      providerCredentials: {
        async load() {
          loads += 1;
          throw new ProviderCredentialSourceUnavailableError();
        },
      },
    });

    const { simulationId } = await conductSimulation(world, {
      spans: { measured: { turn_response_latency: [900, 1_100] } },
    });
    await eventually("the code-only grading job to finish", async () => {
      const [job] = await listGradingJobsForSimulation(world.auth, simulationId);
      return job?.status === "graded" ? job : undefined;
    });

    expect(loads).toBe(0);
    expect((await readVerdicts(world.auth, simulationId)).verdicts).toHaveLength(1);
  });

  it("loads once and spends only the selected provider key", async () => {
    await seedGrader(world, aJudgedCopy());
    const judge = scriptedJudge({ answers: { [BEHAVIOR]: met("done") } });
    let loads = 0;
    const providerCredentials: ProviderCredentialSource = {
      async load() {
        loads += 1;
        return { openai: THE_PROVIDER_KEY, deepgram: "unused-deepgram-key" };
      },
    };
    await service.start(undefined, {
      makers: judge.makers,
      providerCredentials,
    });

    const testId = await seedTest(world, [BEHAVIOR]);
    const { simulationId } = await conductSimulation(world, { testId });
    await eventually("the grading job to finish", async () => {
      const [job] = await listGradingJobsForSimulation(world.auth, simulationId);
      return job?.status === "graded" ? job : undefined;
    });

    expect(loads).toBe(1);
    expect(judge.configured).toHaveLength(2);
    expect(judge.configured.every((one) => one.key === THE_PROVIDER_KEY)).toBe(true);
    expect(
      JSON.stringify(
        await readVerdicts(world.auth, simulationId),
        (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain(THE_PROVIDER_KEY);
  });

  it("uses the current credential bundle for each new grading job", async () => {
    await seedGrader(world, aJudgedCopy());
    const judge = scriptedJudge({ answers: { [BEHAVIOR]: met("done") } });
    const firstKey = "sk-egma-first-job-NEVERLEAKME";
    const secondKey = "sk-egma-second-job-NEVERLEAKME";
    const keys = [firstKey, secondKey] as const;
    let loads = 0;
    await service.start(undefined, {
      makers: judge.makers,
      providerCredentials: {
        async load() {
          const key = keys[loads];
          if (key === undefined) throw new Error("credential source read too often");
          loads += 1;
          return { openai: key };
        },
      },
    });

    const testId = await seedTest(world, [BEHAVIOR]);
    const first = await conductSimulation(world, { testId });
    await eventually("the first grading job to finish", async () => {
      const [job] = await listGradingJobsForSimulation(
        world.auth,
        first.simulationId,
      );
      return job?.status === "graded" ? job : undefined;
    });

    const second = await conductSimulation(world, { testId });
    await eventually("the second grading job to finish", async () => {
      const [job] = await listGradingJobsForSimulation(
        world.auth,
        second.simulationId,
      );
      return job?.status === "graded" ? job : undefined;
    });

    expect(loads).toBe(2);
    expect(judge.configured.map((configured) => configured.key)).toEqual([
      firstKey,
      firstKey,
      secondKey,
      secondKey,
    ]);
  });

  it.each([
    ["missing", async () => ({})],
    [
      "unavailable",
      async () => {
        throw new ProviderCredentialSourceUnavailableError();
      },
    ],
  ] as const)("releases the job when the bundle is %s", async (_label, load) => {
    const judge = scriptedJudge({ answers: { [BEHAVIOR]: met("done") } });
    let loads = 0;
    await service.start(undefined, {
      makers: judge.makers,
      providerCredentials: {
        async load() {
          loads += 1;
          return load();
        },
      },
    });

    const testId = await seedTest(world, [BEHAVIOR]);
    const { simulationId } = await conductSimulation(world, { testId });
    await eventually("the failed claim to be released", async () => {
      const [job] = await listGradingJobsForSimulation(world.auth, simulationId);
      return job?.status === "pending" && job.attempts === 1 ? job : undefined;
    });
    await service.stop();

    expect(loads).toBe(1);
    expect((await readVerdicts(world.auth, simulationId)).verdicts).toEqual([]);
    expect(judge.configured).toEqual([]);
  });
});
