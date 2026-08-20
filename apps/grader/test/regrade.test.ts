import {
  deleteGrader,
  editGrader,
  readVerdicts,
  regrade,
  type RecordedVerdict,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Service } from "../src/service.ts";
import {
  aLatencyCopy,
  conductSimulation,
  eventually,
  jobFor,
  makeWorld,
  runService,
  seedGrader,
  testConfig,
  theSeededGrader,
  type World,
} from "./support/world.ts";

/**
 * A simulation run pins grader-version ids once. Initial grading and every
 * later re-grade follow those ids; neither may follow a running copy's current
 * pointer after somebody edits it.
 */
describe("re-grading a frozen run", () => {
  let world: World;
  let service: Service;
  let primary: string;

  const rowsFrom = async (
    simulationId: string,
    graderId: string,
  ): Promise<readonly RecordedVerdict[]> =>
    (await readVerdicts(world.auth, simulationId)).verdicts.filter(
      (row) => row.graderId === graderId,
    );

  beforeAll(async () => {
    world = await makeWorld("grader_regrade_pinned_versions");
    // These cases isolate computed graders. Every real test carries an expected
    // behavior, so switch off the model-judged copy before a plan is frozen.
    await deleteGrader(world.auth, await theSeededGrader(world));
    primary = await seedGrader(
      world,
      aLatencyCopy({ name: "Answers inside two seconds" }),
    );
    service = runService(testConfig());
  });

  afterAll(async () => {
    service.stop();
    await service.finished;
    await world.drop();
  });

  it("uses the run's pinned version for a whole-run re-grade", async () => {
    const conducted = await conductSimulation(world, {
      spans: { measured: { turn_response_latency: [900, 1_100] } },
    });
    await jobFor(world, { simulationId: conducted.simulationId }, "graded");
    const [first] = await rowsFrom(conducted.simulationId, primary);
    expect(first).toMatchObject({ verdict: "passed" });

    const edited = await editGrader(world.auth, primary, {
      params: { metric: "turn_response_latency", bound: 1_000 },
    });
    expect(edited?.versionId).not.toBe(first?.graderVersionId);

    const asked = await regrade(world.auth, { runId: conducted.runId });
    expect(asked?.reopened).toHaveLength(1);
    const repeated = await eventually("the frozen grader version to judge again", async () => {
      const [row] = await rowsFrom(conducted.simulationId, primary);
      return row !== undefined &&
        row.judgedAtMicroseconds > (first?.judgedAtMicroseconds ?? 0n)
        ? row
        : undefined;
    });

    expect(repeated.graderVersionId).toBe(first?.graderVersionId);
    expect(repeated.graderVersionId).not.toBe(edited?.versionId);
    expect(repeated.verdict).toBe("passed");
    expect(await rowsFrom(conducted.simulationId, primary)).toHaveLength(1);

    // A new run is the place the edit takes effect.
    const next = await conductSimulation(world, {
      spans: { measured: { turn_response_latency: [900, 1_100] } },
    });
    await jobFor(world, { simulationId: next.simulationId }, "graded");
    const [newRun] = await rowsFrom(next.simulationId, primary);
    expect(newRun).toMatchObject({
      graderVersionId: edited?.versionId,
      verdict: "failed",
    });
  });

  it("narrows within the run's pinned versions and leaves other rows untouched", async () => {
    const secondary = await seedGrader(
      world,
      aLatencyCopy({
        name: "Answers inside five seconds",
        params: { metric: "turn_response_latency", bound: 5_000 },
      }),
    );
    const conducted = await conductSimulation(world, {
      spans: { measured: { turn_response_latency: [900, 1_100] } },
    });
    await jobFor(world, { simulationId: conducted.simulationId }, "graded");

    const [primaryBefore] = await rowsFrom(conducted.simulationId, primary);
    const [secondaryBefore] = await rowsFrom(conducted.simulationId, secondary);
    expect(secondaryBefore?.verdict).toBe("passed");

    const edited = await editGrader(world.auth, secondary, {
      params: { metric: "turn_response_latency", bound: 500 },
    });
    expect(edited?.versionId).not.toBe(secondaryBefore?.graderVersionId);

    const asked = await regrade(world.auth, {
      runId: conducted.runId,
      graderId: secondary,
    });
    expect(asked?.graderId).toBe(secondary);
    expect(asked?.reopened).toHaveLength(1);

    const secondaryAfter = await eventually(
      "the named pinned grader version to judge again",
      async () => {
        const [row] = await rowsFrom(conducted.simulationId, secondary);
        return row !== undefined &&
          row.judgedAtMicroseconds >
            (secondaryBefore?.judgedAtMicroseconds ?? 0n)
          ? row
          : undefined;
      },
    );
    expect(secondaryAfter.graderVersionId).toBe(
      secondaryBefore?.graderVersionId,
    );
    expect(secondaryAfter.graderVersionId).not.toBe(edited?.versionId);
    expect(secondaryAfter.verdict).toBe("passed");
    expect(await rowsFrom(conducted.simulationId, primary)).toEqual([
      primaryBefore,
    ]);
  });
});
