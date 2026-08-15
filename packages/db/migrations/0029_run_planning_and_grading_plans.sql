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
-- **An old run gets a captured plan only when it still has work outstanding.**
-- `migration_snapshot` takes priority whenever any simulation is nonterminal or
-- any grading job is `pending` or `claimed`, even where the run header itself
-- reads terminal — because that work is about to be judged and has to be judged
-- against something written down. Every other old run is `not_recorded`, and no
-- plan is invented for it: reconstructing one from today's graders would put a
-- sentence on a run from March claiming it was judged by things that may not
-- have existed when it ran.
--
-- **A migrated simulation with no test version falls into the one testless
-- group**, which holds only the project's active default authored graders. It
-- carries no scenario grader and no expected-behaviors built-in, because there
-- is no stored test content to support either, and inventing one would be a
-- claim about a conversation nobody can check.

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

-- One judge choice, in the tagged shape the plan stores and the grader service
-- reads. Written once here because it is decided four times below — for the
-- built-in and for each authored grader, in the version groups and in the
-- testless one — and four copies of a rule are four things to keep in step.
--
-- `source` null is a project that had configured no judge at the moment of
-- capture, and it records `unavailable_at_capture` rather than inventing a
-- credential reference that would resolve to somebody else's key.
CREATE OR REPLACE FUNCTION pg_temp.judge_choice(
	judged boolean,
	provider text,
	model text,
	source text,
	override_provider text,
	override_model text
) RETURNS jsonb AS $$
	SELECT CASE
		WHEN NOT judged THEN jsonb_build_object('tag', 'not_required')
		WHEN source IS NULL THEN jsonb_build_object('tag', 'unavailable_at_capture')
		ELSE jsonb_build_object(
			'tag', 'configured',
			'provider', COALESCE(override_provider, provider),
			'model', COALESCE(override_model, model),
			'source', source)
	END;
$$ LANGUAGE sql IMMUTABLE;--> statement-breakpoint

-- The captured plans: one per old run that still has work outstanding.
INSERT INTO "grading_plan" (
	"id", "run_id", "organization_id", "project_id",
	"state", "captured_at", "groups", "judge_credential_ids", "created_at"
)
WITH outstanding AS (
	SELECT r."id", r."organization_id", r."project_id"
	FROM "run" AS r
	WHERE EXISTS (
			SELECT 1 FROM "simulation" AS s
			WHERE s."run_id" = r."id"
				AND s."status" IN ('queued', 'claimed', 'running')
		)
		OR EXISTS (
			SELECT 1 FROM "grading_job" AS g
			JOIN "simulation" AS s ON s."id" = g."simulation_id"
			WHERE s."run_id" = r."id" AND g."status" IN ('pending', 'claimed')
		)
),
-- The project's judge as it stands right now, which is what "captured during
-- the upgrade" means. A project with no row is absent here and reads as no
-- judge, which is the honest state rather than a guess.
project_judge AS (
	SELECT jc."project_id",
		jc."provider",
		jc."model",
		CASE WHEN jc."source" = 'platform' THEN 'platform' ELSE jc."credential_id" END AS "source"
	FROM "judge_configuration" AS jc
),
-- Every active authored grader of a project, with its current version's
-- judged content. Archived graders are left out: Archive means stop entering
-- new plans, and this is a new plan.
project_graders AS (
	SELECT g."id", g."project_id", g."name", g."type", g."priority", g."scope",
		g."current_version_id", gv."reads", gv."modalities", gv."judge_model"
	FROM "grader" AS g
	JOIN "grader_version" AS gv ON gv."id" = g."current_version_id"
	WHERE g."deleted_at" IS NULL
),
-- Which pinned test versions each outstanding run actually executed.
run_versions AS (
	SELECT DISTINCT o."id" AS "run_id", o."project_id", s."test_id", s."test_version_id", t."name" AS "test_name"
	FROM outstanding AS o
	JOIN "simulation" AS s ON s."run_id" = o."id"
	JOIN "test" AS t ON t."id" = s."test_id"
	WHERE s."test_version_id" IS NOT NULL
),
-- One authored item per grader per version: a project default whose live scope
-- reaches simulations, or a grader the version names directly — and a direct
-- link wins the origin, because it is the scoping decision somebody made.
version_items AS (
	SELECT rv."run_id", rv."test_version_id",
		jsonb_build_object(
			'kind', 'authored',
			'graderId', pg."id",
			'graderVersionId', pg."current_version_id",
			'graderName', pg."name",
			'origin', CASE WHEN tg."grader_id" IS NOT NULL THEN 'scenario_specific' ELSE 'project_default' END,
			'priority', pg."priority",
			'scope', pg."scope",
			'reads', to_jsonb(pg."reads"),
			'modalities', to_jsonb(pg."modalities"),
			'judge', pg_temp.judge_choice(
				pg."type" = 'llm_rubric', j."provider", j."model", j."source",
				pg."judge_model" ->> 'provider', pg."judge_model" ->> 'model')
		) AS "item",
		pg."id" AS "grader_id"
	FROM run_versions AS rv
	JOIN project_graders AS pg ON pg."project_id" = rv."project_id"
	LEFT JOIN "test_grader" AS tg
		ON tg."test_version_id" = rv."test_version_id" AND tg."grader_id" = pg."id"
	LEFT JOIN project_judge AS j ON j."project_id" = rv."project_id"
	WHERE tg."grader_id" IS NOT NULL OR pg."scope" IN ('simulations', 'both')
),
version_groups AS (
	SELECT rv."run_id",
		jsonb_build_object(
			'tag', 'version',
			'testId', rv."test_id",
			'testVersionId', rv."test_version_id",
			'testName', rv."test_name",
			'items', jsonb_build_array(
				jsonb_build_object(
					'kind', 'built_in',
					'graderKey', 'expected_behaviors_v1',
					'engineVersion', '1',
					'reads', '["transcript", "outcome", "tool_calls", "measures"]'::jsonb,
					'modalities', '["voice", "chat"]'::jsonb,
					'judge', pg_temp.judge_choice(true, j."provider", j."model", j."source", NULL, NULL)
				)
			) || COALESCE(
				(SELECT jsonb_agg(vi."item" ORDER BY vi."grader_id")
					FROM version_items AS vi
					WHERE vi."run_id" = rv."run_id" AND vi."test_version_id" = rv."test_version_id"),
				'[]'::jsonb)
		) AS "group"
	FROM run_versions AS rv
	LEFT JOIN project_judge AS j ON j."project_id" = rv."project_id"
),
-- The one testless group, for simulations written before a simulation could
-- pin a test at all. Project defaults only.
testless_runs AS (
	SELECT DISTINCT o."id" AS "run_id", o."project_id"
	FROM outstanding AS o
	JOIN "simulation" AS s ON s."run_id" = o."id"
	WHERE s."test_version_id" IS NULL
),
testless_groups AS (
	SELECT tr."run_id",
		jsonb_build_object(
			'tag', 'legacy_testless',
			'items', COALESCE(
				(SELECT jsonb_agg(
						jsonb_build_object(
							'kind', 'authored',
							'graderId', pg."id",
							'graderVersionId', pg."current_version_id",
							'graderName', pg."name",
							'origin', 'project_default',
							'priority', pg."priority",
							'scope', pg."scope",
							'reads', to_jsonb(pg."reads"),
							'modalities', to_jsonb(pg."modalities"),
							'judge', pg_temp.judge_choice(
								pg."type" = 'llm_rubric', j."provider", j."model", j."source",
								pg."judge_model" ->> 'provider', pg."judge_model" ->> 'model')
						) ORDER BY pg."id")
					FROM project_graders AS pg
					WHERE pg."project_id" = tr."project_id"
						AND pg."scope" IN ('simulations', 'both')),
				'[]'::jsonb)
		) AS "group"
	FROM testless_runs AS tr
	LEFT JOIN project_judge AS j ON j."project_id" = tr."project_id"
),
grouped AS (
	SELECT o."id", o."organization_id", o."project_id",
		COALESCE(
			(SELECT jsonb_agg(vg."group") FROM version_groups AS vg WHERE vg."run_id" = o."id"),
			'[]'::jsonb)
		|| COALESCE(
			(SELECT jsonb_agg(tg."group") FROM testless_groups AS tg WHERE tg."run_id" = o."id"),
			'[]'::jsonb) AS "groups"
	FROM outstanding AS o
)
SELECT pg_temp.migration_id('gpl', 'grading-plan:' || grouped."id"),
	grouped."id", grouped."organization_id", grouped."project_id",
	'migration_snapshot', now(), grouped."groups",
	-- Derived from the plan itself, in the same statement, so the index of what
	-- a plan needs can never come apart from the plan. The platform sentinel
	-- names no customer credential and is deliberately left out.
	COALESCE((
		SELECT jsonb_agg(DISTINCT "item" -> 'judge' ->> 'source')
		FROM jsonb_array_elements(grouped."groups") AS "grp",
			jsonb_array_elements("grp" -> 'items') AS "item"
		WHERE "item" -> 'judge' ->> 'tag' = 'configured'
			AND "item" -> 'judge' ->> 'source' <> 'platform'
	), '[]'::jsonb),
	now()
FROM grouped;--> statement-breakpoint

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
