/**
 * A platform's final agent record, independent of simulation lifecycle.
 * Filing clears ends_trace so provider spans cannot end or grade a simulation
 * themselves. These predicates read the recognized root that the normalizers
 * stored, including Retell's original end timestamp and degraded marker.
 */
export const AGENT_EVIDENCE_INCOMPLETE_SQL = `spans.emitter = 'agent'
  and JSONExtractBool(spans.payload, 'egma_normalised', 'degraded') = 1`;

export const AGENT_EVIDENCE_COMPLETE_SQL = `spans.emitter = 'agent' and (
  (spans.agent_platform = 'livekit' and spans.kind = 'root' and spans.name = 'agent_session')
  or (spans.agent_platform = 'retell' and spans.kind = 'conversation' and spans.name = 'retell_call'
    and JSONExtractRaw(spans.payload, 'end_timestamp') not in ('', 'null')
    and isFinite(toFloat64OrNull(JSONExtractRaw(spans.payload, 'end_timestamp')))
    and JSONExtractBool(spans.payload, 'egma_normalised', 'degraded') = 0)
)`;
