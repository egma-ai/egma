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

/**
 * A complete provider record within one trace, run, and provider-call group.
 * New Retell roots declare how many stable span IDs belong to the record, so a
 * root cannot make partial evidence gradeable. Older roots have no declaration
 * and retain the historical root-only behavior.
 */
export const AGENT_EVIDENCE_GROUP_COMPLETE_SQL = `countIf(${AGENT_EVIDENCE_COMPLETE_SQL}) > 0
  and (
    maxIf(
      toUInt64OrZero(JSONExtractRaw(spans.payload, 'egma_normalised', 'expected_span_count')),
      ${AGENT_EVIDENCE_COMPLETE_SQL}
    ) = 0
    or uniqExactIf(spans.span_id, spans.emitter = 'agent') >= maxIf(
      toUInt64OrZero(JSONExtractRaw(spans.payload, 'egma_normalised', 'expected_span_count')),
      ${AGENT_EVIDENCE_COMPLETE_SQL}
    )
  )`;
