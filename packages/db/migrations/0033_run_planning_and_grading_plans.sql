-- Runs plan before they start, and old runs say honestly what they never planned.
--
-- Four changes, and they are one change to what starting a run *means*: egma
-- decides in advance which conversations it can honestly have, writes down what
-- will judge each one, remembers which request asked for it, and refuses to
-- invent any of that for history that predates the decision.
--
-- **The generated body for this diff would have been wrong on any installed
-- deployment**, in two ways. `run_counts_written_together` gains
-- `skipped_count`, and every run that has already finished holds three counts
-- and a null fourth — so the constraint would refuse the table it was added to.
-- And nothing in a generated diff writes a grading plan, so every run on an
-- upgraded instance would come out of it with no plan at all, which is the one
-- state a run must never be in when a grader comes looking. The snapshot and
-- the journal entry are drizzle's, untouched, so the next `generate` diffs
-- against a schema this file really produces; the body is written, in the order
-- that makes it safe.
--
-- **Judge credentials were migrated first, and by 0026 rather than by this
-- file.** A plan stores the *reference* to a credential and never a secret, so
-- there has to be a credential row to point at before any plan is captured.
-- 0026 created one per project from each project's own judge configuration and
-- pointed the project at it, which is exactly the order the product requires
-- and is guaranteed here by nothing more than the migration number.
--
-- **Every old run is `not_recorded`, and no plan is invented for any of them.**
-- This file captured a `migration_snapshot` for runs with work still
-- outstanding; see the note beside that statement's remains for why it cannot
-- and need not. Reconstructing a plan from today's graders would put a sentence
-- on a run from March claiming it was judged by things that may not have
-- existed when it ran, which is the failure `not_recorded` exists to avoid.

CREATE TABLE "grading_plan" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"run_id" text COLLATE "C" NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"state" text NOT NULL,
	"captured_at" timestamp with time zone,
	"groups" jsonb NOT NULL,
	"judge_credential_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grading_plan_run_id_unique" UNIQUE("run_id"),
	CONSTRAINT "grading_plan_id_prefix" CHECK ("grading_plan"."id" ~ '^gpl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "grading_plan_state_allowed" CHECK ("grading_plan"."state" in ('run_start', 'migration_snapshot', 'not_recorded')),
	CONSTRAINT "grading_plan_recorded_plans_carry_their_moment" CHECK (("grading_plan"."state" = 'not_recorded')
        = ("grading_plan"."captured_at" is null)),
	CONSTRAINT "grading_plan_groups_are_a_list" CHECK (jsonb_typeof("grading_plan"."groups") = 'array'),
	CONSTRAINT "grading_plan_credentials_are_a_list" CHECK (jsonb_typeof("grading_plan"."judge_credential_ids") = 'array'),
	CONSTRAINT "grading_plan_unrecorded_holds_nothing" CHECK ("grading_plan"."state" <> 'not_recorded'
        or ("grading_plan"."groups" = '[]'::jsonb
          and "grading_plan"."judge_credential_ids" = '[]'::jsonb))
);
--> statement-breakpoint
CREATE TABLE "idempotent_operation" (
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"actor_id" text COLLATE "C" NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"result_id" text COLLATE "C" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotent_operation_pk" PRIMARY KEY("organization_id","project_id","actor_id","operation","idempotency_key"),
	CONSTRAINT "idempotent_operation_organization_id_prefix" CHECK ("idempotent_operation"."organization_id" ~ '^org_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "idempotent_operation_allowed" CHECK ("idempotent_operation"."operation" in ('start_run')),
	CONSTRAINT "idempotent_operation_key_is_not_empty" CHECK (length("idempotent_operation"."idempotency_key") > 0)
);
--> statement-breakpoint
ALTER TABLE "run" DROP CONSTRAINT "run_counts_written_together";--> statement-breakpoint
ALTER TABLE "run" DROP CONSTRAINT "run_counts_are_counts";--> statement-breakpoint
ALTER TABLE "run_event" DROP CONSTRAINT "run_event_simulation_shape";--> statement-breakpoint
ALTER TABLE "run_event" DROP CONSTRAINT "run_event_verdict_agrees";--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_status_allowed";--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "skipped_count" integer;--> statement-breakpoint
ALTER TABLE "simulation" ADD COLUMN "skip_reason" text;--> statement-breakpoint
ALTER TABLE "simulation" ADD COLUMN "skipped_capabilities" jsonb;--> statement-breakpoint

-- **Before the constraint that names it.** Every run that has already finished
-- holds its three counts, and the widened `run_counts_written_together` would
-- refuse the table outright if this ran after it. Zero is the honest number:
-- nothing was skipped before egma could skip anything.
--
-- **And around the guard, which is doing exactly its job.** A finished run's
-- header is written once — `guard_run_lifecycle` has refused every update to
-- one since 0007, and that refusal is what stops a straggling report reopening
-- a run that already reported its numbers. This backfill is the one write that
-- legitimately has to reach those rows, because it adds a column rather than
-- changing an answer, so the guard is lifted for this statement and put back
-- immediately. It is lifted rather than taught an exception on purpose: an
-- exception would live in the trigger forever and would be a hole in the rule
-- for every write afterwards, while this is one statement in one migration.
ALTER TABLE "run" DISABLE TRIGGER "run_lifecycle_guard";--> statement-breakpoint
UPDATE "run" SET "skipped_count" = 0 WHERE "finished_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ENABLE TRIGGER "run_lifecycle_guard";--> statement-breakpoint

ALTER TABLE "grading_plan" ADD CONSTRAINT "grading_plan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_plan" ADD CONSTRAINT "grading_plan_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_plan" ADD CONSTRAINT "grading_plan_run_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."run"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotent_operation" ADD CONSTRAINT "idempotent_operation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotent_operation" ADD CONSTRAINT "idempotent_operation_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotent_operation" ADD CONSTRAINT "idempotent_operation_actor_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grading_plan_judge_credential_ids_idx" ON "grading_plan" USING gin ("judge_credential_ids");--> statement-breakpoint
CREATE INDEX "grading_plan_organization_id_project_id_idx" ON "grading_plan" USING btree ("organization_id","project_id");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_counts_written_together" CHECK ((("run"."completed_count" is null) = ("run"."failed_count" is null))
        and (("run"."failed_count" is null) = ("run"."canceled_count" is null))
        and (("run"."canceled_count" is null) = ("run"."skipped_count" is null))
        and (("run"."canceled_count" is null) = ("run"."finished_at" is null)));--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_counts_are_counts" CHECK (("run"."completed_count" is null)
        or ("run"."completed_count" >= 0 and "run"."failed_count" >= 0
          and "run"."canceled_count" >= 0 and "run"."skipped_count" >= 0));--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_simulation_shape" CHECK ("run_event"."kind" <> 'simulation'
        or ("run_event"."simulation_id" is not null
          and "run_event"."status" in ('queued', 'claimed', 'running', 'completed', 'failed', 'canceled', 'skipped')));--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_verdict_agrees" CHECK ("run_event"."verdict" is null
        or ("run_event"."status" = 'completed' and "run_event"."verdict" in ('passed', 'failed', 'skipped'))
        or ("run_event"."status" = 'failed' and "run_event"."verdict" = 'errored')
        or ("run_event"."status" = 'canceled' and "run_event"."verdict" = 'skipped')
        or ("run_event"."status" = 'skipped' and "run_event"."verdict" = 'skipped'));--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_skipped_shape" CHECK ("simulation"."status" <> 'skipped'
        or ("simulation"."ended_at" is not null and "simulation"."claimed_at" is null
          and "simulation"."started_at" is null and "simulation"."cancel_requested_at" is null
          and "simulation"."skip_reason" is not null
          and "simulation"."skipped_capabilities" is not null));--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_skip_reason_belongs_to_a_skip" CHECK ("simulation"."status" = 'skipped'
        or ("simulation"."skip_reason" is null and "simulation"."skipped_capabilities" is null));--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_skip_reason_allowed" CHECK ("simulation"."skip_reason" is null or "simulation"."skip_reason" in ('required_capability_unsupported', 'required_capability_unknown'));--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_status_allowed" CHECK ("simulation"."status" in ('queued', 'claimed', 'running', 'completed', 'failed', 'canceled', 'skipped'));--> statement-breakpoint

-- `skipped` is terminal from birth, and the guard has to say so. Without this
-- line the lifecycle trigger would read a skipped row as a live one and permit
-- `skipped → claimed`, which is the one transition that would put a
-- conversation egma declined to have in front of a simulator. `OR REPLACE`
-- rather than a new name, because the trigger already points at this function
-- and the point is to change what it does, not where it lives.
CREATE OR REPLACE FUNCTION guard_simulation_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'canceled', 'skipped') THEN
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

-- An identifier in egma's own format, minted in SQL for rows nobody was there
-- to mint one for — 0026's helper, verbatim, for the same reason it was written
-- there. `OR REPLACE`, because earlier migrations define the same helper and all
-- of them run in one session.
CREATE OR REPLACE FUNCTION pg_temp.migration_id(prefix text, seed text) RETURNS text AS $$
	SELECT prefix || '_' || upper(substr(md5(seed), 1, 26));
$$ LANGUAGE sql IMMUTABLE;--> statement-breakpoint

-- **No plan is captured for an old run, and one used to be.** This file wrote a
-- `migration_snapshot` for every run that still had work outstanding, built out
-- of the project's authored graders, their priorities, what each version read
-- and which modalities it scored, the graders a test named directly, and the
-- expected-behaviors built-in as a rowless item with a reserved key. The grader
-- redesign retired every one of those: `grader.priority` is dropped by 0025,
-- `test_grader` by 0027, `reads` and `modalities` never exist, and the built-in
-- is an ordinary running copy. There is nothing left to read and no shape left
-- to write it in.
--
-- **And there is nothing to capture.** 0026 deletes every grader row on an
-- upgraded instance — the four retired types were all of them, and none points
-- at a library entry — so a snapshot taken here would name graders that no
-- longer exist. `not_recorded` below is the honest answer for every old run,
-- and it is the answer the state exists for: this run predates frozen plans and
-- egma will not reconstruct one.

-- And every other old run says out loud that nothing was written down.
INSERT INTO "grading_plan" (
	"id", "run_id", "organization_id", "project_id",
	"state", "captured_at", "groups", "judge_credential_ids", "created_at"
)
SELECT pg_temp.migration_id('gpl', 'grading-plan:' || r."id"),
	r."id", r."organization_id", r."project_id",
	'not_recorded', NULL, '[]'::jsonb, '[]'::jsonb, now()
FROM "run" AS r
WHERE NOT EXISTS (
	SELECT 1 FROM "grading_plan" AS gp WHERE gp."run_id" = r."id"
);
