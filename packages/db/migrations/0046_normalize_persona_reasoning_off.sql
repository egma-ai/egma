-- PRE-LAUNCH REASONING CUTOVER, confirmed by the founder on 2026-08-24:
-- execution policy now lives only in the model catalog. Remove the old
-- duplicate persona value before tightening the stored JSON shape.
DROP TRIGGER "persona_version_semantics_immutable_guard" ON "persona_version";--> statement-breakpoint
UPDATE "persona_version"
SET "models" = jsonb_set(
	"models",
	'{llm}',
	("models"->'llm') - 'reasoningEffort',
	false
)
WHERE "models"->'llm' ? 'reasoningEffort';--> statement-breakpoint
ALTER TABLE "persona_version" DROP CONSTRAINT "persona_version_models_valid";--> statement-breakpoint
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
      );--> statement-breakpoint
CREATE TRIGGER persona_version_semantics_immutable_guard
BEFORE UPDATE OF persona_id, version, traits, models ON persona_version
FOR EACH ROW EXECUTE FUNCTION guard_persona_version_semantics_immutable();
