-- One more way to reach an agent: a LiveKit room the agent joins.
--
-- Two constraints rather than one, because the list of connection types is one
-- list in the schema and two CHECKs read it — what a connection may be, and
-- what a simulation may record it as. Widening only the first would let a
-- livekit connection be stored and then refuse every run over it, which is a
-- disagreement between two copies of one fact and exactly what deriving both
-- from one list exists to prevent.
--
-- Postgres has no "add a value" for a CHECK, so each is dropped and written
-- again. Both are widenings: every row that satisfied the old constraint
-- satisfies the new one, so no table is rewritten and the scan each new
-- constraint costs can only pass.
ALTER TABLE "connection" DROP CONSTRAINT "connection_type_allowed";--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_connection_type_allowed";--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_type_allowed" CHECK ("connection"."type" in ('retell', 'phone', 'livekit'));--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_connection_type_allowed" CHECK ("simulation"."connection_type" in ('retell', 'phone', 'livekit'));
