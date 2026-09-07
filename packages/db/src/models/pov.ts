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
 * A simulation stores both POVs of the same conversation under one trace — the
 * persona's and the agent's — and they describe the same turns and the same
 * calls. So every reader that shows, counts or judges them has to choose one,
 * and they all have to choose the same way or one surface will say a
 * thirteen-turn conversation had twenty-six while another says thirteen. This
 * is that rule, in one place: the run view, the grader, the recording's speaker
 * bands and the trace facts all read through it.
 *
 * **Falling back to every row is the whole of what makes it safe.** A chat
 * simulation, a production transcript, a platform that reports nothing of its
 * own and a conversation whose agent never reached egma each hold one POV, and
 * it is the one to show — asking for a POV that is not there must never empty a
 * transcript.
 */
export function fromOnePov<Span extends { readonly pov: SpanPov }>(
  spans: readonly Span[],
  pov: SpanPov,
): readonly Span[] {
  const own = spans.filter((span) => span.pov === pov);
  return own.length === 0 ? spans : own;
}
