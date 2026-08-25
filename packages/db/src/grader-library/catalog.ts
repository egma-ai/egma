import { RECOMMENDED_GRADER_MODEL } from "../models/selections.ts";
import type {
  GraderDefinitionType,
  GraderJudgeModel,
  GraderModality,
} from "../schema/graders.ts";
import type { GraderParameter } from "./parameters.ts";

export type { GraderParameter } from "./parameters.ts";

/** A definition-owned description of the structured details it can return. */
export type GraderOutputContract = Readonly<Record<string, unknown>>;

export const NORMALIZED_GRADE_OUTPUT_CONTRACT: GraderOutputContract = {
  score: {
    type: "number | null",
    minimum: 0,
    maximum: 1,
    means:
      "the normalized score produced by the grader; null when the grader errored",
  },
  details: {
    type: "object",
    properties: {
      rationale: {
        type: "string",
        means: "a short explanation of the score",
      },
      error: {
        type: "string",
        means: "why the grader could not produce a score",
      },
      assertions: {
        type: "array",
        means: "optional supporting results for graders that check several assertions",
        items: {
          key: { type: "string" },
          score: { type: "number", minimum: 0, maximum: 1 },
          rationale: { type: "string" },
          citedSpanIds: { type: "string[]" },
          error: { type: "string" },
        },
      },
    },
  },
};

const EXPECTED_BEHAVIORS_PROMPT = [
  "You grade one expected behavior against one recorded simulation.",
  "Decide only the expected behavior you are given.",
  "Use cannot_determine when the evidence does not settle it.",
  "Answer with JSON containing decision, rationale, and cited_turns.",
].join("\n");

export type PredefinedGraderDefinition = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type: GraderDefinitionType;
  readonly scopeEditable: boolean;
  readonly prompt: string | null;
  readonly parameterContract: readonly GraderParameter[];
  readonly outputContract: GraderOutputContract | null;
  readonly modalities: readonly GraderModality[];
  readonly judgeModel: GraderJudgeModel | null;
  readonly createdAt: Date;
};

export const PREDEFINED_GRADERS = {
  expectedBehaviors: "grl_01M01MH8KAE8ZB19B0YJ7Z7EYW",
  responseLatency: "grl_01M0TQE5HBE1X9PDN9HFJC987Q",
} as const;

export const MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER =
  "maximum_average_response_time_ms";

const SHIPPED = new Date("2026-08-14T00:00:00.000Z");
const RESPONSE_LATENCY_SHIPPED = new Date("2026-08-24T00:00:00.000Z");

/** The product library shipped and maintained by Egma. */
export const GRADER_DEFINITION_CATALOG: readonly PredefinedGraderDefinition[] = [
  {
    id: PREDEFINED_GRADERS.expectedBehaviors,
    name: "expected_behaviors",
    description:
      "Grades a completed simulation against the expected behaviors in its test.",
    type: "llm_as_judge",
    scopeEditable: false,
    prompt: EXPECTED_BEHAVIORS_PROMPT,
    parameterContract: [],
    outputContract: NORMALIZED_GRADE_OUTPUT_CONTRACT,
    modalities: ["chat", "voice"],
    judgeModel: RECOMMENDED_GRADER_MODEL,
    createdAt: SHIPPED,
  },
  {
    id: PREDEFINED_GRADERS.responseLatency,
    name: "Response latency",
    description:
      "Grades the average response time across measured turns against the maximum this project chooses.",
    type: "code",
    scopeEditable: true,
    prompt: null,
    parameterContract: [
      {
        key: MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER,
        label: "Maximum average response time",
        valueType: "integer",
        defaultValue: 3_000,
        unit: "milliseconds",
        minimum: 1,
        maximum: null,
      },
    ],
    outputContract: NORMALIZED_GRADE_OUTPUT_CONTRACT,
    modalities: ["chat", "voice"],
    judgeModel: null,
    createdAt: RESPONSE_LATENCY_SHIPPED,
  },
];
