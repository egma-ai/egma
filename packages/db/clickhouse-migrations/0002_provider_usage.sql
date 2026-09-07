-- Price facts stay on their spans. A conflict survives merges instead of
-- replacing a bill with different evidence. Exact replays still group by the
-- full organization/project/trace/span identity when money is summed.
ALTER TABLE spans
 ADD COLUMN IF NOT EXISTS usage_identity_hash String,
 ADD COLUMN IF NOT EXISTS usage_received_at DateTime64(6, 'UTC'),
 ADD COLUMN IF NOT EXISTS usage_occurred_at DateTime64(6, 'UTC'),
 ADD COLUMN IF NOT EXISTS usage_provider LowCardinality(String),
 ADD COLUMN IF NOT EXISTS usage_model LowCardinality(String),
 ADD COLUMN IF NOT EXISTS usage_operation LowCardinality(String),
 ADD COLUMN IF NOT EXISTS usage_payment_source LowCardinality(String),
 ADD COLUMN IF NOT EXISTS usage_measurement LowCardinality(String),
 ADD COLUMN IF NOT EXISTS usage_provider_ref String,
 ADD COLUMN IF NOT EXISTS usage_credential_ref String,
 ADD COLUMN IF NOT EXISTS usage_unit LowCardinality(String),
 ADD COLUMN IF NOT EXISTS usage_quantities Map(String, Float64),
 ADD COLUMN IF NOT EXISTS usage_priced_by Map(String, String),
 ADD COLUMN IF NOT EXISTS usage_amount_micros UInt64,
 ADD COLUMN IF NOT EXISTS usage_evidence String,
 MODIFY ORDER BY (organization_id, project_id, trace_id, span_id, usage_identity_hash, usage_received_at)
;
