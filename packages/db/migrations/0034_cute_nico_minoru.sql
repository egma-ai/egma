ALTER TABLE "simulation" DROP CONSTRAINT "simulation_audio_band_is_a_rate";--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_report_only_when_ended";--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_audio_facts_are_voice_facts";--> statement-breakpoint
ALTER TABLE "simulation" DROP COLUMN "measured_audio_band_hertz";--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_report_only_when_ended" CHECK ("simulation"."ended_at" is not null or "simulation"."recording_reference" is null);--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_audio_facts_are_voice_facts" CHECK ("simulation"."modality" = 'voice' or "simulation"."recording_reference" is null);