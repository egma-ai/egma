/**
 * The world one run **read** at its start, and conducts against.
 *
 * Its sibling `MockedWorld` is a record of what egma put onto somebody's
 * platform so that teardown can put it back. This is the opposite record: on a
 * lane that carries its mocked answers on each request, egma writes nothing at
 * all, and what has to be remembered is only what was *read* — which version is
 * serving, which engine it runs on, and what that version's tools are.
 *
 * **Why it is remembered rather than re-read.** Retell's own default is "the
 * newest version", and a concurrent edit mints a newer one. A suite that asked
 * for the default twice could be testing two different agents halfway through.
 * So the version is resolved once, frozen here, and named explicitly on every
 * request from then on — and the same value is copied onto every simulation of
 * the run, because a result is read at the simulation and has to answer for
 * itself.
 *
 * **The three classes are here for two readers.** The claim path serves a
 * native mock for a `mocked` name and for no other, so a tool egma cannot
 * stand in front of reaches the customer's real implementation and the record
 * says which class it fell in. The report path turns the same three classes
 * into the five-list stamp every simulation carries.
 */

import {
  toolCoverageClassesFrom,
  type ToolCoverageClasses,
} from "./coverage.ts";

/** Which engine document the conducted version runs on. */
export type ConductedEngine = {
  /** The platform's own word for the engine kind, verbatim. */
  readonly type: string;
  /** The platform's id for the engine document, or `""` where it holds none. */
  readonly engineId: string;
  /** The engine version the conducted agent version points at. */
  readonly version: number | null;
};

export type ConductedWorld = {
  /**
   * The numeric agent version this run conducts against, resolved once at run
   * start. Never a tag and never `latest`: those are what move.
   */
  readonly agentVersion: number;
  readonly engine: ConductedEngine;
  /** The three classes of that version's tools, read before any conversation. */
  readonly coverage: ToolCoverageClasses;
};

/** The world a stored row holds, or `null` for a run that pinned none. */
export function conductedWorldFrom(
  value: unknown,
  malformed: () => Error,
): ConductedWorld | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw malformed();
  const row = value as Record<string, unknown>;

  const agentVersion = row["agentVersion"];
  const engine = row["engine"];
  if (
    typeof agentVersion !== "number" ||
    typeof engine !== "object" ||
    engine === null ||
    Array.isArray(engine)
  ) {
    throw malformed();
  }

  const held = engine as Record<string, unknown>;
  const engineVersion = held["version"];
  if (
    typeof held["type"] !== "string" ||
    typeof held["engineId"] !== "string" ||
    (engineVersion !== null && typeof engineVersion !== "number")
  ) {
    throw malformed();
  }

  return {
    agentVersion,
    engine: {
      type: held["type"],
      engineId: held["engineId"],
      version: engineVersion,
    },
    coverage: toolCoverageClassesFrom(row["coverage"], malformed),
  };
}

/** The world as a row stores it. Copied, so no caller holds the stored value. */
export function conductedWorldRow(
  world: ConductedWorld,
): Record<string, unknown> {
  return {
    agentVersion: world.agentVersion,
    engine: {
      type: world.engine.type,
      engineId: world.engine.engineId,
      version: world.engine.version,
    },
    coverage: {
      mocked: [...world.coverage.mocked],
      notInterceptable: [...world.coverage.notInterceptable],
      notInThisVersion: [...world.coverage.notInThisVersion],
    },
  };
}
