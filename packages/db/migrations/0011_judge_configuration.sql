CREATE TABLE "judge_configuration" (
	"project_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"credentials" text NOT NULL,
	"credentials_hint" text NOT NULL,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judge_configuration_project_id_prefix" CHECK ("judge_configuration"."project_id" ~ '^prj_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "judge_configuration_provider_allowed" CHECK ("judge_configuration"."provider" in ('openai'))
);
--> statement-breakpoint
ALTER TABLE "judge_configuration" ADD CONSTRAINT "judge_configuration_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_configuration" ADD CONSTRAINT "judge_configuration_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_configuration" ADD CONSTRAINT "judge_configuration_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;