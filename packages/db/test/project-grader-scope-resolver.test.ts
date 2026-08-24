import { describe, expect, it } from "vitest";

import { validateProjectGraderScope } from "../src/grader-library/policy.ts";
import {
  planGroupsFor,
  productionSampleSelected,
  resolveSimulationGraders,
  type ProjectGraderCandidate,
} from "../src/grading/plan.ts";

function candidate(
  scope: ProjectGraderCandidate["scope"],
  modalities: ProjectGraderCandidate["definition"]["modalities"] = ["chat"],
): ProjectGraderCandidate {
  return {
    projectGraderId: "grd_01M01MH8KAE8ZB19B0YJ7Z7EYX",
    graderName: "Fixture grader",
    passThreshold: 0.7,
    parameterValues: { maximum: 7 },
    scope,
    definition: {
      definitionId: "grl_01M01MH8KAE8ZB19B0YJ7Z7EYX",
      definitionVersion: 3,
      type: "llm_as_judge",
      prompt: "Grade it",
      parameterContract: [],
      outputContract: {},
      modalities,
      judgeModel: { provider: "openai", model: "gpt-5" },
    },
  };
}

describe("project grader scope", () => {
  it("accepts the complete closed object and uses null as the only production-off spelling", () => {
    expect(
      validateProjectGraderScope({ simulations: [], production: null }),
    ).toEqual({ simulations: [], production: null });
    expect(
      validateProjectGraderScope({
        simulations: [{ kind: "all" }],
        production: { sample_percent: 1 },
      }),
    ).toEqual({
      simulations: [{ kind: "all" }],
      production: { sample_percent: 1 },
    });

    expect(() =>
      validateProjectGraderScope({
        simulations: [],
        production: { sample_percent: 0 },
      }),
    ).toThrow("use null to turn production grading off");
    expect(() =>
      validateProjectGraderScope({
        simulations: [{ kind: "all" }, { kind: "all" }],
        production: null,
      }),
    ).toThrow("repeats selector all");
    expect(() =>
      validateProjectGraderScope({
        simulations: [],
        production: null,
        hidden_rule: true,
      }),
    ).toThrow("only simulations and production");
  });
});

describe("the pure grader resolver", () => {
  it("adds one item when All, suite, and test selectors all match", () => {
    const one = candidate({
      simulations: [
        { kind: "all" },
        { kind: "test_suite", id: "ste_one" },
        { kind: "test", id: "tst_one" },
      ],
      production: null,
    });

    expect(
      resolveSimulationGraders([one], {
        suiteId: "ste_one",
        testId: "tst_one",
        modality: "chat",
      }),
    ).toEqual([one]);
  });

  it("builds separate test groups, so one selected test cannot leak to its sibling", () => {
    const onlyFirst = candidate(
      {
        simulations: [{ kind: "test", id: "tst_one" }],
        production: null,
      },
      ["chat"],
    );
    const groups = planGroupsFor([onlyFirst], [
      {
        suiteId: "ste_one",
        testId: "tst_one",
        testVersionId: "tstv_one",
        modality: "chat",
      },
      {
        suiteId: "ste_one",
        testId: "tst_two",
        testVersionId: "tstv_two",
        modality: "chat",
      },
    ]);

    expect(groups).toEqual([
      {
        tag: "test",
        testId: "tst_one",
        testVersionId: "tstv_one",
        items: [
          {
            kind: "project_grader",
            projectGraderId: onlyFirst.projectGraderId,
            graderDefinitionId: onlyFirst.definition.definitionId,
            graderDefinitionVersion: 3,
            graderName: "Fixture grader",
            type: "llm_as_judge",
            passThreshold: 0.7,
            parameterValues: { maximum: 7 },
          },
        ],
      },
      {
        tag: "test",
        testId: "tst_two",
        testVersionId: "tstv_two",
        items: [],
      },
    ]);
  });

  it("removes an incompatible modality before it evaluates scope", () => {
    const voiceOnly = candidate(
      { simulations: [{ kind: "all" }], production: null },
      ["voice"],
    );
    expect(
      resolveSimulationGraders([voiceOnly], {
        suiteId: "ste_one",
        testId: "tst_one",
        modality: "chat",
      }),
    ).toEqual([]);
  });

  it("makes production sampling stable for one trace and project grader", () => {
    const decisions = Array.from({ length: 10 }, () =>
      productionSampleSelected("trace-one", "grader-one", 25),
    );
    expect(new Set(decisions).size).toBe(1);
    expect(productionSampleSelected("trace-one", "grader-one", 100)).toBe(true);
  });
});
