-- Move `type` into the immutable version. The version immutability trigger has
-- to stand aside only for this one migration backfill; it is restored before
-- the migration ends. The stable-definition type trigger leaves permanently
-- with the column it protected.
DROP TRIGGER "grader_definition_type_is_immutable" ON "grader_definition";
--> statement-breakpoint
DROP FUNCTION guard_grader_definition_type_immutable();
--> statement-breakpoint
DROP TRIGGER "grader_definition_version_is_immutable" ON "grader_definition_version";
--> statement-breakpoint
DROP FUNCTION guard_grader_definition_version_immutable();
--> statement-breakpoint

ALTER TABLE "grader_definition" DROP CONSTRAINT "grader_definition_type_allowed";
--> statement-breakpoint
ALTER TABLE "grader_definition" DROP CONSTRAINT "grader_definition_tenancy_is_whole_or_egmas";
--> statement-breakpoint
ALTER TABLE "grader_definition_version" DROP CONSTRAINT "grader_definition_version_source_code_columns_agree";
--> statement-breakpoint
ALTER TABLE "grader_definition" DROP CONSTRAINT "grader_definition_project_organization_fk";
--> statement-breakpoint
DROP INDEX "grader_definition_organization_id_project_id_idx";
--> statement-breakpoint

ALTER TABLE "grader_definition_version" ADD COLUMN "type" text;
--> statement-breakpoint
UPDATE "grader_definition_version" AS version
SET "type" = definition."type"
FROM "grader_definition" AS definition
WHERE definition."id" = version."definition_id";
--> statement-breakpoint
ALTER TABLE "grader_definition_version" ALTER COLUMN "type" SET NOT NULL;
--> statement-breakpoint

-- Before this release no active grader has configurable settings. Existing
-- project rows therefore receive the complete empty value object. The column
-- has no lasting default: every later write must supply values explicitly.
ALTER TABLE "project_grader" ADD COLUMN "parameter_values" jsonb DEFAULT '{}'::jsonb;
--> statement-breakpoint
UPDATE "project_grader" SET "parameter_values" = '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "project_grader" ALTER COLUMN "parameter_values" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_grader" ALTER COLUMN "parameter_values" DROP DEFAULT;
--> statement-breakpoint

CREATE INDEX "grader_definition_organization_id_idx" ON "grader_definition" USING btree ("organization_id");
--> statement-breakpoint
ALTER TABLE "grader_definition" DROP COLUMN "project_id";
--> statement-breakpoint
ALTER TABLE "grader_definition" DROP COLUMN "type";
--> statement-breakpoint
ALTER TABLE "grader_definition_version" DROP COLUMN "source_code";
--> statement-breakpoint
ALTER TABLE "grader_definition_version" DROP COLUMN "source_code_language";
--> statement-breakpoint
ALTER TABLE "grader_definition_version" ADD CONSTRAINT "grader_definition_version_type_allowed" CHECK ("grader_definition_version"."type" in ('llm_as_judge', 'code'));
--> statement-breakpoint

CREATE FUNCTION guard_grader_definition_version_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'grader definition versions are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER grader_definition_version_is_immutable
BEFORE UPDATE ON "grader_definition_version"
FOR EACH ROW EXECUTE FUNCTION guard_grader_definition_version_immutable();
