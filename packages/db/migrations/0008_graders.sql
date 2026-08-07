CREATE TABLE "grader" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"priority" text NOT NULL,
	"scope" text DEFAULT 'simulations' NOT NULL,
	"production_sample_rate" integer DEFAULT 100 NOT NULL,
	"current_version_id" text COLLATE "C" NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grader_id_prefix" CHECK ("grader"."id" ~ '^grd_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "grader_type_allowed" CHECK ("grader"."type" in ('llm_rubric', 'metric_threshold', 'tool_calls', 'phrase_match')),
	CONSTRAINT "grader_priority_allowed" CHECK ("grader"."priority" in ('P0', 'P1', 'P2')),
	CONSTRAINT "grader_scope_allowed" CHECK ("grader"."scope" in ('simulations', 'production', 'both')),
	CONSTRAINT "grader_production_sample_rate_is_a_percentage" CHECK ("grader"."production_sample_rate" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "grader_version" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"grader_id" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"judge_model" jsonb,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grader_version_grader_id_version_unique" UNIQUE("grader_id","version"),
	CONSTRAINT "grader_version_id_prefix" CHECK ("grader_version"."id" ~ '^grv_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "test_grader" (
	"test_version_id" text COLLATE "C" NOT NULL,
	"grader_id" text COLLATE "C" NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "test_grader_pk" PRIMARY KEY("test_version_id","grader_id"),
	CONSTRAINT "test_grader_version_id_position_unique" UNIQUE("test_version_id","position"),
	CONSTRAINT "test_grader_test_version_id_prefix" CHECK ("test_grader"."test_version_id" ~ '^tstv_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
-- The persona junction takes the name the grader junction beside it wants:
-- `test_persona` and `test_grader`, two tables answering the same question about
-- one version. Both are version-scoped either way, and saying so twice in one
-- name bought nothing.
--
-- Nothing about the rows changes — no column, no prefix, no definition — so
-- every constraint and index is renamed rather than recreated, exactly as 0005
-- renamed the persona's. Recreating them would drop and rebuild indexes on a
-- table that is only being called something else.
ALTER TABLE "test_version_persona" RENAME TO "test_persona";--> statement-breakpoint
ALTER TABLE "test_persona" RENAME CONSTRAINT "test_version_persona_pk" TO "test_persona_pk";--> statement-breakpoint
ALTER TABLE "test_persona" RENAME CONSTRAINT "test_version_persona_version_id_position_unique" TO "test_persona_version_id_position_unique";--> statement-breakpoint
ALTER TABLE "test_persona" RENAME CONSTRAINT "test_version_persona_test_version_id_prefix" TO "test_persona_test_version_id_prefix";--> statement-breakpoint
ALTER TABLE "test_persona" RENAME CONSTRAINT "test_version_persona_test_version_id_test_version_id_fk" TO "test_persona_test_version_id_test_version_id_fk";--> statement-breakpoint
ALTER TABLE "test_persona" RENAME CONSTRAINT "test_version_persona_persona_id_persona_id_fk" TO "test_persona_persona_id_persona_id_fk";--> statement-breakpoint
ALTER INDEX "test_version_persona_persona_id_idx" RENAME TO "test_persona_persona_id_idx";--> statement-breakpoint
ALTER TABLE "grader" ADD CONSTRAINT "grader_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- DEFERRABLE is written here by hand, as it was for the persona (0003) and the
-- test (0006): the schema source cannot express it, and without it the identity
-- row could never be inserted ahead of the version row it points at. Carry this
-- clause forward if this constraint is ever recreated.
ALTER TABLE "grader" ADD CONSTRAINT "grader_current_version_id_grader_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."grader_version"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "grader" ADD CONSTRAINT "grader_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grader" ADD CONSTRAINT "grader_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grader_version" ADD CONSTRAINT "grader_version_grader_id_grader_id_fk" FOREIGN KEY ("grader_id") REFERENCES "public"."grader"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grader_version" ADD CONSTRAINT "grader_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_grader" ADD CONSTRAINT "test_grader_test_version_id_test_version_id_fk" FOREIGN KEY ("test_version_id") REFERENCES "public"."test_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_grader" ADD CONSTRAINT "test_grader_grader_id_grader_id_fk" FOREIGN KEY ("grader_id") REFERENCES "public"."grader"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grader_organization_id_project_id_idx" ON "grader" USING btree ("organization_id","project_id") WHERE "grader"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "test_grader_grader_id_idx" ON "test_grader" USING btree ("grader_id");
