ALTER TABLE "persona_definition_version" DROP CONSTRAINT "persona_version_language_stated";--> statement-breakpoint
ALTER TABLE "persona_definition_version" ALTER COLUMN "language" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "persona_definition_version" ADD CONSTRAINT "persona_version_language_matches_contract" CHECK ((
        ("persona_definition_version"."language" is not null and btrim("persona_definition_version"."language") <> '' and not jsonb_path_exists(
          "persona_definition_version"."parameter_contract", '$[*] ? (@.key == "language")'
        ))
        or ("persona_definition_version"."language" is null and jsonb_path_exists(
          "persona_definition_version"."parameter_contract", '$[*] ? (@.key == "language")'
        ))
      ));--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.persona_parameters_valid(parameters jsonb, contract jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE keys text[]; field text;
BEGIN
  IF NOT egma_parameter_values_valid(parameters, contract) THEN RETURN false; END IF;
  keys := ARRAY(SELECT value->>'key' FROM jsonb_array_elements(contract));
  IF NOT (
    cardinality(keys) = 8 AND keys @> ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id','tts_speed']
  ) AND NOT (
    cardinality(keys) = 13 AND keys @> ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id','tts_speed','language','emotion','accent','speech_volume','execution_policy_version']
  )
  THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id'] LOOP
    IF jsonb_typeof(parameters->field) IS DISTINCT FROM 'string' OR btrim(parameters->>field) = '' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(parameters->'tts_speed') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  IF keys @> ARRAY['language'] THEN
    IF jsonb_typeof(parameters->'language') IS DISTINCT FROM 'string' OR btrim(parameters->>'language') = ''
       OR jsonb_typeof(parameters->'emotion') IS DISTINCT FROM 'string'
       OR parameters->>'emotion' NOT IN ('neutral','happy','angry','frustrated','sad','anxious')
       OR jsonb_typeof(parameters->'accent') IS DISTINCT FROM 'string' OR btrim(parameters->>'accent') = ''
       OR jsonb_typeof(parameters->'speech_volume') IS DISTINCT FROM 'number'
       OR (parameters->>'speech_volume')::numeric NOT BETWEEN 0.5 AND 1.5
       OR jsonb_typeof(parameters->'execution_policy_version') IS DISTINCT FROM 'number'
       OR trunc((parameters->>'execution_policy_version')::numeric) <> (parameters->>'execution_policy_version')::numeric
       OR (parameters->>'execution_policy_version')::numeric < 1
       OR (parameters->>'tts_speed')::numeric NOT BETWEEN 0.25 AND 4
    THEN RETURN false; END IF;
  ELSIF (parameters->>'tts_speed')::numeric NOT BETWEEN 0.6 AND 1.5 THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;
