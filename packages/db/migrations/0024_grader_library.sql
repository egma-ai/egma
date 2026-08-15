CREATE TABLE "grader_library" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C",
	"project_id" text COLLATE "C",
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"prompt" text,
	"params" jsonb NOT NULL,
	"output_definition" jsonb,
	"source_code" text,
	"source_code_language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grader_library_id_prefix" CHECK ("grader_library"."id" ~ '^grl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "grader_library_type_allowed" CHECK ("grader_library"."type" in ('llm_as_judge', 'code')),
	CONSTRAINT "grader_library_tenancy_is_whole_or_egmas" CHECK (("grader_library"."organization_id" is null) = ("grader_library"."project_id" is null)),
	CONSTRAINT "grader_library_source_code_within_budget" CHECK ("grader_library"."source_code" is null or octet_length("grader_library"."source_code") <= 262144),
	CONSTRAINT "grader_library_source_code_columns_agree" CHECK (("grader_library"."source_code" is null) = ("grader_library"."source_code_language" is null))
);
--> statement-breakpoint
ALTER TABLE "grader_library" ADD CONSTRAINT "grader_library_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grader_library" ADD CONSTRAINT "grader_library_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grader_library_predefined_name_unique" ON "grader_library" USING btree ("name") WHERE "grader_library"."organization_id" is null;--> statement-breakpoint
CREATE INDEX "grader_library_organization_id_project_id_idx" ON "grader_library" USING btree ("organization_id","project_id");