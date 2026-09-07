/**
 * Whose POV a piece of evidence is, and the one rule for reading one POV of a
 * conversation that holds two.
 *
 * Pure functions over rows already read — no store, no tenancy — which is why
 * they live beside the models rather than on the data-access surface, whose
 * every export must carry an `AuthContext`.
 */

/**
 * Whose POV a piece of evidence is: the persona's or the agent's.
 *
 * The product word. `emitter` is the storage column that carries it and never
 * reaches a screen — `egma-runtime` there is `persona` here.
 */
export type SpanPov = "persona" | "agent";

/** The storage word for the agent's own POV, read as the product word. */
export function povOf(emitter: string): SpanPov {
  return emitter === "agent" ? "agent" : "persona";
}

/**
 * **One conversation, told once**: the rows of one POV where the record holds
 * any, and every row where it holds none.
 *
 * This compatibility selection is for recordings and lanes that collect the
 * conversation directly. Retell web-call and LiveKit simulation transcripts
 * require agent rows explicitly: those readers must filter by POV even when
 * that leaves no evidence. A missing platform record must not be replaced by
 * the simulator's record.
 */
export function fromOnePov<Span extends { readonly pov: SpanPov }>(
  spans: readonly Span[],
  pov: SpanPov,
): readonly Span[] {
  const own = spans.filter((span) => span.pov === pov);
  return own.length === 0 ? spans : own;
}
