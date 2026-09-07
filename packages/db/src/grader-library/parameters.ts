import { UnprocessableInputError } from "../access/errors.ts";
import { RECOMMENDED_GRADER_MODEL, validGraderModel, type GraderModel } from "../models/selections.ts";

/** One setting declared by an immutable grader definition version. */
export type GraderParameter = {
  readonly key: string;
  readonly label: string;
  readonly valueType: "integer" | "number" | "string";
  readonly defaultValue: number | string;
  readonly unit: string | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
};

/** One project's complete answers to a version's parameter contract. */
export type GraderParameterValues = Readonly<Record<string, unknown>>;

const CONTRACT_FIELDS = [
  "key",
  "label",
  "valueType",
  "defaultValue",
  "unit",
  "minimum",
  "maximum",
] as const;

function objectOf(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(message);
  }
  return value as Record<string, unknown>;
}

function numberOrNull(value: unknown): value is number | null {
  return value === null ||
    (typeof value === "number" && Number.isFinite(value));
}

/** Validate a stored immutable contract before it can shape a form or worker. */
export function validateGraderParameterContract(
  value: unknown,
): readonly GraderParameter[] {
  if (!Array.isArray(value)) {
    throw new TypeError("grader parameter contract must be a list");
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    const held = objectOf(
      entry,
      `grader parameter ${index + 1} must be an object`,
    );
    const unsupported = Object.keys(held).filter(
      (key) => !(CONTRACT_FIELDS as readonly string[]).includes(key),
    );
    const missing = CONTRACT_FIELDS.filter((key) => !(key in held));
    if (unsupported.length > 0 || missing.length > 0) {
      throw new TypeError(
        `grader parameter ${index + 1} must contain exactly ${
          CONTRACT_FIELDS.join(", ")
        }`,
      );
    }

    const { key, label, valueType, defaultValue, unit, minimum, maximum } = held;
    if (
      typeof key !== "string" ||
      !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(key)
    ) {
      throw new TypeError(
        `grader parameter ${index + 1} needs a snake_case key`,
      );
    }
    if (seen.has(key)) {
      throw new TypeError(`grader parameter key ${key} is repeated`);
    }
    seen.add(key);
    if (typeof label !== "string" || label.trim() === "") {
      throw new TypeError(`grader parameter ${key} needs a label`);
    }
    if (valueType !== "integer" && valueType !== "number" && valueType !== "string") {
      throw new TypeError(`grader parameter ${key} has an unsupported value type`);
    }
    if (valueType === "string" ? typeof defaultValue !== "string" || defaultValue.trim() === "" :
      typeof defaultValue !== "number" || !Number.isFinite(defaultValue) ||
      (valueType === "integer" && !Number.isInteger(defaultValue))) {
      throw new TypeError(`grader parameter ${key} has an invalid default`);
    }
    if (unit !== null && (typeof unit !== "string" || unit.trim() === "")) {
      throw new TypeError(`grader parameter ${key} has an invalid unit`);
    }
    if (!numberOrNull(minimum) || !numberOrNull(maximum) ||
      (valueType === "integer" && [minimum, maximum].some((one) => one !== null && !Number.isInteger(one))) ||
      (valueType === "string" && (minimum !== null || maximum !== null || unit !== null))) {
      throw new TypeError(`grader parameter ${key} has an invalid range or unit`);
    }
    if (minimum !== null && maximum !== null && minimum > maximum) {
      throw new TypeError(`grader parameter ${key} has a reversed range`);
    }
    if (
      typeof defaultValue === "number" && ((minimum !== null && defaultValue < minimum) ||
      (maximum !== null && defaultValue > maximum))
    ) {
      throw new TypeError(`grader parameter ${key} has a default outside its range`);
    }

    return {
      key,
      label: label.trim(),
      valueType,
      defaultValue: defaultValue as number | string,
      unit: unit === null ? null : unit.trim(),
      minimum,
      maximum,
    };
  });
}

/** Validate one project's complete values against one immutable contract. */
export function validateGraderParameterValues(
  contractValue: unknown,
  valuesValue: unknown,
): GraderParameterValues {
  let contract: readonly GraderParameter[];
  try {
    contract = validateGraderParameterContract(contractValue);
  } catch (error) {
    throw new Error("grader definition has an invalid parameter contract", {
      cause: error,
    });
  }

  let values: Record<string, unknown>;
  try {
    values = objectOf(valuesValue, "grader settings must be an object");
  } catch (error) {
    throw new UnprocessableInputError(
      error instanceof Error ? error.message : "grader settings are invalid",
    );
  }

  const expected = new Set(contract.map((parameter) => parameter.key));
  const unsupported = Object.keys(values).filter((key) => !expected.has(key));
  const missing = contract
    .map((parameter) => parameter.key)
    .filter((key) => !(key in values));
  if (unsupported.length > 0) {
    throw new UnprocessableInputError(
      `grader settings have unsupported fields ${unsupported.join(", ")}`,
    );
  }
  if (missing.length > 0) {
    throw new UnprocessableInputError(
      `grader settings need values for ${missing.join(", ")}`,
    );
  }

  const answer: Record<string, unknown> = {};
  for (const parameter of contract) {
    const value = values[parameter.key];
    if (parameter.valueType === "string") {
      if (typeof value !== "string" || value.trim() === "") {
        throw new UnprocessableInputError(`${parameter.label} must be nonempty text`);
      }
      answer[parameter.key] = value.trim();
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) ||
      (parameter.valueType === "integer" && !Number.isInteger(value))) {
      throw new UnprocessableInputError(
        `${parameter.label} must be ${parameter.valueType === "integer" ? "a whole number" : "a number"}`,
      );
    }
    if (parameter.minimum !== null && value < parameter.minimum) {
      throw new UnprocessableInputError(
        `${parameter.label} must be at least ${parameter.minimum}`,
      );
    }
    if (parameter.maximum !== null && value > parameter.maximum) {
      throw new UnprocessableInputError(
        `${parameter.label} must be at most ${parameter.maximum}`,
      );
    }
    answer[parameter.key] = value;
  }
  return answer;
}

/** A saved number keeps its unit when a compatible core becomes current. */
export function validateUnchangedParameterUnits(
  currentContract: unknown,
  proposedContract: unknown,
): void {
  const current = new Map(validateGraderParameterContract(currentContract).map((field) => [field.key, field]));
  for (const proposed of validateGraderParameterContract(proposedContract)) {
    const previous = current.get(proposed.key);
    if (previous !== undefined && previous.unit !== proposed.unit) {
      throw new UnprocessableInputError(
        `the unit for ${proposed.key} cannot change from ${previous.unit ?? "unitless"} to ${proposed.unit ?? "unitless"} while project settings are saved`,
      );
    }
  }
}

/** Defaults are materialized only on creation or first use. */
export function defaultGraderParameterValues(contractValue: unknown): GraderParameterValues {
  const contract = validateGraderParameterContract(contractValue);
  return validateGraderParameterValues(contract, Object.fromEntries(
    contract.map((parameter) => [parameter.key, parameter.defaultValue]),
  ));
}

export const LLM_GRADER_PARAMETER_CONTRACT: readonly GraderParameter[] = [
  { key: "llm_provider", label: "LLM provider", valueType: "string", defaultValue: RECOMMENDED_GRADER_MODEL.provider, unit: null, minimum: null, maximum: null },
  { key: "llm_model", label: "LLM model", valueType: "string", defaultValue: RECOMMENDED_GRADER_MODEL.model, unit: null, minimum: null, maximum: null },
];

export function graderModelOfParameters(values: GraderParameterValues): GraderModel {
  return validGraderModel({ provider: values.llm_provider, model: values.llm_model });
}

/** Model capability checks belong at every grader settings write/read boundary. */
export function validateExecutableGraderParameters(type: string, contract: unknown, values: unknown): GraderParameterValues {
  const checked = validateGraderParameterValues(contract, values);
  if (type === "llm_as_judge") graderModelOfParameters(checked);
  return checked;
}
