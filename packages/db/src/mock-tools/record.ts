/**
 * The put-it-back note one mocked run leaves behind, and nothing else.
 *
 * It exists so that **a teardown gives back rather than guesses**, and so that
 * a run which never reached its own teardown can still be finished by somebody
 * else. Two things live in it, both written before the thing they describe is
 * changed:
 *
 * - `engine` — the serving engine capture: which document it is, and what its
 *   tools looked like, which is what the verify step reads back and compares
 *   against once the mocked tools are on the copy — and what a teardown
 *   resumed by somebody else compares against before it deletes anything.
 * - `urlVariables` — which per-call variable routes which tool on the copy,
 *   which is what the claim fills on every call the run creates.
 *
 * **Egma writes to nothing of the customer's**, so there is nothing of theirs
 * to promise back: no number binding, no tag, no version they made. The one
 * thing a mocked run makes is its own temporary copy, and the two cleanup
 * fields beside this note are what say whether it is still standing.
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
   * The version of that same engine the run's temporary copy ran on, as the
   * platform's own branch response reported it.
   *
   * Kept so a teardown can name what it leaves behind, and never derived from
   * the agent version — the two numbers track each other in practice and
   * nothing documents that they must.
   */
  readonly draftVersion?: number;
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

/** One tool of the temporary copy, and the per-call variable that routes it. */
export type MockToolVariable = {
  /** The tool's own name, as the model calls it and as a test names it. */
  readonly tool: string;
  /** The variable the platform renders per call in front of that tool's URL. */
  readonly variable: string;
};

export type MockMetadata = {
  readonly engine: MockEngineNote;
  /**
   * Which per-call variable routes which tool on the temporary copy.
   *
   * **Kept because the claim reads it.** A run's copy points every one of the
   * agent's own tools at a variable, and each call the run creates fills every
   * one of them: Egma's address for the tools that simulation's test names,
   * and the empty string for the rest, which renders to nothing and leaves the
   * customer's own URL. The test says which tools; only this says which
   * variables the agent has at all.
   *
   * Absent on a note whose run branched no copy.
   */
  readonly urlVariables?: readonly MockToolVariable[];
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
  /**
   * The conversation-flow version the platform keeps after the agent version is
   * deleted.
   *
   * **Deleting an agent version does not take its flow version with it**
   * (verified live, 2026-08-31), and no endpoint removes one: the flow can only
   * be deleted whole. The orphan is invisible in the platform's own screens and
   * unroutable, because a binding can only name a live agent version — but it
   * exists over the API. So the number is written down rather than pretended
   * away, and it is written only once the agent version's deletion is proved.
   */
  readonly strayFlowVersion?: number;
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
  const stray = row["stray_flow_version"];
  const variables = urlVariablesFrom(row["url_variables"], malformed);
  if (
    typeof engine !== "object" ||
    engine === null ||
    Array.isArray(engine) ||
    (gone !== undefined && gone !== null && typeof gone !== "boolean") ||
    (stray !== undefined && stray !== null && typeof stray !== "number")
  ) {
    throw malformed();
  }
  const held = engine as Record<string, unknown>;
  const engineVersion = held["version"];
  const print = held["tool_print"];
  const draft = held["draft_version"];
  if (
    typeof held["type"] !== "string" ||
    typeof held["engine_id"] !== "string" ||
    (engineVersion !== null && typeof engineVersion !== "number") ||
    (print !== undefined && print !== null && typeof print !== "string") ||
    (draft !== undefined && draft !== null && typeof draft !== "number")
  ) {
    throw malformed();
  }

  return {
    engine: {
      type: held["type"],
      engineId: held["engine_id"],
      version: engineVersion,
      ...(typeof print === "string" ? { toolPrint: print } : {}),
      ...(typeof draft === "number" ? { draftVersion: draft } : {}),
    },
    ...(variables === undefined ? {} : { urlVariables: variables }),
    ...(gone === true ? { temporaryVersionGone: true } : {}),
    ...(typeof stray === "number" ? { strayFlowVersion: stray } : {}),
  };
}

/**
 * The variable map a stored row holds, refused rather than repaired.
 *
 * A half-read map is worse than none: the claim would pass the variables it
 * could read and leave the rest to their defaults, so a run would mock some of
 * what its tests named and quietly reach the customer's backend for the rest.
 * So a row that does not read as a whole map is malformed, like every other
 * field here.
 */
function urlVariablesFrom(
  value: unknown,
  malformed: () => Error,
): readonly MockToolVariable[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw malformed();
  return value.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw malformed();
    }
    const held = row as Record<string, unknown>;
    if (
      typeof held["tool"] !== "string" ||
      typeof held["variable"] !== "string"
    ) {
      throw malformed();
    }
    return { tool: held["tool"], variable: held["variable"] };
  });
}

/**
 * The note as a **reader of the run** sees it: what Egma promised to put back,
 * and nothing of how it goes about it.
 *
 * Four fields are the teardown's own working notes and are dropped here. The
 * print is the whole of the serving version's tools in one line, kept so a
 * resumed teardown can still prove that version never moved; a canonicalized
 * copy of the customer's tool declarations is neither something a person can
 * act on nor something a page of runs should carry. `draftVersion`,
 * `temporaryVersionGone` and `strayFlowVersion` are bookkeeping between one
 * teardown and the next — what a reader wants to know about the copy is
 * whether the account is back, and the cleanup flag beside the note says that.
 * So the sweep's read keeps all four and the run's read drops all four, which
 * is also why the published shape of the note names none of them.
 *
 * **The variable map is the one working note this read keeps**, because the
 * claim is a reader of the run and cannot conduct a simulation without it: it
 * fills every one of those variables on every call it creates. It is not part
 * of the note's **published** shape — see `mockMetadataAsPublished` below,
 * which is what the API answers with — because a map of variable names is
 * machinery rather than anything a person can act on.
 */
export function mockMetadataAsRead(
  metadata: MockMetadata | null,
): MockMetadata | null {
  if (metadata === null) return null;
  const {
    toolPrint: _print,
    draftVersion: _draft,
    ...engine
  } = metadata.engine;
  return {
    engine,
    ...(metadata.urlVariables === undefined
      ? {}
      : { urlVariables: metadata.urlVariables }),
  };
}

/**
 * The note as the **API publishes** it: the engine capture and nothing else.
 *
 * A second projection rather than a narrower `mockMetadataAsRead`, because the
 * two readers want two different things. The claim is a reader of the run and
 * needs the variable map to conduct a simulation at all; a person reading a
 * run header wants to know which engine this run's copy was built from, and a
 * list of generated variable names is machinery to them.
 *
 * **The published shape is a contract**, and it names `engine` alone: a field
 * outside it is not a field the wire drops quietly — the response serializer
 * refuses the whole document — so the narrowing happens here, once, rather
 * than at each route that answers with a run.
 */
export function mockMetadataAsPublished(
  metadata: MockMetadata | null,
): MockMetadata | null {
  if (metadata === null) return null;
  const { urlVariables: _variables, ...published } = metadata;
  return published;
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
      // The row's own spelling, beside `engine_id`.
      ...(metadata.engine.toolPrint === undefined
        ? {}
        : { tool_print: metadata.engine.toolPrint }),
      ...(metadata.engine.draftVersion === undefined
        ? {}
        : { draft_version: metadata.engine.draftVersion }),
    },
    // The row's own spelling again. Each is written only when it is there, so a
    // note from before these facts existed reads back exactly as written.
    ...(metadata.urlVariables === undefined
      ? {}
      : {
          url_variables: metadata.urlVariables.map((one) => ({
            tool: one.tool,
            variable: one.variable,
          })),
        }),
    ...(metadata.temporaryVersionGone === true
      ? { temporary_version_gone: true }
      : {}),
    ...(metadata.strayFlowVersion === undefined
      ? {}
      : { stray_flow_version: metadata.strayFlowVersion }),
  };
}
