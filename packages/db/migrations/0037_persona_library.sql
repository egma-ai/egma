-- PRELAUNCH CUTOVER, confirmed by the founder on 2026-08-19:
-- Egma has not launched in production. This release intentionally changes a
-- persona from project-owned to Egma-owned in one step. An older API, a rollback
-- to it, or an old web client left open across this deployment is not supported.
-- The shared identity cannot satisfy the old API's project-owned-persona rule,
-- and keeping a compatibility copy would defeat this product decision.
--
-- This is the only cutover. Every installed persona version receives one
-- complete, executable model selection and its technical voice moves out of
-- traits. Runtime code has no nullable or platform-settings fallback.
-- Add the required model owner with the cutover value, then remove the
-- temporary database default before any DML. This fills installed rows without
-- a write that would queue FK events before later schema changes.
ALTER TABLE "persona_version"
	ADD COLUMN "models" jsonb NOT NULL DEFAULT '{"llm":{"provider":"openai","model":"gpt-4o-mini"},"stt":{"provider":"openai","model":"gpt-live-transcribe"},"tts":{"provider":"cartesia","model":"sonic-3.5","voiceId":"5ee9feff-1265-424a-9d7f-8e4d431a12c7","speed":1}}'::jsonb;--> statement-breakpoint
ALTER TABLE "persona_version" ALTER COLUMN "models" DROP DEFAULT;--> statement-breakpoint

-- Finish every persona schema change before rewriting installed version rows.
-- The circular current-version foreign key is deferred, and PostgreSQL will
-- refuse ALTER TABLE after a write has queued one of its trigger events.
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_persona_project_fk";--> statement-breakpoint
ALTER TABLE "persona" DROP CONSTRAINT "persona_id_project_id_unique";--> statement-breakpoint
ALTER TABLE "persona" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "persona" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_tenancy_is_whole_or_egmas" CHECK (("persona"."organization_id" is null) = ("persona"."project_id" is null));--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_egma_provided_is_active" CHECK ("persona"."organization_id" is not null or "persona"."archived_at" is null);--> statement-breakpoint
CREATE UNIQUE INDEX "persona_egma_provided_name_unique" ON "persona" USING btree ("name") WHERE "persona"."organization_id" is null;--> statement-breakpoint
-- Language was not required when the oldest supported databases wrote their
-- persona versions. Give only those missing rows the former product default
-- during this one-time cutover. This is data migration, not a runtime fallback:
-- every row is complete before the new code can start.
UPDATE "persona_version"
SET "traits" = jsonb_set("traits", '{language}', '"en-US"'::jsonb, true)
WHERE jsonb_typeof("traits") = 'object'
	AND NOT ("traits" ? 'language');--> statement-breakpoint
UPDATE "persona_version"
	-- Preserve every authored human fact byte for byte. Only the old
	-- technical voice owner leaves this block.
	SET "traits" = traits - 'voice';--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM persona_version
		WHERE jsonb_typeof(traits) IS DISTINCT FROM 'object'
			OR jsonb_typeof(traits->'personality') IS DISTINCT FROM 'string'
			OR nullif(btrim(traits->>'personality'), '') IS NULL
			OR jsonb_typeof(traits->'language') IS DISTINCT FROM 'string'
			OR nullif(btrim(traits->>'language'), '') IS NULL
			OR EXISTS (
				SELECT 1
				FROM jsonb_each(
					CASE
						WHEN jsonb_typeof(traits) = 'object' THEN traits
						ELSE '{}'::jsonb
					END
				) AS held(name, value)
				WHERE held.name IN ('manner', 'patience', 'accent', 'backgroundNoise', 'underFriction')
					AND (
						jsonb_typeof(held.value) IS DISTINCT FROM 'string'
						OR nullif(btrim(held.value #>> '{}'), '') IS NULL
					)
			)
			OR EXISTS (
				SELECT 1
				FROM jsonb_object_keys(
					CASE
						WHEN jsonb_typeof(traits) = 'object' THEN traits
						ELSE '{}'::jsonb
					END
				) AS held(name)
				WHERE held.name NOT IN (
					'personality', 'language', 'manner', 'patience', 'accent',
					'backgroundNoise', 'underFriction'
				)
			)
	) THEN
			RAISE check_violation USING
				MESSAGE = 'every installed persona version needs exact human traits after the voice and missing-language cutover';
		END IF;
END;
$$;--> statement-breakpoint

-- Hold the authored JSON at the same closed boundary as its TypeScript writer.
-- This prevents a direct or stale writer from restoring technical voice in
-- traits or combining a provider with a model another adapter interprets.
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_traits_valid" CHECK (
	jsonb_typeof("persona_version"."traits") is not distinct from 'object'
	and ("persona_version"."traits" - array[
		'personality', 'language', 'manner', 'patience', 'accent',
		'backgroundNoise', 'underFriction'
	]::text[]) is not distinct from '{}'::jsonb
	and jsonb_typeof("persona_version"."traits"->'personality') is not distinct from 'string'
	and nullif(btrim("persona_version"."traits"->>'personality'), '') is not null
	and jsonb_typeof("persona_version"."traits"->'language') is not distinct from 'string'
	and nullif(btrim("persona_version"."traits"->>'language'), '') is not null
	and (
		not ("persona_version"."traits" ? 'manner')
		or (
			jsonb_typeof("persona_version"."traits"->'manner') is not distinct from 'string'
			and nullif(btrim("persona_version"."traits"->>'manner'), '') is not null
		)
	)
	and (
		not ("persona_version"."traits" ? 'patience')
		or (
			jsonb_typeof("persona_version"."traits"->'patience') is not distinct from 'string'
			and nullif(btrim("persona_version"."traits"->>'patience'), '') is not null
		)
	)
	and (
		not ("persona_version"."traits" ? 'accent')
		or (
			jsonb_typeof("persona_version"."traits"->'accent') is not distinct from 'string'
			and nullif(btrim("persona_version"."traits"->>'accent'), '') is not null
		)
	)
	and (
		not ("persona_version"."traits" ? 'backgroundNoise')
		or (
			jsonb_typeof("persona_version"."traits"->'backgroundNoise') is not distinct from 'string'
			and nullif(btrim("persona_version"."traits"->>'backgroundNoise'), '') is not null
		)
	)
	and (
		not ("persona_version"."traits" ? 'underFriction')
		or (
			jsonb_typeof("persona_version"."traits"->'underFriction') is not distinct from 'string'
			and nullif(btrim("persona_version"."traits"->>'underFriction'), '') is not null
		)
	)
);--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_models_valid" CHECK (
	jsonb_typeof("persona_version"."models") is not distinct from 'object'
	and ("persona_version"."models" - array['llm', 'stt', 'tts']::text[])
		is not distinct from '{}'::jsonb
	and ("persona_version"."models"->'llm') is not distinct from
		jsonb_build_object('provider', 'openai', 'model', 'gpt-4o-mini')
	and (
		("persona_version"."models"->'stt') is not distinct from
			jsonb_build_object('provider', 'openai', 'model', 'gpt-live-transcribe')
		or ("persona_version"."models"->'stt') is not distinct from
			jsonb_build_object('provider', 'deepgram', 'model', 'nova-3-general')
	)
	and jsonb_typeof("persona_version"."models"->'tts') is not distinct from 'object'
	and (("persona_version"."models"->'tts') - array[
		'provider', 'model', 'voiceId', 'speed'
	]::text[]) is not distinct from '{}'::jsonb
	and (
		(
			"persona_version"."models"->'tts'->>'provider' is not distinct from 'cartesia'
			and "persona_version"."models"->'tts'->>'model' is not distinct from 'sonic-3.5'
		)
		or (
			"persona_version"."models"->'tts'->>'provider' is not distinct from 'openai'
			and "persona_version"."models"->'tts'->>'model' is not distinct from 'gpt-4o-mini-tts'
		)
	)
	and jsonb_typeof("persona_version"."models"->'tts'->'voiceId') is not distinct from 'string'
	and nullif(btrim("persona_version"."models"->'tts'->>'voiceId'), '') is not null
	and jsonb_path_exists(
		"persona_version"."models",
		'$.tts.speed ? (@.type() == "number" && @ >= 0.6 && @ <= 1.5)'::jsonpath
	)
);--> statement-breakpoint

-- A run pins this row's meaning. Direct SQL may clear created_by when its user
-- is deleted, but it cannot change any authored fact under the same version id.
CREATE FUNCTION guard_persona_version_semantics_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.persona_id IS DISTINCT FROM OLD.persona_id
		OR NEW.version IS DISTINCT FROM OLD.version
		OR NEW.traits IS DISTINCT FROM OLD.traits
		OR NEW.models IS DISTINCT FROM OLD.models
	THEN
		RAISE check_violation USING
			CONSTRAINT = 'persona_version_semantics_immutable',
			MESSAGE = 'a persona version''s authored content cannot change; mint a new version';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER persona_version_semantics_immutable_guard
BEFORE UPDATE OF persona_id, version, traits, models ON persona_version
FOR EACH ROW EXECUTE FUNCTION guard_persona_version_semantics_immutable();--> statement-breakpoint

-- Carrier routing is the only deployment fact that stays in this table.
-- Delete every former model, speech, voice-activity and media owner so an old
-- row cannot be read by a stale path after this release.
DELETE FROM "platform_setting"
WHERE "name" LIKE 'persona_model%'
	OR "name" LIKE 'speech_to_text%'
	OR "name" LIKE 'text_to_speech%'
	OR "name" IN ('voice_activity_provider', 'media_backend');--> statement-breakpoint
ALTER TABLE "platform_setting" ADD CONSTRAINT "platform_setting_name_allowed"
CHECK ("platform_setting"."name" in (
	'carrier_trunk_address', 'carrier_trunk_number',
	'carrier_trunk_username', 'carrier_trunk_password'
));--> statement-breakpoint

-- The fixed catalog entry exists at the schema level, before any process
-- starts. Startup seeding therefore checks this row and becomes an idempotent
-- catalog reconciliation, not the operation that makes a project usable.
INSERT INTO "persona"
	("id", "organization_id", "project_id", "name", "description",
	 "current_version_id", "revision", "archived_at", "created_by",
	 "created_at", "updated_at")
VALUES
	('prs_01M0E4EVJ6ECGVJEA4NSBTC0CC', null, null, 'Default Persona',
	 'Regular conversationalist persona', 'prsv_01M0E4J0BBE1FVDVTZ1BSS5C97',
	 'rev_01M0E4EVJ6ECGVJEA4NSBTC0CD', null, null,
	 '2026-08-19T23:09:01.674Z'::timestamptz,
	 '2026-08-19T23:09:01.674Z'::timestamptz);--> statement-breakpoint
INSERT INTO "persona_version"
	("id", "persona_id", "version", "traits", "models", "created_by", "created_at")
VALUES
	('prsv_01M0E4J0BBE1FVDVTZ1BSS5C97',
	 'prs_01M0E4EVJ6ECGVJEA4NSBTC0CC',
	 1,
	 '{"personality":"Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.","language":"en-US","manner":"Clear, natural, and conversational.","patience":"Starts patient and gives the agent time to explain.","accent":"Neutral American English.","backgroundNoise":"None.","underFriction":"Becomes firmer if the agent is confusing or repetitive, without becoming rude."}'::jsonb,
	 '{"llm":{"provider":"openai","model":"gpt-4o-mini"},"stt":{"provider":"openai","model":"gpt-live-transcribe"},"tts":{"provider":"cartesia","model":"sonic-3.5","voiceId":"5ee9feff-1265-424a-9d7f-8e4d431a12c7","speed":1}}'::jsonb,
	 null,
	 '2026-08-19T23:09:01.674Z'::timestamptz);--> statement-breakpoint
-- Both halves of the circular identity/version insert now exist. Clear the
-- deferred pointer event before the project FK needs to lock persona again.
SET CONSTRAINTS "persona_current_version_id_persona_version_id_fk" IMMEDIATE;--> statement-breakpoint

-- A project always has one default. Existing custom choices stay untouched;
-- only rows that had no choice receive the fixed Egma-provided persona.
-- Drop the old nullable FK before the rewrite so the update does not queue a
-- trigger event that would block the NOT NULL schema change below.
ALTER TABLE "project" DROP CONSTRAINT "project_default_persona_id_persona_id_fk";--> statement-breakpoint
UPDATE "project"
SET "default_persona_id" = 'prs_01M0E4EVJ6ECGVJEA4NSBTC0CC'
WHERE "default_persona_id" IS NULL;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "default_persona_id" SET DEFAULT 'prs_01M0E4EVJ6ECGVJEA4NSBTC0CC';--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "default_persona_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_default_persona_id_persona_id_fk"
FOREIGN KEY ("default_persona_id") REFERENCES "public"."persona"("id")
ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- A normal foreign key cannot say "the persona is owned by this project OR by
-- Egma." Keep that rule in one database function and make every stored use of
-- a persona pass through it. Project ids are globally unique, so matching a
-- project-owned row also proves its organization.
CREATE FUNCTION persona_is_available_to_project(wanted_persona_id text, wanted_project_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
	SELECT EXISTS (
		SELECT 1
		FROM persona p
		WHERE p.id = wanted_persona_id
			AND (
				p.project_id = wanted_project_id
				OR (p.organization_id IS NULL AND p.project_id IS NULL)
			)
	);
$$;--> statement-breakpoint

-- The old default pointer proved only that the persona existed. Refuse the
-- upgrade if a raw write pointed a project at another project's persona; the
-- guards below must not be installed over a violation they would reject on the
-- next write. Use the future-write guard's SQLSTATE and constraint name so old
-- and new violations give an operator the same actionable integrity error.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM project target
		WHERE target.default_persona_id IS NOT NULL
			AND NOT persona_is_available_to_project(
				target.default_persona_id,
				target.id
			)
	) THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'project_default_persona_availability',
			MESSAGE = 'an installed default persona is not available to its project';
	END IF;
END;
$$;--> statement-breakpoint

-- The old schema checked only that both rows existed. Refuse the upgrade if a
-- raw write already linked a test version to another project's persona; adding
-- guards over bad installed data would preserve a violation behind them. This
-- uses the same SQLSTATE and constraint name as the write guard below, so an
-- operator gets one actionable integrity error for old and new violations.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM test_persona tp
		JOIN test_version tv ON tv.id = tp.test_version_id
		JOIN test t ON t.id = tv.test_id
		WHERE NOT persona_is_available_to_project(tp.persona_id, t.project_id)
	) THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'test_persona_availability',
			MESSAGE = 'an installed persona is not available to its test project';
	END IF;
END;
$$;--> statement-breakpoint

-- A project may point at one of its own personas or at an Egma-provided persona,
-- and never at another project's. The old plain id foreign key still proves
-- the row exists; this trigger proves it is available here.
CREATE FUNCTION guard_project_default_persona_availability() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.default_persona_id IS NOT NULL
		AND NOT persona_is_available_to_project(NEW.default_persona_id, NEW.id)
	THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'project_default_persona_availability',
			MESSAGE = 'the default persona is not available to this project';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER project_default_persona_availability_insert_guard
BEFORE INSERT ON project
FOR EACH ROW EXECUTE FUNCTION guard_project_default_persona_availability();--> statement-breakpoint
CREATE TRIGGER project_default_persona_availability_update_guard
BEFORE UPDATE OF default_persona_id ON project
FOR EACH ROW EXECUTE FUNCTION guard_project_default_persona_availability();--> statement-breakpoint

-- test_persona does not carry project_id. Resolve it through the immutable
-- test-version identity and hold the same rule there. This also closes the old
-- raw-SQL hole that let a test version name another project's persona.
CREATE FUNCTION guard_test_persona_availability() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target_project_id text;
BEGIN
	SELECT t.project_id INTO target_project_id
	FROM test_version tv
	JOIN test t ON t.id = tv.test_id
	WHERE tv.id = NEW.test_version_id;

	-- Let the existing prefix and foreign-key constraints explain a missing
	-- test version. This trigger adds only the project-availability rule.
	IF target_project_id IS NOT NULL
		AND NOT persona_is_available_to_project(NEW.persona_id, target_project_id)
	THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'test_persona_availability',
			MESSAGE = 'the persona is not available to this test project';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER test_persona_availability_insert_guard
BEFORE INSERT ON test_persona
FOR EACH ROW EXECUTE FUNCTION guard_test_persona_availability();--> statement-breakpoint
CREATE TRIGGER test_persona_availability_update_guard
BEFORE UPDATE OF test_version_id, persona_id ON test_persona
FOR EACH ROW EXECUTE FUNCTION guard_test_persona_availability();--> statement-breakpoint

-- Test ownership and a version's test are identity facts. If either could move
-- after a test_persona row passed the guard above, that link could become
-- invalid without touching the guarded row. Normal authoring never moves these
-- fields; it creates another identity or version instead.
CREATE FUNCTION guard_test_ownership_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.project_id IS DISTINCT FROM OLD.project_id
	THEN
		RAISE EXCEPTION 'a test ownership cannot change';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER test_ownership_immutable_guard
BEFORE UPDATE OF organization_id, project_id ON test
FOR EACH ROW EXECUTE FUNCTION guard_test_ownership_immutable();--> statement-breakpoint

CREATE FUNCTION guard_test_version_test_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.test_id IS DISTINCT FROM OLD.test_id
	THEN
		RAISE EXCEPTION 'a test version cannot move between tests';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER test_version_test_immutable_guard
BEFORE UPDATE OF test_id ON test_version
FOR EACH ROW EXECUTE FUNCTION guard_test_version_test_immutable();--> statement-breakpoint

-- A simulation keeps the persona/version composite foreign key. This guard
-- replaces only the project edge that a nullable predefined owner made unable
-- to fit in a normal composite key.
CREATE FUNCTION guard_simulation_persona_availability() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NOT persona_is_available_to_project(NEW.persona_id, NEW.project_id)
	THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'simulation_persona_availability',
			MESSAGE = 'the persona is not available to this simulation project';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER simulation_persona_availability_insert_guard
BEFORE INSERT ON simulation
FOR EACH ROW EXECUTE FUNCTION guard_simulation_persona_availability();--> statement-breakpoint
CREATE TRIGGER simulation_persona_availability_update_guard
BEFORE UPDATE OF persona_id, project_id ON simulation
FOR EACH ROW EXECUTE FUNCTION guard_simulation_persona_availability();--> statement-breakpoint

-- Ownership is identity. Moving a persona between a project and Egma would
-- invalidate the three availability decisions above without touching their
-- rows, so it is refused at the row that owns the fact.
CREATE FUNCTION guard_persona_ownership_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.project_id IS DISTINCT FROM OLD.project_id
	THEN
		RAISE EXCEPTION 'a persona ownership cannot change';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER persona_ownership_immutable_guard
BEFORE UPDATE OF organization_id, project_id ON persona
FOR EACH ROW EXECUTE FUNCTION guard_persona_ownership_immutable();--> statement-breakpoint

-- One-model-execution cutover. A model-judged grader version owns one exact
-- cataloged model; a code grader owns none. This deployment supports one LLM
-- pair today, so every installed model-judged version moves to that pair in one
-- step. There is no project default or runtime fallback after this migration.
UPDATE "grader_version" AS gv
SET "judge_model" = CASE
	WHEN g."type" = 'llm_as_judge'
		THEN '{"provider":"openai","model":"gpt-4o-mini"}'::jsonb
	ELSE NULL
END
FROM "grader" AS g
WHERE g."id" = gv."grader_id";--> statement-breakpoint

-- `judge_model` has existed since 0008. It remains nullable because null means
-- exactly one thing: a code grader makes no model call. A plain NOT NULL would
-- make that valid state impossible, so the catalog check and the cross-table
-- trigger below hold the two parts of the rule instead.
ALTER TABLE "grader_version" ADD CONSTRAINT "grader_version_judge_model_allowed"
CHECK (
	"grader_version"."judge_model" is null
	or "grader_version"."judge_model" = jsonb_build_object(
		'provider', 'openai', 'model', 'gpt-4o-mini'
	)
);--> statement-breakpoint

CREATE FUNCTION guard_grader_version_judge_model() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	grader_type text;
BEGIN
	SELECT g."type" INTO grader_type
	FROM "grader" AS g
	WHERE g."id" = NEW."grader_id";

	-- The foreign key reports an unknown grader. This trigger reports only a
	-- known grader whose type and model ownership disagree.
	IF grader_type = 'llm_as_judge' AND NEW."judge_model" IS NULL
		OR grader_type = 'code' AND NEW."judge_model" IS NOT NULL
	THEN
		RAISE check_violation USING
			CONSTRAINT = 'grader_version_judge_model_matches_type',
			MESSAGE = 'a model-judged grader version needs one model and a code grader version needs none';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER grader_version_judge_model_guard
BEFORE INSERT OR UPDATE OF grader_id, judge_model ON grader_version
FOR EACH ROW EXECUTE FUNCTION guard_grader_version_judge_model();--> statement-breakpoint

-- Type is an identity fact in normal authoring, but hold the pairing even for
-- a direct SQL update so a valid version cannot become invalid behind the
-- version trigger's back.
CREATE FUNCTION guard_grader_type_judge_models() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "grader_version" AS gv
		WHERE gv."grader_id" = NEW."id"
			AND (
				(NEW."type" = 'llm_as_judge' AND gv."judge_model" IS NULL)
				OR (NEW."type" = 'code' AND gv."judge_model" IS NOT NULL)
			)
	) THEN
		RAISE check_violation USING
			CONSTRAINT = 'grader_version_judge_model_matches_type',
			MESSAGE = 'a grader type must agree with every version model';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER grader_type_judge_models_guard
BEFORE UPDATE OF type ON grader
FOR EACH ROW EXECUTE FUNCTION guard_grader_type_judge_models();--> statement-breakpoint

-- A frozen plan pins one immutable grader version id. Remove the old copied
-- judge object from every installed item: keeping a model beside the version
-- would create a second durable answer that can drift from its owner.
UPDATE "grading_plan" AS gp
SET "groups" = COALESCE((
	SELECT jsonb_agg(
		jsonb_set(
			plan_group,
			'{items}',
			COALESCE((
				SELECT jsonb_agg(
					plan_item - 'judge'
					ORDER BY item_position
				)
				FROM jsonb_array_elements(plan_group->'items')
					WITH ORDINALITY AS item(plan_item, item_position)
			), '[]'::jsonb),
			true
		)
		ORDER BY group_position
	)
	FROM jsonb_array_elements(gp."groups")
		WITH ORDINALITY AS grouped(plan_group, group_position)
), '[]'::jsonb)
WHERE gp."state" <> 'not_recorded';--> statement-breakpoint

ALTER TABLE "grading_plan" DROP CONSTRAINT "grading_plan_credentials_are_a_list";--> statement-breakpoint
ALTER TABLE "grading_plan" DROP CONSTRAINT "grading_plan_unrecorded_holds_nothing";--> statement-breakpoint
DROP INDEX "grading_plan_judge_credential_ids_idx";--> statement-breakpoint
ALTER TABLE "grading_plan" DROP COLUMN "judge_credential_ids";--> statement-breakpoint
ALTER TABLE "grading_plan" ADD CONSTRAINT "grading_plan_unrecorded_holds_nothing" CHECK ("grading_plan"."state" <> 'not_recorded'
		or "grading_plan"."groups" = '[]'::jsonb);--> statement-breakpoint
DROP TABLE "judge_configuration";--> statement-breakpoint
DROP TABLE "judge_credential";
