ALTER TABLE "digital_human" RENAME TO "persona";--> statement-breakpoint
ALTER TABLE "digital_human_version" RENAME TO "persona_version";--> statement-breakpoint
ALTER TABLE "persona_version" RENAME COLUMN "digital_human_id" TO "persona_id";--> statement-breakpoint
-- Constraints whose definitions do not change are renamed, never recreated.
-- Renaming is what keeps the hand-written DEFERRABLE INITIALLY DEFERRED on the
-- current-version pointer (see 0003) without having to restate it here.
ALTER TABLE "persona" RENAME CONSTRAINT "digital_human_organization_id_organization_id_fk" TO "persona_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "persona" RENAME CONSTRAINT "digital_human_current_version_id_digital_human_version_id_fk" TO "persona_current_version_id_persona_version_id_fk";--> statement-breakpoint
ALTER TABLE "persona" RENAME CONSTRAINT "digital_human_created_by_user_id_fk" TO "persona_created_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "persona" RENAME CONSTRAINT "digital_human_project_organization_fk" TO "persona_project_organization_fk";--> statement-breakpoint
ALTER TABLE "persona_version" RENAME CONSTRAINT "digital_human_version_created_by_user_id_fk" TO "persona_version_created_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "persona_version" RENAME CONSTRAINT "digital_human_version_digital_human_id_version_unique" TO "persona_version_persona_id_version_unique";--> statement-breakpoint
ALTER INDEX "digital_human_organization_id_project_id_idx" RENAME TO "persona_organization_id_project_id_idx";--> statement-breakpoint
-- The id prefixes change with the name: dh_ becomes prs_ and dhv_ becomes
-- prsv_, on the rows as well as in the checks, so one prefix means one thing
-- forever. The version-to-identity foreign key must step aside while both
-- sides are rewritten (it is not deferrable); the current-version pointer's
-- deferred check simply waits for the commit, by which time both tables agree.
ALTER TABLE "persona" DROP CONSTRAINT "digital_human_id_prefix";--> statement-breakpoint
ALTER TABLE "persona_version" DROP CONSTRAINT "digital_human_version_id_prefix";--> statement-breakpoint
ALTER TABLE "persona_version" DROP CONSTRAINT "digital_human_version_digital_human_id_digital_human_id_fk";--> statement-breakpoint
UPDATE "persona" SET "id" = 'prs_' || substring("id" from 4), "current_version_id" = 'prsv_' || substring("current_version_id" from 5);--> statement-breakpoint
UPDATE "persona_version" SET "id" = 'prsv_' || substring("id" from 5), "persona_id" = 'prs_' || substring("persona_id" from 4);--> statement-breakpoint
-- The rewrites queued the pointer's deferred checks, and Postgres will not
-- ALTER a table with checks still pending. Both tables agree again, so the
-- queue can be drained here rather than at commit.
SET CONSTRAINTS "persona_current_version_id_persona_version_id_fk" IMMEDIATE;--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_persona_id_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_id_prefix" CHECK ("persona"."id" ~ '^prs_[0-9A-HJKMNP-TV-Z]{26}$');--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_id_prefix" CHECK ("persona_version"."id" ~ '^prsv_[0-9A-HJKMNP-TV-Z]{26}$');
