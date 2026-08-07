CREATE TABLE "run_event" (
	"run_id" text COLLATE "C" NOT NULL,
	"seq" integer NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"kind" text NOT NULL,
	"simulation_id" text COLLATE "C",
	"status" text NOT NULL,
	"verdict" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_event_pk" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "run_event_run_id_prefix" CHECK ("run_event"."run_id" ~ '^run_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "run_event_kind_allowed" CHECK ("run_event"."kind" in ('run', 'simulation')),
	CONSTRAINT "run_event_seq_counts_from_one" CHECK ("run_event"."seq" >= 1),
	CONSTRAINT "run_event_run_shape" CHECK ("run_event"."kind" <> 'run'
        or ("run_event"."simulation_id" is null
          and "run_event"."verdict" is null and "run_event"."reason" is null
          and "run_event"."status" in ('pending', 'running', 'completed', 'canceled'))),
	CONSTRAINT "run_event_simulation_shape" CHECK ("run_event"."kind" <> 'simulation'
        or ("run_event"."simulation_id" is not null
          and "run_event"."status" in ('queued', 'claimed', 'running', 'completed', 'failed', 'canceled'))),
	CONSTRAINT "run_event_verdict_allowed" CHECK ("run_event"."verdict" is null or "run_event"."verdict" in ('passed', 'failed', 'skipped', 'errored')),
	CONSTRAINT "run_event_verdict_agrees" CHECK ("run_event"."verdict" is null
        or ("run_event"."status" = 'completed' and "run_event"."verdict" in ('passed', 'failed', 'skipped'))
        or ("run_event"."status" = 'failed' and "run_event"."verdict" = 'errored')
        or ("run_event"."status" = 'canceled' and "run_event"."verdict" = 'skipped')),
	CONSTRAINT "run_event_reason_agrees" CHECK ("run_event"."reason" is null
        or ("run_event"."status" = 'completed' and "run_event"."reason" in ('persona_concluded', 'agent_ended', 'limit_reached'))
        or ("run_event"."status" = 'failed' and "run_event"."reason" in ('agent_never_joined', 'not_answered', 'capacity', 'simulator_error', 'orphaned')))
);
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "pinned_test_versions" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "simulation" ADD COLUMN "test_id" text COLLATE "C" NOT NULL;--> statement-breakpoint
ALTER TABLE "simulation" ADD COLUMN "test_version_id" text COLLATE "C" NOT NULL;--> statement-breakpoint
-- Moved ahead of the three foreign keys that target them, exactly as the
-- persona pin's were in 0007: the generator emits the unique constraints last,
-- and a key cannot reference one that does not exist yet.
ALTER TABLE "test" ADD CONSTRAINT "test_id_project_id_unique" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "test_version" ADD CONSTRAINT "test_version_id_test_id_unique" UNIQUE("id","test_id");--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_id_run_id_unique" UNIQUE("id","run_id");--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_run_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."run"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_simulation_run_fk" FOREIGN KEY ("simulation_id","run_id") REFERENCES "public"."simulation"("id","run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_test_version_test_fk" FOREIGN KEY ("test_version_id","test_id") REFERENCES "public"."test_version"("id","test_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_test_project_fk" FOREIGN KEY ("test_id","project_id") REFERENCES "public"."test"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "simulation_test_version_id_idx" ON "simulation" USING btree ("test_version_id");--> statement-breakpoint
CREATE INDEX "simulation_test_id_idx" ON "simulation" USING btree ("test_id");--> statement-breakpoint
-- Written here by hand for the reason the two lifecycle guards were: the
-- schema source cannot express a trigger, and this is the only form in which
-- "an event is appended, never rewritten" is enforced by the database itself.
-- A record whose rows could be edited afterwards is not a record — a follower
-- replaying from its last number would be replaying whatever somebody has since
-- decided the past should have been. Deletes are left alone, because they only
-- ever arrive as the cascade of the run or the customer being removed, and a
-- log of a run that no longer exists is nothing to keep. Carry this trigger
-- forward if this table is ever recreated.
CREATE FUNCTION guard_run_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'event % of run % is written once, and what happened cannot be rewritten',
    OLD.seq, OLD.run_id;
END
$$;--> statement-breakpoint
CREATE TRIGGER run_event_append_only_guard
  BEFORE UPDATE ON "run_event"
  FOR EACH ROW EXECUTE FUNCTION guard_run_event_append_only();
