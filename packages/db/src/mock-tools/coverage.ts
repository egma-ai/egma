/**
 * The coverage stamp: how isolated one simulation really was.
 *
 * It answers a question a developer asks about a single conversation and must
 * be able to answer from that conversation alone — "did mock tools change the
 * world this simulation met, and what did they miss?" So it is a stamp on the
 * record rather than something worked out later from spans.
 *
 * **One writer, deliberately: the LiveKit in-room seam.** There the agent
 * declares its tools per conversation, so two simulations of one run can
 * honestly differ and the stamp belongs at the simulation. The Retell lanes
 * never write it: what they answered for is decided once per run and each
 * answered call is already marked on the transcript, so a per-simulation copy
 * would be a second version of a fact that cannot differ. It returns to Retell
 * if per-simulation mocking ever arrives.
 *
 * Three lists, one question: what the agent has, what egma answered for, and
 * what reached its real implementation.
 */

/** The stamp one simulation carries. */
export type MockToolCoverage = {
  /** Every tool the agent was found to have. */
  readonly discovered: readonly string[];
  /** The tools egma answered for. */
  readonly covered: readonly string[];
  /** The tools that reached their real implementations. */
  readonly uncovered: readonly string[];
};

/** A stamp saying the asking happened and no tool came back. */
export const NO_MOCK_TOOL_COVERAGE: MockToolCoverage = {
  discovered: [],
  covered: [],
  uncovered: [],
};

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.some((one) => typeof one !== "string")) return undefined;
  return value as readonly string[];
}

/**
 * The stamp a stored row holds, or `null` for a row that holds none.
 *
 * All three lists are demanded: a row is written by egma's own writer, so a
 * stamp missing one is a corrupted row rather than an old one.
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
  };
}

/** The stamp as a row stores it: three lists, copied rather than referenced. */
export function mockToolCoverageRow(
  coverage: MockToolCoverage,
): Record<string, readonly string[]> {
  return {
    discovered: [...coverage.discovered],
    covered: [...coverage.covered],
    uncovered: [...coverage.uncovered],
  };
}
