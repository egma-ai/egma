CREATE TABLE "run" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"connection_id" text COLLATE "C" NOT NULL,
	"label" text,
	"status" text NOT NULL,
	"triggered_via" text NOT NULL,
	"triggered_by" text COLLATE "C",
	"requested_personas" jsonb NOT NULL,
	"connection_snapshot" jsonb NOT NULL,
	"expected_simulation_count" integer NOT NULL,
	"completed_count" integer,
	"failed_count" integer,
	"canceled_count" integer,
	"retry_of_run_id" text COLLATE "C",
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "run_id_prefix" CHECK ("run"."id" ~ '^run_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "run_status_allowed" CHECK ("run"."status" in ('pending', 'running', 'completed', 'canceled')),
	CONSTRAINT "run_triggered_via_allowed" CHECK ("run"."triggered_via" in ('manual')),
	CONSTRAINT "run_expects_at_least_one_simulation" CHECK ("run"."expected_simulation_count" > 0),
	CONSTRAINT "run_counts_written_together" CHECK ((("run"."completed_count" is null) = ("run"."failed_count" is null))
        and (("run"."failed_count" is null) = ("run"."canceled_count" is null))
        and (("run"."canceled_count" is null) = ("run"."finished_at" is null))),
	CONSTRAINT "run_counts_are_counts" CHECK (("run"."completed_count" is null)
        or ("run"."completed_count" >= 0 and "run"."failed_count" >= 0 and "run"."canceled_count" >= 0)),
	CONSTRAINT "run_finished_is_terminal" CHECK ("run"."finished_at" is null or "run"."status" in ('completed', 'canceled')),
	CONSTRAINT "run_completed_is_finished" CHECK ("run"."status" <> 'completed' or "run"."finished_at" is not null),
	CONSTRAINT "run_started_when_left_pending" CHECK (case
        when "run"."status" = 'pending' then "run"."started_at" is null
        when "run"."status" in ('running', 'completed') then "run"."started_at" is not null
        else true
      end)
);
--> statement-breakpoint
CREATE TABLE "simulation" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"run_id" text COLLATE "C" NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"connection_id" text COLLATE "C" NOT NULL,
	"persona_id" text COLLATE "C" NOT NULL,
	"persona_version_id" text COLLATE "C" NOT NULL,
	"position" integer NOT NULL,
	"connection_type" text NOT NULL,
	"modality" text NOT NULL,
	"status" text NOT NULL,
	"ending_reason" text,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"measured_audio_band_hertz" integer,
	"transcript" jsonb,
	"events" jsonb,
	"metrics" jsonb,
	"recording_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "simulation_run_id_position_unique" UNIQUE("run_id","position"),
	CONSTRAINT "simulation_id_prefix" CHECK ("simulation"."id" ~ '^sim_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "simulation_status_allowed" CHECK ("simulation"."status" in ('queued', 'claimed', 'running', 'completed', 'failed', 'canceled')),
	CONSTRAINT "simulation_connection_type_allowed" CHECK ("simulation"."connection_type" in ('retell', 'phone')),
	CONSTRAINT "simulation_modality_allowed" CHECK ("simulation"."modality" in ('voice', 'chat')),
	CONSTRAINT "simulation_position_counts_from_one" CHECK ("simulation"."position" >= 1),
	CONSTRAINT "simulation_ending_reason_allowed" CHECK ("simulation"."ending_reason" is null or "simulation"."ending_reason" in ('persona_concluded', 'agent_ended', 'limit_reached', 'agent_never_joined', 'not_answered', 'capacity', 'simulator_error', 'orphaned')),
	CONSTRAINT "simulation_ending_reason_agrees" CHECK (case "simulation"."status"
        when 'completed' then "simulation"."ending_reason" in ('persona_concluded', 'agent_ended', 'limit_reached')
        when 'failed' then "simulation"."ending_reason" in ('agent_never_joined', 'not_answered', 'capacity', 'simulator_error', 'orphaned')
        else "simulation"."ending_reason" is null
      end),
	CONSTRAINT "simulation_claim_columns_agree" CHECK ((("simulation"."claimed_at" is null) = ("simulation"."claimed_by" is null))
        and (("simulation"."claimed_at" is null) = ("simulation"."heartbeat_at" is null))),
	CONSTRAINT "simulation_queued_shape" CHECK ("simulation"."status" <> 'queued'
        or ("simulation"."claimed_at" is null and "simulation"."started_at" is null
          and "simulation"."ended_at" is null and "simulation"."cancel_requested_at" is null)),
	CONSTRAINT "simulation_claimed_shape" CHECK ("simulation"."status" <> 'claimed'
        or ("simulation"."claimed_at" is not null and "simulation"."started_at" is null
          and "simulation"."ended_at" is null)),
	CONSTRAINT "simulation_running_shape" CHECK ("simulation"."status" <> 'running'
        or ("simulation"."claimed_at" is not null and "simulation"."started_at" is not null
          and "simulation"."ended_at" is null)),
	CONSTRAINT "simulation_completed_shape" CHECK ("simulation"."status" <> 'completed'
        or ("simulation"."started_at" is not null and "simulation"."ended_at" is not null)),
	CONSTRAINT "simulation_failed_shape" CHECK ("simulation"."status" <> 'failed' or "simulation"."ended_at" is not null),
	CONSTRAINT "simulation_canceled_shape" CHECK ("simulation"."status" <> 'canceled'
        or ("simulation"."ended_at" is not null and "simulation"."cancel_requested_at" is not null)),
	CONSTRAINT "simulation_report_only_when_ended" CHECK ("simulation"."ended_at" is not null
        or ("simulation"."transcript" is null and "simulation"."events" is null
          and "simulation"."metrics" is null and "simulation"."recording_reference" is null
          and "simulation"."measured_audio_band_hertz" is null)),
	CONSTRAINT "simulation_audio_facts_are_voice_facts" CHECK ("simulation"."modality" = 'voice'
        or ("simulation"."measured_audio_band_hertz" is null
          and "simulation"."recording_reference" is null)),
	CONSTRAINT "simulation_audio_band_is_a_rate" CHECK ("simulation"."measured_audio_band_hertz" is null or "simulation"."measured_audio_band_hertz" > 0)
);
--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_triggered_by_user_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_retry_of_run_id_run_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_connection_agent_fk" FOREIGN KEY ("connection_id","agent_id") REFERENCES "public"."connection"("id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_connection_agent_fk" FOREIGN KEY ("connection_id","agent_id") REFERENCES "public"."connection"("id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_run_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."run"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Moved ahead of the two foreign keys that target them; the generator emits
-- the unique constraints last, and a key cannot reference one that does not
-- exist yet.
ALTER TABLE "persona" ADD CONSTRAINT "persona_id_project_id_unique" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_id_persona_id_unique" UNIQUE("id","persona_id");--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_persona_version_persona_fk" FOREIGN KEY ("persona_version_id","persona_id") REFERENCES "public"."persona_version"("id","persona_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_persona_project_fk" FOREIGN KEY ("persona_id","project_id") REFERENCES "public"."persona"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_organization_id_id_idx" ON "run" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "run_organization_id_project_id_id_idx" ON "run" USING btree ("organization_id","project_id","id");--> statement-breakpoint
CREATE INDEX "run_agent_id_idx" ON "run" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "simulation_run_id_idx" ON "simulation" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "simulation_queued_idx" ON "simulation" USING btree ("organization_id","id") WHERE "simulation"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "simulation_heartbeat_idx" ON "simulation" USING btree ("heartbeat_at") WHERE "simulation"."status" in ('claimed', 'running');--> statement-breakpoint
CREATE INDEX "simulation_persona_version_id_idx" ON "simulation" USING btree ("persona_version_id");--> statement-breakpoint
CREATE INDEX "simulation_persona_id_idx" ON "simulation" USING btree ("persona_id");--> statement-breakpoint
-- Written here by hand: the schema source cannot express a trigger, and a
-- check constraint cannot see the row being replaced, so this is the only
-- form in which "no illegal state transition can be written" is enforced by
-- the database itself. Like the composite foreign keys, it defends the paths
-- that never pass through the application — migration scripts, bulk imports,
-- a manual fix at three in the morning. Carry both triggers forward if these
-- tables are ever recreated.
CREATE FUNCTION guard_simulation_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'simulation % is %, and a terminal simulation is written once',
      OLD.id, OLD.status;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'queued'  AND NEW.status IN ('claimed', 'canceled'))
  OR (OLD.status = 'claimed' AND NEW.status IN ('running', 'failed', 'canceled'))
  OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'canceled'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'simulation % may not move from % to %',
    OLD.id, OLD.status, NEW.status;
END
$$;--> statement-breakpoint
CREATE TRIGGER simulation_lifecycle_guard
  BEFORE UPDATE ON "simulation"
  FOR EACH ROW EXECUTE FUNCTION guard_simulation_lifecycle();--> statement-breakpoint
CREATE FUNCTION guard_run_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The counts and finished_at land together, once; after that the header is
  -- frozen and a retry is a new run.
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'run % is finished, and a finished run''s header is written once',
      OLD.id;
  END IF;

  IF NEW.expected_simulation_count <> OLD.expected_simulation_count THEN
    RAISE EXCEPTION 'run % expected % simulations, and the expectation is set once at start',
      OLD.id, OLD.expected_simulation_count;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'pending' AND NEW.status IN ('running', 'canceled'))
  OR (OLD.status = 'running' AND NEW.status IN ('completed', 'canceled'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'run % may not move from % to %', OLD.id, OLD.status, NEW.status;
END
$$;--> statement-breakpoint
CREATE TRIGGER run_lifecycle_guard
  BEFORE UPDATE ON "run"
  FOR EACH ROW EXECUTE FUNCTION guard_run_lifecycle();