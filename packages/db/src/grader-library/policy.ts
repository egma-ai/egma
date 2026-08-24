import type {
  ProjectGraderScope,
  SimulationScopeSelector,
} from "../schema/graders.ts";
import { UnprocessableInputError } from "../access/errors.ts";

function objectWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const held = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return held.length === wanted.length && held.every((key, i) => key === wanted[i]);
}

/** Parse the complete, closed scope object. Partial or extra policy is refused. */
export function validateProjectGraderScope(
  value: unknown,
): ProjectGraderScope {
  if (!objectWithExactKeys(value, ["simulations", "production"])) {
    throw new UnprocessableInputError(
      "grader scope must contain only simulations and production",
    );
  }
  if (!Array.isArray(value.simulations)) {
    throw new UnprocessableInputError("grader scope simulations must be a list");
  }

  const selectors: SimulationScopeSelector[] = [];
  const seen = new Set<string>();
  for (const candidate of value.simulations) {
    if (
      !objectWithExactKeys(candidate, ["kind"]) &&
      !objectWithExactKeys(candidate, ["kind", "id"])
    ) {
      throw new UnprocessableInputError(
        "each simulation selector must be a closed object",
      );
    }
    let selector: SimulationScopeSelector;
    if (candidate.kind === "all" && Object.keys(candidate).length === 1) {
      selector = { kind: "all" };
    } else if (
      (candidate.kind === "test_suite" || candidate.kind === "test") &&
      typeof candidate.id === "string" &&
      candidate.id.length > 0 &&
      Object.keys(candidate).length === 2
    ) {
      selector = { kind: candidate.kind, id: candidate.id };
    } else {
      throw new UnprocessableInputError(
        "a simulation selector must be all, test_suite with an id, or test with an id",
      );
    }
    const key = selector.kind === "all" ? "all" : `${selector.kind}:${selector.id}`;
    if (seen.has(key)) {
      throw new UnprocessableInputError(`grader scope repeats selector ${key}`);
    }
    seen.add(key);
    selectors.push(selector);
  }

  let production: ProjectGraderScope["production"];
  if (value.production === null) {
    production = null;
  } else {
    if (!objectWithExactKeys(value.production, ["sample_percent"])) {
      throw new UnprocessableInputError(
        "production scope must be null or contain only sample_percent",
      );
    }
    const percent = value.production.sample_percent;
    if (
      typeof percent !== "number" ||
      !Number.isFinite(percent) ||
      percent < 1 ||
      percent > 100
    ) {
      throw new UnprocessableInputError(
        "production sample_percent must be from 1 through 100; use null to turn production grading off",
      );
    }
    production = { sample_percent: percent };
  }

  return { simulations: selectors, production };
}

export function validatePassThreshold(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new UnprocessableInputError(
      "grader pass threshold must be from 0 through 1",
    );
  }
  return value;
}
