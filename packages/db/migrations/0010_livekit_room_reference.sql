-- The room must be registered before its agent can export telemetry. Keep
-- transcript counts terminal-only; the provider reference may exist once
-- a simulation is claimed. Existing rows satisfy both replacement checks.
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_summary_facts_only_when_ended";
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_summary_facts_only_when_ended"
  CHECK ("ended_at" IS NOT NULL OR "turn_count" IS NULL);
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_provider_reference_after_claim"
  CHECK ("status" <> 'queued' OR "provider_reference" IS NULL);
