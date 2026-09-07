-- Register the room before agent telemetry can arrive. Turn counts remain
-- terminal facts; an unclaimed simulation still carries no provider reference.
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_summary_facts_only_when_ended";--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_provider_reference_after_claim" CHECK ("simulation"."status" <> 'queued' or "simulation"."provider_reference" is null);--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_summary_facts_only_when_ended" CHECK ("simulation"."ended_at" is not null
        or "simulation"."turn_count" is null);
