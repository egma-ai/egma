-- THE ONE DESTRUCTIVE MIGRATION OF THE PERSONA REWORK.
--
-- It breaks the rule in README.md on purpose, and it is the only file allowed
-- to: egma is not live, so there is no running build to keep working and no
-- rollback to stay bootable. The whole persona cut lands here, in one script,
-- with the code that reads the new shape shipping in the same change.
--
-- Existing data survives by the backfill below and by nothing else. Personality,
-- language and the model fields come out of the two jsonb bags; every persona's
-- identity name is seeded from the team name they already carry, which is the
-- only human name the old shape ever held. Accent and background noise were
-- authored, stored, validated, shipped in the work order and then read by
-- nobody; they go with the bags and are not carried anywhere.
--
-- `archived_at` keeps its name and its data. The product word above it becomes
-- Delete; the storage word stays archive, deliberately.
ALTER TABLE "persona_version" DROP CONSTRAINT IF EXISTS "persona_version_traits_valid";--> statement-breakpoint
ALTER TABLE "persona_version" DROP CONSTRAINT IF EXISTS "persona_version_models_valid";--> statement-breakpoint

-- The old guard names the columns this migration is about to remove, so it goes
-- first and its replacement is created last. Between the two, nothing but this
-- transaction is touching the table.
DROP TRIGGER IF EXISTS "persona_version_semantics_immutable_guard" ON "persona_version";--> statement-breakpoint

ALTER TABLE "persona_version"
	ADD COLUMN "identity_name" text,
	ADD COLUMN "personality" text,
	ADD COLUMN "language" text,
	ADD COLUMN "llm_provider" text,
	ADD COLUMN "llm_model" text,
	ADD COLUMN "stt_provider" text,
	ADD COLUMN "stt_model" text,
	ADD COLUMN "tts_provider" text,
	ADD COLUMN "tts_model" text,
	ADD COLUMN "tts_voice_id" text,
	ADD COLUMN "tts_speed" numeric(3, 2);--> statement-breakpoint

-- The backfill. The join is total: a version row cannot exist without the
-- persona it belongs to, so every row gets an identity name.
UPDATE "persona_version" AS v
SET
	"identity_name" = p."name",
	"personality" = v."traits"->>'personality',
	"language" = v."traits"->>'language',
	"llm_provider" = v."models"->'llm'->>'provider',
	"llm_model" = v."models"->'llm'->>'model',
	"stt_provider" = v."models"->'stt'->>'provider',
	"stt_model" = v."models"->'stt'->>'model',
	"tts_provider" = v."models"->'tts'->>'provider',
	"tts_model" = v."models"->'tts'->>'model',
	"tts_voice_id" = v."models"->'tts'->>'voiceId',
	"tts_speed" = (v."models"->'tts'->>'speed')::numeric
FROM "persona" AS p
WHERE p."id" = v."persona_id";--> statement-breakpoint

-- Catalog content, in the same change: the shelf persona is called "Default
-- Persona" by the team, and an agent that asked who was calling would have
-- heard exactly that. `persona-library/catalog.ts` is the source of truth for
-- this value and the boot-time seeder checks the row against it, so the two
-- have to move together. The id is the fixed catalog version id, written out
-- here the same way the baseline writes it.
UPDATE "persona_version"
SET "identity_name" = 'Alex Morgan'
WHERE "id" = 'prsv_01M0E4J0BBE1FVDVTZ1BSS5C97';--> statement-breakpoint

ALTER TABLE "persona_version"
	ALTER COLUMN "identity_name" SET NOT NULL,
	ALTER COLUMN "personality" SET NOT NULL,
	ALTER COLUMN "language" SET NOT NULL,
	ALTER COLUMN "llm_provider" SET NOT NULL,
	ALTER COLUMN "llm_model" SET NOT NULL,
	ALTER COLUMN "stt_provider" SET NOT NULL,
	ALTER COLUMN "stt_model" SET NOT NULL,
	ALTER COLUMN "tts_provider" SET NOT NULL,
	ALTER COLUMN "tts_model" SET NOT NULL,
	ALTER COLUMN "tts_voice_id" SET NOT NULL,
	ALTER COLUMN "tts_speed" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_identity_name_stated" CHECK (btrim("persona_version"."identity_name") <> '');--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_personality_stated" CHECK (btrim("persona_version"."personality") <> '');--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_language_stated" CHECK (btrim("persona_version"."language") <> '');--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_llm_provider_stated" CHECK (btrim("persona_version"."llm_provider") <> '');--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_llm_model_stated" CHECK (btrim("persona_version"."llm_model") <> '');--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_stt_provider_stated" CHECK (btrim("persona_version"."stt_provider") <> '');--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_stt_model_stated" CHECK (btrim("persona_version"."stt_model") <> '');--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_tts_provider_stated" CHECK (btrim("persona_version"."tts_provider") <> '');--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_tts_model_stated" CHECK (btrim("persona_version"."tts_model") <> '');--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_tts_voice_id_stated" CHECK (btrim("persona_version"."tts_voice_id") <> '');--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_tts_speed_in_range" CHECK ("persona_version"."tts_speed" >= 0.6 and "persona_version"."tts_speed" <= 1.5);--> statement-breakpoint

ALTER TABLE "persona_version" DROP COLUMN "traits";--> statement-breakpoint
ALTER TABLE "persona_version" DROP COLUMN "models";--> statement-breakpoint

-- Persona writes become last-write-wins. The token guarded concurrent edits a
-- two-person pre-launch team does not have, and every door above it has
-- stopped asking for one.
ALTER TABLE "persona" DROP COLUMN "revision";--> statement-breakpoint

-- The project's default persona, and every guard that existed to keep the
-- pointer true. The question it answered — who calls when a test names nobody
-- — stopped existing on 2026-08-24, when a test began refusing an empty
-- persona list. Dropped before the column, because a trigger that names a
-- column depends on it.
DROP TRIGGER IF EXISTS "project_default_persona_availability_insert_guard" ON "project";--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_default_persona_availability_update_guard" ON "project";--> statement-breakpoint
DROP TRIGGER IF EXISTS "persona_default_archive_guard" ON "persona";--> statement-breakpoint
DROP FUNCTION IF EXISTS public.guard_project_default_persona_availability();--> statement-breakpoint
DROP FUNCTION IF EXISTS public.guard_default_persona_archive();--> statement-breakpoint
-- Its sibling `persona_is_available_to_project` stays: the simulation and test
-- availability guards still call it, and it never had anything to do with the
-- default pointer.
DROP FUNCTION IF EXISTS public.persona_is_active_default_for_project(text, text);--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN "default_persona_id";--> statement-breakpoint

-- The immutability guard, rewritten over the flat columns. Same constraint
-- name and same sentence, so a caller that recognized the old refusal
-- recognizes this one.
CREATE OR REPLACE FUNCTION public.guard_persona_version_semantics_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	IF NEW.persona_id IS DISTINCT FROM OLD.persona_id
		OR NEW.version IS DISTINCT FROM OLD.version
		OR NEW.identity_name IS DISTINCT FROM OLD.identity_name
		OR NEW.personality IS DISTINCT FROM OLD.personality
		OR NEW.language IS DISTINCT FROM OLD.language
		OR NEW.llm_provider IS DISTINCT FROM OLD.llm_provider
		OR NEW.llm_model IS DISTINCT FROM OLD.llm_model
		OR NEW.stt_provider IS DISTINCT FROM OLD.stt_provider
		OR NEW.stt_model IS DISTINCT FROM OLD.stt_model
		OR NEW.tts_provider IS DISTINCT FROM OLD.tts_provider
		OR NEW.tts_model IS DISTINCT FROM OLD.tts_model
		OR NEW.tts_voice_id IS DISTINCT FROM OLD.tts_voice_id
		OR NEW.tts_speed IS DISTINCT FROM OLD.tts_speed
	THEN
		RAISE check_violation USING
			CONSTRAINT = 'persona_version_semantics_immutable',
			MESSAGE = 'a persona version''s authored content cannot change; mint a new version';
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER persona_version_semantics_immutable_guard BEFORE UPDATE OF persona_id, version, identity_name, personality, language, llm_provider, llm_model, stt_provider, stt_model, tts_provider, tts_model, tts_voice_id, tts_speed ON persona_version FOR EACH ROW EXECUTE FUNCTION guard_persona_version_semantics_immutable();
