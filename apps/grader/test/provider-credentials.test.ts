import {
  listGradingJobsForSimulation,
  readVerdicts,
} from "@egma/db";
import {
  ProviderCredentialSourceUnavailableError,
  type ProviderCredentialSource,
} from "@egma/provider-credentials";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  aJudgedCopy,
  conductSimulation,
  eventually,
  makeWorld,
  oneServiceAtATime,
  seedGrader,
  seedTest,
  THE_PROVIDER_KEY,
  type World,
} from "./support/world.ts";
import { met, scriptedJudge } from "./support/scripted-judge.ts";

const BEHAVIOR = "confirms the new time back before finishing";

let world: World;
const service = oneServiceAtATime();

beforeEach(async () => {
  world = await makeWorld("grader_provider_credentials");
});

afterEach(async () => {
  await service.stop();
  await world.drop();
});

describe("provider credentials for one claimed grading job", () => {
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
