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
 * Select the requested POV when present; otherwise return all rows. Use this
 * for recordings and directly collected conversations. Retell web-call and
 * LiveKit simulation transcript readers must select agent rows explicitly,
 * including when no agent evidence is available.
 */
export function fromOnePov<Span extends { readonly pov: SpanPov }>(
  spans: readonly Span[],
  pov: SpanPov,
): readonly Span[] {
  const own = spans.filter((span) => span.pov === pov);
  return own.length === 0 ? spans : own;
}
