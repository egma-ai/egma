ALTER TABLE "simulation" ADD COLUMN "failure_detail" text;--> statement-breakpoint
ALTER TABLE "simulation" ADD COLUMN "recording_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_failure_detail_agrees" CHECK ("simulation"."failure_detail" is null or "simulation"."status" = 'failed');--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_recording_origin_agrees" CHECK ("simulation"."recording_started_at" is null
        or ("simulation"."ended_at" is not null
          and "simulation"."modality" = 'voice'
          and "simulation"."recording_reference" is not null));