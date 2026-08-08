ALTER TABLE "grading_job" ADD COLUMN "regrade_grader_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_regrade_grader_id_grader_id_fk" FOREIGN KEY ("regrade_grader_id") REFERENCES "public"."grader"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_only_outstanding_work_is_narrowed" CHECK ("grading_job"."regrade_grader_id" is null
        or "grading_job"."status" in ('pending', 'claimed'));