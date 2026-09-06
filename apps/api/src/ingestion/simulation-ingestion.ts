import type { NewSpan, SimulationStanding, SpanEmitter } from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";

import { WIRE_TRACE_ID_PAYLOAD_KEY, type SpanAttribution } from "../otlp/normalise.ts";
import {
  acceptEvidenceForProjects,
  type Acceptance,
  type EvidenceGroup,
} from "./accept.ts";

/**
 * **Simulation ingestion: the one filing step.**
 *
 * Three sources produce a simulation's evidence and there is one step that
 * files all three, because ADR-0015 §2 says so in one sentence: *a
 * project-authenticated export that names a simulation by its provider
 * reference is filed under that simulation's trace id, `source = simulation`,
 * `emitter = agent`, with the run and version pins.* The sources are
 *
 * - **egma's own simulator**, posting the persona's POV with the deployment's
 *   service token and naming its simulation by id (`emitter = egma-runtime`);
 * - **the customer's agent**, pushing its own POV with a project API key and
 *   naming its simulation by provider reference (`emitter = agent`);
 * - **the Retell pull**, where no agent exports anything and egma fetches the
 *   call record itself the moment the simulation ends (`emitter = agent`).
 *
 * They differ in who authenticates, how the simulation is found, and what
 * normalises the bytes. They agree on everything after that, and everything
 * after that is here. Pipecat and Vapi arrive as one more resolver and one more
 * normaliser each, and touch nothing in this file.
 *
 * ## What the step does, and why each part of it is not the caller's business
 *
 * **It stamps the attribution from egma's own row.** `source`, `emitter`, the
 * run, the agent and the two version pins are facts about the conversation that
 * only the control plane holds, and a payload that stated any of them would be
 * stating them about somebody else's run. The caller hands over the standing it
 * resolved; nothing here reads the evidence to decide whose it is.
 *
 * **It files under the simulation's own trace id.** One conversation is one
 * trace: the persona's POV and the agent's POV sit in it together, and a reader
 * opening a simulation converts its id into that trace and finds both. The
 * exporter's own trace id is kept on each span's payload, so LiveKit's tooling
 * is still reachable from what egma stored. Span ids are never touched — a
 * span's identity is `(organization, project, trace, span)` and the span half
 * of it is the emitter's to mint.
 *
 * **It accepts through the same acceptance module every other write uses**
 * (ADR-0014). There is no second path to durability, so a simulation's evidence
 * gets the same write-ahead log, the same segment, the same object store and
 * the same *not yet* refusal as a customer's production traffic.
 *
 * **It never inspects the simulation's state.** Evidence for a known simulation
 * is filed whatever its standing — a POV arriving after the sweep called the
 * conversation orphaned is still that conversation's evidence, and the service
 * path has kept late evidence on that reasoning since it was written.
 *
 * ## What the step does not do
 *
 * It does not resolve the simulation and it does not normalise. Both differ per
 * source and both are refusals a caller has to answer in its own vocabulary: an
 * OTLP door answers `google.rpc.Status`, the poller answers its own log. A step
 * that swallowed either would be deciding how a refusal reads for a caller it
 * cannot see.
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
 * The stamp one simulation's spans carry, off egma's own row and off nothing
 * the wire said.
 *
 * Exported because the OTLP paths hand it to the normaliser rather than
 * applying it afterwards: `connectionType` is only read off a resource when the
 * source is already known to be a simulation, so the normaliser has to be told
 * before it builds the row. `filedUnderSimulation` applies the same stamp again
 * on the way past, which makes the two orders agree by construction and lets a
 * source with no OTLP normaliser — the Retell pull — hand over rows that say
 * `production` and still be filed correctly.
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
 * The framework's trace id, kept at the top of a span's payload before egma
 * files the span under the simulation's trace instead.
 *
 * Written by prepending rather than by parsing: a payload is the provider's own
 * document, sometimes megabytes of it, and a round trip through `JSON.parse`
 * would re-key and re-space every object inside it — which is precisely the
 * "kept byte for byte" promise the store makes. The key is egma's own and
 * egma's alone, so prepending cannot shadow a field the sender meant.
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
 * File one or more simulations' evidence, and answer when it is durable.
 *
 * `alongside` is whatever else the same request carried that is already
 * attributed — the production resources of an export that also held a
 * simulation's. It rides the same call so the answer is one answer: a request
 * is a success only when everything it carried is durable, and a per-group
 * reply would tell a sender its whole flush landed while part of it sat in a
 * local log.
 */
export function fileSimulationEvidence(
  filings: readonly SimulationFiling[],
  alongside: readonly EvidenceGroup[] = [],
): Promise<Acceptance> {
  const groups: EvidenceGroup[] = [...alongside];

  for (const filing of filings) {
    const spans = filedUnderSimulation(filing);
    if (spans === undefined || spans.length === 0) continue;
    groups.push({ auth: filing.standing.auth, spans });
  }

  return acceptEvidenceForProjects(groups);
}
