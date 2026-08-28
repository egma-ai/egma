/**
 * The temporary world one run built on the agent's platform.
 *
 * It exists so that **teardown restores rather than reconstructs**, and so that
 * a run which never reached its own teardown can still be finished by somebody
 * else. Every field here is written before the thing it describes is changed:
 * the version that was serving before anything was branched, the temporary
 * version that was minted, and each touched number's inbound bindings exactly
 * as they were read — sibling fields egma has never heard of included.
 *
 * A record built out of the two fields egma happened to look at would be a
 * restore that quietly edited the customer's routing. This is the record that
 * cannot.
 */

import {
  toolCoverageClassesFrom,
  type ToolCoverageClasses,
} from "./coverage.ts";

/** One number the run looked at, and everything it would take to put it back. */
export type MockedWorldNumber = {
  /** E.164, exactly as the platform holds it. */
  readonly number: string;
  /**
   * Whether egma changed this number's binding for the run, and therefore owes
   * it a restore. A number already pinned to a version, riding an environment
   * tag, or riding the published pointer is recorded and not touched — so the
   * record says what was checked as well as what was changed.
   */
  readonly pinned: boolean;
  /**
   * Every inbound binding the number carried, verbatim, including the entries
   * that name other agents. The whole array goes back, because the whole array
   * is what a write replaces.
   */
  readonly bindings: readonly Readonly<Record<string, unknown>>[];
};

/** Which engine document the temporary version runs on. */
export type MockedWorldEngine = {
  /** The platform's own word for the engine kind. */
  readonly type: string;
  /** The platform's id for the engine document, or `""` where it holds none. */
  readonly engineId: string;
  /** The engine version the temporary agent version points at. */
  readonly version: number | null;
};

export type MockedWorld = {
  /** The numeric agent version that was serving when the run started. */
  readonly servingVersion: number;
  /**
   * The temporary version egma minted for this run, or null when the world was
   * recorded before the branch landed. Null here and a pinned number below is
   * exactly the state a sweep has to be able to finish.
   */
  readonly draftVersion: number | null;
  readonly engine: MockedWorldEngine;
  readonly numbers: readonly MockedWorldNumber[];
  /**
   * The three classes of the configuration the temporary version was built
   * from, read before the version existed. Nothing about it can be late.
   */
  readonly coverage: ToolCoverageClasses;
};

function bindingsFrom(
  value: unknown,
  malformed: () => Error,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) throw malformed();
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw malformed();
    }
    return entry as Record<string, unknown>;
  });
}

/** The world a stored row holds, or `null` for a run that built none. */
export function mockedWorldFrom(
  value: unknown,
  malformed: () => Error,
): MockedWorld | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw malformed();
  const row = value as Record<string, unknown>;

  const servingVersion = row["servingVersion"];
  const draftVersion = row["draftVersion"];
  const engine = row["engine"];
  const numbers = row["numbers"];
  if (
    typeof servingVersion !== "number" ||
    (draftVersion !== null && typeof draftVersion !== "number") ||
    typeof engine !== "object" ||
    engine === null ||
    Array.isArray(engine) ||
    !Array.isArray(numbers)
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
    servingVersion,
    draftVersion,
    engine: {
      type: held["type"],
      engineId: held["engineId"],
      version: engineVersion,
    },
    numbers: numbers.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw malformed();
      }
      const one = entry as Record<string, unknown>;
      if (typeof one["number"] !== "string" || typeof one["pinned"] !== "boolean") {
        throw malformed();
      }
      return {
        number: one["number"],
        pinned: one["pinned"],
        bindings: bindingsFrom(one["bindings"], malformed),
      };
    }),
    coverage: toolCoverageClassesFrom(row["coverage"], malformed),
  };
}

/**
 * The world a run wears while it is still building one — and the claim that
 * says this agent's one mocked world is taken.
 *
 * Written by `claimMockedWorldFor` under the agent's lock, before the builder
 * reaches the platform, so two things are true at once: the run is visible to a
 * later sweep if the process building it dies, and a second run for the same
 * agent finds this agent already claimed and refuses. `servingVersion` is not
 * known yet — the build reads it — and the build's own first record replaces
 * this whole marker within a moment. Its null draft keeps the claim gate shut,
 * so nothing is conducted against it.
 */
export const MOCKED_WORLD_BUILDING: MockedWorld = {
  servingVersion: 0,
  draftVersion: null,
  engine: { type: "", engineId: "", version: null },
  numbers: [],
  coverage: { mocked: [], notInterceptable: [], notInThisVersion: [] },
};

/** The world as a row stores it. Copied, so no caller holds the stored value. */
export function mockedWorldRow(world: MockedWorld): Record<string, unknown> {
  return {
    servingVersion: world.servingVersion,
    draftVersion: world.draftVersion,
    engine: {
      type: world.engine.type,
      engineId: world.engine.engineId,
      version: world.engine.version,
    },
    numbers: world.numbers.map((one) => ({
      number: one.number,
      pinned: one.pinned,
      bindings: one.bindings.map((binding) => ({ ...binding })),
    })),
    coverage: {
      mocked: [...world.coverage.mocked],
      notInterceptable: [...world.coverage.notInterceptable],
      notInThisVersion: [...world.coverage.notInThisVersion],
    },
  };
}
