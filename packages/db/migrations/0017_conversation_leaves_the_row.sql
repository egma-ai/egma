-- The conversation leaves the row. A simulation's turns, tool calls and
-- measurements arrive as OpenTelemetry spans through the trace store's own
-- ingest — the door a customer's agent exports to — so a simulation is read
-- by exactly the code a production trace is read by. These three jsonb
-- columns were the interim carrier, and they are dropped before any writer
-- or reader outside egma existed, which is the cheapest this will ever be.
--
-- The row keeps what only it knows: lifecycle, ending reason, claim
-- bookkeeping, the two moments, the summary facts, the measured audio band
-- and the recording's reference.
--
-- The report check shrinks rather than being renamed: it named the three
-- columns and the two audio facts, and what is left of it is the audio
-- facts. A constraint's name is what a violation prints, so it keeps the
-- one it has.
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_report_only_when_ended";--> statement-breakpoint
ALTER TABLE "simulation" DROP COLUMN "transcript";--> statement-breakpoint
ALTER TABLE "simulation" DROP COLUMN "events";--> statement-breakpoint
ALTER TABLE "simulation" DROP COLUMN "metrics";--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_report_only_when_ended" CHECK ("simulation"."ended_at" is not null
        or ("simulation"."recording_reference" is null
          and "simulation"."measured_audio_band_hertz" is null));
