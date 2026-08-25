-- PRE-PRODUCTION BASELINE RESET, confirmed by the founder on 2026-08-25.
-- This file replaces PostgreSQL migrations 0000 through 0046. Self-hosted
-- databases that ran them must be recreated. A managed store may instead adopt
-- this exact file hash only after an operator verifies every old ledger hash
-- and the logical schema; old ledger rows may remain for rollback. The baseline
-- creates only the current schema and current catalog rows; it carries no
-- rename, backfill, or general compatibility path.
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"user_id" text COLLATE "C" NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_id_prefix" CHECK ("account"."id" ~ '^acc_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"user_id" text COLLATE "C" NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token"),
	CONSTRAINT "session_id_prefix" CHECK ("session"."id" ~ '^ses_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"name" text,
	"image" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"external_identity_provider" text,
	"external_identity_id" text,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_external_identity_unique" UNIQUE("external_identity_provider","external_identity_id"),
	CONSTRAINT "user_id_prefix" CHECK ("user"."id" ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_id_prefix" CHECK ("verification"."id" ~ '^vrf_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C",
	"scope" text NOT NULL,
	"hash" text NOT NULL,
	"prefix" text NOT NULL,
	"display_suffix" text NOT NULL,
	"name" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" text COLLATE "C" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_hash_unique" UNIQUE("hash"),
	CONSTRAINT "api_key_id_prefix" CHECK ("api_key"."id" ~ '^key_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "api_key_scope_allowed" CHECK ("api_key"."scope" in ('organization', 'project')),
	CONSTRAINT "api_key_project_scope_agrees" CHECK (("api_key"."scope" = 'project') = ("api_key"."project_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"email" "citext" NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitation_id_prefix" CHECK ("invitation"."id" ~ '^inv_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "invitation_role_allowed" CHECK ("invitation"."role" in ('admin', 'member', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"user_id" text COLLATE "C" NOT NULL,
	"role" text NOT NULL,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "membership_organization_id_user_id_unique" UNIQUE("organization_id","user_id"),
	CONSTRAINT "membership_id_prefix" CHECK ("membership"."id" ~ '^mbr_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "membership_role_allowed" CHECK ("membership"."role" in ('admin', 'member', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"external_identity_provider" text,
	"external_identity_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organization_external_identity_unique" UNIQUE("external_identity_provider","external_identity_id"),
	CONSTRAINT "organization_id_prefix" CHECK ("organization"."id" ~ '^org_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"retention_days" integer,
	"data_residency" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_settings_organization_id_prefix" CHECK ("organization_settings"."organization_id" ~ '^org_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"revision" text COLLATE "C" NOT NULL,
	"default_persona_id" text COLLATE "C" DEFAULT 'prs_01M0E4EVJ6ECGVJEA4NSBTC0CC' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_organization_id_slug_unique" UNIQUE("organization_id","slug"),
	CONSTRAINT "project_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "project_id_prefix" CHECK ("project"."id" ~ '^prj_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "project_revision_prefix" CHECK ("project"."revision" ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text COLLATE "C",
	"client_id" text,
	"scope" text,
	"status" text NOT NULL,
	"organization_id" text COLLATE "C",
	"project_id" text COLLATE "C",
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	"polling_interval" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_code_device_code_unique" UNIQUE("device_code"),
	CONSTRAINT "device_code_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "device_code_id_prefix" CHECK ("device_code"."id" ~ '^dvc_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "device_code_status_allowed" CHECK ("device_code"."status" in ('pending', 'approved', 'denied')),
	CONSTRAINT "device_code_authorized_for_agrees" CHECK (("device_code"."organization_id" is null) = ("device_code"."project_id" is null))
);
--> statement-breakpoint
CREATE TABLE "persona" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C",
	"project_id" text COLLATE "C",
	"name" text NOT NULL,
	"description" text,
	"current_version_id" text COLLATE "C" NOT NULL,
	"revision" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persona_id_prefix" CHECK ("persona"."id" ~ '^prs_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "persona_tenancy_is_whole_or_egmas" CHECK (("persona"."organization_id" is null) = ("persona"."project_id" is null)),
	CONSTRAINT "persona_egma_provided_is_active" CHECK ("persona"."organization_id" is not null or "persona"."archived_at" is null)
);
--> statement-breakpoint
CREATE TABLE "persona_version" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"persona_id" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"traits" jsonb NOT NULL,
	"models" jsonb NOT NULL,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persona_version_persona_id_version_unique" UNIQUE("persona_id","version"),
	CONSTRAINT "persona_version_id_persona_id_unique" UNIQUE("id","persona_id"),
	CONSTRAINT "persona_version_id_prefix" CHECK ("persona_version"."id" ~ '^prsv_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "persona_version_traits_valid" CHECK (
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
      ),
	CONSTRAINT "persona_version_models_valid" CHECK (
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
      )
);
--> statement-breakpoint
CREATE TABLE "agent" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"agent_platform" text NOT NULL,
	"platform_agent_id" text,
	"monitoring_api_key" text,
	"monitoring_api_key_hint" text,
	"pull_production_calls" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "agent_id_prefix" CHECK ("agent"."id" ~ '^agt_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "agent_platform_allowed" CHECK ("agent"."agent_platform" in ('retell', 'livekit')),
	CONSTRAINT "agent_monitoring_key_hint_agrees" CHECK (("agent"."monitoring_api_key" is null) = ("agent"."monitoring_api_key_hint" is null)),
	CONSTRAINT "agent_monitoring_key_needs_platform" CHECK ("agent"."monitoring_api_key" is null or "agent"."agent_platform" is not null),
	CONSTRAINT "agent_pull_needs_binding" CHECK ("agent"."pull_production_calls" = false or ("agent"."agent_platform" is not null and "agent"."platform_agent_id" is not null and "agent"."monitoring_api_key" is not null))
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"connection_type" text NOT NULL,
	"modality" text NOT NULL,
	"topology" text NOT NULL,
	"access_variant" text NOT NULL,
	"environment" text,
	"config" jsonb NOT NULL,
	"credentials" text,
	"credentials_hint" text,
	"archived_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_id_agent_id_unique" UNIQUE("id","agent_id"),
	CONSTRAINT "connection_id_prefix" CHECK ("connection"."id" ~ '^con_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "connection_type_allowed" CHECK ("connection"."connection_type" in ('retell_chat_api', 'phone_number', 'livekit_room')),
	CONSTRAINT "connection_access_variant_allowed" CHECK ("connection"."access_variant" in ('retell_chat_api.api_key', 'phone_number.public_e164', 'livekit_room.project_credentials', 'livekit_room.customer_token_endpoint')),
	CONSTRAINT "connection_modality_allowed" CHECK ("connection"."modality" in ('voice', 'chat')),
	CONSTRAINT "connection_topology_allowed" CHECK ("connection"."topology" in ('agent-dials-out', 'hosted-broker', 'egma-dials-in')),
	CONSTRAINT "connection_credentials_hint_agrees" CHECK (("connection"."credentials" is null) = ("connection"."credentials_hint" is null))
);
--> statement-breakpoint
CREATE TABLE "monitoring_state" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"scan_kind" text,
	"scan_from" timestamp with time zone,
	"scan_through" timestamp with time zone,
	"pagination_key" text,
	"pagination_trail" text DEFAULT '[]' NOT NULL,
	"completed_through" timestamp with time zone,
	"next_poll_at" timestamp with time zone NOT NULL,
	"regular_floor_at" timestamp with time zone,
	"import_generation" integer DEFAULT 1 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"failure_started_at" timestamp with time zone,
	"last_error_kind" text,
	"last_error_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_state_agent_unique" UNIQUE("agent_id"),
	CONSTRAINT "monitoring_state_id_prefix" CHECK ("monitoring_state"."id" ~ '^mst_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "monitoring_state_scan_kind_allowed" CHECK ("monitoring_state"."scan_kind" in ('historical_import', 'regular')),
	CONSTRAINT "monitoring_state_scan_agrees" CHECK (("monitoring_state"."scan_kind" is null and "monitoring_state"."scan_from" is null and "monitoring_state"."scan_through" is null and "monitoring_state"."pagination_key" is null) or ("monitoring_state"."scan_kind" is not null and "monitoring_state"."scan_from" is not null and "monitoring_state"."scan_through" is not null)),
	CONSTRAINT "monitoring_state_lease_agrees" CHECK (("monitoring_state"."lease_owner" is null) = ("monitoring_state"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "retell_call_retry" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"provider_call_id" text NOT NULL,
	"error_kind" text NOT NULL,
	"attempts" smallint DEFAULT 1 NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"import_generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retell_call_retry_project_call_unique" UNIQUE("project_id","provider_call_id"),
	CONSTRAINT "retell_call_retry_id_prefix" CHECK ("retell_call_retry"."id" ~ '^rcr_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "retell_call_retry_one_schedule" CHECK (("retell_call_retry"."next_attempt_at" is null) <> ("retell_call_retry"."expires_at" is null)),
	CONSTRAINT "retell_call_retry_attempts_bounded" CHECK ("retell_call_retry"."attempts" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "grader_definition" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C",
	"name" text NOT NULL,
	"description" text,
	"scope_editable" boolean NOT NULL,
	"current_definition_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grader_definition_id_prefix" CHECK ("grader_definition"."id" ~ '^grl_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "grader_definition_version" (
	"definition_id" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"type" text NOT NULL,
	"prompt" text,
	"parameter_contract" jsonb NOT NULL,
	"output_contract" jsonb,
	"modalities" jsonb NOT NULL,
	"judge_model" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grader_definition_version_definition_id_version_pk" PRIMARY KEY("definition_id","version"),
	CONSTRAINT "grader_definition_version_definition_id_prefix" CHECK ("grader_definition_version"."definition_id" ~ '^grl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "grader_definition_version_version_is_positive" CHECK ("grader_definition_version"."version" >= 1),
	CONSTRAINT "grader_definition_version_type_allowed" CHECK ("grader_definition_version"."type" in ('llm_as_judge', 'code')),
	CONSTRAINT "grader_definition_version_modalities_allowed" CHECK ("grader_definition_version"."modalities" in (
        '["chat"]'::jsonb,
        '["voice"]'::jsonb,
        '["chat", "voice"]'::jsonb,
        '["voice", "chat"]'::jsonb
      ))
);
--> statement-breakpoint
CREATE TABLE "project_grader" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"grader_definition_id" text COLLATE "C" NOT NULL,
	"scope" jsonb NOT NULL,
	"parameter_values" jsonb NOT NULL,
	"pass_threshold" double precision NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_grader_id_prefix" CHECK ("project_grader"."id" ~ '^grd_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "project_grader_scope_is_closed_object" CHECK (jsonb_typeof("project_grader"."scope") is not distinct from 'object'
        and ("project_grader"."scope" - array['simulations', 'production']::text[])
          is not distinct from '{}'::jsonb
        and "project_grader"."scope" ?& array['simulations', 'production']::text[]
        and jsonb_typeof("project_grader"."scope"->'simulations') is not distinct from 'array'
        and (
          "project_grader"."scope"->'production' = 'null'::jsonb
          or jsonb_typeof("project_grader"."scope"->'production') is not distinct from 'object'
        )),
	CONSTRAINT "project_grader_pass_threshold_is_normalized" CHECK ("project_grader"."pass_threshold" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "mock_tool" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"tool_name" text NOT NULL,
	"answer" jsonb NOT NULL,
	"delay_milliseconds" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mock_tool_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "mock_tool_id_prefix" CHECK ("mock_tool"."id" ~ '^mck_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "mock_tool_delay_within_budget" CHECK ("mock_tool"."delay_milliseconds" between 0 and 30000)
);
--> statement-breakpoint
CREATE TABLE "mock_tool_agent" (
	"mock_tool_id" text COLLATE "C" NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "mock_tool_agent_pk" PRIMARY KEY("mock_tool_id","agent_id"),
	CONSTRAINT "mock_tool_agent_mock_tool_id_position_unique" UNIQUE("mock_tool_id","position"),
	CONSTRAINT "mock_tool_agent_mock_tool_id_prefix" CHECK ("mock_tool_agent"."mock_tool_id" ~ '^mck_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "test" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"suite_id" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"current_version_id" text COLLATE "C" NOT NULL,
	"revision" text COLLATE "C" NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "test_id_prefix" CHECK ("test"."id" ~ '^tst_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "test_revision_prefix" CHECK ("test"."revision" ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "test_persona" (
	"test_version_id" text COLLATE "C" NOT NULL,
	"persona_id" text COLLATE "C" NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "test_persona_pk" PRIMARY KEY("test_version_id","persona_id"),
	CONSTRAINT "test_persona_version_id_position_unique" UNIQUE("test_version_id","position"),
	CONSTRAINT "test_persona_test_version_id_prefix" CHECK ("test_persona"."test_version_id" ~ '^tstv_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "test_suite" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_suite_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "test_suite_id_prefix" CHECK ("test_suite"."id" ~ '^ste_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "test_suite_name_is_not_blank" CHECK (btrim("test_suite"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "test_version" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"test_id" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_version_test_id_version_unique" UNIQUE("test_id","version"),
	CONSTRAINT "test_version_id_test_id_unique" UNIQUE("id","test_id"),
	CONSTRAINT "test_version_id_prefix" CHECK ("test_version"."id" ~ '^tstv_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"suite_id" text COLLATE "C" NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"connection_id" text COLLATE "C" NOT NULL,
	"name" text,
	"status" text NOT NULL,
	"triggered_via" text NOT NULL,
	"triggered_by" text COLLATE "C",
	"connection_snapshot" jsonb NOT NULL,
	"mock_tool_snapshot" jsonb NOT NULL,
	"expected_simulation_count" integer NOT NULL,
	"completed_count" integer,
	"failed_count" integer,
	"canceled_count" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "run_id_prefix" CHECK ("run"."id" ~ '^run_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "run_status_allowed" CHECK ("run"."status" in ('pending', 'running', 'completed', 'canceled')),
	CONSTRAINT "run_triggered_via_allowed" CHECK ("run"."triggered_via" in ('manual')),
	CONSTRAINT "run_expects_at_least_one_simulation" CHECK ("run"."expected_simulation_count" > 0),
	CONSTRAINT "run_counts_written_together" CHECK ((("run"."completed_count" is null) = ("run"."failed_count" is null))
        and (("run"."failed_count" is null) = ("run"."canceled_count" is null))
        and (("run"."canceled_count" is null) = ("run"."finished_at" is null))),
	CONSTRAINT "run_counts_are_counts" CHECK (("run"."completed_count" is null)
        or ("run"."completed_count" >= 0 and "run"."failed_count" >= 0
          and "run"."canceled_count" >= 0)),
	CONSTRAINT "run_finished_is_terminal" CHECK ("run"."finished_at" is null or "run"."status" in ('completed', 'canceled')),
	CONSTRAINT "run_completed_is_finished" CHECK ("run"."status" <> 'completed' or "run"."finished_at" is not null),
	CONSTRAINT "run_started_when_left_pending" CHECK (case
        when "run"."status" = 'pending' then "run"."started_at" is null
        when "run"."status" in ('running', 'completed') then "run"."started_at" is not null
        else true
      end)
);
--> statement-breakpoint
CREATE TABLE "run_event" (
	"run_id" text COLLATE "C" NOT NULL,
	"seq" integer NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"kind" text NOT NULL,
	"simulation_id" text COLLATE "C",
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_event_pk" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "run_event_run_id_prefix" CHECK ("run_event"."run_id" ~ '^run_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "run_event_kind_allowed" CHECK ("run_event"."kind" in ('run', 'simulation')),
	CONSTRAINT "run_event_seq_counts_from_one" CHECK ("run_event"."seq" >= 1),
	CONSTRAINT "run_event_run_shape" CHECK ("run_event"."kind" <> 'run'
        or ("run_event"."simulation_id" is null
          and "run_event"."reason" is null
          and "run_event"."status" in ('pending', 'running', 'completed', 'canceled'))),
	CONSTRAINT "run_event_simulation_shape" CHECK ("run_event"."kind" <> 'simulation'
        or ("run_event"."simulation_id" is not null
          and "run_event"."status" in ('queued', 'claimed', 'running', 'completed', 'failed', 'canceled'))),
	CONSTRAINT "run_event_reason_agrees" CHECK ("run_event"."reason" is null
        or ("run_event"."status" = 'completed' and "run_event"."reason" in ('persona_concluded', 'agent_ended', 'limit_reached'))
        or ("run_event"."status" = 'failed' and "run_event"."reason" in ('agent_never_joined', 'not_answered', 'capacity', 'simulator_error', 'orphaned', 'dispatch_failed')))
);
--> statement-breakpoint
CREATE TABLE "simulation" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"run_id" text COLLATE "C" NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"connection_id" text COLLATE "C" NOT NULL,
	"persona_id" text COLLATE "C" NOT NULL,
	"persona_version_id" text COLLATE "C" NOT NULL,
	"test_id" text COLLATE "C" NOT NULL,
	"test_version_id" text COLLATE "C" NOT NULL,
	"position" integer NOT NULL,
	"modality" text NOT NULL,
	"status" text NOT NULL,
	"ending_reason" text,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"recording_reference" text,
	"turn_count" integer,
	"provider_reference" text,
	"mock_tool_coverage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "simulation_run_id_position_unique" UNIQUE("run_id","position"),
	CONSTRAINT "simulation_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "simulation_id_run_id_unique" UNIQUE("id","run_id"),
	CONSTRAINT "simulation_id_prefix" CHECK ("simulation"."id" ~ '^sim_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "simulation_status_allowed" CHECK ("simulation"."status" in ('queued', 'claimed', 'running', 'completed', 'failed', 'canceled')),
	CONSTRAINT "simulation_modality_allowed" CHECK ("simulation"."modality" in ('voice', 'chat')),
	CONSTRAINT "simulation_position_counts_from_one" CHECK ("simulation"."position" >= 1),
	CONSTRAINT "simulation_ending_reason_allowed" CHECK ("simulation"."ending_reason" is null or "simulation"."ending_reason" in ('persona_concluded', 'agent_ended', 'limit_reached', 'agent_never_joined', 'not_answered', 'capacity', 'simulator_error', 'orphaned', 'dispatch_failed')),
	CONSTRAINT "simulation_ending_reason_agrees" CHECK (case "simulation"."status"
        when 'completed' then "simulation"."ending_reason" in ('persona_concluded', 'agent_ended', 'limit_reached')
        when 'failed' then "simulation"."ending_reason" in ('agent_never_joined', 'not_answered', 'capacity', 'simulator_error', 'orphaned', 'dispatch_failed')
        else "simulation"."ending_reason" is null
      end),
	CONSTRAINT "simulation_claim_columns_agree" CHECK ((("simulation"."claimed_at" is null) = ("simulation"."claimed_by" is null))
        and (("simulation"."claimed_at" is null) = ("simulation"."heartbeat_at" is null))),
	CONSTRAINT "simulation_queued_shape" CHECK ("simulation"."status" <> 'queued'
        or ("simulation"."claimed_at" is null and "simulation"."started_at" is null
          and "simulation"."ended_at" is null and "simulation"."cancel_requested_at" is null)),
	CONSTRAINT "simulation_claimed_shape" CHECK ("simulation"."status" <> 'claimed'
        or ("simulation"."claimed_at" is not null and "simulation"."started_at" is null
          and "simulation"."ended_at" is null)),
	CONSTRAINT "simulation_running_shape" CHECK ("simulation"."status" <> 'running'
        or ("simulation"."claimed_at" is not null and "simulation"."started_at" is not null
          and "simulation"."ended_at" is null)),
	CONSTRAINT "simulation_completed_shape" CHECK ("simulation"."status" <> 'completed'
        or ("simulation"."started_at" is not null and "simulation"."ended_at" is not null)),
	CONSTRAINT "simulation_failed_shape" CHECK ("simulation"."status" <> 'failed' or "simulation"."ended_at" is not null),
	CONSTRAINT "simulation_canceled_shape" CHECK ("simulation"."status" <> 'canceled'
        or ("simulation"."ended_at" is not null and "simulation"."cancel_requested_at" is not null)),
	CONSTRAINT "simulation_report_only_when_ended" CHECK ("simulation"."ended_at" is not null
        or "simulation"."recording_reference" is null),
	CONSTRAINT "simulation_summary_facts_only_when_ended" CHECK ("simulation"."ended_at" is not null
        or ("simulation"."turn_count" is null and "simulation"."provider_reference" is null)),
	CONSTRAINT "simulation_turn_count_is_a_count" CHECK ("simulation"."turn_count" is null or "simulation"."turn_count" >= 0),
	CONSTRAINT "simulation_mock_tool_coverage_only_when_ended" CHECK ("simulation"."ended_at" is not null or "simulation"."mock_tool_coverage" is null),
	CONSTRAINT "simulation_audio_facts_are_voice_facts" CHECK ("simulation"."modality" = 'voice'
        or "simulation"."recording_reference" is null)
);
--> statement-breakpoint
CREATE TABLE "grading_plan" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"run_id" text COLLATE "C" NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"state" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"groups" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grading_plan_run_id_unique" UNIQUE("run_id"),
	CONSTRAINT "grading_plan_id_prefix" CHECK ("grading_plan"."id" ~ '^gpl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "grading_plan_state_allowed" CHECK ("grading_plan"."state" in ('run_start')),
	CONSTRAINT "grading_plan_groups_are_a_list" CHECK (jsonb_typeof("grading_plan"."groups") = 'array')
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
CREATE TABLE "grading_job" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"source" text NOT NULL,
	"simulation_id" text COLLATE "C",
	"trace_id" text NOT NULL,
	"trace_started_at" timestamp with time zone NOT NULL,
	"run_id" text COLLATE "C",
	"entries" jsonb NOT NULL,
	"status" text NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"sequence_base" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grading_job_simulation_id_unique" UNIQUE("simulation_id"),
	CONSTRAINT "grading_job_project_id_trace_id_unique" UNIQUE("project_id","trace_id"),
	CONSTRAINT "grading_job_id_prefix" CHECK ("grading_job"."id" ~ '^gjb_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "grading_job_status_allowed" CHECK ("grading_job"."status" in ('pending', 'claimed', 'abandoned')),
	CONSTRAINT "grading_job_source_allowed" CHECK ("grading_job"."source" in ('simulation', 'production')),
	CONSTRAINT "grading_job_source_names_its_control_record" CHECK (case "grading_job"."source"
        when 'simulation' then "grading_job"."simulation_id" is not null and "grading_job"."run_id" is not null
        when 'production' then "grading_job"."simulation_id" is null and "grading_job"."run_id" is null
        else false
      end),
	CONSTRAINT "grading_job_entries_are_a_nonempty_list" CHECK (jsonb_typeof("grading_job"."entries") = 'array'
        and jsonb_array_length("grading_job"."entries") > 0),
	CONSTRAINT "grading_job_claim_columns_agree" CHECK ((("grading_job"."claimed_at" is null) = ("grading_job"."claimed_by" is null))
        and (("grading_job"."claimed_at" is null) = ("grading_job"."heartbeat_at" is null))),
	CONSTRAINT "grading_job_pending_shape" CHECK ("grading_job"."status" <> 'pending'
        or ("grading_job"."claimed_at" is null and "grading_job"."finished_at" is null)),
	CONSTRAINT "grading_job_claimed_shape" CHECK ("grading_job"."status" <> 'claimed'
        or ("grading_job"."claimed_at" is not null and "grading_job"."finished_at" is null)),
	CONSTRAINT "grading_job_abandoned_shape" CHECK (("grading_job"."status" = 'abandoned') = ("grading_job"."finished_at" is not null)),
	CONSTRAINT "grading_job_sequence_base_is_counted" CHECK ("grading_job"."sequence_base" >= 0),
	CONSTRAINT "grading_job_attempts_are_counted" CHECK ("grading_job"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_default_persona_id_persona_id_fk" FOREIGN KEY ("default_persona_id") REFERENCES "public"."persona"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_current_version_id_persona_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."persona_version"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_persona_id_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_version" ADD CONSTRAINT "persona_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retell_call_retry" ADD CONSTRAINT "retell_call_retry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retell_call_retry" ADD CONSTRAINT "retell_call_retry_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retell_call_retry" ADD CONSTRAINT "retell_call_retry_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grader_definition" ADD CONSTRAINT "grader_definition_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grader_definition" ADD CONSTRAINT "grader_definition_current_version_fk" FOREIGN KEY ("id","current_definition_version") REFERENCES "public"."grader_definition_version"("definition_id","version") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "grader_definition_version" ADD CONSTRAINT "grader_definition_version_definition_id_grader_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."grader_definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grader" ADD CONSTRAINT "project_grader_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grader" ADD CONSTRAINT "project_grader_grader_definition_id_grader_definition_id_fk" FOREIGN KEY ("grader_definition_id") REFERENCES "public"."grader_definition"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grader" ADD CONSTRAINT "project_grader_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tool" ADD CONSTRAINT "mock_tool_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tool" ADD CONSTRAINT "mock_tool_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tool" ADD CONSTRAINT "mock_tool_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tool_agent" ADD CONSTRAINT "mock_tool_agent_mock_tool_id_mock_tool_id_fk" FOREIGN KEY ("mock_tool_id") REFERENCES "public"."mock_tool"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tool_agent" ADD CONSTRAINT "mock_tool_agent_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tool_agent" ADD CONSTRAINT "mock_tool_agent_mock_tool_project_fk" FOREIGN KEY ("mock_tool_id","project_id") REFERENCES "public"."mock_tool"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tool_agent" ADD CONSTRAINT "mock_tool_agent_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_current_version_id_test_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."test_version"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_suite_project_fk" FOREIGN KEY ("suite_id","project_id") REFERENCES "public"."test_suite"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_persona" ADD CONSTRAINT "test_persona_test_version_id_test_version_id_fk" FOREIGN KEY ("test_version_id") REFERENCES "public"."test_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_persona" ADD CONSTRAINT "test_persona_persona_id_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."persona"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suite" ADD CONSTRAINT "test_suite_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suite" ADD CONSTRAINT "test_suite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suite" ADD CONSTRAINT "test_suite_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_version" ADD CONSTRAINT "test_version_test_id_test_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."test"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_version" ADD CONSTRAINT "test_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_triggered_by_user_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_suite_project_fk" FOREIGN KEY ("suite_id","project_id") REFERENCES "public"."test_suite"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_connection_agent_fk" FOREIGN KEY ("connection_id","agent_id") REFERENCES "public"."connection"("id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_run_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."run"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_simulation_run_fk" FOREIGN KEY ("simulation_id","run_id") REFERENCES "public"."simulation"("id","run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_connection_agent_fk" FOREIGN KEY ("connection_id","agent_id") REFERENCES "public"."connection"("id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_run_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."run"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_persona_version_persona_fk" FOREIGN KEY ("persona_version_id","persona_id") REFERENCES "public"."persona_version"("id","persona_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_test_version_test_fk" FOREIGN KEY ("test_version_id","test_id") REFERENCES "public"."test_version"("id","test_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_test_project_fk" FOREIGN KEY ("test_id","project_id") REFERENCES "public"."test"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_plan" ADD CONSTRAINT "grading_plan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_plan" ADD CONSTRAINT "grading_plan_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_plan" ADD CONSTRAINT "grading_plan_run_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."run"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotent_operation" ADD CONSTRAINT "idempotent_operation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotent_operation" ADD CONSTRAINT "idempotent_operation_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotent_operation" ADD CONSTRAINT "idempotent_operation_actor_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_job" ADD CONSTRAINT "grading_job_simulation_project_fk" FOREIGN KEY ("simulation_id","project_id") REFERENCES "public"."simulation"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "api_key_organization_id_idx" ON "api_key" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_organization_id_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "membership_organization_id_idx" ON "membership" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "project_organization_id_idx" ON "project" USING btree ("organization_id") WHERE "project"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "device_code_expires_at_idx" ON "device_code" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "persona_egma_provided_name_unique" ON "persona" USING btree ("name") WHERE "persona"."organization_id" is null;--> statement-breakpoint
CREATE INDEX "persona_organization_id_project_id_idx" ON "persona" USING btree ("organization_id","project_id") WHERE "persona"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_project_id_name_unique" ON "agent" USING btree ("project_id","name") WHERE "agent"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "agent_organization_id_project_id_idx" ON "agent" USING btree ("organization_id","project_id") WHERE "agent"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_pulled_platform_agent_unique" ON "agent" USING btree ("project_id","agent_platform","platform_agent_id") WHERE "agent"."pull_production_calls";--> statement-breakpoint
CREATE UNIQUE INDEX "connection_agent_id_name_unique" ON "connection" USING btree ("agent_id","name") WHERE "connection"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "connection_agent_id_idx" ON "connection" USING btree ("agent_id") WHERE "connection"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "monitoring_state_due_idx" ON "monitoring_state" USING btree ("next_poll_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "monitoring_state_project_idx" ON "monitoring_state" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "retell_call_retry_due_idx" ON "retell_call_retry" USING btree ("agent_id","next_attempt_at") WHERE "retell_call_retry"."next_attempt_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "grader_definition_predefined_name_unique" ON "grader_definition" USING btree ("name") WHERE "grader_definition"."organization_id" is null;--> statement-breakpoint
CREATE INDEX "grader_definition_organization_id_idx" ON "grader_definition" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_grader_active_definition_unique" ON "project_grader" USING btree ("project_id","grader_definition_id") WHERE "project_grader"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "project_grader_organization_id_project_id_idx" ON "project_grader" USING btree ("organization_id","project_id") WHERE "project_grader"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "project_grader_definition_id_idx" ON "project_grader" USING btree ("grader_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mock_tool_project_id_tool_name_unique" ON "mock_tool" USING btree ("project_id","tool_name") WHERE "mock_tool"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "mock_tool_organization_id_project_id_idx" ON "mock_tool" USING btree ("organization_id","project_id") WHERE "mock_tool"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "mock_tool_agent_agent_id_idx" ON "mock_tool_agent" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "test_organization_id_project_id_idx" ON "test" USING btree ("organization_id","project_id") WHERE "test"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "test_suite_id_id_idx" ON "test" USING btree ("suite_id","id") WHERE "test"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "test_persona_persona_id_idx" ON "test_persona" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "test_suite_organization_id_project_id_idx" ON "test_suite" USING btree ("organization_id","project_id") WHERE "test_suite"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "run_organization_id_id_idx" ON "run" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "run_organization_id_project_id_id_idx" ON "run" USING btree ("organization_id","project_id","id");--> statement-breakpoint
CREATE INDEX "run_agent_id_idx" ON "run" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "run_suite_id_idx" ON "run" USING btree ("suite_id");--> statement-breakpoint
CREATE INDEX "simulation_run_id_idx" ON "simulation" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "simulation_queued_idx" ON "simulation" USING btree ("organization_id","id") WHERE "simulation"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "simulation_heartbeat_idx" ON "simulation" USING btree ("organization_id","heartbeat_at") WHERE "simulation"."status" in ('claimed', 'running');--> statement-breakpoint
CREATE INDEX "simulation_persona_version_id_idx" ON "simulation" USING btree ("persona_version_id");--> statement-breakpoint
CREATE INDEX "simulation_persona_id_idx" ON "simulation" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "simulation_test_version_id_idx" ON "simulation" USING btree ("test_version_id");--> statement-breakpoint
CREATE INDEX "simulation_test_id_idx" ON "simulation" USING btree ("test_id");--> statement-breakpoint
CREATE INDEX "grading_plan_organization_id_project_id_idx" ON "grading_plan" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "grading_job_outstanding_idx" ON "grading_job" USING btree ("id") WHERE "grading_job"."status" in ('pending', 'claimed');--> statement-breakpoint
CREATE INDEX "grading_job_organization_id_project_id_idx" ON "grading_job" USING btree ("organization_id","project_id");

-- Current database behavior that Drizzle does not model.
CREATE OR REPLACE FUNCTION public.guard_default_persona_archive()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	IF OLD.archived_at IS NULL
		AND NEW.archived_at IS NOT NULL THEN
		-- Use the same key as the project pointer guard. Whichever write takes
		-- it first commits before the other checks, so two stale writers cannot
		-- each approve half of an archived-default state.
		PERFORM pg_advisory_xact_lock(
			hashtextextended('egma:default-persona:' || NEW.id, 0)
		);
	END IF;

	IF OLD.archived_at IS NULL
		AND NEW.archived_at IS NOT NULL
		AND EXISTS (
			SELECT 1 FROM project target
			WHERE target.default_persona_id = NEW.id
		)
	THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'project_default_persona_availability',
			MESSAGE = 'a project default persona cannot be archived before its pointer moves';
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_grader_definition_version_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'grader definition versions are immutable';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_persona_ownership_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.project_id IS DISTINCT FROM OLD.project_id
	THEN
		RAISE EXCEPTION 'a persona ownership cannot change';
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_persona_version_semantics_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_project_default_persona_availability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.default_persona_id IS NOT NULL THEN
		-- The reverse archive guard takes this exact lock before it checks the
		-- project table. This makes choosing a default and archiving that same
		-- persona one ordered decision even though they update different rows.
		PERFORM pg_advisory_xact_lock(
			hashtextextended('egma:default-persona:' || NEW.default_persona_id, 0)
		);
	END IF;

	IF NEW.default_persona_id IS NOT NULL
		AND NOT persona_is_active_default_for_project(NEW.default_persona_id, NEW.id)
	THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'project_default_persona_availability',
			MESSAGE = 'the default persona is not available to this project';
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_run_event_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'event % of run % is written once, and what happened cannot be rewritten',
    OLD.seq, OLD.run_id;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_run_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- The counts and finished_at land together, once; after that the header is
  -- frozen and a retry is a new run.
  IF OLD.finished_at IS NOT NULL THEN
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
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_simulation_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_simulation_persona_availability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	IF NOT persona_is_available_to_project(NEW.persona_id, NEW.project_id)
	THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'simulation_persona_availability',
			MESSAGE = 'the persona is not available to this simulation project';
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_test_ownership_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.project_id IS DISTINCT FROM OLD.project_id
	THEN
		RAISE EXCEPTION 'a test ownership cannot change';
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_test_persona_availability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_test_suite_membership()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	IF NEW.suite_id IS DISTINCT FROM OLD.suite_id THEN
		RAISE EXCEPTION 'test % belongs to suite % for life', OLD.id, OLD.suite_id
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_test_version_test_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	IF NEW.test_id IS DISTINCT FROM OLD.test_id
	THEN
		RAISE EXCEPTION 'a test version cannot move between tests';
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.persona_is_active_default_for_project(wanted_persona_id text, wanted_project_id text)
 RETURNS boolean
 LANGUAGE sql
AS $function$
	SELECT EXISTS (
		SELECT 1
		FROM persona p
		WHERE p.id = wanted_persona_id
			AND p.archived_at IS NULL
			AND (
				p.project_id = wanted_project_id
				OR (p.organization_id IS NULL AND p.project_id IS NULL)
			)
	);
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.persona_is_available_to_project(wanted_persona_id text, wanted_project_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
	SELECT EXISTS (
		SELECT 1
		FROM persona p
		WHERE p.id = wanted_persona_id
			AND (
				p.project_id = wanted_project_id
				OR (p.organization_id IS NULL AND p.project_id IS NULL)
			)
	);
$function$;
--> statement-breakpoint

-- Triggers for the current schema.
CREATE TRIGGER grader_definition_version_is_immutable BEFORE UPDATE ON grader_definition_version FOR EACH ROW EXECUTE FUNCTION guard_grader_definition_version_immutable();
--> statement-breakpoint
CREATE TRIGGER persona_default_archive_guard BEFORE UPDATE OF archived_at ON persona FOR EACH ROW EXECUTE FUNCTION guard_default_persona_archive();
--> statement-breakpoint
CREATE TRIGGER persona_ownership_immutable_guard BEFORE UPDATE OF organization_id, project_id ON persona FOR EACH ROW EXECUTE FUNCTION guard_persona_ownership_immutable();
--> statement-breakpoint
CREATE TRIGGER persona_version_semantics_immutable_guard BEFORE UPDATE OF persona_id, version, traits, models ON persona_version FOR EACH ROW EXECUTE FUNCTION guard_persona_version_semantics_immutable();
--> statement-breakpoint
CREATE TRIGGER project_default_persona_availability_insert_guard BEFORE INSERT ON project FOR EACH ROW EXECUTE FUNCTION guard_project_default_persona_availability();
--> statement-breakpoint
CREATE TRIGGER project_default_persona_availability_update_guard BEFORE UPDATE OF default_persona_id ON project FOR EACH ROW EXECUTE FUNCTION guard_project_default_persona_availability();
--> statement-breakpoint
CREATE TRIGGER run_lifecycle_guard BEFORE UPDATE ON run FOR EACH ROW EXECUTE FUNCTION guard_run_lifecycle();
--> statement-breakpoint
CREATE TRIGGER run_event_append_only_guard BEFORE UPDATE ON run_event FOR EACH ROW EXECUTE FUNCTION guard_run_event_append_only();
--> statement-breakpoint
CREATE TRIGGER simulation_lifecycle_guard BEFORE UPDATE ON simulation FOR EACH ROW EXECUTE FUNCTION guard_simulation_lifecycle();
--> statement-breakpoint
CREATE TRIGGER simulation_persona_availability_insert_guard BEFORE INSERT ON simulation FOR EACH ROW EXECUTE FUNCTION guard_simulation_persona_availability();
--> statement-breakpoint
CREATE TRIGGER simulation_persona_availability_update_guard BEFORE UPDATE OF persona_id, project_id ON simulation FOR EACH ROW EXECUTE FUNCTION guard_simulation_persona_availability();
--> statement-breakpoint
CREATE TRIGGER test_ownership_immutable_guard BEFORE UPDATE OF organization_id, project_id ON test FOR EACH ROW EXECUTE FUNCTION guard_test_ownership_immutable();
--> statement-breakpoint
CREATE TRIGGER test_suite_membership_immutable BEFORE UPDATE OF suite_id ON test FOR EACH ROW EXECUTE FUNCTION guard_test_suite_membership();
--> statement-breakpoint
CREATE TRIGGER test_persona_availability_insert_guard BEFORE INSERT ON test_persona FOR EACH ROW EXECUTE FUNCTION guard_test_persona_availability();
--> statement-breakpoint
CREATE TRIGGER test_persona_availability_update_guard BEFORE UPDATE OF test_version_id, persona_id ON test_persona FOR EACH ROW EXECUTE FUNCTION guard_test_persona_availability();
--> statement-breakpoint
CREATE TRIGGER test_version_test_immutable_guard BEFORE UPDATE OF test_id ON test_version FOR EACH ROW EXECUTE FUNCTION guard_test_version_test_immutable();
--> statement-breakpoint

-- Current Egma-provided persona catalog. Startup seeding reconciles this
-- fixed row with the TypeScript catalog before a project is created.
INSERT INTO persona (id, organization_id, project_id, name, description, current_version_id, revision, archived_at, created_by, created_at, updated_at)
VALUES ('prs_01M0E4EVJ6ECGVJEA4NSBTC0CC', NULL, NULL, 'Default Persona', 'Regular conversationalist persona', 'prsv_01M0E4J0BBE1FVDVTZ1BSS5C97', 'rev_01M0E4EVJ6ECGVJEA4NSBTC0CD', NULL, NULL, '2026-08-19T23:09:01.674Z'::timestamptz, '2026-08-19T23:09:01.674Z'::timestamptz);
--> statement-breakpoint
INSERT INTO persona_version (id, persona_id, version, traits, models, created_by, created_at)
VALUES ('prsv_01M0E4J0BBE1FVDVTZ1BSS5C97', 'prs_01M0E4EVJ6ECGVJEA4NSBTC0CC', 1, '{"accent":"Neutral American English.","language":"en-US","personality":"Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.","backgroundNoise":"None."}'::jsonb, '{"llm":{"model":"gpt-5.6-terra","provider":"openai"},"stt":{"model":"gpt-live-transcribe","provider":"openai"},"tts":{"model":"sonic-3.5","speed":1,"voiceId":"5ee9feff-1265-424a-9d7f-8e4d431a12c7","provider":"cartesia"}}'::jsonb, NULL, '2026-08-19T23:09:01.674Z'::timestamptz);
--> statement-breakpoint
