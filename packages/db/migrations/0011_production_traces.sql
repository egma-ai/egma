ALTER TABLE "grading_job" DROP CONSTRAINT "grading_job_source_names_its_conversation";--> statement-breakpoint
ALTER TABLE "grader" ADD COLUMN "production_sample_accumulator" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grading_job" ADD COLUMN "trace_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "grading_job" ADD COLUMN "first_span_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grading_job" ADD COLUMN "last_span_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grading_job" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grading_job" ADD COLUMN "root_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_trace_id_unique" UNIQUE("trace_id");--> statement-breakpoint
ALTER TABLE "grader" ADD CONSTRAINT "grader_production_sample_accumulator_is_a_remainder" CHECK ("grader"."production_sample_accumulator" between 0 and 99);--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_production_carries_its_trace_times" CHECK (("grading_job"."source" = 'production') = ("grading_job"."first_span_at" is not null
        and "grading_job"."last_span_at" is not null
        and "grading_job"."last_seen_at" is not null));--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_only_a_trace_closes_a_root" CHECK ("grading_job"."root_closed_at" is null or "grading_job"."source" = 'production');--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_trace_times_run_forwards" CHECK ("grading_job"."first_span_at" is null or "grading_job"."first_span_at" <= "grading_job"."last_span_at");--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_source_names_its_conversation" CHECK (case "grading_job"."source"
        when 'simulation' then "grading_job"."simulation_id" is not null and "grading_job"."trace_id" is null
        when 'production' then "grading_job"."trace_id" is not null and "grading_job"."simulation_id" is null
        else false
      end);