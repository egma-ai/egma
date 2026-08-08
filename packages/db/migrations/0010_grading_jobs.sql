CREATE TABLE "grading_job" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"source" text NOT NULL,
	"simulation_id" text COLLATE "C",
	"status" text NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grading_job_simulation_id_unique" UNIQUE("simulation_id"),
	CONSTRAINT "grading_job_id_prefix" CHECK ("grading_job"."id" ~ '^gjb_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "grading_job_status_allowed" CHECK ("grading_job"."status" in ('pending', 'claimed', 'graded', 'abandoned')),
	CONSTRAINT "grading_job_source_allowed" CHECK ("grading_job"."source" in ('simulation', 'production')),
	CONSTRAINT "grading_job_source_names_its_conversation" CHECK (case "grading_job"."source"
        when 'simulation' then "grading_job"."simulation_id" is not null
        else "grading_job"."simulation_id" is null
      end),
	CONSTRAINT "grading_job_claim_columns_agree" CHECK ((("grading_job"."claimed_at" is null) = ("grading_job"."claimed_by" is null))
        and (("grading_job"."claimed_at" is null) = ("grading_job"."heartbeat_at" is null))),
	CONSTRAINT "grading_job_pending_shape" CHECK ("grading_job"."status" <> 'pending'
        or ("grading_job"."claimed_at" is null and "grading_job"."finished_at" is null)),
	CONSTRAINT "grading_job_claimed_shape" CHECK ("grading_job"."status" <> 'claimed'
        or ("grading_job"."claimed_at" is not null and "grading_job"."finished_at" is null)),
	CONSTRAINT "grading_job_finished_is_terminal" CHECK (("grading_job"."finished_at" is null)
        = ("grading_job"."status" not in ('graded', 'abandoned'))),
	CONSTRAINT "grading_job_attempts_are_counted" CHECK ("grading_job"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Moved ahead of the foreign key that targets it; the generator emits the
-- unique constraints last, and a key cannot reference one that does not exist
-- yet. The same reordering 0007 made for the persona pin's pair and 0009 for
-- the test pin's. It looks redundant beside the simulation's primary key, and
-- is not: it is what lets a grading job prove that the conversation it was
-- written for belongs to the project the job names.
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_id_project_id_unique" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_simulation_project_fk" FOREIGN KEY ("simulation_id","project_id") REFERENCES "public"."simulation"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grading_job_outstanding_idx" ON "grading_job" USING btree ("id") WHERE "grading_job"."status" in ('pending', 'claimed');--> statement-breakpoint
CREATE INDEX "grading_job_organization_id_project_id_idx" ON "grading_job" USING btree ("organization_id","project_id");
