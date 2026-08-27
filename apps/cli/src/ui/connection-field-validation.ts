/** Validation shared by the grouped terminal form and its flow boundary. */

export type ConnectionFieldIssue = "missing" | "invalid-json";

type ValidatedConnectionField = {
  readonly required: boolean;
  readonly kind: string;
};

function isJsonObject(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

export function connectionFieldIssue(
  field: ValidatedConnectionField,
  value: string,
): ConnectionFieldIssue | null {
  if (field.required && value === "") return "missing";
  if (field.kind === "json" && value !== "" && !isJsonObject(value)) {
    return "invalid-json";
  }
  return null;
}
