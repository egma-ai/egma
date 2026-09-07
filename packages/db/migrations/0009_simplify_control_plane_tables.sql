-- Destructive pre-launch cutover; see README.md, "Before launch".
-- Organization settings keep their values and independent edit timestamp.
-- Run-start receipts are intentionally removed: every accepted start now
-- creates a new run. Existing runs and their evidence are unchanged.
ALTER TABLE "organization" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "data_residency" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "settings_updated_at" timestamp with time zone;--> statement-breakpoint
UPDATE "organization" AS target
SET "retention_days" = source."retention_days",
    "data_residency" = source."data_residency",
    "settings_updated_at" = source."updated_at"
FROM "organization_settings" AS source
WHERE target."id" = source."organization_id";--> statement-breakpoint
DROP TABLE "organization_settings";--> statement-breakpoint
DROP TABLE "idempotent_operation";
