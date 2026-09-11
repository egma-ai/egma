ALTER TABLE public.project_persona ADD COLUMN IF NOT EXISTS parameter_contract jsonb;

UPDATE public.project_persona saved SET parameter_contract = version.parameter_contract
FROM public.persona_definition definition, public.persona_definition_version version
WHERE saved.persona_definition_id = definition.id AND version.id = definition.current_version_id AND saved.parameter_contract IS NULL;

ALTER TABLE public.project_persona ALTER COLUMN parameter_contract SET NOT NULL;

ALTER TABLE public.simulation ADD COLUMN IF NOT EXISTS persona_parameter_contract jsonb;

CREATE OR REPLACE FUNCTION public.persona_parameters_valid(parameters jsonb, contract jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE keys text[]; field text; current_mode text;
BEGIN
  IF NOT egma_parameter_values_valid(parameters, contract) THEN RETURN false; END IF;
  keys := ARRAY(SELECT value->>'key' FROM jsonb_array_elements(contract));
  current_mode := parameters->>'speech_mode';
  IF NOT (
    cardinality(keys) = 8 AND keys @> ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id','tts_speed']
  ) AND NOT (
    cardinality(keys) = 13 AND keys @> ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id','tts_speed','language','emotion','accent','speech_volume','execution_policy_version']
  ) AND NOT (
    cardinality(keys) = 15 AND keys @> ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id','tts_speed','language','emotion','accent','speech_volume','execution_policy_version','background_sound_id','background_volume']
  ) AND NOT (
    cardinality(keys) = 16 AND keys @> ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id','tts_speed','language','emotion','accent','speech_volume','execution_policy_version','background_sound_id','background_volume','interruption_level']
  ) AND NOT (
    cardinality(keys) = 17 AND keys @> ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id','tts_speed','language','emotion','accent','speech_volume','execution_policy_version','background_sound_id','background_volume','interruption_level','speech_speed']
  ) AND NOT (
    cardinality(keys) = 18 AND keys @> ARRAY['speech_mode','llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id','tts_speed','language','emotion','accent','speech_volume','execution_policy_version','background_sound_id','background_volume','interruption_level','speech_speed']
  ) AND NOT (
    cardinality(keys) = 17 AND keys @> ARRAY['speech_mode','llm_provider','llm_model','live_provider','live_model','live_adapter','live_voice_id','tts_speed','language','emotion','accent','speech_volume','execution_policy_version','background_sound_id','background_volume','interruption_level','speech_speed']
  ) THEN RETURN false; END IF;

  IF current_mode = 'live' THEN
    FOREACH field IN ARRAY ARRAY['llm_provider','llm_model','live_provider','live_model','live_adapter','live_voice_id'] LOOP
      IF jsonb_typeof(parameters->field) IS DISTINCT FROM 'string' OR btrim(parameters->>field) = '' THEN RETURN false; END IF;
    END LOOP;
    IF parameters->>'live_provider' <> 'openai' OR parameters->>'live_model' <> 'gpt-live-1' OR parameters->>'live_adapter' <> 'openai_live' THEN RETURN false; END IF;
  ELSE
    FOREACH field IN ARRAY ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id'] LOOP
      IF jsonb_typeof(parameters->field) IS DISTINCT FROM 'string' OR btrim(parameters->>field) = '' THEN RETURN false; END IF;
    END LOOP;
    IF jsonb_typeof(parameters->'tts_speed') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  END IF;

  IF keys @> ARRAY['language'] AND (
    jsonb_typeof(parameters->'language') IS DISTINCT FROM 'string' OR btrim(parameters->>'language') = ''
    OR jsonb_typeof(parameters->'emotion') IS DISTINCT FROM 'string' OR parameters->>'emotion' NOT IN ('neutral','happy','angry','frustrated','sad','anxious')
    OR jsonb_typeof(parameters->'accent') IS DISTINCT FROM 'string' OR btrim(parameters->>'accent') = ''
    OR jsonb_typeof(parameters->'speech_volume') IS DISTINCT FROM 'number' OR (parameters->>'speech_volume')::numeric NOT BETWEEN 0.5 AND 1.5
    OR jsonb_typeof(parameters->'execution_policy_version') IS DISTINCT FROM 'number'
    OR trunc((parameters->>'execution_policy_version')::numeric) <> (parameters->>'execution_policy_version')::numeric
    OR (parameters->>'execution_policy_version')::numeric < 1
  ) THEN RETURN false; END IF;
  IF current_mode IS NULL AND keys @> ARRAY['language'] AND (parameters->>'tts_speed')::numeric NOT BETWEEN 0.25 AND 4 THEN RETURN false;
  ELSIF current_mode IS NULL AND NOT keys @> ARRAY['language'] AND (parameters->>'tts_speed')::numeric NOT BETWEEN 0.6 AND 1.5 THEN RETURN false; END IF;
  IF keys @> ARRAY['background_sound_id'] AND (
    parameters->>'background_sound_id' NOT IN ('none','office-v1','cafe-v1','street-traffic-v1','crowd-talking-v1','inside-car-v1','home-tv-v1','wind-v1','rain-v1')
    OR jsonb_typeof(parameters->'background_volume') IS DISTINCT FROM 'number'
    OR (parameters->>'background_volume')::numeric NOT BETWEEN 0.015848931924611134 AND 0.251188643150958
  ) THEN RETURN false; END IF;
  IF keys @> ARRAY['speech_speed'] AND (
    parameters->>'speech_speed' NOT IN ('slow','normal','fast')
    OR parameters->>'interruption_level' NOT IN ('none','occasional','frequent')
    OR (parameters->>'execution_policy_version')::numeric <> 2
    OR (parameters->>'tts_speed')::numeric <> (CASE parameters->>'speech_speed' WHEN 'slow' THEN 0.8 WHEN 'normal' THEN 1.0 WHEN 'fast' THEN 1.5 END)
  ) THEN RETURN false;
  ELSIF keys @> ARRAY['interruption_level'] AND NOT keys @> ARRAY['speech_speed'] AND parameters->>'interruption_level' NOT IN ('off','occasional','frequent') THEN RETURN false; END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_project_persona() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE held persona_definition; core_contract jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.persona_definition_id IS DISTINCT FROM OLD.persona_definition_id) THEN
    RAISE check_violation USING MESSAGE = 'project persona ownership cannot change';
  END IF;
  SELECT * INTO held FROM persona_definition WHERE id = NEW.persona_definition_id FOR SHARE;
  IF NOT FOUND OR (held.organization_id IS NOT NULL AND
     (held.organization_id IS DISTINCT FROM NEW.organization_id OR held.project_id IS DISTINCT FROM NEW.project_id)) THEN
    RAISE foreign_key_violation USING MESSAGE = 'persona is not available in this project';
  END IF;
  SELECT parameter_contract INTO STRICT core_contract FROM persona_definition_version WHERE id = held.current_version_id;
  IF NOT persona_parameters_valid(NEW.parameter_values, NEW.parameter_contract) THEN
    IF persona_parameters_valid(NEW.parameter_values, core_contract) THEN
      NEW.parameter_contract := core_contract;
    ELSE
      RAISE check_violation USING MESSAGE = 'persona settings are invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_simulation_persona_parameters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE core_contract jsonb; settings_found boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.persona_id IS DISTINCT FROM OLD.persona_id
     OR NEW.persona_version_id IS DISTINCT FROM OLD.persona_version_id
     OR NEW.persona_parameter_values IS DISTINCT FROM OLD.persona_parameter_values
     OR NEW.persona_parameter_contract IS DISTINCT FROM OLD.persona_parameter_contract) THEN
    RAISE check_violation USING MESSAGE = 'a simulation persona selection is immutable';
  END IF;
  SELECT parameter_contract INTO core_contract FROM persona_definition_version
    WHERE id = NEW.persona_version_id AND persona_id = NEW.persona_id;
  IF NOT FOUND THEN RAISE foreign_key_violation USING MESSAGE = 'simulation persona version does not belong to the selected persona'; END IF;
  IF TG_OP = 'INSERT' AND NEW.persona_parameter_contract IS NOT NULL THEN
    SELECT true INTO settings_found FROM project_persona
      WHERE organization_id = NEW.organization_id AND project_id = NEW.project_id
        AND persona_definition_id = NEW.persona_id
        AND parameter_values = NEW.persona_parameter_values
        AND parameter_contract = NEW.persona_parameter_contract;
    IF NOT COALESCE(settings_found, false) THEN
      RAISE check_violation USING MESSAGE = 'simulation persona settings do not match the selected project settings';
    END IF;
  END IF;
  IF NOT persona_parameters_valid(NEW.persona_parameter_values, COALESCE(NEW.persona_parameter_contract, core_contract)) THEN
    RAISE check_violation USING MESSAGE = 'simulation persona settings are invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS simulation_persona_parameters_guard ON public.simulation;
CREATE TRIGGER simulation_persona_parameters_guard
BEFORE INSERT OR UPDATE OF persona_id, persona_version_id, persona_parameter_values, persona_parameter_contract
ON public.simulation FOR EACH ROW EXECUTE FUNCTION public.guard_simulation_persona_parameters();
