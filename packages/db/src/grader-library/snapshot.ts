import type {
  GraderOutputContract,
  GraderParameter,
} from "./catalog.ts";
import {
  GRADER_DEFINITION_TYPES,
  GRADER_MODALITIES,
  type GraderDefinitionType,
  type GraderJudgeModel,
  type GraderModality,
} from "../schema/graders.ts";

export type GraderDefinitionSnapshot = {
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly type: GraderDefinitionType;
  readonly prompt: string | null;
  readonly parameterContract: readonly GraderParameter[];
  readonly outputContract: GraderOutputContract | null;
  readonly sourceCode: string | null;
  readonly sourceCodeLanguage: string | null;
  readonly modalities: readonly GraderModality[];
  readonly judgeModel: GraderJudgeModel | null;
};

export type GraderDefinitionSource = {
  readonly definitionId: string;
  readonly version: number;
  readonly type: string;
  readonly prompt: string | null;
  readonly parameterContract: unknown;
  readonly outputContract: unknown;
  readonly sourceCode: string | null;
  readonly sourceCodeLanguage: string | null;
  readonly modalities: unknown;
  readonly judgeModel: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the complete immutable value before execution can receive it. */
export function snapshotGraderDefinition(
  source: GraderDefinitionSource,
): GraderDefinitionSnapshot {
  const malformed = (because: string): Error =>
    new Error(`grader definition ${source.definitionId} ${because}`);

  if (!Number.isInteger(source.version) || source.version < 1) {
    throw malformed("has no positive version");
  }
  if (!(GRADER_DEFINITION_TYPES as readonly string[]).includes(source.type)) {
    throw malformed(`has an execution type Egma does not know: ${source.type}`);
  }
  if (!Array.isArray(source.parameterContract)) {
    throw malformed("holds a parameter contract Egma never writes");
  }
  if (source.outputContract !== null && !isObject(source.outputContract)) {
    throw malformed("holds an output contract Egma never writes");
  }
  if ((source.sourceCode === null) !== (source.sourceCodeLanguage === null)) {
    throw malformed("holds only half of its executable source");
  }
  if (
    !Array.isArray(source.modalities) ||
    source.modalities.length === 0 ||
    new Set(source.modalities).size !== source.modalities.length ||
    source.modalities.some(
      (modality) =>
        typeof modality !== "string" ||
        !(GRADER_MODALITIES as readonly string[]).includes(modality),
    )
  ) {
    throw malformed("holds modalities Egma never writes");
  }

  const type = source.type as GraderDefinitionType;
  if (type === "llm_as_judge" && !isObject(source.judgeModel)) {
    throw malformed("needs one LLM model selection");
  }
  if (type === "code" && source.judgeModel !== null) {
    throw malformed("is code but holds an LLM model selection");
  }

  return {
    definitionId: source.definitionId,
    definitionVersion: source.version,
    type,
    prompt: source.prompt,
    parameterContract:
      source.parameterContract as readonly GraderParameter[],
    outputContract: source.outputContract as GraderOutputContract | null,
    sourceCode: source.sourceCode,
    sourceCodeLanguage: source.sourceCodeLanguage,
    modalities: source.modalities as readonly GraderModality[],
    judgeModel: source.judgeModel as GraderJudgeModel | null,
  };
}
