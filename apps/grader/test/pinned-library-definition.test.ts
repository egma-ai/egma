import {
  getGrader,
  GRADER_LIBRARY_CATALOG,
  PREDEFINED_GRADERS,
  readVerdicts,
  regrade,
  seedGraderLibrary,
  type PredefinedGrader,
  type RecordedVerdict,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  conductSimulation,
  eventually,
  jobFor,
  makeWorld,
  oneServiceAtATime,
  theSeededGrader,
  type World,
} from "./support/world.ts";
import { met } from "./support/scripted-judge.ts";

describe("a run-pinned Library definition", () => {
  let world: World;
  const service = oneServiceAtATime();
  const behavior = "finishes the conversation";

  beforeAll(async () => {
    world = await makeWorld("grader_pinned_library_definition");
  });

  afterAll(async () => {
    await service.stop();
    await world.drop();
  });

  it("keeps the old prompt for initial grading and re-grade, then gives new runs the new prompt", async () => {
    const shipped = catalogEntry(PREDEFINED_GRADERS.expectedBehaviors);
    const marker = "PROMPT-FOR-RUNS-STARTED-AFTER-THE-RELEASE";
    const improved: PredefinedGrader = {
      ...shipped,
      prompt: `${shipped.prompt ?? ""}\n${marker}`,
    };
    const graderId = await theSeededGrader(world);
    const before = await getGrader(world.auth, graderId);
    if (before === undefined) throw new Error("the seeded grader is missing");

    const judge = await service.judgingWith({
      [behavior]: met("the conversation finished"),
    });
    let promotedVersionId = "";
    const firstRun = await conductSimulation(world, {
      afterRunStarted: async () => {
        await seedGraderLibrary([improved]);
        promotedVersionId =
          (await getGrader(world.auth, graderId))?.versionId ?? "";
      },
    });
    await jobFor(world, { simulationId: firstRun.simulationId }, "graded");

    const first = await rowFor(firstRun.simulationId, graderId);
    expect(first.graderVersionId).toBe(before.versionId);
    expect(first.graderVersionId).not.toBe(promotedVersionId);
    expect(judge.asked[0]?.prompt).toBe(shipped.prompt);
    expect(judge.asked[0]?.prompt).not.toContain(marker);

    const reopened = await regrade(world.auth, {
      runId: firstRun.runId,
      graderId,
    });
    expect(reopened?.reopened).toHaveLength(1);
    const repeated = await eventually(
      "the run-pinned definition to judge again",
      async () => {
        const row = await rowFor(firstRun.simulationId, graderId);
        return judge.asked.length >= 2 &&
          row.judgedAtMicroseconds > first.judgedAtMicroseconds
          ? row
          : undefined;
      },
    );
    expect(repeated.graderVersionId).toBe(before.versionId);
    expect(judge.asked[1]?.prompt).toBe(shipped.prompt);
    expect(judge.asked[1]?.prompt).not.toContain(marker);

    const nextRun = await conductSimulation(world);
    await jobFor(world, { simulationId: nextRun.simulationId }, "graded");
    const next = await rowFor(nextRun.simulationId, graderId);
    expect(next.graderVersionId).toBe(promotedVersionId);
    expect(judge.asked[2]?.prompt).toBe(improved.prompt);
    expect(judge.asked[2]?.prompt).toContain(marker);
  });

  async function rowFor(
    simulationId: string,
    graderId: string,
  ): Promise<RecordedVerdict> {
    const row = (await readVerdicts(world.auth, simulationId)).verdicts.find(
      (candidate) => candidate.graderId === graderId,
    );
    if (row === undefined) {
      throw new Error(`grader ${graderId} wrote no row for ${simulationId}`);
    }
    return row;
  }
});

function catalogEntry(id: string): PredefinedGrader {
  const entry = GRADER_LIBRARY_CATALOG.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`missing catalog entry ${id}`);
  return entry;
}
