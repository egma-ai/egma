ALTER TABLE "persona" RENAME COLUMN "deleted_at" TO "archived_at";--> statement-breakpoint
DROP INDEX IF EXISTS "persona_organization_id_project_id_idx";--> statement-breakpoint
ALTER TABLE "persona" ADD COLUMN "revision" text;--> statement-breakpoint
UPDATE "persona" SET "revision" = md5(random()::text || clock_timestamp()::text || "id") WHERE "revision" IS NULL;--> statement-breakpoint
ALTER TABLE "persona" ALTER COLUMN "revision" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "persona_organization_id_project_id_idx" ON "persona" USING btree ("organization_id","project_id") WHERE "persona"."archived_at" is null;
