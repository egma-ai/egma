import { RECOMMENDED_GRADER_MODEL } from "../models/selections.ts";
import type {
  GraderDefinitionType,
  GraderJudgeModel,
  GraderModality,
} from "../schema/graders.ts";

export type GraderParameter = {
  readonly name: string;
  readonly label: string;
  readonly kind: "text" | "number" | "measure";
  readonly means: string;
};

/** A definition-owned description of the structured details it can return. */
export type GraderOutputContract = Readonly<Record<string, unknown>>;

const EXPECTED_BEHAVIORS_OUTPUT: GraderOutputContract = {
  score: {
    type: "number | null",
    minimum: 0,
    maximum: 1,
    means:
      "the fraction of expected-behavior assertions that passed; null when any assertion errored",
  },
  details: {
    type: "object",
    properties: {
      rationale: {
        type: "string",
        means: "a summary of how many expected behaviors passed",
      },
      error: {
        type: "string",
        means: "why the grader could not produce a score",
      },
      assertions: {
        type: "array",
        means: "one stored result for each expected behavior, in test order",
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
  readonly sourceCode: string | null;
  readonly sourceCodeLanguage: string | null;
  readonly modalities: readonly GraderModality[];
  readonly judgeModel: GraderJudgeModel | null;
  readonly createdAt: Date;
};

export const PREDEFINED_GRADERS = {
  expectedBehaviors: "grl_01M01MH8KAE8ZB19B0YJ7Z7EYW",
} as const;

const SHIPPED = new Date("2026-08-14T00:00:00.000Z");

/** The first product library contains one grader and no retired Latency row. */
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
    outputContract: EXPECTED_BEHAVIORS_OUTPUT,
    sourceCode: null,
    sourceCodeLanguage: null,
    modalities: ["chat", "voice"],
    judgeModel: RECOMMENDED_GRADER_MODEL,
    createdAt: SHIPPED,
  },
];
