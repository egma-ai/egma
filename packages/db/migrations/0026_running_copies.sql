-- The `grader` table becomes the running copies: every row points at a library
-- entry, says whether it can fail a test, and carries the entry's own type.
--
-- **The graders that exist now are deleted, and that is the honest migration.**
-- Every one of them holds a type this release retires — `llm_rubric`,
-- `metric_threshold`, `tool_calls`, `phrase_match` — and none of them points at
-- a library entry, because there was no shelf when they were written. There is
-- no value `library_id` could be back-filled with: a copy is a copy *of*
-- something, and inventing an entry for each of these would be inventing a
-- definition nobody wrote. The custom-grader authoring surface is shelved with
-- this change, so nothing will write rows of that shape again either.
--
-- The product is pre-launch, so this is taken plainly rather than as an
-- expand-and-contract. What replaces them is not nothing: the boot after this
-- migration writes every project an active copy of egma's `expected_behaviors`
-- grader, so a project that had graders before has mandatory grading after —
-- and a project that had none has more grading than it had.
--
-- The junction rows go first because `test_grader.grader_id` refuses a delete
-- underneath it. The junction itself is dropped by the change that removes
-- per-test attachment; this only empties it.
DELETE FROM "test_grader";--> statement-breakpoint
-- `grading_job.regrade_grader_id` points at a grader too, and a re-grade
-- narrowed to a grader that no longer exists is a job asking for a judgment
-- nothing can make. Cleared rather than deleted: the conversation still wants
-- judging, and it is judged by whatever applies to it now.
UPDATE "grading_job" SET "regrade_grader_id" = NULL WHERE "regrade_grader_id" IS NOT NULL;--> statement-breakpoint
-- The versions go with them, by their own cascade.
DELETE FROM "grader";--> statement-breakpoint
ALTER TABLE "grader" DROP CONSTRAINT "grader_type_allowed";--> statement-breakpoint
ALTER TABLE "grader" ADD COLUMN "library_id" text COLLATE "C" NOT NULL;--> statement-breakpoint
ALTER TABLE "grader" ADD COLUMN "required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- `restrict`, never `set null` and never `cascade`. A copy reads its definition
-- through this pointer every time it judges, so an entry deleted underneath one
-- would leave a grader that judges nothing while still appearing on screen —
-- and a cascade would delete judging somebody set up without them asking.
ALTER TABLE "grader" ADD CONSTRAINT "grader_library_id_grader_library_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."grader_library"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grader_library_id_idx" ON "grader" USING btree ("library_id");--> statement-breakpoint
-- The shelf's own two words, so a copy can only ever hold a type it was copied
-- from. The reserved three are refused here exactly as they are up there.
ALTER TABLE "grader" ADD CONSTRAINT "grader_type_allowed" CHECK ("grader"."type" in ('llm_as_judge', 'code'));
