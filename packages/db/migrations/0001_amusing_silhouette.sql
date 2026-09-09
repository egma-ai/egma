ALTER TABLE "grading_job" DROP CONSTRAINT "grading_job_entries_are_a_nonempty_list";--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_entries_are_a_nonempty_list" CHECK (jsonb_typeof("grading_job"."entries") = 'array'
        and (jsonb_array_length("grading_job"."entries") > 0
          or ("grading_job"."status" = 'abandoned' and "grading_job"."attempts" = 0
            and "grading_job"."last_error" = 'simulator_evidence_delivery_error')));
