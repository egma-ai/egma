ALTER TABLE "persona_version" DROP CONSTRAINT "persona_version_traits_valid";--> statement-breakpoint
ALTER TABLE "persona_version" DROP CONSTRAINT "persona_version_models_valid";--> statement-breakpoint

-- PRE-LAUNCH CUTOVER, confirmed by the founder on 2026-08-24:
-- Default Persona v1 is the platform persona we intend to ship. Rewrite that
-- fixed version in place instead of minting v2. This intentionally changes the
-- meaning of any pre-launch simulation that already pinned v1.
--
-- The same cutover removes three redundant trait keys from every persona
-- version. Preserve each customer's authored meaning by folding the old values
-- into `personality` before deleting the keys. The platform Default Persona is
-- the one exception: its personality already says the same things, so appending
-- the old fields would duplicate its behavior. Accent and backgroundNoise
-- remain stored facts until a separate product decision.
--
-- The normal trigger is still the rule after this one migration. Remove it for
-- the bounded rewrite and restore it before another process can write.
DROP TRIGGER "persona_version_semantics_immutable_guard" ON "persona_version";--> statement-breakpoint
UPDATE "persona_version"
SET "traits" = jsonb_set(
	"traits",
	'{personality}',
	to_jsonb(concat_ws(
		E'\n\n',
		"traits"->>'personality',
		case when "traits" ? 'manner'
			then 'Manner: ' || ("traits"->>'manner') end,
		case when "traits" ? 'patience'
			then 'Patience: ' || ("traits"->>'patience') end,
		case when "traits" ? 'underFriction'
			then 'Under friction: ' || ("traits"->>'underFriction') end
	))
) - 'manner' - 'patience' - 'underFriction'
WHERE "id" <> 'prsv_01M0E4J0BBE1FVDVTZ1BSS5C97'
  AND "traits" ?| array['manner', 'patience', 'underFriction'];--> statement-breakpoint
UPDATE "persona_version"
SET "traits" = "traits" - 'manner' - 'patience' - 'underFriction'
WHERE "id" = 'prsv_01M0E4J0BBE1FVDVTZ1BSS5C97'
  AND "traits" ?| array['manner', 'patience', 'underFriction'];--> statement-breakpoint
UPDATE "persona_version"
SET "models" = jsonb_set(
	"models",
	'{llm}',
	'{"provider":"openai","model":"gpt-5.6-terra"}'::jsonb,
	false
)
WHERE "id" = 'prsv_01M0E4J0BBE1FVDVTZ1BSS5C97';--> statement-breakpoint
CREATE TRIGGER persona_version_semantics_immutable_guard
BEFORE UPDATE OF persona_id, version, traits, models ON persona_version
FOR EACH ROW EXECUTE FUNCTION guard_persona_version_semantics_immutable();--> statement-breakpoint

-- These constraints protect the stored wire shape against stale code and
-- direct SQL. They deliberately do not duplicate the product model catalog.
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_traits_valid" CHECK (
        jsonb_typeof("persona_version"."traits") is not distinct from 'object'
        and ("persona_version"."traits" - array[
          'personality', 'language', 'accent', 'backgroundNoise'
        ]::text[]) is not distinct from '{}'::jsonb
        and jsonb_typeof("persona_version"."traits"->'personality') is not distinct from 'string'
        and nullif(btrim("persona_version"."traits"->>'personality'), '') is not null
        and jsonb_typeof("persona_version"."traits"->'language') is not distinct from 'string'
        and nullif(btrim("persona_version"."traits"->>'language'), '') is not null
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
      );--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_models_valid" CHECK (
        jsonb_typeof("persona_version"."models") is not distinct from 'object'
        and ("persona_version"."models" - array['llm', 'stt', 'tts']::text[])
          is not distinct from '{}'::jsonb
        and jsonb_typeof("persona_version"."models"->'llm') is not distinct from 'object'
        and (("persona_version"."models"->'llm') - array['provider', 'model']::text[])
          is not distinct from '{}'::jsonb
        and jsonb_typeof("persona_version"."models"->'llm'->'provider') is not distinct from 'string'
        and nullif(btrim("persona_version"."models"->'llm'->>'provider'), '') is not null
        and jsonb_typeof("persona_version"."models"->'llm'->'model') is not distinct from 'string'
        and nullif(btrim("persona_version"."models"->'llm'->>'model'), '') is not null
        and jsonb_typeof("persona_version"."models"->'stt') is not distinct from 'object'
        and (("persona_version"."models"->'stt') - array['provider', 'model']::text[])
          is not distinct from '{}'::jsonb
        and jsonb_typeof("persona_version"."models"->'stt'->'provider') is not distinct from 'string'
        and nullif(btrim("persona_version"."models"->'stt'->>'provider'), '') is not null
        and jsonb_typeof("persona_version"."models"->'stt'->'model') is not distinct from 'string'
        and nullif(btrim("persona_version"."models"->'stt'->>'model'), '') is not null
        and jsonb_typeof("persona_version"."models"->'tts') is not distinct from 'object'
        and (("persona_version"."models"->'tts') - array[
          'provider', 'model', 'voiceId', 'speed'
        ]::text[]) is not distinct from '{}'::jsonb
        and jsonb_typeof("persona_version"."models"->'tts'->'provider') is not distinct from 'string'
        and nullif(btrim("persona_version"."models"->'tts'->>'provider'), '') is not null
        and jsonb_typeof("persona_version"."models"->'tts'->'model') is not distinct from 'string'
        and nullif(btrim("persona_version"."models"->'tts'->>'model'), '') is not null
        and jsonb_typeof("persona_version"."models"->'tts'->'voiceId') is not distinct from 'string'
        and nullif(btrim("persona_version"."models"->'tts'->>'voiceId'), '') is not null
        and jsonb_path_exists(
          "persona_version"."models",
          '$.tts.speed ? (@.type() == "number" && @ >= 0.6 && @ <= 1.5)'::jsonpath
        )
      );
