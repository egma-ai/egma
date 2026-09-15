ALTER FUNCTION public.persona_parameters_valid(jsonb, jsonb)
  RENAME TO persona_parameters_valid_pre_simplification;

CREATE FUNCTION public.persona_parameters_valid(parameters jsonb, contract jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE keys text[]; field text; current_mode text;
BEGIN
  keys := ARRAY(SELECT value->>'key' FROM jsonb_array_elements(contract));
  current_mode := parameters->>'speech_mode';

  IF (cardinality(keys) = 12 AND keys @> ARRAY[
    'speech_mode','llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id',
    'language','execution_policy_version','background_sound_id','interruption_level'
  ]) OR (cardinality(keys) = 10 AND keys @> ARRAY[
    'speech_mode','llm_provider','llm_model','live_provider','live_model','live_adapter','live_voice_id',
    'language','execution_policy_version','background_sound_id'
  ]) THEN
    IF NOT egma_parameter_values_valid(parameters, contract) THEN RETURN false; END IF;
    IF jsonb_typeof(parameters->'language') IS DISTINCT FROM 'string' OR btrim(parameters->>'language') = ''
      OR jsonb_typeof(parameters->'execution_policy_version') IS DISTINCT FROM 'number'
      OR (parameters->>'execution_policy_version')::numeric <> 2
      OR parameters->>'background_sound_id' NOT IN ('none','office-v1','cafe-v1','street-traffic-v1','crowd-talking-v1','inside-car-v1','home-tv-v1','wind-v1','rain-v1')
    THEN RETURN false; END IF;
    IF current_mode = 'live' THEN
      FOREACH field IN ARRAY ARRAY['llm_provider','llm_model','live_provider','live_model','live_adapter','live_voice_id'] LOOP
        IF jsonb_typeof(parameters->field) IS DISTINCT FROM 'string' OR btrim(parameters->>field) = '' THEN RETURN false; END IF;
      END LOOP;
      RETURN parameters->>'live_provider' = 'openai'
        AND parameters->>'live_model' = 'gpt-live-1'
        AND parameters->>'live_adapter' = 'openai_live';
    END IF;
    IF current_mode <> 'separate' OR parameters->>'interruption_level' NOT IN ('none','occasional','frequent') THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id'] LOOP
      IF jsonb_typeof(parameters->field) IS DISTINCT FROM 'string' OR btrim(parameters->>field) = '' THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  END IF;

  RETURN persona_parameters_valid_pre_simplification(parameters, contract);
END;
$$;

CREATE FUNCTION public.egma_current_persona_contract(parameters jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE result jsonb;
BEGIN
  result := jsonb_build_array(
    jsonb_build_object('key','speech_mode','label','Speech mode','valueType','string','defaultValue',parameters->'speech_mode','unit',NULL,'minimum',NULL,'maximum',NULL),
    jsonb_build_object('key','llm_provider','label','Language model provider','valueType','string','defaultValue',parameters->'llm_provider','unit',NULL,'minimum',NULL,'maximum',NULL),
    jsonb_build_object('key','llm_model','label','Language model','valueType','string','defaultValue',parameters->'llm_model','unit',NULL,'minimum',NULL,'maximum',NULL)
  );
  IF parameters->>'speech_mode' = 'live' THEN
    result := result || jsonb_build_array(
      jsonb_build_object('key','live_provider','label','Live speech provider','valueType','string','defaultValue',parameters->'live_provider','unit',NULL,'minimum',NULL,'maximum',NULL),
      jsonb_build_object('key','live_model','label','Live speech model','valueType','string','defaultValue',parameters->'live_model','unit',NULL,'minimum',NULL,'maximum',NULL),
      jsonb_build_object('key','live_adapter','label','Live speech adapter','valueType','string','defaultValue',parameters->'live_adapter','unit',NULL,'minimum',NULL,'maximum',NULL),
      jsonb_build_object('key','live_voice_id','label','Live voice ID','valueType','string','defaultValue',parameters->'live_voice_id','unit',NULL,'minimum',NULL,'maximum',NULL)
    );
  ELSE
    result := result || jsonb_build_array(
      jsonb_build_object('key','stt_provider','label','Speech recognition provider','valueType','string','defaultValue',parameters->'stt_provider','unit',NULL,'minimum',NULL,'maximum',NULL),
      jsonb_build_object('key','stt_model','label','Speech recognition model','valueType','string','defaultValue',parameters->'stt_model','unit',NULL,'minimum',NULL,'maximum',NULL),
      jsonb_build_object('key','tts_provider','label','Speech generation provider','valueType','string','defaultValue',parameters->'tts_provider','unit',NULL,'minimum',NULL,'maximum',NULL),
      jsonb_build_object('key','tts_model','label','Speech generation model','valueType','string','defaultValue',parameters->'tts_model','unit',NULL,'minimum',NULL,'maximum',NULL),
      jsonb_build_object('key','tts_voice_id','label','Voice ID','valueType','string','defaultValue',parameters->'tts_voice_id','unit',NULL,'minimum',NULL,'maximum',NULL)
    );
  END IF;
  result := result || jsonb_build_array(
    jsonb_build_object('key','language','label','Language','valueType','string','defaultValue',parameters->'language','unit',NULL,'minimum',NULL,'maximum',NULL),
    jsonb_build_object('key','execution_policy_version','label','Execution policy version','valueType','integer','defaultValue',parameters->'execution_policy_version','unit',NULL,'minimum',1,'maximum',2),
    jsonb_build_object('key','background_sound_id','label','Background sound','valueType','string','defaultValue',parameters->'background_sound_id','unit',NULL,'minimum',NULL,'maximum',NULL)
  );
  IF parameters->>'speech_mode' = 'separate' THEN
    result := result || jsonb_build_array(
      jsonb_build_object('key','interruption_level','label','Interruption level','valueType','string','defaultValue',parameters->'interruption_level','unit',NULL,'minimum',NULL,'maximum',NULL)
    );
  END IF;
  RETURN result;
END;
$$;

WITH reduced AS (
  SELECT saved.id,
    CASE WHEN saved.parameter_values->>'speech_mode' = 'live' THEN
      jsonb_build_object(
        'speech_mode','live','llm_provider',saved.parameter_values->'llm_provider','llm_model',saved.parameter_values->'llm_model',
        'live_provider',saved.parameter_values->'live_provider','live_model',saved.parameter_values->'live_model',
        'live_adapter',saved.parameter_values->'live_adapter','live_voice_id',saved.parameter_values->'live_voice_id',
        'language',COALESCE(saved.parameter_values->'language',to_jsonb(version.language),'"en-US"'::jsonb),
        'execution_policy_version',2,'background_sound_id',COALESCE(saved.parameter_values->'background_sound_id','"none"'::jsonb)
      )
    ELSE
      jsonb_build_object(
        'speech_mode','separate','llm_provider',saved.parameter_values->'llm_provider','llm_model',saved.parameter_values->'llm_model',
        'stt_provider',saved.parameter_values->'stt_provider','stt_model',saved.parameter_values->'stt_model',
        'tts_provider',saved.parameter_values->'tts_provider','tts_model',saved.parameter_values->'tts_model','tts_voice_id',saved.parameter_values->'tts_voice_id',
        'language',COALESCE(saved.parameter_values->'language',to_jsonb(version.language),'"en-US"'::jsonb),
        'execution_policy_version',2,'background_sound_id',COALESCE(saved.parameter_values->'background_sound_id','"none"'::jsonb),
        'interruption_level',to_jsonb(CASE WHEN saved.parameter_values->>'interruption_level' IN ('occasional','frequent') THEN saved.parameter_values->>'interruption_level' ELSE 'none' END)
      )
    END AS parameter_values
  FROM public.project_persona saved
  JOIN public.persona_definition definition ON definition.id = saved.persona_definition_id
  JOIN public.persona_definition_version version ON version.id = definition.current_version_id
)
UPDATE public.project_persona saved
SET parameter_values = reduced.parameter_values,
    parameter_contract = public.egma_current_persona_contract(reduced.parameter_values),
    updated_at = now()
FROM reduced WHERE reduced.id = saved.id;

INSERT INTO public.persona_definition_version (
  id, persona_id, version, identity_name, personality, language, parameter_contract, created_by, created_at
)
SELECT 'prsv_' || upper(substr(md5(definition.id || ':' || current.version::text || ':persona-settings-simplification'), 1, 26)),
  definition.id, current.version + 1, current.identity_name, current.personality, NULL,
  saved.parameter_contract, current.created_by, now()
FROM public.persona_definition definition
JOIN public.persona_definition_version current ON current.id = definition.current_version_id
JOIN public.project_persona saved ON saved.persona_definition_id = definition.id
WHERE definition.organization_id IS NOT NULL;

UPDATE public.persona_definition definition
SET current_version_id = 'prsv_' || upper(substr(md5(definition.id || ':' || current.version::text || ':persona-settings-simplification'), 1, 26)),
    updated_at = now()
FROM public.persona_definition_version current
WHERE current.id = definition.current_version_id AND definition.organization_id IS NOT NULL;

DROP FUNCTION public.egma_current_persona_contract(jsonb);
