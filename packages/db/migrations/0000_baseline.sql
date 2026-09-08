-- Fresh Postgres schema, including the named checks, functions and triggers.
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL check_function_bodies = false;

--
-- Name: egma_parameter_values_valid(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.egma_parameter_values_valid(parameters jsonb, contract jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
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
$_$;


--
-- Name: guard_definition_parameter_contract(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_definition_parameter_contract() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_grader_definition_ownership_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_grader_definition_ownership_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE check_violation USING MESSAGE = 'grader definition ownership is immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_grader_definition_version_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_grader_definition_version_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'grader definition versions are immutable';
END;
$$;


--
-- Name: guard_grading_job_selection_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_grading_job_selection_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_persona_ownership_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_persona_ownership_immutable() RETURNS trigger
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
$$;


--
-- Name: guard_persona_version_semantics_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_persona_version_semantics_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.persona_id IS DISTINCT FROM OLD.persona_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.identity_name IS DISTINCT FROM OLD.identity_name OR NEW.personality IS DISTINCT FROM OLD.personality
     OR NEW.language IS DISTINCT FROM OLD.language OR NEW.parameter_contract IS DISTINCT FROM OLD.parameter_contract THEN
    RAISE check_violation USING CONSTRAINT = 'persona_version_semantics_immutable', MESSAGE = 'a persona core version cannot change';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_project_grader_definition_ownership(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_project_grader_definition_ownership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_project_persona(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_project_persona() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_run_event_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_run_event_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'event % of run % is written once, and what happened cannot be rewritten',
    OLD.seq, OLD.run_id;
END
$$;


--
-- Name: guard_run_grading_plan(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_run_grading_plan() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_run_lifecycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_run_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- The counts and finished_at land together, once; after that the header is
  -- frozen and a retry is a new run. The one carve-out below is the cleanup
  -- bookkeeping, which is about somebody's Retell account rather than about
  -- this run's numbers.
  IF OLD.finished_at IS NOT NULL THEN
    IF (NEW.temp_mock_agent_version_cleanup IS DISTINCT FROM OLD.temp_mock_agent_version_cleanup
        OR NEW.mock_metadata IS DISTINCT FROM OLD.mock_metadata)
       AND (to_jsonb(NEW) - 'temp_mock_agent_version_cleanup' - 'mock_metadata')
         = (to_jsonb(OLD) - 'temp_mock_agent_version_cleanup' - 'mock_metadata')
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'run % is finished, and a finished run''s header is written once',
      OLD.id;
  END IF;

  IF NEW.expected_simulation_count <> OLD.expected_simulation_count THEN
    RAISE EXCEPTION 'run % expected % simulations, and the expectation is set once at start',
      OLD.id, OLD.expected_simulation_count;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'pending' AND NEW.status IN ('running', 'canceled'))
  OR (OLD.status = 'running' AND NEW.status IN ('completed', 'canceled'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'run % may not move from % to %', OLD.id, OLD.status, NEW.status;
END
$$;


--
-- Name: guard_simulation_lifecycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_simulation_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF OLD.status IN ('completed', 'failed', 'canceled') THEN
		RAISE EXCEPTION 'simulation % is %, and a terminal simulation is written once',
			OLD.id, OLD.status;
	END IF;

	IF NEW.status = OLD.status THEN
		RETURN NEW;
	END IF;

	IF (OLD.status = 'queued' AND NEW.status IN ('claimed', 'canceled'))
	OR (OLD.status = 'claimed' AND NEW.status IN ('queued', 'running', 'failed', 'canceled'))
	OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'canceled'))
	THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'simulation % may not move from % to %',
		OLD.id, OLD.status, NEW.status;
END
$$;


--
-- Name: guard_simulation_persona_availability(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_simulation_persona_availability() RETURNS trigger
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
$$;


--
-- Name: guard_simulation_persona_parameters(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_simulation_persona_parameters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_test_ownership_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_test_ownership_immutable() RETURNS trigger
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
$$;


--
-- Name: guard_test_persona_availability(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_test_persona_availability() RETURNS trigger
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
$$;


--
-- Name: guard_test_suite_membership(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_test_suite_membership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF NEW.suite_id IS DISTINCT FROM OLD.suite_id THEN
		RAISE EXCEPTION 'test % belongs to suite % for life', OLD.id, OLD.suite_id
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;


--
-- Name: guard_test_version_test_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_test_version_test_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF NEW.test_id IS DISTINCT FROM OLD.test_id
	THEN
		RAISE EXCEPTION 'a test version cannot move between tests';
	END IF;
	RETURN NEW;
END;
$$;


--
-- Name: persona_is_available_to_project(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.persona_is_available_to_project(wanted_persona_id text, wanted_project_id text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT EXISTS (SELECT 1 FROM persona_definition p JOIN project target ON target.id = wanted_project_id
    WHERE p.id = wanted_persona_id AND
      ((p.organization_id IS NULL AND p.project_id IS NULL) OR
       (p.project_id = target.id AND p.organization_id = target.organization_id)));
$$;


--
-- Name: persona_parameters_valid(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.persona_parameters_valid(parameters jsonb, contract jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
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




--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL COLLATE pg_catalog."C",
    user_id text NOT NULL COLLATE pg_catalog."C",
    account_id text NOT NULL,
    provider_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_id_prefix CHECK ((id ~ '^acc_[0-9A-HJKMNP-TV-Z]{26}$'::text))
);


--
-- Name: agent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text NOT NULL COLLATE pg_catalog."C",
    name text NOT NULL,
    agent_platform text NOT NULL,
    platform_agent_id text,
    monitoring_api_key text,
    monitoring_api_key_hint text,
    pull_production_calls boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    created_by text COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_archived_releases_pull CHECK (((pull_production_calls = false) OR (archived_at IS NULL))),
    CONSTRAINT agent_id_prefix CHECK ((id ~ '^agt_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT agent_monitoring_key_hint_agrees CHECK (((monitoring_api_key IS NULL) = (monitoring_api_key_hint IS NULL))),
    CONSTRAINT agent_monitoring_key_needs_platform CHECK (((monitoring_api_key IS NULL) OR (agent_platform IS NOT NULL))),
    CONSTRAINT agent_platform_allowed CHECK ((agent_platform = ANY (ARRAY['retell'::text, 'livekit'::text]))),
    CONSTRAINT agent_pull_needs_binding CHECK (((pull_production_calls = false) OR ((agent_platform IS NOT NULL) AND (platform_agent_id IS NOT NULL) AND (monitoring_api_key IS NOT NULL))))
);


--
-- Name: api_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_key (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text COLLATE pg_catalog."C",
    scope text NOT NULL,
    hash text NOT NULL,
    prefix text NOT NULL,
    display_suffix text NOT NULL,
    name text,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_by_user_id text NOT NULL COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT api_key_id_prefix CHECK ((id ~ '^key_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT api_key_project_scope_agrees CHECK (((scope = 'project'::text) = (project_id IS NOT NULL))),
    CONSTRAINT api_key_scope_allowed CHECK ((scope = ANY (ARRAY['organization'::text, 'project'::text])))
);


--
-- Name: cloud_billing_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_billing_account (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    plan_code text NOT NULL,
    period_anchor timestamp with time zone NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    stripe_subscription_status text,
    stripe_subscription_refreshed_at timestamp with time zone,
    stripe_period_started_at timestamp with time zone,
    stripe_period_ends_at timestamp with time zone,
    stripe_failed_at timestamp with time zone,
    stripe_failure_version bigint DEFAULT 0 NOT NULL,
    activated_at timestamp with time zone NOT NULL,
    inference_settled_through timestamp with time zone,
    settlement_failed_at timestamp with time zone,
    balance_micros bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_cancel_at timestamp with time zone,
    CONSTRAINT cloud_billing_account_id_prefix CHECK ((id ~ '^cba_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT cloud_billing_account_plan_code_allowed CHECK ((plan_code = ANY (ARRAY['hobby'::text, 'pro'::text]))),
    CONSTRAINT cloud_billing_account_stripe_failure_version_is_exact CHECK (((stripe_failure_version >= 0) AND (stripe_failure_version <= '9007199254740991'::bigint))),
    CONSTRAINT cloud_billing_account_subscription_needs_a_customer CHECK (((stripe_subscription_id IS NULL) OR (stripe_customer_id IS NOT NULL))),
    CONSTRAINT cloud_billing_account_subscription_status_allowed CHECK (((stripe_subscription_status IS NULL) OR (stripe_subscription_status = ANY (ARRAY['trialing'::text, 'active'::text, 'past_due'::text, 'canceled'::text, 'unpaid'::text, 'incomplete'::text, 'incomplete_expired'::text, 'paused'::text])))),
    CONSTRAINT cloud_billing_account_subscription_status_needs_a_subscription CHECK (((stripe_subscription_status IS NULL) OR (stripe_subscription_id IS NOT NULL)))
);


--
-- Name: cloud_ledger_entry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_ledger_entry (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    kind text NOT NULL,
    amount_micros bigint NOT NULL,
    reference_kind text NOT NULL,
    reference_id text NOT NULL,
    interval_started_at timestamp with time zone,
    interval_ended_at timestamp with time zone,
    idempotency_key text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_ledger_entry_id_prefix CHECK ((id ~ '^cle_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT cloud_ledger_entry_idempotency_key_is_not_blank CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT cloud_ledger_entry_interval_matches_kind CHECK (
CASE
    WHEN (kind = 'inference_charge'::text) THEN ((interval_started_at IS NOT NULL) AND (interval_ended_at IS NOT NULL) AND (interval_started_at < interval_ended_at))
    ELSE ((interval_started_at IS NULL) AND (interval_ended_at IS NULL))
END),
    CONSTRAINT cloud_ledger_entry_kind_allowed CHECK ((kind = ANY (ARRAY['welcome_credit'::text, 'purchased_credit'::text, 'inference_charge'::text, 'correction'::text]))),
    CONSTRAINT cloud_ledger_entry_kind_names_its_cause CHECK (
CASE kind
    WHEN 'welcome_credit'::text THEN (reference_kind = 'organization'::text)
    WHEN 'purchased_credit'::text THEN (reference_kind = 'checkout_session'::text)
    WHEN 'inference_charge'::text THEN (reference_kind = 'settlement_interval'::text)
    ELSE true
END),
    CONSTRAINT cloud_ledger_entry_reference_id_is_not_blank CHECK ((btrim(reference_id) <> ''::text)),
    CONSTRAINT cloud_ledger_entry_reference_kind_allowed CHECK ((reference_kind = ANY (ARRAY['organization'::text, 'settlement_interval'::text, 'checkout_session'::text, 'operator'::text]))),
    CONSTRAINT cloud_ledger_entry_sign_follows_its_kind CHECK (
CASE kind
    WHEN 'welcome_credit'::text THEN (amount_micros > 0)
    WHEN 'purchased_credit'::text THEN (amount_micros > 0)
    WHEN 'inference_charge'::text THEN (amount_micros < 0)
    ELSE (amount_micros <> 0)
END)
);


--
-- Name: cloud_meter_period; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_meter_period (
    organization_id text NOT NULL COLLATE pg_catalog."C",
    stripe_subscription_id text NOT NULL,
    period_started_at timestamp with time zone NOT NULL,
    period_ends_at timestamp with time zone NOT NULL,
    channel text NOT NULL,
    stripe_customer_id text NOT NULL,
    meter_id text NOT NULL,
    event_name text NOT NULL,
    price_id text NOT NULL,
    invoice_id text,
    observed_through_hour timestamp with time zone,
    accepted_seconds bigint DEFAULT 0 NOT NULL,
    uncertain_seconds bigint DEFAULT 0 NOT NULL,
    last_observed_seconds bigint DEFAULT 0 NOT NULL,
    pending_identifier text,
    pending_seconds bigint,
    pending_value numeric(30,12),
    pending_timestamp timestamp with time zone,
    pending_hour timestamp with time zone,
    pending_first_sent_at timestamp with time zone,
    late_invoiced_cents bigint DEFAULT 0 NOT NULL,
    late_observed_seconds bigint DEFAULT 0 NOT NULL,
    late_pending_identifier text,
    late_pending_through_seconds bigint,
    late_pending_amount_cents bigint,
    late_invoice_create_started_at timestamp with time zone,
    late_invoice_id text,
    late_item_create_started_at timestamp with time zone,
    late_invoice_item_id text,
    state text DEFAULT 'open'::text NOT NULL,
    last_outcome text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_meter_period_bounds CHECK ((period_ends_at > period_started_at)),
    CONSTRAINT cloud_meter_period_channel_allowed CHECK ((channel = ANY (ARRAY['web_call_minutes'::text, 'phone_minutes'::text]))),
    CONSTRAINT cloud_meter_period_customer_not_blank CHECK ((btrim(stripe_customer_id) <> ''::text)),
    CONSTRAINT cloud_meter_period_event_not_blank CHECK ((btrim(event_name) <> ''::text)),
    CONSTRAINT cloud_meter_period_late_counted CHECK (late_invoiced_cents BETWEEN 0 AND 9007199254740991 AND late_observed_seconds BETWEEN 0 AND 9007199254740991),
    CONSTRAINT cloud_meter_period_late_pending_complete CHECK (((num_nonnulls(late_pending_identifier, late_pending_through_seconds, late_pending_amount_cents) = ANY (ARRAY[0, 3])) AND ((late_pending_identifier IS NOT NULL) OR (num_nonnulls(late_invoice_create_started_at, late_invoice_id, late_item_create_started_at, late_invoice_item_id) = 0)))),
    CONSTRAINT cloud_meter_period_late_pending_valid CHECK (((late_pending_identifier IS NULL) OR ((btrim(late_pending_identifier) <> ''::text) AND ((late_pending_through_seconds >= 1) AND (late_pending_through_seconds <= '9007199254740991'::bigint)) AND ((late_pending_amount_cents >= 1) AND (late_pending_amount_cents <= '9007199254740991'::bigint)) AND ((late_invoice_id IS NULL) OR ((late_invoice_create_started_at IS NOT NULL) AND (btrim(late_invoice_id) <> ''::text))) AND ((late_item_create_started_at IS NULL) OR (late_invoice_id IS NOT NULL)) AND ((late_invoice_item_id IS NULL) OR ((late_item_create_started_at IS NOT NULL) AND (btrim(late_invoice_item_id) <> ''::text)))))),
    CONSTRAINT cloud_meter_period_meter_not_blank CHECK ((btrim(meter_id) <> ''::text)),
    CONSTRAINT cloud_meter_period_outcome_allowed CHECK (((last_outcome IS NULL) OR (last_outcome = ANY (ARRAY['accepted'::text, 'duplicate'::text, 'uncertain'::text, 'invoice_closed'::text, 'timestamp_expired'::text])))),
    CONSTRAINT cloud_meter_period_pending_complete CHECK ((num_nonnulls(pending_identifier, pending_seconds, pending_value, pending_timestamp, pending_hour, pending_first_sent_at) = ANY (ARRAY[0, 6]))),
    CONSTRAINT cloud_meter_period_pending_valid CHECK (((pending_identifier IS NULL) OR ((btrim(pending_identifier) <> ''::text) AND ((pending_seconds >= 1) AND (pending_seconds <= '9007199254740991'::bigint)) AND (pending_value > (0)::numeric) AND (pending_timestamp >= period_started_at) AND (pending_timestamp < period_ends_at)))),
    CONSTRAINT cloud_meter_period_price_not_blank CHECK ((btrim(price_id) <> ''::text)),
    CONSTRAINT cloud_meter_period_seconds_counted CHECK (accepted_seconds BETWEEN 0 AND 9007199254740991 AND uncertain_seconds BETWEEN 0 AND 9007199254740991 AND last_observed_seconds BETWEEN 0 AND 9007199254740991),
    CONSTRAINT cloud_meter_period_state_allowed CHECK ((state = ANY (ARRAY['open'::text, 'needs_attention'::text, 'closed'::text]))),
    CONSTRAINT cloud_meter_period_subscription_not_blank CHECK ((btrim(stripe_subscription_id) <> ''::text))
);


--
-- Name: cloud_plan; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_plan (
    id text NOT NULL COLLATE pg_catalog."C",
    code text NOT NULL,
    name text NOT NULL,
    fee_micros bigint NOT NULL,
    chat_simulations_allowance bigint,
    web_call_minutes_allowance bigint,
    phone_minutes_allowance bigint,
    web_call_overage_micros_per_minute bigint NOT NULL,
    phone_overage_micros_per_minute bigint NOT NULL,
    stripe_product_id text,
    stripe_fee_price_id text,
    stripe_web_call_meter_price_id text,
    stripe_phone_meter_price_id text,
    stripe_web_call_meter_id text,
    stripe_phone_meter_id text,
    billing_activated_at timestamp with time zone,
    stripe_payments_ready boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_plan_allowances_are_not_negative CHECK (((COALESCE(chat_simulations_allowance, (0)::bigint) >= 0) AND (COALESCE(web_call_minutes_allowance, (0)::bigint) >= 0) AND (COALESCE(phone_minutes_allowance, (0)::bigint) >= 0))),
    CONSTRAINT cloud_plan_code_allowed CHECK ((code = ANY (ARRAY['hobby'::text, 'pro'::text]))),
    CONSTRAINT cloud_plan_fee_is_not_negative CHECK ((fee_micros >= 0)),
    CONSTRAINT cloud_plan_id_prefix CHECK ((id ~ '^cpl_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT cloud_plan_name_is_not_blank CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT cloud_plan_overage_prices_are_not_negative CHECK (((web_call_overage_micros_per_minute >= 0) AND (phone_overage_micros_per_minute >= 0)))
);


--
-- Name: connection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connection (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text NOT NULL COLLATE pg_catalog."C",
    agent_id text NOT NULL COLLATE pg_catalog."C",
    name text NOT NULL,
    connection_type text NOT NULL,
    modality text NOT NULL,
    topology text NOT NULL,
    access_variant text NOT NULL,
    environment text,
    config jsonb NOT NULL,
    credentials text,
    credentials_hint text,
    archived_at timestamp with time zone,
    created_by text COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connection_access_variant_allowed CHECK ((access_variant = ANY (ARRAY['retell_chat_api.api_key'::text, 'retell_text_mode.api_key'::text, 'retell_web_call.api_key'::text, 'phone_number.public_e164'::text, 'livekit_room.project_credentials'::text, 'livekit_room.customer_token_endpoint'::text]))),
    CONSTRAINT connection_credentials_hint_agrees CHECK (((credentials IS NULL) = (credentials_hint IS NULL))),
    CONSTRAINT connection_id_prefix CHECK ((id ~ '^con_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT connection_modality_allowed CHECK ((modality = ANY (ARRAY['voice'::text, 'chat'::text]))),
    CONSTRAINT connection_topology_allowed CHECK ((topology = ANY (ARRAY['agent-dials-out'::text, 'hosted-broker'::text, 'egma-dials-in'::text]))),
    CONSTRAINT connection_type_allowed CHECK ((connection_type = ANY (ARRAY['retell_chat_api'::text, 'retell_text_mode'::text, 'retell_web_call'::text, 'phone_number'::text, 'livekit_room'::text])))
);


--
-- Name: device_code; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_code (
    id text NOT NULL COLLATE pg_catalog."C",
    device_code text NOT NULL,
    user_code text NOT NULL,
    user_id text COLLATE pg_catalog."C",
    client_id text,
    scope text,
    status text NOT NULL,
    organization_id text COLLATE pg_catalog."C",
    project_id text COLLATE pg_catalog."C",
    expires_at timestamp with time zone NOT NULL,
    last_polled_at timestamp with time zone,
    polling_interval integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT device_code_authorized_for_agrees CHECK (((organization_id IS NULL) = (project_id IS NULL))),
    CONSTRAINT device_code_id_prefix CHECK ((id ~ '^dvc_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT device_code_status_allowed CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text])))
);


--
-- Name: grader_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grader_definition (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text COLLATE pg_catalog."C",
    name text NOT NULL,
    description text,
    scope_editable boolean NOT NULL,
    current_definition_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id text COLLATE pg_catalog."C",
    CONSTRAINT grader_definition_id_prefix CHECK ((id ~ '^grl_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT grader_definition_ownership_pair CHECK (((organization_id IS NULL) = (project_id IS NULL)))
);


--
-- Name: grader_definition_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grader_definition_version (
    definition_id text NOT NULL COLLATE pg_catalog."C",
    version integer NOT NULL,
    type text NOT NULL,
    prompt text,
    parameter_contract jsonb NOT NULL,
    modalities jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grader_definition_version_definition_id_prefix CHECK ((definition_id ~ '^grl_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT grader_definition_version_modalities_allowed CHECK ((modalities = ANY (ARRAY['["chat"]'::jsonb, '["voice"]'::jsonb, '["chat", "voice"]'::jsonb, '["voice", "chat"]'::jsonb]))),
    CONSTRAINT grader_definition_version_type_allowed CHECK ((type = ANY (ARRAY['llm_as_judge'::text, 'code'::text]))),
    CONSTRAINT grader_definition_version_version_is_positive CHECK ((version >= 1))
);


--
-- Name: grading_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grading_job (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text NOT NULL COLLATE pg_catalog."C",
    source text NOT NULL,
    simulation_id text COLLATE pg_catalog."C",
    trace_id text NOT NULL,
    trace_started_at timestamp with time zone NOT NULL,
    run_id text COLLATE pg_catalog."C",
    entries jsonb NOT NULL,
    status text NOT NULL,
    claimed_by text,
    claimed_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    sequence_base integer DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grading_job_abandoned_shape CHECK (((status = 'abandoned'::text) = (finished_at IS NOT NULL))),
    CONSTRAINT grading_job_attempts_are_counted CHECK ((attempts >= 0)),
    CONSTRAINT grading_job_claim_columns_agree CHECK ((((claimed_at IS NULL) = (claimed_by IS NULL)) AND ((claimed_at IS NULL) = (heartbeat_at IS NULL)))),
    CONSTRAINT grading_job_claimed_shape CHECK (((status <> 'claimed'::text) OR ((claimed_at IS NOT NULL) AND (finished_at IS NULL)))),
    CONSTRAINT grading_job_entries_are_a_nonempty_list CHECK (((jsonb_typeof(entries) = 'array'::text) AND (jsonb_array_length(entries) > 0))),
    CONSTRAINT grading_job_id_prefix CHECK ((id ~ '^gjb_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT grading_job_pending_shape CHECK (((status <> 'pending'::text) OR ((claimed_at IS NULL) AND (finished_at IS NULL)))),
    CONSTRAINT grading_job_sequence_base_is_counted CHECK ((sequence_base >= 0)),
    CONSTRAINT grading_job_source_allowed CHECK ((source = ANY (ARRAY['simulation'::text, 'production'::text]))),
    CONSTRAINT grading_job_source_names_its_control_record CHECK (
CASE source
    WHEN 'simulation'::text THEN ((simulation_id IS NOT NULL) AND (run_id IS NOT NULL))
    WHEN 'production'::text THEN ((simulation_id IS NULL) AND (run_id IS NULL))
    ELSE false
END),
    CONSTRAINT grading_job_status_allowed CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'abandoned'::text])))
);


--
-- Name: invitation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitation (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    email public.citext NOT NULL,
    role text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_by text COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invitation_id_prefix CHECK ((id ~ '^inv_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT invitation_role_allowed CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text, 'viewer'::text])))
);


--
-- Name: membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.membership (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    user_id text NOT NULL COLLATE pg_catalog."C",
    role text NOT NULL,
    created_by text COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT membership_id_prefix CHECK ((id ~ '^mbr_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT membership_role_allowed CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text, 'viewer'::text])))
);


--
-- Name: monitoring_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_state (
    id text NOT NULL COLLATE pg_catalog."C",
    agent_id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text NOT NULL COLLATE pg_catalog."C",
    scan_kind text,
    scan_from timestamp with time zone,
    scan_through timestamp with time zone,
    pagination_key text,
    pagination_trail text DEFAULT '[]'::text NOT NULL,
    completed_through timestamp with time zone,
    next_poll_at timestamp with time zone NOT NULL,
    regular_floor_at timestamp with time zone,
    import_generation integer DEFAULT 1 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    failure_started_at timestamp with time zone,
    last_error_kind text,
    last_error_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_received_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_state_id_prefix CHECK ((id ~ '^mst_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT monitoring_state_lease_agrees CHECK (((lease_owner IS NULL) = (lease_expires_at IS NULL))),
    CONSTRAINT monitoring_state_scan_agrees CHECK ((((scan_kind IS NULL) AND (scan_from IS NULL) AND (scan_through IS NULL) AND (pagination_key IS NULL)) OR ((scan_kind IS NOT NULL) AND (scan_from IS NOT NULL) AND (scan_through IS NOT NULL)))),
    CONSTRAINT monitoring_state_scan_kind_allowed CHECK ((scan_kind = ANY (ARRAY['historical_import'::text, 'regular'::text])))
);


--
-- Name: organization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization (
    id text NOT NULL COLLATE pg_catalog."C",
    name text NOT NULL,
    slug text NOT NULL,
    external_identity_provider text,
    external_identity_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    retention_days integer,
    data_residency text,
    settings_updated_at timestamp with time zone,
    CONSTRAINT organization_id_prefix CHECK ((id ~ '^org_[0-9A-HJKMNP-TV-Z]{26}$'::text))
);


--
-- Name: persona_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.persona_definition (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text COLLATE pg_catalog."C",
    project_id text COLLATE pg_catalog."C",
    name text NOT NULL,
    description text,
    current_version_id text NOT NULL COLLATE pg_catalog."C",
    archived_at timestamp with time zone,
    created_by text COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT persona_egma_provided_is_active CHECK (((organization_id IS NOT NULL) OR (archived_at IS NULL))),
    CONSTRAINT persona_id_prefix CHECK ((id ~ '^prs_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT persona_tenancy_is_whole_or_egmas CHECK (((organization_id IS NULL) = (project_id IS NULL)))
);


--
-- Name: persona_definition_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.persona_definition_version (
    id text NOT NULL COLLATE pg_catalog."C",
    persona_id text NOT NULL COLLATE pg_catalog."C",
    version integer NOT NULL,
    created_by text COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    identity_name text NOT NULL,
    personality text NOT NULL,
    language text NOT NULL,
    parameter_contract jsonb NOT NULL,
    CONSTRAINT persona_definition_version_parameter_contract_is_array CHECK ((jsonb_typeof(parameter_contract) = 'array'::text)),
    CONSTRAINT persona_version_id_prefix CHECK ((id ~ '^prsv_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT persona_version_identity_name_stated CHECK ((btrim(identity_name) <> ''::text)),
    CONSTRAINT persona_version_language_stated CHECK ((btrim(language) <> ''::text)),
    CONSTRAINT persona_version_personality_stated CHECK ((btrim(personality) <> ''::text))
);


--
-- Name: project; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    revision text NOT NULL COLLATE pg_catalog."C",
    deleted_at timestamp with time zone,
    created_by text COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_id_prefix CHECK ((id ~ '^prj_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT project_revision_prefix CHECK ((revision ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$'::text))
);


--
-- Name: project_grader; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_grader (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text NOT NULL COLLATE pg_catalog."C",
    grader_definition_id text NOT NULL COLLATE pg_catalog."C",
    scope jsonb NOT NULL,
    parameter_values jsonb NOT NULL,
    pass_threshold double precision NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_grader_id_prefix CHECK ((id ~ '^grd_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT project_grader_pass_threshold_is_normalized CHECK (((pass_threshold >= (0)::double precision) AND (pass_threshold <= (1)::double precision))),
    CONSTRAINT project_grader_scope_is_closed_object CHECK (((NOT (jsonb_typeof(scope) IS DISTINCT FROM 'object'::text)) AND (NOT ((scope - ARRAY['simulations'::text, 'production'::text]) IS DISTINCT FROM '{}'::jsonb)) AND (scope ?& ARRAY['simulations'::text, 'production'::text]) AND (NOT (jsonb_typeof((scope -> 'simulations'::text)) IS DISTINCT FROM 'array'::text)) AND (((scope -> 'production'::text) = 'null'::jsonb) OR (NOT (jsonb_typeof((scope -> 'production'::text)) IS DISTINCT FROM 'object'::text)))))
);


--
-- Name: project_persona; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_persona (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text NOT NULL COLLATE pg_catalog."C",
    persona_definition_id text NOT NULL COLLATE pg_catalog."C",
    parameter_values jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_persona_id_prefix CHECK ((id ~ '^ppr_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT project_persona_parameters_are_object CHECK ((jsonb_typeof(parameter_values) = 'object'::text))
);


--
-- Name: provider_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_key (
    organization_id text NOT NULL COLLATE pg_catalog."C",
    provider text NOT NULL,
    credentials text NOT NULL,
    hint text NOT NULL,
    revision text NOT NULL COLLATE pg_catalog."C",
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_key_hint_shape CHECK ((char_length(hint) = 8)),
    CONSTRAINT provider_key_provider_allowed CHECK ((provider = ANY (ARRAY['openai'::text, 'deepgram'::text, 'cartesia'::text]))),
    CONSTRAINT provider_key_revision_prefix CHECK ((revision ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$'::text))
);


--
-- Name: rate_card; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_card (
    id text NOT NULL COLLATE pg_catalog."C",
    provider text NOT NULL,
    model text NOT NULL,
    usage_type text NOT NULL,
    unit text NOT NULL,
    usd_per_million numeric(24,12) NOT NULL,
    effective_from timestamp with time zone NOT NULL,
    source text NOT NULL,
    read_at text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_card_id_prefix CHECK ((id ~ '^rat_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT rate_card_price_is_not_negative CHECK ((usd_per_million >= (0)::numeric)),
    CONSTRAINT rate_card_unit_allowed CHECK ((unit = ANY (ARRAY['tokens'::text, 'seconds'::text, 'characters'::text]))),
    CONSTRAINT rate_card_usage_type_allowed CHECK ((usage_type = ANY (ARRAY['input_tokens'::text, 'cached_input_tokens'::text, 'output_tokens'::text, 'audio_input_tokens'::text, 'text_input_tokens'::text, 'audio_seconds'::text, 'characters'::text])))
);


--
-- Name: retell_call_retry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retell_call_retry (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text NOT NULL COLLATE pg_catalog."C",
    agent_id text NOT NULL COLLATE pg_catalog."C",
    provider_call_id text NOT NULL,
    error_kind text NOT NULL,
    attempts smallint DEFAULT 1 NOT NULL,
    last_attempt_at timestamp with time zone NOT NULL,
    next_attempt_at timestamp with time zone,
    expires_at timestamp with time zone,
    import_generation integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retell_call_retry_attempts_bounded CHECK (((attempts >= 1) AND (attempts <= 4))),
    CONSTRAINT retell_call_retry_id_prefix CHECK ((id ~ '^rcr_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT retell_call_retry_one_schedule CHECK (((next_attempt_at IS NULL) <> (expires_at IS NULL)))
);


--
-- Name: run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text NOT NULL COLLATE pg_catalog."C",
    suite_id text NOT NULL COLLATE pg_catalog."C",
    agent_id text NOT NULL COLLATE pg_catalog."C",
    connection_id text NOT NULL COLLATE pg_catalog."C",
    name text,
    status text NOT NULL,
    triggered_via text NOT NULL,
    triggered_by text COLLATE pg_catalog."C",
    connection_snapshot jsonb NOT NULL,
    expected_simulation_count integer NOT NULL,
    completed_count integer,
    failed_count integer,
    canceled_count integer,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    agent_version integer,
    temp_mock_agent_version integer,
    temp_mock_agent_version_cleanup boolean,
    mock_metadata jsonb,
    grading_plan jsonb NOT NULL,
    CONSTRAINT run_agent_version_is_a_version CHECK (((agent_version IS NULL) OR (agent_version >= 0))),
    CONSTRAINT run_completed_is_finished CHECK (((status <> 'completed'::text) OR (finished_at IS NOT NULL))),
    CONSTRAINT run_counts_are_counts CHECK (((completed_count IS NULL) OR ((completed_count >= 0) AND (failed_count >= 0) AND (canceled_count >= 0)))),
    CONSTRAINT run_counts_written_together CHECK ((((completed_count IS NULL) = (failed_count IS NULL)) AND ((failed_count IS NULL) = (canceled_count IS NULL)) AND ((canceled_count IS NULL) = (finished_at IS NULL)))),
    CONSTRAINT run_expects_at_least_one_simulation CHECK ((expected_simulation_count > 0)),
    CONSTRAINT run_finished_is_terminal CHECK (((finished_at IS NULL) OR (status = ANY (ARRAY['completed'::text, 'canceled'::text])))),
    CONSTRAINT run_id_prefix CHECK ((id ~ '^run_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT run_started_when_left_pending CHECK (
CASE
    WHEN (status = 'pending'::text) THEN (started_at IS NULL)
    WHEN (status = ANY (ARRAY['running'::text, 'completed'::text])) THEN (started_at IS NOT NULL)
    ELSE true
END),
    CONSTRAINT run_status_allowed CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'canceled'::text]))),
    CONSTRAINT run_temp_mock_agent_version_is_a_version CHECK (((temp_mock_agent_version IS NULL) OR (temp_mock_agent_version >= 0))),
    CONSTRAINT run_temp_mock_agent_version_owes_cleanup CHECK (((temp_mock_agent_version IS NULL) OR (temp_mock_agent_version_cleanup IS NOT NULL))),
    CONSTRAINT run_triggered_via_allowed CHECK ((triggered_via = 'manual'::text))
);


--
-- Name: run_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_event (
    run_id text NOT NULL COLLATE pg_catalog."C",
    seq integer NOT NULL,
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text NOT NULL COLLATE pg_catalog."C",
    kind text NOT NULL,
    simulation_id text COLLATE pg_catalog."C",
    status text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_event_kind_allowed CHECK ((kind = ANY (ARRAY['run'::text, 'simulation'::text]))),
    CONSTRAINT run_event_reason_agrees CHECK (((reason IS NULL) OR ((status = 'completed'::text) AND (reason = ANY (ARRAY['persona_concluded'::text, 'agent_ended'::text, 'limit_reached'::text]))) OR ((status = 'failed'::text) AND (reason = ANY (ARRAY['agent_never_joined'::text, 'not_answered'::text, 'capacity'::text, 'simulator_error'::text, 'orphaned'::text, 'dispatch_failed'::text, 'provider_key_unavailable'::text]))))),
    CONSTRAINT run_event_run_id_prefix CHECK ((run_id ~ '^run_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT run_event_run_shape CHECK (((kind <> 'run'::text) OR ((simulation_id IS NULL) AND (reason IS NULL) AND (status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'canceled'::text]))))),
    CONSTRAINT run_event_seq_counts_from_one CHECK ((seq >= 1)),
    CONSTRAINT run_event_simulation_shape CHECK (((kind <> 'simulation'::text) OR ((simulation_id IS NOT NULL) AND (status = ANY (ARRAY['queued'::text, 'claimed'::text, 'running'::text, 'completed'::text, 'failed'::text, 'canceled'::text])))))
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id text NOT NULL COLLATE pg_catalog."C",
    user_id text NOT NULL COLLATE pg_catalog."C",
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_id_prefix CHECK ((id ~ '^ses_[0-9A-HJKMNP-TV-Z]{26}$'::text))
);


--
-- Name: simulation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.simulation (
    id text NOT NULL COLLATE pg_catalog."C",
    run_id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text NOT NULL COLLATE pg_catalog."C",
    agent_id text NOT NULL COLLATE pg_catalog."C",
    connection_id text NOT NULL COLLATE pg_catalog."C",
    persona_id text NOT NULL COLLATE pg_catalog."C",
    persona_version_id text NOT NULL COLLATE pg_catalog."C",
    test_id text NOT NULL COLLATE pg_catalog."C",
    test_version_id text NOT NULL COLLATE pg_catalog."C",
    "position" integer NOT NULL,
    modality text NOT NULL,
    status text NOT NULL,
    ending_reason text,
    claimed_by text,
    claimed_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    cancel_requested_at timestamp with time zone,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    recording_reference text,
    turn_count integer,
    provider_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    execution_failure text,
    persona_parameter_values jsonb NOT NULL,
    connection_type text NOT NULL,
    CONSTRAINT simulation_audio_facts_are_voice_facts CHECK (((modality = 'voice'::text) OR (recording_reference IS NULL))),
    CONSTRAINT simulation_canceled_shape CHECK (((status <> 'canceled'::text) OR ((ended_at IS NOT NULL) AND (cancel_requested_at IS NOT NULL)))),
    CONSTRAINT simulation_claim_columns_agree CHECK ((((claimed_at IS NULL) = (claimed_by IS NULL)) AND ((claimed_at IS NULL) = (heartbeat_at IS NULL)))),
    CONSTRAINT simulation_claimed_shape CHECK (((status <> 'claimed'::text) OR ((claimed_at IS NOT NULL) AND (started_at IS NULL) AND (ended_at IS NULL)))),
    CONSTRAINT simulation_completed_shape CHECK (((status <> 'completed'::text) OR ((started_at IS NOT NULL) AND (ended_at IS NOT NULL)))),
    CONSTRAINT simulation_connection_type_allowed CHECK ((connection_type = ANY (ARRAY['retell_chat_api'::text, 'retell_text_mode'::text, 'retell_web_call'::text, 'phone_number'::text, 'livekit_room'::text]))),
    CONSTRAINT simulation_ending_reason_agrees CHECK (
CASE status
    WHEN 'completed'::text THEN (ending_reason = ANY (ARRAY['persona_concluded'::text, 'agent_ended'::text, 'limit_reached'::text]))
    WHEN 'failed'::text THEN (ending_reason = ANY (ARRAY['agent_never_joined'::text, 'not_answered'::text, 'capacity'::text, 'simulator_error'::text, 'orphaned'::text, 'dispatch_failed'::text, 'provider_key_unavailable'::text]))
    ELSE (ending_reason IS NULL)
END),
    CONSTRAINT simulation_ending_reason_allowed CHECK (((ending_reason IS NULL) OR (ending_reason = ANY (ARRAY['persona_concluded'::text, 'agent_ended'::text, 'limit_reached'::text, 'agent_never_joined'::text, 'not_answered'::text, 'capacity'::text, 'simulator_error'::text, 'orphaned'::text, 'dispatch_failed'::text, 'provider_key_unavailable'::text])))),
    CONSTRAINT simulation_execution_failure_agrees CHECK (((execution_failure IS NULL) OR (status = 'failed'::text))),
    CONSTRAINT simulation_execution_failure_not_blank CHECK (((execution_failure IS NULL) OR (btrim(execution_failure) <> ''::text))),
    CONSTRAINT simulation_failed_shape CHECK (((status <> 'failed'::text) OR (ended_at IS NOT NULL))),
    CONSTRAINT simulation_id_prefix CHECK ((id ~ '^sim_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT simulation_modality_allowed CHECK ((modality = ANY (ARRAY['voice'::text, 'chat'::text]))),
    CONSTRAINT simulation_position_counts_from_one CHECK (("position" >= 1)),
    CONSTRAINT simulation_provider_reference_after_claim CHECK (((status <> 'queued'::text) OR (provider_reference IS NULL))),
    CONSTRAINT simulation_queued_shape CHECK (((status <> 'queued'::text) OR ((claimed_at IS NULL) AND (started_at IS NULL) AND (ended_at IS NULL) AND (cancel_requested_at IS NULL)))),
    CONSTRAINT simulation_report_only_when_ended CHECK (((ended_at IS NOT NULL) OR (recording_reference IS NULL))),
    CONSTRAINT simulation_running_shape CHECK (((status <> 'running'::text) OR ((claimed_at IS NOT NULL) AND (started_at IS NOT NULL) AND (ended_at IS NULL)))),
    CONSTRAINT simulation_status_allowed CHECK ((status = ANY (ARRAY['queued'::text, 'claimed'::text, 'running'::text, 'completed'::text, 'failed'::text, 'canceled'::text]))),
    CONSTRAINT simulation_summary_facts_only_when_ended CHECK (((ended_at IS NOT NULL) OR (turn_count IS NULL))),
    CONSTRAINT simulation_turn_count_is_a_count CHECK (((turn_count IS NULL) OR (turn_count >= 0)))
);


--
-- Name: test; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text NOT NULL COLLATE pg_catalog."C",
    suite_id text NOT NULL COLLATE pg_catalog."C",
    name text NOT NULL,
    description text,
    current_version_id text NOT NULL COLLATE pg_catalog."C",
    revision text NOT NULL COLLATE pg_catalog."C",
    deleted_at timestamp with time zone,
    created_by text COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT test_id_prefix CHECK ((id ~ '^tst_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT test_revision_prefix CHECK ((revision ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$'::text))
);


--
-- Name: test_persona; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test_persona (
    test_version_id text NOT NULL COLLATE pg_catalog."C",
    persona_id text NOT NULL COLLATE pg_catalog."C",
    "position" integer NOT NULL,
    CONSTRAINT test_persona_test_version_id_prefix CHECK ((test_version_id ~ '^tstv_[0-9A-HJKMNP-TV-Z]{26}$'::text))
);


--
-- Name: test_suite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test_suite (
    id text NOT NULL COLLATE pg_catalog."C",
    organization_id text NOT NULL COLLATE pg_catalog."C",
    project_id text NOT NULL COLLATE pg_catalog."C",
    name text NOT NULL,
    deleted_at timestamp with time zone,
    created_by text COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT test_suite_id_prefix CHECK ((id ~ '^ste_[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT test_suite_name_is_not_blank CHECK ((btrim(name) <> ''::text))
);


--
-- Name: test_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test_version (
    id text NOT NULL COLLATE pg_catalog."C",
    test_id text NOT NULL COLLATE pg_catalog."C",
    version integer NOT NULL,
    content jsonb NOT NULL,
    created_by text COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    mock_tools jsonb,
    env jsonb,
    CONSTRAINT test_version_id_prefix CHECK ((id ~ '^tstv_[0-9A-HJKMNP-TV-Z]{26}$'::text))
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id text NOT NULL COLLATE pg_catalog."C",
    email public.citext NOT NULL,
    name text,
    image text,
    email_verified boolean DEFAULT false NOT NULL,
    external_identity_provider text,
    external_identity_id text,
    deactivated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_id_prefix CHECK ((id ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'::text))
);


--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id text NOT NULL COLLATE pg_catalog."C",
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT verification_id_prefix CHECK ((id ~ '^vrf_[0-9A-HJKMNP-TV-Z]{26}$'::text))
);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: agent agent_id_project_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent
    ADD CONSTRAINT agent_id_project_id_unique UNIQUE (id, project_id);


--
-- Name: agent agent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent
    ADD CONSTRAINT agent_pkey PRIMARY KEY (id);


--
-- Name: api_key api_key_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT api_key_hash_unique UNIQUE (hash);


--
-- Name: api_key api_key_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT api_key_pkey PRIMARY KEY (id);


--
-- Name: cloud_billing_account cloud_billing_account_organization_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_billing_account
    ADD CONSTRAINT cloud_billing_account_organization_unique UNIQUE (organization_id);


--
-- Name: cloud_billing_account cloud_billing_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_billing_account
    ADD CONSTRAINT cloud_billing_account_pkey PRIMARY KEY (id);


--
-- Name: cloud_billing_account cloud_billing_account_stripe_customer_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_billing_account
    ADD CONSTRAINT cloud_billing_account_stripe_customer_unique UNIQUE (stripe_customer_id);


--
-- Name: cloud_billing_account cloud_billing_account_stripe_subscription_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_billing_account
    ADD CONSTRAINT cloud_billing_account_stripe_subscription_unique UNIQUE (stripe_subscription_id);


--
-- Name: cloud_ledger_entry cloud_ledger_entry_idempotency_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_ledger_entry
    ADD CONSTRAINT cloud_ledger_entry_idempotency_key_unique UNIQUE (idempotency_key);


--
-- Name: cloud_ledger_entry cloud_ledger_entry_organization_interval_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_ledger_entry
    ADD CONSTRAINT cloud_ledger_entry_organization_interval_unique UNIQUE (organization_id, interval_started_at, interval_ended_at);


--
-- Name: cloud_ledger_entry cloud_ledger_entry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_ledger_entry
    ADD CONSTRAINT cloud_ledger_entry_pkey PRIMARY KEY (id);


--
-- Name: cloud_meter_period cloud_meter_period_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_meter_period
    ADD CONSTRAINT cloud_meter_period_pk PRIMARY KEY (organization_id, stripe_subscription_id, period_started_at, period_ends_at, channel);


--
-- Name: cloud_plan cloud_plan_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_plan
    ADD CONSTRAINT cloud_plan_code_unique UNIQUE (code);


--
-- Name: cloud_plan cloud_plan_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_plan
    ADD CONSTRAINT cloud_plan_pkey PRIMARY KEY (id);


--
-- Name: connection connection_id_agent_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection
    ADD CONSTRAINT connection_id_agent_id_unique UNIQUE (id, agent_id);


--
-- Name: connection connection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection
    ADD CONSTRAINT connection_pkey PRIMARY KEY (id);


--
-- Name: device_code device_code_device_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_code
    ADD CONSTRAINT device_code_device_code_unique UNIQUE (device_code);


--
-- Name: device_code device_code_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_code
    ADD CONSTRAINT device_code_pkey PRIMARY KEY (id);


--
-- Name: device_code device_code_user_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_code
    ADD CONSTRAINT device_code_user_code_unique UNIQUE (user_code);


--
-- Name: grader_definition grader_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grader_definition
    ADD CONSTRAINT grader_definition_pkey PRIMARY KEY (id);


--
-- Name: grader_definition_version grader_definition_version_definition_id_version_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grader_definition_version
    ADD CONSTRAINT grader_definition_version_definition_id_version_pk PRIMARY KEY (definition_id, version);


--
-- Name: grading_job grading_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grading_job
    ADD CONSTRAINT grading_job_pkey PRIMARY KEY (id);


--
-- Name: grading_job grading_job_project_id_trace_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grading_job
    ADD CONSTRAINT grading_job_project_id_trace_id_unique UNIQUE (project_id, trace_id);


--
-- Name: grading_job grading_job_simulation_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grading_job
    ADD CONSTRAINT grading_job_simulation_id_unique UNIQUE (simulation_id);


--
-- Name: invitation invitation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT invitation_pkey PRIMARY KEY (id);


--
-- Name: invitation invitation_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT invitation_token_hash_unique UNIQUE (token_hash);


--
-- Name: membership membership_organization_id_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_organization_id_user_id_unique UNIQUE (organization_id, user_id);


--
-- Name: membership membership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_pkey PRIMARY KEY (id);


--
-- Name: membership membership_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_user_id_unique UNIQUE (user_id);


--
-- Name: monitoring_state monitoring_state_agent_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_state
    ADD CONSTRAINT monitoring_state_agent_unique UNIQUE (agent_id);


--
-- Name: monitoring_state monitoring_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_state
    ADD CONSTRAINT monitoring_state_pkey PRIMARY KEY (id);


--
-- Name: organization organization_external_identity_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_external_identity_unique UNIQUE (external_identity_provider, external_identity_id);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: organization organization_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_slug_unique UNIQUE (slug);


--
-- Name: persona_definition persona_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persona_definition
    ADD CONSTRAINT persona_definition_pkey PRIMARY KEY (id);


--
-- Name: persona_definition_version persona_definition_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persona_definition_version
    ADD CONSTRAINT persona_definition_version_pkey PRIMARY KEY (id);


--
-- Name: persona_definition_version persona_version_id_persona_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persona_definition_version
    ADD CONSTRAINT persona_version_id_persona_id_unique UNIQUE (id, persona_id);


--
-- Name: persona_definition_version persona_version_persona_id_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persona_definition_version
    ADD CONSTRAINT persona_version_persona_id_version_unique UNIQUE (persona_id, version);


--
-- Name: project_grader project_grader_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_grader
    ADD CONSTRAINT project_grader_pkey PRIMARY KEY (id);


--
-- Name: project project_id_organization_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project
    ADD CONSTRAINT project_id_organization_id_unique UNIQUE (id, organization_id);


--
-- Name: project project_organization_id_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project
    ADD CONSTRAINT project_organization_id_slug_unique UNIQUE (organization_id, slug);


--
-- Name: project_persona project_persona_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_persona
    ADD CONSTRAINT project_persona_pkey PRIMARY KEY (id);


--
-- Name: project_persona project_persona_project_definition_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_persona
    ADD CONSTRAINT project_persona_project_definition_unique UNIQUE (project_id, persona_definition_id);


--
-- Name: project project_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project
    ADD CONSTRAINT project_pkey PRIMARY KEY (id);


--
-- Name: provider_key provider_key_organization_id_provider_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_key
    ADD CONSTRAINT provider_key_organization_id_provider_pk PRIMARY KEY (organization_id, provider);


--
-- Name: rate_card rate_card_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_card
    ADD CONSTRAINT rate_card_pkey PRIMARY KEY (id);


--
-- Name: rate_card rate_card_price_identity_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_card
    ADD CONSTRAINT rate_card_price_identity_unique UNIQUE (provider, model, usage_type, effective_from);


--
-- Name: retell_call_retry retell_call_retry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retell_call_retry
    ADD CONSTRAINT retell_call_retry_pkey PRIMARY KEY (id);


--
-- Name: retell_call_retry retell_call_retry_project_call_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retell_call_retry
    ADD CONSTRAINT retell_call_retry_project_call_unique UNIQUE (project_id, provider_call_id);


--
-- Name: run_event run_event_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_event
    ADD CONSTRAINT run_event_pk PRIMARY KEY (run_id, seq);


--
-- Name: run run_id_project_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run
    ADD CONSTRAINT run_id_project_id_unique UNIQUE (id, project_id);


--
-- Name: run run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run
    ADD CONSTRAINT run_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_unique UNIQUE (token);


--
-- Name: simulation simulation_id_project_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation
    ADD CONSTRAINT simulation_id_project_id_unique UNIQUE (id, project_id);


--
-- Name: simulation simulation_id_run_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation
    ADD CONSTRAINT simulation_id_run_id_unique UNIQUE (id, run_id);


--
-- Name: simulation simulation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation
    ADD CONSTRAINT simulation_pkey PRIMARY KEY (id);


--
-- Name: simulation simulation_run_id_position_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation
    ADD CONSTRAINT simulation_run_id_position_unique UNIQUE (run_id, "position");


--
-- Name: test test_id_project_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test
    ADD CONSTRAINT test_id_project_id_unique UNIQUE (id, project_id);


--
-- Name: test_persona test_persona_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_persona
    ADD CONSTRAINT test_persona_pk PRIMARY KEY (test_version_id, persona_id);


--
-- Name: test_persona test_persona_version_id_position_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_persona
    ADD CONSTRAINT test_persona_version_id_position_unique UNIQUE (test_version_id, "position");


--
-- Name: test test_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test
    ADD CONSTRAINT test_pkey PRIMARY KEY (id);


--
-- Name: test_suite test_suite_id_project_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_suite
    ADD CONSTRAINT test_suite_id_project_id_unique UNIQUE (id, project_id);


--
-- Name: test_suite test_suite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_suite
    ADD CONSTRAINT test_suite_pkey PRIMARY KEY (id);


--
-- Name: test_version test_version_id_test_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_version
    ADD CONSTRAINT test_version_id_test_id_unique UNIQUE (id, test_id);


--
-- Name: test_version test_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_version
    ADD CONSTRAINT test_version_pkey PRIMARY KEY (id);


--
-- Name: test_version test_version_test_id_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_version
    ADD CONSTRAINT test_version_test_id_version_unique UNIQUE (test_id, version);


--
-- Name: user user_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_unique UNIQUE (email);


--
-- Name: user user_external_identity_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_external_identity_unique UNIQUE (external_identity_provider, external_identity_id);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: account_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_user_id_idx ON public.account USING btree (user_id);


--
-- Name: agent_organization_id_project_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_organization_id_project_id_idx ON public.agent USING btree (organization_id, project_id) WHERE (archived_at IS NULL);


--
-- Name: agent_project_id_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_project_id_name_unique ON public.agent USING btree (project_id, name) WHERE (archived_at IS NULL);


--
-- Name: agent_pulled_platform_agent_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_pulled_platform_agent_unique ON public.agent USING btree (project_id, agent_platform, platform_agent_id) WHERE pull_production_calls;


--
-- Name: api_key_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_key_organization_id_idx ON public.api_key USING btree (organization_id);


--
-- Name: cloud_ledger_entry_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloud_ledger_entry_organization_idx ON public.cloud_ledger_entry USING btree (organization_id, id);


--
-- Name: connection_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX connection_agent_id_idx ON public.connection USING btree (agent_id) WHERE (archived_at IS NULL);


--
-- Name: connection_agent_id_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX connection_agent_id_name_unique ON public.connection USING btree (agent_id, name) WHERE (archived_at IS NULL);


--
-- Name: device_code_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_code_expires_at_idx ON public.device_code USING btree (expires_at);


--
-- Name: grader_definition_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grader_definition_organization_id_idx ON public.grader_definition USING btree (organization_id);


--
-- Name: grader_definition_predefined_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX grader_definition_predefined_name_unique ON public.grader_definition USING btree (name) WHERE (organization_id IS NULL);


--
-- Name: grading_job_organization_id_project_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grading_job_organization_id_project_id_idx ON public.grading_job USING btree (organization_id, project_id);


--
-- Name: grading_job_outstanding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grading_job_outstanding_idx ON public.grading_job USING btree (id) WHERE (status = ANY (ARRAY['pending'::text, 'claimed'::text]));


--
-- Name: invitation_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitation_organization_id_idx ON public.invitation USING btree (organization_id);


--
-- Name: membership_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX membership_organization_id_idx ON public.membership USING btree (organization_id);


--
-- Name: monitoring_state_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX monitoring_state_due_idx ON public.monitoring_state USING btree (next_poll_at, lease_expires_at);


--
-- Name: monitoring_state_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX monitoring_state_project_idx ON public.monitoring_state USING btree (project_id);


--
-- Name: persona_egma_provided_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX persona_egma_provided_name_unique ON public.persona_definition USING btree (name) WHERE (organization_id IS NULL);


--
-- Name: persona_organization_id_project_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX persona_organization_id_project_id_idx ON public.persona_definition USING btree (organization_id, project_id) WHERE (archived_at IS NULL);


--
-- Name: project_grader_active_definition_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX project_grader_active_definition_unique ON public.project_grader USING btree (project_id, grader_definition_id) WHERE (archived_at IS NULL);


--
-- Name: project_grader_definition_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_grader_definition_id_idx ON public.project_grader USING btree (grader_definition_id);


--
-- Name: project_grader_organization_id_project_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_grader_organization_id_project_id_idx ON public.project_grader USING btree (organization_id, project_id) WHERE (archived_at IS NULL);


--
-- Name: project_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_organization_id_idx ON public.project USING btree (organization_id) WHERE (deleted_at IS NULL);


--
-- Name: rate_card_effective_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rate_card_effective_idx ON public.rate_card USING btree (provider, model, effective_from);


--
-- Name: retell_call_retry_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX retell_call_retry_due_idx ON public.retell_call_retry USING btree (agent_id, next_attempt_at) WHERE (next_attempt_at IS NOT NULL);


--
-- Name: run_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_agent_id_idx ON public.run USING btree (agent_id);


--
-- Name: run_mock_tools_cleanup_owed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_mock_tools_cleanup_owed_idx ON public.run USING btree (organization_id, agent_id) WHERE (temp_mock_agent_version_cleanup = false);


--
-- Name: run_organization_id_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_organization_id_id_idx ON public.run USING btree (organization_id, id);


--
-- Name: run_organization_id_project_id_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_organization_id_project_id_id_idx ON public.run USING btree (organization_id, project_id, id);


--
-- Name: run_suite_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_suite_id_idx ON public.run USING btree (suite_id);


--
-- Name: session_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_user_id_idx ON public.session USING btree (user_id);


--
-- Name: simulation_heartbeat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_heartbeat_idx ON public.simulation USING btree (organization_id, heartbeat_at) WHERE (status = ANY (ARRAY['claimed'::text, 'running'::text]));


--
-- Name: simulation_organization_id_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_organization_id_started_at_idx ON public.simulation USING btree (organization_id, started_at);


--
-- Name: simulation_persona_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_persona_id_idx ON public.simulation USING btree (persona_id);


--
-- Name: simulation_persona_version_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_persona_version_id_idx ON public.simulation USING btree (persona_version_id);


--
-- Name: simulation_queued_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_queued_idx ON public.simulation USING btree (organization_id, id) WHERE (status = 'queued'::text);


--
-- Name: simulation_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_run_id_idx ON public.simulation USING btree (run_id);


--
-- Name: simulation_test_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_test_id_idx ON public.simulation USING btree (test_id);


--
-- Name: simulation_test_version_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_test_version_id_idx ON public.simulation USING btree (test_version_id);


--
-- Name: test_organization_id_project_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX test_organization_id_project_id_idx ON public.test USING btree (organization_id, project_id) WHERE (deleted_at IS NULL);


--
-- Name: test_persona_persona_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX test_persona_persona_id_idx ON public.test_persona USING btree (persona_id);


--
-- Name: test_suite_id_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX test_suite_id_id_idx ON public.test USING btree (suite_id, id) WHERE (deleted_at IS NULL);


--
-- Name: test_suite_organization_id_project_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX test_suite_organization_id_project_id_idx ON public.test_suite USING btree (organization_id, project_id) WHERE (deleted_at IS NULL);


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);


--
-- Name: grader_definition grader_definition_ownership_immutable_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grader_definition_ownership_immutable_guard BEFORE UPDATE OF organization_id, project_id ON public.grader_definition FOR EACH ROW EXECUTE FUNCTION public.guard_grader_definition_ownership_immutable();


--
-- Name: grader_definition_version grader_definition_parameter_contract_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grader_definition_parameter_contract_guard BEFORE INSERT ON public.grader_definition_version FOR EACH ROW EXECUTE FUNCTION public.guard_definition_parameter_contract();


--
-- Name: grader_definition_version grader_definition_version_is_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grader_definition_version_is_immutable BEFORE UPDATE ON public.grader_definition_version FOR EACH ROW EXECUTE FUNCTION public.guard_grader_definition_version_immutable();


--
-- Name: grading_job grading_job_selection_immutable_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grading_job_selection_immutable_guard BEFORE UPDATE ON public.grading_job FOR EACH ROW EXECUTE FUNCTION public.guard_grading_job_selection_immutable();


--
-- Name: persona_definition_version persona_definition_parameter_contract_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER persona_definition_parameter_contract_guard BEFORE INSERT ON public.persona_definition_version FOR EACH ROW EXECUTE FUNCTION public.guard_definition_parameter_contract();


--
-- Name: persona_definition persona_ownership_immutable_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER persona_ownership_immutable_guard BEFORE UPDATE OF organization_id, project_id ON public.persona_definition FOR EACH ROW EXECUTE FUNCTION public.guard_persona_ownership_immutable();


--
-- Name: persona_definition_version persona_version_semantics_immutable_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER persona_version_semantics_immutable_guard BEFORE UPDATE ON public.persona_definition_version FOR EACH ROW EXECUTE FUNCTION public.guard_persona_version_semantics_immutable();


--
-- Name: project_grader project_grader_definition_ownership_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER project_grader_definition_ownership_guard BEFORE INSERT OR UPDATE ON public.project_grader FOR EACH ROW EXECUTE FUNCTION public.guard_project_grader_definition_ownership();


--
-- Name: project_persona project_persona_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER project_persona_guard BEFORE INSERT OR UPDATE ON public.project_persona FOR EACH ROW EXECUTE FUNCTION public.guard_project_persona();


--
-- Name: run_event run_event_append_only_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_event_append_only_guard BEFORE UPDATE ON public.run_event FOR EACH ROW EXECUTE FUNCTION public.guard_run_event_append_only();


--
-- Name: run run_grading_plan_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_grading_plan_guard BEFORE INSERT OR UPDATE OF grading_plan ON public.run FOR EACH ROW EXECUTE FUNCTION public.guard_run_grading_plan();


--
-- Name: run run_lifecycle_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_lifecycle_guard BEFORE UPDATE ON public.run FOR EACH ROW EXECUTE FUNCTION public.guard_run_lifecycle();


--
-- Name: simulation simulation_lifecycle_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER simulation_lifecycle_guard BEFORE UPDATE ON public.simulation FOR EACH ROW EXECUTE FUNCTION public.guard_simulation_lifecycle();


--
-- Name: simulation simulation_persona_availability_insert_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER simulation_persona_availability_insert_guard BEFORE INSERT ON public.simulation FOR EACH ROW EXECUTE FUNCTION public.guard_simulation_persona_availability();


--
-- Name: simulation simulation_persona_availability_update_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER simulation_persona_availability_update_guard BEFORE UPDATE OF persona_id, project_id ON public.simulation FOR EACH ROW EXECUTE FUNCTION public.guard_simulation_persona_availability();


--
-- Name: simulation simulation_persona_parameters_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER simulation_persona_parameters_guard BEFORE INSERT OR UPDATE OF persona_id, persona_version_id, persona_parameter_values ON public.simulation FOR EACH ROW EXECUTE FUNCTION public.guard_simulation_persona_parameters();


--
-- Name: test test_ownership_immutable_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER test_ownership_immutable_guard BEFORE UPDATE OF organization_id, project_id ON public.test FOR EACH ROW EXECUTE FUNCTION public.guard_test_ownership_immutable();


--
-- Name: test_persona test_persona_availability_insert_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER test_persona_availability_insert_guard BEFORE INSERT ON public.test_persona FOR EACH ROW EXECUTE FUNCTION public.guard_test_persona_availability();


--
-- Name: test_persona test_persona_availability_update_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER test_persona_availability_update_guard BEFORE UPDATE OF test_version_id, persona_id ON public.test_persona FOR EACH ROW EXECUTE FUNCTION public.guard_test_persona_availability();


--
-- Name: test test_suite_membership_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER test_suite_membership_immutable BEFORE UPDATE OF suite_id ON public.test FOR EACH ROW EXECUTE FUNCTION public.guard_test_suite_membership();


--
-- Name: test_version test_version_test_immutable_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER test_version_test_immutable_guard BEFORE UPDATE OF test_id ON public.test_version FOR EACH ROW EXECUTE FUNCTION public.guard_test_version_test_immutable();


--
-- Name: account account_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: agent agent_created_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent
    ADD CONSTRAINT agent_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: agent agent_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent
    ADD CONSTRAINT agent_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: agent agent_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent
    ADD CONSTRAINT agent_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: api_key api_key_created_by_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT api_key_created_by_user_id_user_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public."user"(id) ON DELETE RESTRICT;


--
-- Name: api_key api_key_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT api_key_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: api_key api_key_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT api_key_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: cloud_billing_account cloud_billing_account_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_billing_account
    ADD CONSTRAINT cloud_billing_account_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: cloud_billing_account cloud_billing_account_plan_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_billing_account
    ADD CONSTRAINT cloud_billing_account_plan_fk FOREIGN KEY (plan_code) REFERENCES public.cloud_plan(code);


--
-- Name: cloud_ledger_entry cloud_ledger_entry_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_ledger_entry
    ADD CONSTRAINT cloud_ledger_entry_account_fk FOREIGN KEY (organization_id) REFERENCES public.cloud_billing_account(organization_id) ON DELETE CASCADE;


--
-- Name: cloud_meter_period cloud_meter_period_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_meter_period
    ADD CONSTRAINT cloud_meter_period_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: connection connection_agent_id_agent_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection
    ADD CONSTRAINT connection_agent_id_agent_id_fk FOREIGN KEY (agent_id) REFERENCES public.agent(id) ON DELETE CASCADE;


--
-- Name: connection connection_agent_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection
    ADD CONSTRAINT connection_agent_project_fk FOREIGN KEY (agent_id, project_id) REFERENCES public.agent(id, project_id) ON DELETE CASCADE;


--
-- Name: connection connection_created_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection
    ADD CONSTRAINT connection_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: connection connection_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection
    ADD CONSTRAINT connection_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: connection connection_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection
    ADD CONSTRAINT connection_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: device_code device_code_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_code
    ADD CONSTRAINT device_code_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: device_code device_code_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_code
    ADD CONSTRAINT device_code_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: device_code device_code_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_code
    ADD CONSTRAINT device_code_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: grader_definition grader_definition_current_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grader_definition
    ADD CONSTRAINT grader_definition_current_version_fk FOREIGN KEY (id, current_definition_version) REFERENCES public.grader_definition_version(definition_id, version) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: grader_definition grader_definition_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grader_definition
    ADD CONSTRAINT grader_definition_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: grader_definition grader_definition_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grader_definition
    ADD CONSTRAINT grader_definition_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: grader_definition_version grader_definition_version_definition_id_grader_definition_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grader_definition_version
    ADD CONSTRAINT grader_definition_version_definition_id_grader_definition_id_fk FOREIGN KEY (definition_id) REFERENCES public.grader_definition(id) ON DELETE CASCADE;


--
-- Name: grading_job grading_job_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grading_job
    ADD CONSTRAINT grading_job_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: grading_job grading_job_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grading_job
    ADD CONSTRAINT grading_job_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: grading_job grading_job_simulation_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grading_job
    ADD CONSTRAINT grading_job_simulation_project_fk FOREIGN KEY (simulation_id, project_id) REFERENCES public.simulation(id, project_id) ON DELETE CASCADE;


--
-- Name: invitation invitation_created_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT invitation_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: invitation invitation_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT invitation_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: membership membership_created_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: membership membership_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: membership membership_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: monitoring_state monitoring_state_agent_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_state
    ADD CONSTRAINT monitoring_state_agent_project_fk FOREIGN KEY (agent_id, project_id) REFERENCES public.agent(id, project_id) ON DELETE CASCADE;


--
-- Name: monitoring_state monitoring_state_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_state
    ADD CONSTRAINT monitoring_state_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: monitoring_state monitoring_state_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_state
    ADD CONSTRAINT monitoring_state_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: persona_definition persona_definition_created_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persona_definition
    ADD CONSTRAINT persona_definition_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: persona_definition persona_definition_current_version_id_persona_definition_versio; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persona_definition
    ADD CONSTRAINT persona_definition_current_version_id_persona_definition_versio FOREIGN KEY (current_version_id) REFERENCES public.persona_definition_version(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: persona_definition persona_definition_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persona_definition
    ADD CONSTRAINT persona_definition_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: persona_definition_version persona_definition_version_created_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persona_definition_version
    ADD CONSTRAINT persona_definition_version_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: persona_definition_version persona_definition_version_persona_id_persona_definition_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persona_definition_version
    ADD CONSTRAINT persona_definition_version_persona_id_persona_definition_id_fk FOREIGN KEY (persona_id) REFERENCES public.persona_definition(id) ON DELETE CASCADE;


--
-- Name: persona_definition persona_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persona_definition
    ADD CONSTRAINT persona_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: project project_created_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project
    ADD CONSTRAINT project_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: project_grader project_grader_grader_definition_id_grader_definition_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_grader
    ADD CONSTRAINT project_grader_grader_definition_id_grader_definition_id_fk FOREIGN KEY (grader_definition_id) REFERENCES public.grader_definition(id) ON DELETE RESTRICT;


--
-- Name: project_grader project_grader_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_grader
    ADD CONSTRAINT project_grader_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: project_grader project_grader_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_grader
    ADD CONSTRAINT project_grader_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: project project_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project
    ADD CONSTRAINT project_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE RESTRICT;


--
-- Name: project_persona project_persona_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_persona
    ADD CONSTRAINT project_persona_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: project_persona project_persona_persona_definition_id_persona_definition_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_persona
    ADD CONSTRAINT project_persona_persona_definition_id_persona_definition_id_fk FOREIGN KEY (persona_definition_id) REFERENCES public.persona_definition(id);


--
-- Name: project_persona project_persona_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_persona
    ADD CONSTRAINT project_persona_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: provider_key provider_key_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_key
    ADD CONSTRAINT provider_key_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: retell_call_retry retell_call_retry_agent_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retell_call_retry
    ADD CONSTRAINT retell_call_retry_agent_project_fk FOREIGN KEY (agent_id, project_id) REFERENCES public.agent(id, project_id) ON DELETE CASCADE;


--
-- Name: retell_call_retry retell_call_retry_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retell_call_retry
    ADD CONSTRAINT retell_call_retry_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: retell_call_retry retell_call_retry_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retell_call_retry
    ADD CONSTRAINT retell_call_retry_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: run run_agent_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run
    ADD CONSTRAINT run_agent_project_fk FOREIGN KEY (agent_id, project_id) REFERENCES public.agent(id, project_id) ON DELETE CASCADE;


--
-- Name: run run_connection_agent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run
    ADD CONSTRAINT run_connection_agent_fk FOREIGN KEY (connection_id, agent_id) REFERENCES public.connection(id, agent_id) ON DELETE CASCADE;


--
-- Name: run_event run_event_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_event
    ADD CONSTRAINT run_event_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: run_event run_event_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_event
    ADD CONSTRAINT run_event_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: run_event run_event_run_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_event
    ADD CONSTRAINT run_event_run_project_fk FOREIGN KEY (run_id, project_id) REFERENCES public.run(id, project_id) ON DELETE CASCADE;


--
-- Name: run_event run_event_simulation_run_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_event
    ADD CONSTRAINT run_event_simulation_run_fk FOREIGN KEY (simulation_id, run_id) REFERENCES public.simulation(id, run_id) ON DELETE CASCADE;


--
-- Name: run run_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run
    ADD CONSTRAINT run_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: run run_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run
    ADD CONSTRAINT run_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: run run_suite_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run
    ADD CONSTRAINT run_suite_project_fk FOREIGN KEY (suite_id, project_id) REFERENCES public.test_suite(id, project_id);


--
-- Name: run run_triggered_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run
    ADD CONSTRAINT run_triggered_by_user_id_fk FOREIGN KEY (triggered_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: session session_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: simulation simulation_agent_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation
    ADD CONSTRAINT simulation_agent_project_fk FOREIGN KEY (agent_id, project_id) REFERENCES public.agent(id, project_id) ON DELETE CASCADE;


--
-- Name: simulation simulation_connection_agent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation
    ADD CONSTRAINT simulation_connection_agent_fk FOREIGN KEY (connection_id, agent_id) REFERENCES public.connection(id, agent_id) ON DELETE CASCADE;


--
-- Name: simulation simulation_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation
    ADD CONSTRAINT simulation_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: simulation simulation_persona_version_persona_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation
    ADD CONSTRAINT simulation_persona_version_persona_fk FOREIGN KEY (persona_version_id, persona_id) REFERENCES public.persona_definition_version(id, persona_id);


--
-- Name: simulation simulation_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation
    ADD CONSTRAINT simulation_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: simulation simulation_run_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation
    ADD CONSTRAINT simulation_run_project_fk FOREIGN KEY (run_id, project_id) REFERENCES public.run(id, project_id) ON DELETE CASCADE;


--
-- Name: simulation simulation_test_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation
    ADD CONSTRAINT simulation_test_project_fk FOREIGN KEY (test_id, project_id) REFERENCES public.test(id, project_id);


--
-- Name: simulation simulation_test_version_test_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation
    ADD CONSTRAINT simulation_test_version_test_fk FOREIGN KEY (test_version_id, test_id) REFERENCES public.test_version(id, test_id);


--
-- Name: test test_created_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test
    ADD CONSTRAINT test_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: test test_current_version_id_test_version_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test
    ADD CONSTRAINT test_current_version_id_test_version_id_fk FOREIGN KEY (current_version_id) REFERENCES public.test_version(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: test test_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test
    ADD CONSTRAINT test_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: test_persona test_persona_persona_id_persona_definition_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_persona
    ADD CONSTRAINT test_persona_persona_id_persona_definition_id_fk FOREIGN KEY (persona_id) REFERENCES public.persona_definition(id);


--
-- Name: test_persona test_persona_test_version_id_test_version_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_persona
    ADD CONSTRAINT test_persona_test_version_id_test_version_id_fk FOREIGN KEY (test_version_id) REFERENCES public.test_version(id) ON DELETE CASCADE;


--
-- Name: test test_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test
    ADD CONSTRAINT test_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: test_suite test_suite_created_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_suite
    ADD CONSTRAINT test_suite_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: test_suite test_suite_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_suite
    ADD CONSTRAINT test_suite_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: test test_suite_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test
    ADD CONSTRAINT test_suite_project_fk FOREIGN KEY (suite_id, project_id) REFERENCES public.test_suite(id, project_id);


--
-- Name: test_suite test_suite_project_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_suite
    ADD CONSTRAINT test_suite_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES public.project(id, organization_id) ON DELETE CASCADE;


--
-- Name: test_version test_version_created_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_version
    ADD CONSTRAINT test_version_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: test_version test_version_test_id_test_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_version
    ADD CONSTRAINT test_version_test_id_test_id_fk FOREIGN KEY (test_id) REFERENCES public.test(id) ON DELETE CASCADE;
