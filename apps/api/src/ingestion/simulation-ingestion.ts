import { priceUsageSpans, type NewSpan, type SimulationStanding, type SpanEmitter } from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";

import { WIRE_TRACE_ID_PAYLOAD_KEY, type SpanAttribution } from "../otlp/normalise.ts";
import {
  acceptEvidenceForProjects,
  type Acceptance,
  type EvidenceGroup,
} from "@egma/ingestion";

/**
 * File simulator, agent-export, and Retell-pull evidence under the simulation
 * trace ID. Callers authenticate, resolve the simulation, and normalize spans.
 * This module applies stored run/agent/version attribution and the supplied
 * agent or persona POV, retaining span IDs and original wire trace IDs.
 * Accept through the shared durable-ingestion path, including late evidence
 * for terminal simulations. Completion comes from the simulation lifecycle.
 */

/** One simulation's evidence, resolved and normalised, ready to be filed. */
export type SimulationFiling = {
  /** The simulation this evidence is of, as egma's own row answered it. */
  readonly standing: SimulationStanding;
  /**
   * Whose POV this is. `egma-runtime` for the persona's — what egma's simulator
   * said, heard and measured; `agent` for the agent's own account of the same
   * conversation.
   */
  readonly emitter: SpanEmitter;
  /**
   * The spans, normalised, with the trace id they arrived under. Filing
   * rewrites that id and keeps the original on the payload.
   */
  readonly spans: readonly NewSpan[];
};

/**
 * Build simulation attribution from resolved storage state and the supplied
 * POV. OTLP normalization uses it before building spans; final filing applies
 * it again for all sources, including Retell pulls.
 */
export function attributionOf(
  standing: SimulationStanding,
  emitter: SpanEmitter,
): SpanAttribution {
  return {
    source: "simulation",
    emitter,
    runId: standing.runId,
    agentId: standing.agentId,
    testVersionId: standing.testVersionId,
    personaVersionId: standing.personaVersionId,
  };
}

/**
 * Prepend the original trace ID to a normalized object payload without
 * parsing and reserializing its existing fields. Callers provide the payload
 * shape and must reserve WIRE_TRACE_ID_PAYLOAD_KEY.
 */
function withWireTraceId(payload: string, wireTraceId: string): string {
  const opened = payload.indexOf("{");
  // A payload that is not a JSON object is nothing this can add a key to. No
  // normaliser writes one, and inventing a wrapper around it would change the
  // provider's document, which is the one thing storage promises not to do.
  if (opened === -1) return payload;

  const entry = `${JSON.stringify(WIRE_TRACE_ID_PAYLOAD_KEY)}:${JSON.stringify(wireTraceId)}`;
  const rest = payload.slice(opened + 1);
  // `{}` takes the key with no comma after it; anything else has a first field
  // for the comma to separate this one from.
  return rest.trimStart().startsWith("}")
    ? `${payload.slice(0, opened)}{${entry}${rest}`
    : `${payload.slice(0, opened)}{${entry},${rest}`;
}

/**
 * One filing's spans, stamped and moved under the simulation's trace.
 *
 * `undefined` for a standing whose id spells no trace — unreachable for a row
 * egma minted, and answered rather than digested for the same reason
 * `traceIdOfSimulation` answers that way: a made-up trace id sends a reader
 * looking for evidence that was never filed under it.
 */
export function filedUnderSimulation(
  filing: SimulationFiling,
): readonly NewSpan[] | undefined {
  const traceId = traceIdOfSimulation(filing.standing.id);
  if (traceId === undefined) return undefined;

  const attribution = attributionOf(filing.standing, filing.emitter);
  return filing.spans.map((span) => ({
    ...span,
    ...attribution,
    traceId,
    /*
     * Simulation completion comes from its lifecycle report, not a platform
     * root span. Clear the production completion marker for every simulation POV.
     */
    endsTrace: false,
    // Only where the two genuinely differ. egma's own simulator already files
    // under the derived id, and adding a key that repeated it would put noise
    // on every span of every run for nothing.
    payload:
      span.traceId === traceId
        ? span.payload
        : withWireTraceId(span.payload, span.traceId),
  }));
}

/**
 * Accept simulation filings and already-attributed alongside groups in one
 * call. Successful acceptance requires all non-rejected records to be durable.
 */
export async function fileSimulationEvidence(
  filings: readonly SimulationFiling[],
  alongside: readonly EvidenceGroup[] = [],
): Promise<Acceptance> {
  const groups: EvidenceGroup[] = [...alongside];

  for (const filing of filings) {
    let spans = filedUnderSimulation(filing);
    if (spans === undefined || spans.length === 0) continue;
    try {
      spans = await priceUsageSpans(filing.standing.auth, spans);
    } catch (cause) {
      console.error("usage pricing is unavailable; accepted raw evidence will be priced during draining", cause);
    }
    groups.push({ auth: filing.standing.auth, spans });
  }

  return acceptEvidenceForProjects(groups);
}
