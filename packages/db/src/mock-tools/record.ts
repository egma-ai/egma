/**
 * The put-it-back note one mocked run leaves behind, and nothing else.
 *
 * It exists so that **a teardown restores rather than reconstructs**, and so
 * that a run which never reached its own teardown can still be finished by
 * somebody else. Two things live in it, both written before the thing they
 * describe is changed:
 *
 * - `engine` — the serving engine capture, which is what the verify step reads
 *   back and compares against once the mocked tools are on the copy.
 * - `numbers` — one entry per number Egma actually pinned: where this agent's
 *   binding pointed before (`was`), and the numeric version Egma pinned it to
 *   (`pinned_to`).
 *
 * **A restore never writes blind.** It reads where the number points now and
 * writes only where it still points at `pinned_to` — so a late retry of a
 * failed teardown can never move a binding the customer has since changed, and
 * can never put a `latest` binding back onto a newer run's temporary copy.
 * That is why the note holds the two values rather than the whole
 * `inbound_agents` array: the array is re-read at restore time anyway, and
 * writing back a stale copy of it would delete whatever changed in between.
 */

/** Which engine document the serving version ran on when it was captured. */
export type MockEngineNote = {
  /** The platform's own word for the engine kind. */
  readonly type: string;
  /** The platform's id for the engine document, or `""` where it holds none. */
  readonly engineId: string;
  /** The engine version the serving agent version points at. */
  readonly version: number | null;
};

/** One number Egma pinned, and everything it takes to put it back. */
export type MockNumberNote = {
  /** E.164, exactly as the platform holds it. */
  readonly number: string;
  /**
   * Where this agent's binding pointed before Egma touched it, verbatim — a
   * version number, `latest`, a tag's name, or null where the platform held
   * none at all.
   */
  readonly was: string | number | null;
  /** The numeric version Egma pinned it to for the length of the run. */
  readonly pinnedTo: number;
};

export type MockMetadata = {
  readonly engine: MockEngineNote;
  readonly numbers: readonly MockNumberNote[];
};

/** The note a stored row holds, or `null` for a run that made no copy. */
export function mockMetadataFrom(
  value: unknown,
  malformed: () => Error,
): MockMetadata | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw malformed();
  const row = value as Record<string, unknown>;

  const engine = row["engine"];
  const numbers = row["numbers"];
  if (
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
    typeof held["engine_id"] !== "string" ||
    (engineVersion !== null && typeof engineVersion !== "number")
  ) {
    throw malformed();
  }

  return {
    engine: {
      type: held["type"],
      engineId: held["engine_id"],
      version: engineVersion,
    },
    numbers: numbers.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw malformed();
      }
      const one = entry as Record<string, unknown>;
      const was = one["was"];
      if (
        typeof one["number"] !== "string" ||
        typeof one["pinned_to"] !== "number" ||
        (was !== null && typeof was !== "string" && typeof was !== "number")
      ) {
        throw malformed();
      }
      return { number: one["number"], was, pinnedTo: one["pinned_to"] };
    }),
  };
}

/** The note as a row stores it. Copied, so no caller holds the stored value. */
export function mockMetadataRow(
  metadata: MockMetadata,
): Record<string, unknown> {
  return {
    engine: {
      type: metadata.engine.type,
      engine_id: metadata.engine.engineId,
      version: metadata.engine.version,
    },
    numbers: metadata.numbers.map((one) => ({
      number: one.number,
      was: one.was,
      pinned_to: one.pinnedTo,
    })),
  };
}
