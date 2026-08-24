-- Pre-launch forward cutover. Old run plans point at the retired project
-- grader-version rows and cannot be translated honestly. Remove their control
-- records before the old model leaves. Projects, suites, tests, personas,
-- agents, connections, agent-owned monitoring state, and grader-independent
-- configuration remain.
DELETE FROM "idempotent_operation" WHERE "operation" = 'start_run';
--> statement-breakpoint
DELETE FROM "grading_job";
--> statement-breakpoint
DELETE FROM "run";
--> statement-breakpoint

CREATE TABLE "grader_definition" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C",
	"project_id" text COLLATE "C",
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"scope_editable" boolean NOT NULL,
	"current_definition_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grader_definition_id_prefix" CHECK ("grader_definition"."id" ~ '^grl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "grader_definition_type_allowed" CHECK ("grader_definition"."type" in ('llm_as_judge', 'code')),
	CONSTRAINT "grader_definition_tenancy_is_whole_or_egmas" CHECK (("grader_definition"."organization_id" is null) = ("grader_definition"."project_id" is null))
);
--> statement-breakpoint
CREATE TABLE "grader_definition_version" (
	"definition_id" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"prompt" text,
	"parameter_contract" jsonb NOT NULL,
	"output_contract" jsonb,
	"source_code" text,
	"source_code_language" text,
	"modalities" jsonb NOT NULL,
	"judge_model" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grader_definition_version_definition_id_version_pk" PRIMARY KEY("definition_id","version"),
	CONSTRAINT "grader_definition_version_definition_id_prefix" CHECK ("grader_definition_version"."definition_id" ~ '^grl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "grader_definition_version_version_is_positive" CHECK ("grader_definition_version"."version" >= 1),
	CONSTRAINT "grader_definition_version_modalities_allowed" CHECK ("grader_definition_version"."modalities" in (
        '["chat"]'::jsonb,
        '["voice"]'::jsonb,
        '["chat", "voice"]'::jsonb,
        '["voice", "chat"]'::jsonb
      )),
	CONSTRAINT "grader_definition_version_source_code_columns_agree" CHECK (("grader_definition_version"."source_code" is null) = ("grader_definition_version"."source_code_language" is null))
);
--> statement-breakpoint
CREATE TABLE "project_grader" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"grader_definition_id" text COLLATE "C" NOT NULL,
	"scope" jsonb NOT NULL,
	"pass_threshold" double precision NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_grader_id_prefix" CHECK ("project_grader"."id" ~ '^grd_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "project_grader_scope_is_closed_object" CHECK (jsonb_typeof("project_grader"."scope") is not distinct from 'object'
        and ("project_grader"."scope" - array['simulations', 'production']::text[])
          is not distinct from '{}'::jsonb
        and "project_grader"."scope" ?& array['simulations', 'production']::text[]
        and jsonb_typeof("project_grader"."scope"->'simulations') is not distinct from 'array'
        and (
          "project_grader"."scope"->'production' = 'null'::jsonb
          or jsonb_typeof("project_grader"."scope"->'production') is not distinct from 'object'
        )),
	CONSTRAINT "project_grader_pass_threshold_is_normalized" CHECK ("project_grader"."pass_threshold" between 0 and 1)
);
--> statement-breakpoint
ALTER TABLE "grading_job" DROP CONSTRAINT "grading_job_regrade_grader_id_grader_id_fk";--> statement-breakpoint
ALTER TABLE "grader" DROP CONSTRAINT "grader_current_version_id_grader_version_id_fk";--> statement-breakpoint
ALTER TABLE "grader_library" DROP CONSTRAINT "grader_library_current_version_fk";--> statement-breakpoint
DROP TABLE "grader_version";--> statement-breakpoint
DROP TABLE "grader";--> statement-breakpoint
DROP TABLE "grader_library_version";--> statement-breakpoint
DROP TABLE "grader_library";--> statement-breakpoint
DROP FUNCTION guard_grader_library_version_immutable();--> statement-breakpoint
DROP FUNCTION guard_grader_library_type_immutable();--> statement-breakpoint
DROP FUNCTION guard_grader_version_judge_model();--> statement-breakpoint
DROP FUNCTION guard_grader_version_semantics_immutable();--> statement-breakpoint
ALTER TABLE "run_event" DROP CONSTRAINT "run_event_verdict_allowed";--> statement-breakpoint
ALTER TABLE "run_event" DROP CONSTRAINT "run_event_verdict_agrees";--> statement-breakpoint
ALTER TABLE "run_event" DROP CONSTRAINT "run_event_run_shape";--> statement-breakpoint
ALTER TABLE "grading_job" DROP CONSTRAINT "grading_job_source_names_its_conversation";--> statement-breakpoint
ALTER TABLE "grading_job" DROP CONSTRAINT "grading_job_production_carries_its_trace_times";--> statement-breakpoint
ALTER TABLE "grading_job" DROP CONSTRAINT "grading_job_only_a_trace_closes_a_root";--> statement-breakpoint
ALTER TABLE "grading_job" DROP CONSTRAINT "grading_job_trace_times_run_forwards";--> statement-breakpoint
ALTER TABLE "grading_job" DROP CONSTRAINT "grading_job_finished_is_terminal";--> statement-breakpoint
ALTER TABLE "grading_job" DROP CONSTRAINT "grading_job_only_outstanding_work_is_narrowed";--> statement-breakpoint
ALTER TABLE "grading_job" DROP CONSTRAINT "grading_job_status_allowed";--> statement-breakpoint
ALTER TABLE "grading_job" ALTER COLUMN "trace_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "grading_job" ALTER COLUMN "trace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "grading_job" ADD COLUMN "trace_started_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "grading_job" ADD COLUMN "run_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "grading_job" ADD COLUMN "entries" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "grading_job" ADD COLUMN "sequence_base" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grader_definition" ADD CONSTRAINT "grader_definition_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grader_definition" ADD CONSTRAINT "grader_definition_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A definition and its first version are born in one transaction. The two rows
-- point at each other, so this check waits until commit; the reverse FK remains
-- immediate. The database still refuses a committed dangling current-version
-- pointer.
ALTER TABLE "grader_definition" ADD CONSTRAINT "grader_definition_current_version_fk" FOREIGN KEY ("id","current_definition_version") REFERENCES "public"."grader_definition_version"("definition_id","version") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "grader_definition_version" ADD CONSTRAINT "grader_definition_version_definition_id_grader_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."grader_definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grader" ADD CONSTRAINT "project_grader_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grader" ADD CONSTRAINT "project_grader_grader_definition_id_grader_definition_id_fk" FOREIGN KEY ("grader_definition_id") REFERENCES "public"."grader_definition"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grader" ADD CONSTRAINT "project_grader_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grader_definition_predefined_name_unique" ON "grader_definition" USING btree ("name") WHERE "grader_definition"."organization_id" is null;--> statement-breakpoint
CREATE INDEX "grader_definition_organization_id_project_id_idx" ON "grader_definition" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_grader_active_definition_unique" ON "project_grader" USING btree ("project_id","grader_definition_id") WHERE "project_grader"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "project_grader_organization_id_project_id_idx" ON "project_grader" USING btree ("organization_id","project_id") WHERE "project_grader"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "project_grader_definition_id_idx" ON "project_grader" USING btree ("grader_definition_id");--> statement-breakpoint
CREATE FUNCTION guard_grader_definition_type_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type IS DISTINCT FROM OLD.type THEN
    RAISE EXCEPTION 'grader definition type is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER grader_definition_type_is_immutable
BEFORE UPDATE ON "grader_definition"
FOR EACH ROW EXECUTE FUNCTION guard_grader_definition_type_immutable();--> statement-breakpoint
CREATE FUNCTION guard_grader_definition_version_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'grader definition versions are immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER grader_definition_version_is_immutable
BEFORE UPDATE ON "grader_definition_version"
FOR EACH ROW EXECUTE FUNCTION guard_grader_definition_version_immutable();--> statement-breakpoint
ALTER TABLE "run_event" DROP COLUMN "verdict";--> statement-breakpoint
ALTER TABLE "grading_job" DROP COLUMN "first_span_at";--> statement-breakpoint
ALTER TABLE "grading_job" DROP COLUMN "last_span_at";--> statement-breakpoint
ALTER TABLE "grading_job" DROP COLUMN "last_seen_at";--> statement-breakpoint
ALTER TABLE "grading_job" DROP COLUMN "root_closed_at";--> statement-breakpoint
ALTER TABLE "grading_job" DROP COLUMN "regrade_grader_id";--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_run_shape" CHECK ("run_event"."kind" <> 'run'
        or ("run_event"."simulation_id" is null
          and "run_event"."reason" is null
          and "run_event"."status" in ('pending', 'running', 'completed', 'canceled')));--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_source_names_its_control_record" CHECK (case "grading_job"."source"
        when 'simulation' then "grading_job"."simulation_id" is not null and "grading_job"."run_id" is not null
        when 'production' then "grading_job"."simulation_id" is null and "grading_job"."run_id" is null
        else false
      end);--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_entries_are_a_nonempty_list" CHECK (jsonb_typeof("grading_job"."entries") = 'array'
        and jsonb_array_length("grading_job"."entries") > 0);--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_abandoned_shape" CHECK (("grading_job"."status" = 'abandoned') = ("grading_job"."finished_at" is not null));--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_sequence_base_is_counted" CHECK ("grading_job"."sequence_base" >= 0);--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_status_allowed" CHECK ("grading_job"."status" in ('pending', 'claimed', 'abandoned'));
