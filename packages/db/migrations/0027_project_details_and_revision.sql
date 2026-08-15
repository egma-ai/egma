-- A project gains a description somebody wrote, and the revision an edit to it
-- has to name.
--
-- **The generated body for the revision is `ADD COLUMN … NOT NULL`, and that
-- statement fails on every deployment that already holds a project** — which is
-- all of them, because signup provisions one. So the column is added nullable,
-- every installed row is given a revision, and only then is the column made
-- required and the format checked. The snapshot beside this file is drizzle's
-- own and is untouched; what is authored here is the order, which drizzle never
-- reads and cannot diff against.
--
-- The description needs none of that: it is nullable by design, and a project
-- nobody has described yet is undescribed rather than described as nothing.

ALTER TABLE "project" ADD COLUMN "description" text;--> statement-breakpoint

ALTER TABLE "project" ADD COLUMN "revision" text COLLATE "C";--> statement-breakpoint
-- A revision in egma's own format, worked out from the row rather than from a
-- clock. Uppercase hexadecimal is a subset of the Crockford alphabet the check
-- below names, so these pass the same pattern a minted identifier does. Any
-- value satisfying the format would do: a revision means "the state you read",
-- and nobody has read one of these yet.
--
-- Written inline rather than through a helper function, because migrations
-- share one connection on boot and a `pg_temp` function of the same name
-- created by an earlier file is still there when this one runs.
UPDATE "project" SET "revision" = 'rev_' || upper(substr(md5('project:' || "id"), 1, 26)) WHERE "revision" IS NULL;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_revision_prefix" CHECK ("project"."revision" ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$');
