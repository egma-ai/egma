export const USAGE_IDENTITIES = `SELECT organization_id, project_id, trace_id, span_id,
  uniqExact(usage_identity_hash) AS variants,
  any(usage_amount_micros) AS amount, any(usage_payment_source) AS payment_source,
  any(usage_occurred_at) AS occurred_at,
  any(usage_provider) AS provider, any(usage_model) AS model, any(usage_unit) AS unit,
  any(usage_quantities) AS quantities
 FROM spans WHERE organization_id = {org:String} AND usage_identity_hash != ''
 GROUP BY organization_id, project_id, trace_id, span_id`;
