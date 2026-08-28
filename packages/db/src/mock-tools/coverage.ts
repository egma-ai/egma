/**
 * The coverage stamp: how isolated one simulation really was.
 *
 * It answers a question a developer asks about a single conversation and must
 * be able to answer from that conversation alone — "did mock tools change the
 * world this simulation met, and what did they miss?" So it is a stamp on the
 * record rather than something worked out later from spans, and it is written
 * in one vocabulary wherever it comes from.
 *
 * **Five lists, two questions.** `discovered`, `covered` and `uncovered` answer
 * what the agent has and what egma answered for. The two beside them answer
 * *why* something was not answered for, where the seam knows — and knowing why
 * is the difference between "egma did not mock this" and "nothing could have".
 *
 * The three classes the product names are read straight off this stamp:
 *
 * - **mocked** — `covered`.
 * - **not interceptable by construction** — `notInterceptable`. The tool runs
 *   inside the agent's platform and no seam egma could build reaches it. Two of
 *   them, a transfer and an SMS, act outside the call and really happen; naming
 *   them is the whole point.
 * - **not in this version** — `notInThisVersion`. Egma could reach it and does
 *   not yet.
 *
 * A tool in `uncovered` and in neither class is the fourth, unnamed case: egma
 * stands in front of it and nobody authored an answer, so its call was refused.
 * That is a gap in the authored world rather than a fact about the platform,
 * and it is deliberately not a class of its own.
 */

/** The three answers the product gives about one tool. */
export const TOOL_COVERAGE_CLASSES = [
  "mocked",
  "notInterceptable",
  "notInThisVersion",
] as const;
export type ToolCoverageClass = (typeof TOOL_COVERAGE_CLASSES)[number];

/**
 * A configuration's tools in their three classes, before any run has happened.
 *
 * This is what a read of an agent's configuration produces — no run, no
 * simulation, no answers resolved yet — so it is the shape a surface that only
 * wants to *show* what could be mocked also gets.
 */
export type ToolCoverageClasses = Readonly<
  Record<ToolCoverageClass, readonly string[]>
>;

/** The three classes over nothing at all. */
export const NO_TOOL_COVERAGE_CLASSES: ToolCoverageClasses = {
  mocked: [],
  notInterceptable: [],
  notInThisVersion: [],
};

/** The stamp one simulation carries. */
export type MockToolCoverage = {
  /** Every tool the agent was found to have. */
  readonly discovered: readonly string[];
  /** The tools egma answered for. */
  readonly covered: readonly string[];
  /** The tools that reached their real implementations. */
  readonly uncovered: readonly string[];
  /**
   * Uncovered because the tool executes inside the platform, where no
   * interception reaches. Empty on a seam that has no such tools — the
   * in-process seam, where every tool the agent declares is reachable — and
   * empty is that seam's honest answer rather than a gap.
   */
  readonly notInterceptable: readonly string[];
  /** Uncovered because egma does not intercept this kind of tool yet. */
  readonly notInThisVersion: readonly string[];
};

/** A stamp saying the asking happened and no tool came back. */
export const NO_MOCK_TOOL_COVERAGE: MockToolCoverage = {
  discovered: [],
  covered: [],
  uncovered: [],
  notInterceptable: [],
  notInThisVersion: [],
};

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.some((one) => typeof one !== "string")) return undefined;
  return value as readonly string[];
}

/**
 * The stamp a stored row holds, or `null` for a row that holds none.
 *
 * All five lists are demanded. A row is written by egma's own writers and the
 * migration that added the two newer lists filled them in, so a stamp missing
 * one is a corrupted row rather than an old one — and reading a corrupted stamp
 * as "nothing was un-interceptable" would put a claim on a record that nobody
 * made.
 */
export function mockToolCoverageFrom(
  value: unknown,
  malformed: () => Error,
): MockToolCoverage | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw malformed();
  const row = value as Record<string, unknown>;
  const list = (key: keyof MockToolCoverage): readonly string[] => {
    const held = stringList(row[key]);
    if (held === undefined) throw malformed();
    return held;
  };
  return {
    discovered: list("discovered"),
    covered: list("covered"),
    uncovered: list("uncovered"),
    notInterceptable: list("notInterceptable"),
    notInThisVersion: list("notInThisVersion"),
  };
}

/** The stamp as a row stores it: five lists, copied rather than referenced. */
export function mockToolCoverageRow(
  coverage: MockToolCoverage,
): Record<string, readonly string[]> {
  return {
    discovered: [...coverage.discovered],
    covered: [...coverage.covered],
    uncovered: [...coverage.uncovered],
    notInterceptable: [...coverage.notInterceptable],
    notInThisVersion: [...coverage.notInThisVersion],
  };
}

/** The three classes as a stored value holds them, or a refusal. */
export function toolCoverageClassesFrom(
  value: unknown,
  malformed: () => Error,
): ToolCoverageClasses {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed();
  }
  const row = value as Record<string, unknown>;
  const classes: Record<ToolCoverageClass, readonly string[]> = {
    mocked: [],
    notInterceptable: [],
    notInThisVersion: [],
  };
  for (const name of TOOL_COVERAGE_CLASSES) {
    const held = stringList(row[name]);
    if (held === undefined) throw malformed();
    classes[name] = held;
  }
  return classes;
}

/**
 * A simulation's stamp built from a run's three classes and the answers that
 * simulation actually resolved.
 *
 * The seam that knows the tool list from a configuration knows it **before**
 * any conversation happens, so there is nothing to be late to: `discovered` is
 * every tool in every class, `covered` is the intercepted ones an answer was
 * authored for, and everything else is uncovered with its reason kept.
 */
export function coverageFromClasses(
  classes: ToolCoverageClasses,
  answeredFor: readonly string[],
): MockToolCoverage {
  const answered = new Set(answeredFor);
  const covered = classes.mocked.filter((name) => answered.has(name));
  const unanswered = classes.mocked.filter((name) => !answered.has(name));
  return {
    discovered: [
      ...classes.mocked,
      ...classes.notInterceptable,
      ...classes.notInThisVersion,
    ],
    covered,
    uncovered: [
      ...unanswered,
      ...classes.notInterceptable,
      ...classes.notInThisVersion,
    ],
    notInterceptable: [...classes.notInterceptable],
    notInThisVersion: [...classes.notInThisVersion],
  };
}
