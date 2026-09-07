-- One-time PostgreSQL cutover for project model settings and core versions.
-- Destructive under packages/db/migrations/README.md, "Before launch", and the
-- approved removal of disposable prelaunch execution history. The runner supplies
-- one transaction and its migration advisory lock. Apply with workers stopped.
--
-- Preserved: tenancy, credentials, agents/connections, tests and their selections,
-- persona definitions and every persona version ID, shared grader definitions and
-- versions, and structurally valid shared trusted-code grader settings/policy.
-- Removed: disposable runs/simulations/events/plans/jobs and start-run receipts;
-- old LLM project settings, invalid code settings, and organization-wide custom
-- graders whose single project owner cannot be inferred without changing access.
-- Persona settings are initialized ONCE from this release's canonical contract;
-- removed historical model columns are not interpreted or copied.
--
-- Companion ClickHouse cutover must clear disposable grades/production receipts
-- and add grades.parameter_values String. No ClickHouse statement belongs here.

DELETE FROM grading_job;
DELETE FROM run;
DELETE FROM idempotent_operation WHERE operation = 'start_run';

-- Structural contract validation only. Supported provider/model combinations
-- remain in the application's existing catalog, never a second SQL registry.
CREATE FUNCTION public.egma_parameter_values_valid(parameters jsonb, contract jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; candidate jsonb; key_name text; seen text[] := '{}';
BEGIN
  IF jsonb_typeof(parameters) IS DISTINCT FROM 'object'
     OR jsonb_typeof(contract) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(contract) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
       OR NOT item ?& ARRAY['key','label','valueType','defaultValue','unit','minimum','maximum']
       OR item - ARRAY['key','label','valueType','defaultValue','unit','minimum','maximum'] <> '{}'::jsonb
       OR jsonb_typeof(item->'key') IS DISTINCT FROM 'string'
       OR (item->>'key') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
       OR jsonb_typeof(item->'label') IS DISTINCT FROM 'string'
       OR btrim(item->>'label') = ''
       OR (item->>'valueType') IS NULL
       OR (item->>'valueType') NOT IN ('string','number','integer') THEN RETURN false; END IF;
    key_name := item->>'key';
    IF key_name = ANY(seen) OR NOT parameters ? key_name THEN RETURN false; END IF;
    seen := array_append(seen, key_name);
    IF item->>'valueType' = 'string' THEN
      IF item->'minimum' <> 'null'::jsonb OR item->'maximum' <> 'null'::jsonb
         OR item->'unit' <> 'null'::jsonb THEN RETURN false; END IF;
    ELSE
      IF (item->'minimum' <> 'null'::jsonb AND jsonb_typeof(item->'minimum') <> 'number')
         OR (item->'maximum' <> 'null'::jsonb AND jsonb_typeof(item->'maximum') <> 'number')
         OR (item->'unit' <> 'null'::jsonb AND
             (jsonb_typeof(item->'unit') <> 'string' OR btrim(item->>'unit') = '')) THEN RETURN false; END IF;
      IF (item->>'minimum')::numeric > (item->>'maximum')::numeric THEN RETURN false; END IF;
      IF item->>'valueType' = 'integer' AND
         (trunc((item->>'minimum')::numeric) <> (item->>'minimum')::numeric OR
          trunc((item->>'maximum')::numeric) <> (item->>'maximum')::numeric) THEN RETURN false; END IF;
    END IF;
    FOREACH candidate IN ARRAY ARRAY[parameters->key_name, item->'defaultValue'] LOOP
      IF item->>'valueType' = 'string' THEN
        IF jsonb_typeof(candidate) IS DISTINCT FROM 'string'
           OR btrim(candidate#>>'{}') = '' THEN RETURN false; END IF;
      ELSE
        IF jsonb_typeof(candidate) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
        IF item->>'valueType' = 'integer' AND
           trunc((candidate#>>'{}')::numeric) <> (candidate#>>'{}')::numeric THEN RETURN false; END IF;
        IF (candidate#>>'{}')::numeric < (item->>'minimum')::numeric OR
           (candidate#>>'{}')::numeric > (item->>'maximum')::numeric THEN RETURN false; END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN parameters - seen = '{}'::jsonb;
END;
$$;

-- Keep only code settings already valid for a shared current core. A missing
-- LLM choice is not repaired from a removed judge_model or today's defaults.
-- The retired mean-latency key is also discarded, even when its older core
-- still declares it. This release grades p90 and does not reinterpret that value.
DELETE FROM project_grader AS pg
USING grader_definition AS d, grader_definition_version AS v
WHERE pg.grader_definition_id = d.id
  AND v.definition_id = d.id AND v.version = d.current_definition_version
  AND (d.organization_id IS NOT NULL OR v.type = 'llm_as_judge'
       OR (d.id = 'grl_01M0TQE5HBE1X9PDN9HFJC987Q'
           AND pg.parameter_values ? 'maximum_average_response_time_ms')
       OR NOT egma_parameter_values_valid(pg.parameter_values, v.parameter_contract));
DELETE FROM grader_definition WHERE organization_id IS NOT NULL;

-- Resolve the deferred current-version foreign keys before altering tables that
-- their cascading deletes touched. This validates queued events; it does not
-- disable or skip any constraint. The transaction restores normal timing.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE grader_definition ADD COLUMN project_id text COLLATE "C";
ALTER TABLE grader_definition ADD CONSTRAINT grader_definition_ownership_pair
  CHECK ((organization_id IS NULL) = (project_id IS NULL));
ALTER TABLE grader_definition ADD CONSTRAINT grader_definition_project_organization_fk
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE;
ALTER TABLE grader_definition_version DROP COLUMN judge_model;

CREATE FUNCTION public.guard_grader_definition_ownership_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE check_violation USING MESSAGE = 'grader definition ownership is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER grader_definition_ownership_immutable_guard
  BEFORE UPDATE OF organization_id, project_id ON grader_definition
  FOR EACH ROW EXECUTE FUNCTION guard_grader_definition_ownership_immutable();

CREATE FUNCTION public.guard_project_grader_definition_ownership()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held grader_definition; core grader_definition_version;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.grader_definition_id IS DISTINCT FROM OLD.grader_definition_id) THEN
    RAISE check_violation USING MESSAGE = 'project grader ownership is immutable';
  END IF;
  SELECT * INTO held FROM grader_definition WHERE id = NEW.grader_definition_id FOR SHARE;
  IF NOT FOUND OR (held.organization_id IS NOT NULL AND
     (held.organization_id IS DISTINCT FROM NEW.organization_id OR held.project_id IS DISTINCT FROM NEW.project_id)) THEN
    RAISE foreign_key_violation USING MESSAGE = 'grader definition is not available in this project';
  END IF;
  SELECT * INTO STRICT core FROM grader_definition_version
    WHERE definition_id = held.id AND version = held.current_definition_version;
  IF NOT egma_parameter_values_valid(NEW.parameter_values, core.parameter_contract)
     OR (core.type = 'llm_as_judge' AND NOT NEW.parameter_values ?& ARRAY['llm_provider','llm_model']) THEN
    RAISE check_violation USING MESSAGE = 'grader settings are invalid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_grader_definition_ownership_guard
  BEFORE INSERT OR UPDATE ON project_grader
  FOR EACH ROW EXECUTE FUNCTION guard_project_grader_definition_ownership();

-- Existing foreign keys follow table OIDs through a rename. Retained explicit
-- constraint/index names stay as the schema source declares them.
DROP TRIGGER persona_version_semantics_immutable_guard ON persona_version;
ALTER TABLE persona RENAME TO persona_definition;
ALTER TABLE persona_version RENAME TO persona_definition_version;
ALTER TABLE persona_definition RENAME CONSTRAINT persona_pkey TO persona_definition_pkey;
ALTER TABLE persona_definition RENAME CONSTRAINT persona_organization_id_organization_id_fk TO persona_definition_organization_id_organization_id_fk;
ALTER TABLE persona_definition RENAME CONSTRAINT persona_current_version_id_persona_version_id_fk TO persona_definition_current_version_id_persona_definition_version_id_fk;
ALTER TABLE persona_definition RENAME CONSTRAINT persona_created_by_user_id_fk TO persona_definition_created_by_user_id_fk;
ALTER TABLE persona_definition_version RENAME CONSTRAINT persona_version_pkey TO persona_definition_version_pkey;
ALTER TABLE persona_definition_version RENAME CONSTRAINT persona_version_persona_id_persona_id_fk TO persona_definition_version_persona_id_persona_definition_id_fk;
ALTER TABLE persona_definition_version RENAME CONSTRAINT persona_version_created_by_user_id_fk TO persona_definition_version_created_by_user_id_fk;
ALTER TABLE test_persona RENAME CONSTRAINT test_persona_persona_id_persona_id_fk TO test_persona_persona_id_persona_definition_id_fk;
ALTER TABLE persona_definition_version ADD COLUMN parameter_contract jsonb;
UPDATE persona_definition_version SET parameter_contract = '[{"key":"llm_provider","label":"Language model provider","valueType":"string","defaultValue":"openai","unit":null,"minimum":null,"maximum":null},{"key":"llm_model","label":"Language model","valueType":"string","defaultValue":"gpt-5.6-terra","unit":null,"minimum":null,"maximum":null},{"key":"stt_provider","label":"Speech recognition provider","valueType":"string","defaultValue":"openai","unit":null,"minimum":null,"maximum":null},{"key":"stt_model","label":"Speech recognition model","valueType":"string","defaultValue":"gpt-live-transcribe","unit":null,"minimum":null,"maximum":null},{"key":"tts_provider","label":"Speech generation provider","valueType":"string","defaultValue":"cartesia","unit":null,"minimum":null,"maximum":null},{"key":"tts_model","label":"Speech generation model","valueType":"string","defaultValue":"sonic-3.5","unit":null,"minimum":null,"maximum":null},{"key":"tts_voice_id","label":"Voice ID","valueType":"string","defaultValue":"5ee9feff-1265-424a-9d7f-8e4d431a12c7","unit":null,"minimum":null,"maximum":null},{"key":"tts_speed","label":"Speaking speed","valueType":"number","defaultValue":1,"unit":null,"minimum":0.6,"maximum":1.5}]'::jsonb;
ALTER TABLE persona_definition_version ALTER COLUMN parameter_contract SET NOT NULL;
ALTER TABLE persona_definition_version ADD CONSTRAINT persona_definition_version_parameter_contract_is_array
  CHECK (jsonb_typeof(parameter_contract) = 'array');
ALTER TABLE persona_definition_version
  DROP COLUMN llm_provider, DROP COLUMN llm_model, DROP COLUMN stt_provider, DROP COLUMN stt_model,
  DROP COLUMN tts_provider, DROP COLUMN tts_model, DROP COLUMN tts_voice_id, DROP COLUMN tts_speed;

CREATE TABLE project_persona (
  id text COLLATE "C" PRIMARY KEY,
  organization_id text COLLATE "C" NOT NULL,
  project_id text COLLATE "C" NOT NULL,
  persona_definition_id text COLLATE "C" NOT NULL,
  parameter_values jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_persona_id_prefix CHECK (id ~ '^ppr_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT project_persona_parameters_are_object CHECK (jsonb_typeof(parameter_values) = 'object'),
  CONSTRAINT project_persona_organization_id_organization_id_fk
    FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE CASCADE,
  CONSTRAINT project_persona_persona_definition_id_persona_definition_id_fk
    FOREIGN KEY (persona_definition_id) REFERENCES persona_definition(id),
  CONSTRAINT project_persona_project_organization_fk
    FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT project_persona_project_definition_unique UNIQUE (project_id, persona_definition_id)
);
ALTER TABLE simulation ADD COLUMN persona_parameter_values jsonb NOT NULL;

CREATE OR REPLACE FUNCTION public.persona_is_available_to_project(wanted_persona_id text, wanted_project_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM persona_definition p JOIN project target ON target.id = wanted_project_id
    WHERE p.id = wanted_persona_id AND
      ((p.organization_id IS NULL AND p.project_id IS NULL) OR
       (p.project_id = target.id AND p.organization_id = target.organization_id)));
$$;

CREATE FUNCTION public.persona_parameters_valid(parameters jsonb, contract jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE field text;
BEGIN
  IF NOT egma_parameter_values_valid(parameters, contract)
     OR parameters - ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id','tts_speed'] <> '{}'::jsonb
     OR NOT parameters ?& ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id','tts_speed'] THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['llm_provider','llm_model','stt_provider','stt_model','tts_provider','tts_model','tts_voice_id'] LOOP
    IF jsonb_typeof(parameters->field) IS DISTINCT FROM 'string' OR btrim(parameters->>field) = '' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(parameters->'tts_speed') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  RETURN (parameters->>'tts_speed')::numeric BETWEEN 0.6 AND 1.5;
END;
$$;

CREATE FUNCTION public.guard_definition_parameter_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE defaults jsonb;
BEGIN
  IF jsonb_typeof(NEW.parameter_contract) IS DISTINCT FROM 'array' THEN
    RAISE check_violation USING MESSAGE = 'a parameter contract must be a list';
  END IF;
  SELECT coalesce(jsonb_object_agg(field->>'key', field->'defaultValue'), '{}'::jsonb)
    INTO defaults FROM jsonb_array_elements(NEW.parameter_contract) field;
  IF NOT egma_parameter_values_valid(defaults, NEW.parameter_contract) THEN
    RAISE check_violation USING MESSAGE = 'a parameter contract has invalid fields or defaults';
  END IF;
  IF TG_TABLE_NAME = 'persona_definition_version' AND
     NOT persona_parameters_valid(defaults, NEW.parameter_contract) THEN
    RAISE check_violation USING MESSAGE = 'a persona contract must declare complete model, voice and speed settings';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER grader_definition_parameter_contract_guard BEFORE INSERT ON grader_definition_version
  FOR EACH ROW EXECUTE FUNCTION guard_definition_parameter_contract();
CREATE TRIGGER persona_definition_parameter_contract_guard BEFORE INSERT ON persona_definition_version
  FOR EACH ROW EXECUTE FUNCTION guard_definition_parameter_contract();

CREATE OR REPLACE FUNCTION public.guard_persona_version_semantics_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.persona_id IS DISTINCT FROM OLD.persona_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.identity_name IS DISTINCT FROM OLD.identity_name OR NEW.personality IS DISTINCT FROM OLD.personality
     OR NEW.language IS DISTINCT FROM OLD.language OR NEW.parameter_contract IS DISTINCT FROM OLD.parameter_contract THEN
    RAISE check_violation USING CONSTRAINT = 'persona_version_semantics_immutable', MESSAGE = 'a persona core version cannot change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER persona_version_semantics_immutable_guard BEFORE UPDATE ON persona_definition_version
  FOR EACH ROW EXECUTE FUNCTION guard_persona_version_semantics_immutable();

CREATE FUNCTION public.guard_project_persona() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held persona_definition; contract jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.persona_definition_id IS DISTINCT FROM OLD.persona_definition_id) THEN
    RAISE check_violation USING MESSAGE = 'project persona ownership cannot change';
  END IF;
  SELECT * INTO held FROM persona_definition WHERE id = NEW.persona_definition_id FOR SHARE;
  IF NOT FOUND OR (held.organization_id IS NOT NULL AND
     (held.organization_id IS DISTINCT FROM NEW.organization_id OR held.project_id IS DISTINCT FROM NEW.project_id)) THEN
    RAISE foreign_key_violation USING MESSAGE = 'persona is not available to this project';
  END IF;
  SELECT parameter_contract INTO STRICT contract FROM persona_definition_version WHERE id = held.current_version_id;
  IF NOT persona_parameters_valid(NEW.parameter_values, contract) THEN
    RAISE check_violation USING MESSAGE = 'persona settings are invalid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_persona_guard BEFORE INSERT OR UPDATE ON project_persona
  FOR EACH ROW EXECUTE FUNCTION guard_project_persona();

CREATE FUNCTION public.guard_simulation_persona_parameters() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE contract jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.persona_id IS DISTINCT FROM OLD.persona_id
     OR NEW.persona_version_id IS DISTINCT FROM OLD.persona_version_id
     OR NEW.persona_parameter_values IS DISTINCT FROM OLD.persona_parameter_values) THEN
    RAISE check_violation USING MESSAGE = 'a simulation persona selection is immutable';
  END IF;
  SELECT parameter_contract INTO contract FROM persona_definition_version
    WHERE id = NEW.persona_version_id AND persona_id = NEW.persona_id;
  IF NOT FOUND THEN RAISE foreign_key_violation USING MESSAGE = 'simulation persona version does not belong to the selected persona'; END IF;
  IF NOT persona_parameters_valid(NEW.persona_parameter_values, contract) THEN
    RAISE check_violation USING MESSAGE = 'simulation persona settings are invalid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER simulation_persona_parameters_guard
  BEFORE INSERT OR UPDATE OF persona_id, persona_version_id, persona_parameter_values ON simulation
  FOR EACH ROW EXECUTE FUNCTION guard_simulation_persona_parameters();

-- Mint migration-only IDs in Egma's UUIDv7/Crockford format. No permanent ID
-- generator or extension is installed; pg_temp exists only in this session.
CREATE FUNCTION pg_temp.new_project_persona_id() RETURNS text LANGUAGE plpgsql AS $$
DECLARE bytes bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  milliseconds bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  value numeric := 0; encoded text := ''; position integer;
BEGIN
  FOR position IN 0..5 LOOP bytes := set_byte(bytes, position, ((milliseconds >> ((5-position)*8)) & 255)::integer); END LOOP;
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);
  FOR position IN 0..15 LOOP value := value * 256 + get_byte(bytes, position); END LOOP;
  FOR position IN 1..26 LOOP
    encoded := substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', mod(value, 32)::integer + 1, 1) || encoded;
    value := trunc(value / 32);
  END LOOP;
  RETURN 'ppr_' || encoded;
END;
$$;

-- Existing custom personas remain immediately usable. Existing test selections
-- (including historical test versions) keep their definition IDs and acquire
-- one project settings row. No cross-product of every project and shared core.
INSERT INTO project_persona (id, organization_id, project_id, persona_definition_id, parameter_values)
SELECT pg_temp.new_project_persona_id(), selected.organization_id, selected.project_id, selected.persona_id,
       (SELECT jsonb_object_agg(field->>'key', field->'defaultValue') FROM jsonb_array_elements(v.parameter_contract) field)
FROM (
  SELECT p.organization_id, p.project_id, p.id AS persona_id FROM persona_definition p WHERE p.project_id IS NOT NULL
  UNION
  SELECT t.organization_id, t.project_id, tp.persona_id FROM test_persona tp
    JOIN test_version tv ON tv.id = tp.test_version_id JOIN test t ON t.id = tv.test_id
) selected
JOIN persona_definition p ON p.id = selected.persona_id
JOIN persona_definition_version v ON v.id = p.current_version_id;
DROP FUNCTION pg_temp.new_project_persona_id();

-- No state or secondary plan identity remains. Run creation constructs this
-- complete value before inserting the run; a placeholder followed by UPDATE
-- is deliberately refused by the guard.
ALTER TABLE run ADD COLUMN grading_plan jsonb NOT NULL;
DROP TABLE grading_plan;
CREATE FUNCTION public.guard_run_grading_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.grading_plan IS DISTINCT FROM OLD.grading_plan THEN
    RAISE check_violation USING MESSAGE = 'a run grading plan is immutable';
  END IF;
  IF jsonb_typeof(NEW.grading_plan) IS DISTINCT FROM 'object'
     OR NEW.grading_plan - ARRAY['capturedAt','groups'] <> '{}'::jsonb
     OR jsonb_typeof(NEW.grading_plan->'groups') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.grading_plan->'capturedAt') IS DISTINCT FROM 'string'
     OR btrim(NEW.grading_plan->>'capturedAt') = '' THEN
    RAISE check_violation USING MESSAGE = 'a run grading plan needs capture time and groups';
  END IF;
  PERFORM (NEW.grading_plan->>'capturedAt')::timestamptz;
  RETURN NEW;
END;
$$;
CREATE TRIGGER run_grading_plan_guard BEFORE INSERT OR UPDATE OF grading_plan ON run
  FOR EACH ROW EXECUTE FUNCTION guard_run_grading_plan();

CREATE FUNCTION public.guard_grading_job_selection_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.organization_id, NEW.project_id, NEW.source, NEW.simulation_id, NEW.trace_id,
         NEW.trace_started_at, NEW.run_id, NEW.entries) IS DISTINCT FROM
     ROW(OLD.organization_id, OLD.project_id, OLD.source, OLD.simulation_id, OLD.trace_id,
         OLD.trace_started_at, OLD.run_id, OLD.entries) THEN
    RAISE check_violation USING MESSAGE = 'a grading job selection is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER grading_job_selection_immutable_guard BEFORE UPDATE ON grading_job
  FOR EACH ROW EXECUTE FUNCTION guard_grading_job_selection_immutable();

-- No NOT VALID constraints, disabled triggers, session_replication_role changes,
-- or permanent fallback defaults are left behind. Model capability and shared
-- release compatibility are checked by the normal application before publish.
