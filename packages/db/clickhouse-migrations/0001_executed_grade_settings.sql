-- Before launch: old results and production selections do not contain complete
-- model settings. Clear these disposable records while all writers are stopped.
-- Every statement can run again if the migration is interrupted.
TRUNCATE TABLE IF EXISTS grades;
--> statement-breakpoint
TRUNCATE TABLE IF EXISTS production_grading_plans;
--> statement-breakpoint
ALTER TABLE grades ADD COLUMN IF NOT EXISTS parameter_values String;
