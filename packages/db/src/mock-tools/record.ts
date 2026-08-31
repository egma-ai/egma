/**
 * The put-it-back note one mocked run leaves behind, and nothing else.
 *
 * It exists so that **a teardown restores rather than reconstructs**, and so
 * that a run which never reached its own teardown can still be finished by
 * somebody else. Two things live in it, both written before the thing they
 * describe is changed:
 *
 * - `engine` — the serving engine capture: which document it is, and what its
 *   tools looked like, which is what the verify step reads back and compares
 *   against once the mocked tools are on the copy — and what a teardown
 *   resumed by somebody else compares against before it deletes anything.
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
  /**
   * The tools that engine declared when this run captured it, in the one
   * spelling a comparison uses.
   *
   * **The comparison value, written down rather than held in memory.** The
   * run's own verify step compares what the serving version declares after the
   * swap against what it declared before, and a run that crashes between the
   * two takes that "before" with it — so a teardown resumed by anybody else
   * could not say whether the serving version had moved, which is one of the
   * four promises the consent screen makes. With it here, the resumed teardown
   * reads the engine at the reference above and answers honestly.
   *
   * **A difference is reported, never repaired.** Putting the tools back would
   * need the captured document itself, which this note deliberately does not
   * hold — it is a note about what to put back, not a copy of the customer's
   * configuration — so a mismatch is said out loud and the world stays
   * unsettled. Absent on a note written before the print existed, and on one
   * whose run never got as far as reading the engine.
   */
  readonly toolPrint?: string;
};

export type MockMetadata = {
  readonly engine: MockEngineNote;
  /**
   * Whether the temporary version was deleted **and the deletion proved**.
   *
   * The one fact a teardown has to hand to the next one. A teardown can delete
   * the copy, prove it gone against the platform's own version listing, and
   * then fail a restore — which leaves the world unsettled and the next sweep
   * retrying it. Without this the sweep would read a version number off the
   * row and delete it a second time, and by then the platform can have handed
   * that number to somebody else's draft.
   *
   * It lives here rather than beside the version number because a finished
   * run's header is frozen except for this note and the cleanup flag, and
   * because the version number is a permanent answer to "what did this run
   * branch" rather than a statement about what is standing now.
   */
  readonly temporaryVersionGone?: boolean;
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
  const gone = row["temporary_version_gone"];
  if (
    typeof engine !== "object" ||
    engine === null ||
    Array.isArray(engine) ||
    (gone !== undefined && gone !== null && typeof gone !== "boolean")
  ) {
    throw malformed();
  }
  const held = engine as Record<string, unknown>;
  const engineVersion = held["version"];
  const print = held["tool_print"];
  if (
    typeof held["type"] !== "string" ||
    typeof held["engine_id"] !== "string" ||
    (engineVersion !== null && typeof engineVersion !== "number") ||
    (print !== undefined && print !== null && typeof print !== "string")
  ) {
    throw malformed();
  }

  return {
    engine: {
      type: held["type"],
      engineId: held["engine_id"],
      version: engineVersion,
      ...(typeof print === "string" ? { toolPrint: print } : {}),
    },
    ...(gone === true ? { temporaryVersionGone: true } : {}),
  };
}

/**
 * The note as a **reader of the run** sees it: what Egma promised to put back,
 * and nothing of how it goes about it.
 *
 * Two fields are the teardown's own working notes and are dropped here. The
 * print is the whole of the serving version's tools in one line, kept so a
 * resumed teardown can still prove that version never moved; a canonicalized
 * copy of the customer's tool declarations is neither something a person can
 * act on nor something a page of runs should carry. `temporaryVersionGone` is
 * bookkeeping between one teardown and the next — what a reader wants to know
 * about the copy is whether the account is back, and the cleanup flag beside
 * the note says that. So the sweep's read keeps both and the run's read drops
 * both, which is also why the published shape of the note names neither.
 */
export function mockMetadataAsRead(
  metadata: MockMetadata | null,
): MockMetadata | null {
  if (metadata === null) return null;
  const { toolPrint: _print, ...engine } = metadata.engine;
  return { engine };
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
      // The row's own spelling, beside `engine_id` and `pinned_to`.
      ...(metadata.engine.toolPrint === undefined
        ? {}
        : { tool_print: metadata.engine.toolPrint }),
    },
    // The row's own spelling again. Written only when true, so a note from
    // before this fact existed reads back exactly as it was written.
    ...(metadata.temporaryVersionGone === true
      ? { temporary_version_gone: true }
      : {}),
  };
}
