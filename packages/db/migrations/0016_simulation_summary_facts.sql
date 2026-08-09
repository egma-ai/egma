-- Two summary facts the report's terminal events carry onto the simulation
-- row: how many transcript turns the conversation reached, and the platform's
-- own identifier for the exchange — each read alone to answer for one
-- simulation, which is what puts them in Postgres rather than beside the
-- conversation data. Nullable both, because every row written before this
-- migration landed no such facts, and a report may honestly carry none.
ALTER TABLE "simulation" ADD COLUMN "turn_count" integer;--> statement-breakpoint
ALTER TABLE "simulation" ADD COLUMN "provider_reference" text;--> statement-breakpoint
-- Terminal facts, like the report columns beside them — a check of their own
-- rather than a rewrite of the report's, because an additive column takes an
-- additive guard.
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_summary_facts_only_when_ended" CHECK ("simulation"."ended_at" is not null
        or ("simulation"."turn_count" is null and "simulation"."provider_reference" is null));--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_turn_count_is_a_count" CHECK ("simulation"."turn_count" is null or "simulation"."turn_count" >= 0);
