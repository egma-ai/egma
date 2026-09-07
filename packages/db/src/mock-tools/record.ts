/**
 * Durable recovery state for a temporary Retell agent version: serving engine
 * identity and tool fingerprint, per-tool routing variables, and cleanup progress.
 * The build verifies the serving tools and may repair unexpected mutation using
 * its in-memory capture. Resumed cleanup has only the fingerprint, so it reports
 * a mismatch instead of attempting repair. Number bindings are not changed.
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
   * Canonical serving-tool fingerprint for verification and resumed cleanup.
   * A resumed cleanup cannot repair a mismatch because this record has no full engine
   * config. Optional for older records or builds that did not reach engine capture.
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
   * Tool-to-variable map used to fill every temporary-version URL override per
   * simulation. Covered tools receive Egma's mock endpoint; other tools retain
   * the original backend URL. Optional when no routing map was created.
   */
  readonly urlVariables?: readonly MockToolVariable[];
  /**
   * Set only after the version listing proves deletion. Resumed cleanup must not
   * delete the same version number again because Retell may reuse it. This mutable
   * note preserves that fact after the run header freezes.
   */
  readonly temporaryVersionGone?: boolean;
  /**
   * Conversation-flow version left after verified agent-version deletion. Live checks
   * on 2026-08-31 found that deleting the agent version retained this flow version;
   * no individual flow-version delete was available. Record it for cleanup visibility.
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
 * Internal run projection: remove toolPrint, draftVersion, temporaryVersionGone,
 * and strayFlowVersion. Keep urlVariables for simulation claim assembly.
 * Cleanup reads use the full stored record.
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
 * Remove urlVariables from an already reduced run projection for API publication.
 * Call after mockMetadataAsRead; this function alone does not remove cleanup fields.
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
