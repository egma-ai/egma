-- Direct pre-launch Monitoring cutover.
--
-- This removes the connection-owned Retell Monitoring state, its webhook
-- state, and all old production claims. Supported simulation connections and
-- their frozen run snapshots move to the explicit platform, connection kind,
-- and access variant axes in the same forward-only migration.

DROP TABLE IF EXISTS "retell_webhook_refusal" CASCADE;
--> statement-breakpoint
-- Old production trace ids must not keep their unique grading-job row. A new
-- trace with the same deterministic id needs to enqueue fresh grading work.
DELETE FROM "grading_job" WHERE "source" = 'production';
--> statement-breakpoint
DROP TABLE IF EXISTS "production_trace_claim" CASCADE;
--> statement-breakpoint

CREATE TABLE "monitoring_setup" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"agent_platform" text NOT NULL,
	"strategy" text NOT NULL,
	"credentials" text,
	"credentials_hint" text,
	"health_state" text DEFAULT 'healthy' NOT NULL,
	"blocked_until" timestamp with time zone,
	"failure_started_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error_at" timestamp with time zone,
	"last_recovered_at" timestamp with time zone,
	"last_received_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_setup_project_platform_unique" UNIQUE("project_id","agent_platform"),
	CONSTRAINT "monitoring_setup_id_prefix" CHECK ("monitoring_setup"."id" ~ '^mns_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "monitoring_setup_platform_allowed" CHECK ("monitoring_setup"."agent_platform" in ('retell', 'livekit_agents')),
	CONSTRAINT "monitoring_setup_strategy_allowed" CHECK ("monitoring_setup"."strategy" in ('retell_api_polling', 'livekit_otlp')),
	CONSTRAINT "monitoring_setup_health_allowed" CHECK ("monitoring_setup"."health_state" in ('healthy', 'invalid_credential', 'rate_limited', 'provider_unavailable')),
	CONSTRAINT "monitoring_setup_credentials_hint_agrees" CHECK (("monitoring_setup"."credentials" is null) = ("monitoring_setup"."credentials_hint" is null)),
	CONSTRAINT "monitoring_setup_platform_strategy_agrees" CHECK (("monitoring_setup"."agent_platform" = 'retell' and "monitoring_setup"."strategy" = 'retell_api_polling' and "monitoring_setup"."credentials" is not null) or ("monitoring_setup"."agent_platform" = 'livekit_agents' and "monitoring_setup"."strategy" = 'livekit_otlp' and "monitoring_setup"."credentials" is null))
);
--> statement-breakpoint
CREATE TABLE "retell_ingestion_failure" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"retell_monitored_agent_id" text COLLATE "C" NOT NULL,
	"provider_call_id" text NOT NULL,
	"error_kind" text NOT NULL,
	"payload" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"replay_lease_owner" text,
	"replay_lease_expires_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retell_ingestion_failure_project_call_unique" UNIQUE("project_id","provider_call_id"),
	CONSTRAINT "retell_ingestion_failure_id_prefix" CHECK ("retell_ingestion_failure"."id" ~ '^rif_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "retell_ingestion_failure_status_allowed" CHECK ("retell_ingestion_failure"."status" in ('open', 'resolved')),
	CONSTRAINT "retell_ingestion_failure_resolved_agrees" CHECK (("retell_ingestion_failure"."status" = 'resolved') = ("retell_ingestion_failure"."resolved_at" is not null)),
	CONSTRAINT "retell_ingestion_failure_replay_lease_agrees" CHECK (("retell_ingestion_failure"."replay_lease_owner" is null) = ("retell_ingestion_failure"."replay_lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "retell_monitored_agent" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"monitoring_setup_id" text COLLATE "C" NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"provider_agent_id" text NOT NULL,
	"provider_agent_name" text NOT NULL,
	"state" text DEFAULT 'importing' NOT NULL,
	"scan_kind" text,
	"scan_from" timestamp with time zone,
	"scan_through" timestamp with time zone,
	"pagination_key" text,
	"pagination_trail" text DEFAULT '[]' NOT NULL,
	"reconciliation_from" timestamp with time zone,
	"reconciliation_through" timestamp with time zone,
	"reconciliation_pagination_key" text,
	"reconciliation_pagination_trail" text DEFAULT '[]' NOT NULL,
	"reconciliation_needs_regular" boolean DEFAULT false NOT NULL,
	"completed_through" timestamp with time zone,
	"next_regular_poll_at" timestamp with time zone NOT NULL,
	"next_poll_at" timestamp with time zone NOT NULL,
	"next_reconciliation_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error_kind" text,
	"last_error_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_call_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retell_monitored_agent_setup_provider_unique" UNIQUE("monitoring_setup_id","provider_agent_id"),
	CONSTRAINT "retell_monitored_agent_id_prefix" CHECK ("retell_monitored_agent"."id" ~ '^rma_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "retell_monitored_agent_state_allowed" CHECK ("retell_monitored_agent"."state" in ('importing', 'active', 'degraded')),
	CONSTRAINT "retell_monitored_agent_scan_kind_allowed" CHECK ("retell_monitored_agent"."scan_kind" in ('historical_import', 'regular', 'reconciliation')),
	CONSTRAINT "retell_monitored_agent_scan_agrees" CHECK (("retell_monitored_agent"."scan_kind" is null and "retell_monitored_agent"."scan_from" is null and "retell_monitored_agent"."scan_through" is null and "retell_monitored_agent"."pagination_key" is null) or ("retell_monitored_agent"."scan_kind" is not null and "retell_monitored_agent"."scan_from" is not null and "retell_monitored_agent"."scan_through" is not null)),
	CONSTRAINT "retell_monitored_agent_reconciliation_agrees" CHECK (("retell_monitored_agent"."reconciliation_from" is null and "retell_monitored_agent"."reconciliation_through" is null and "retell_monitored_agent"."reconciliation_pagination_key" is null and "retell_monitored_agent"."reconciliation_needs_regular" = false) or ("retell_monitored_agent"."reconciliation_from" is not null and "retell_monitored_agent"."reconciliation_through" is not null)),
	CONSTRAINT "retell_monitored_agent_lease_agrees" CHECK (("retell_monitored_agent"."lease_owner" is null) = ("retell_monitored_agent"."lease_expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "agent_platform" text;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "connection_kind" text;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "access_variant" text;--> statement-breakpoint

-- A legacy direct Retell voice row never had a working simulator adapter. It
-- cannot truthfully become Retell chat or generic phone, so remove it and the
-- pre-launch run history that cascades from it.
DELETE FROM "connection" WHERE "type" = 'retell' AND "modality" = 'voice';
--> statement-breakpoint

UPDATE "connection"
SET
	"agent_platform" = CASE
		WHEN "type" = 'retell' THEN 'retell'
		WHEN "type" = 'livekit' THEN 'livekit_agents'
		ELSE NULL
	END,
	"connection_kind" = CASE
		WHEN "type" = 'retell' THEN 'retell_chat_api'
		WHEN "type" = 'phone' THEN 'phone_number'
		WHEN "type" = 'livekit' THEN 'livekit_room'
	END,
	"access_variant" = CASE
		WHEN "variant_id" = 'retell.api_key' THEN 'retell_chat_api.api_key'
		WHEN "variant_id" = 'phone.number' THEN 'phone_number.public_e164'
		WHEN "variant_id" = 'livekit.key_pair' THEN 'livekit_room.project_credentials'
		WHEN "variant_id" = 'livekit.token_endpoint' THEN 'livekit_room.customer_token_endpoint'
	END;
--> statement-breakpoint

-- Runs freeze the non-secret connection facts as camelCase JSON. Read the
-- access variant from the historical snapshot, because the connection may
-- have been edited after the run started.
UPDATE "run"
SET "connection_snapshot" = jsonb_build_object(
	'agentPlatform', CASE "connection_snapshot" ->> 'type'
		WHEN 'retell' THEN 'retell'
		WHEN 'livekit' THEN 'livekit_agents'
		ELSE NULL
	END,
	'connectionKind', CASE "connection_snapshot" ->> 'type'
		WHEN 'retell' THEN 'retell_chat_api'
		WHEN 'phone' THEN 'phone_number'
		WHEN 'livekit' THEN 'livekit_room'
	END,
	'accessVariant', CASE
		WHEN "connection_snapshot" ->> 'type' = 'retell' THEN 'retell_chat_api.api_key'
		WHEN "connection_snapshot" ->> 'type' = 'phone' THEN 'phone_number.public_e164'
		WHEN "connection_snapshot" ->> 'type' = 'livekit'
			AND ("connection_snapshot" -> 'config') ? 'tokenEndpoint'
			THEN 'livekit_room.customer_token_endpoint'
		WHEN "connection_snapshot" ->> 'type' = 'livekit'
			THEN 'livekit_room.project_credentials'
	END,
	'modality', "connection_snapshot" -> 'modality',
	'topology', "connection_snapshot" -> 'topology',
	'environment', "connection_snapshot" -> 'environment',
	'config', "connection_snapshot" -> 'config'
)
WHERE "connection_snapshot" ->> 'type' IN ('retell', 'phone', 'livekit');
--> statement-breakpoint

ALTER TABLE "connection" ALTER COLUMN "connection_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" ALTER COLUMN "access_variant" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" DROP CONSTRAINT "connection_type_allowed";--> statement-breakpoint

CREATE TABLE "production_trace_claim" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"trace_id" text NOT NULL,
	"provider_call_id" text NOT NULL,
	"provider_agent_id" text NOT NULL,
	"provider_agent_name" text,
	"provider_agent_version" text,
	"payload" text NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"written_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_trace_claim_project_call_unique" UNIQUE("project_id","provider_call_id"),
	CONSTRAINT "production_trace_claim_trace_id_unique" UNIQUE("trace_id"),
	CONSTRAINT "production_trace_claim_id_prefix" CHECK ("production_trace_claim"."id" ~ '^ptc_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "production_trace_claim_status_allowed" CHECK ("production_trace_claim"."status" in ('claimed', 'written')),
	CONSTRAINT "production_trace_claim_written_agrees" CHECK (("production_trace_claim"."status" = 'written') = ("production_trace_claim"."written_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "monitoring_setup" ADD CONSTRAINT "monitoring_setup_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_setup" ADD CONSTRAINT "monitoring_setup_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_setup" ADD CONSTRAINT "monitoring_setup_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retell_ingestion_failure" ADD CONSTRAINT "retell_ingestion_failure_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retell_ingestion_failure" ADD CONSTRAINT "retell_ingestion_failure_retell_monitored_agent_id_retell_monitored_agent_id_fk" FOREIGN KEY ("retell_monitored_agent_id") REFERENCES "public"."retell_monitored_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retell_ingestion_failure" ADD CONSTRAINT "retell_ingestion_failure_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" ADD CONSTRAINT "retell_monitored_agent_monitoring_setup_id_monitoring_setup_id_fk" FOREIGN KEY ("monitoring_setup_id") REFERENCES "public"."monitoring_setup"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" ADD CONSTRAINT "retell_monitored_agent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" ADD CONSTRAINT "retell_monitored_agent_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_trace_claim" ADD CONSTRAINT "production_trace_claim_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_trace_claim" ADD CONSTRAINT "production_trace_claim_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitoring_setup_project_idx" ON "monitoring_setup" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "retell_ingestion_failure_open_idx" ON "retell_ingestion_failure" USING btree ("retell_monitored_agent_id","last_attempt_at") WHERE "retell_ingestion_failure"."status" = 'open';--> statement-breakpoint
CREATE INDEX "retell_monitored_agent_due_idx" ON "retell_monitored_agent" USING btree ("next_poll_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "retell_monitored_agent_project_idx" ON "retell_monitored_agent" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "production_trace_claim_unwritten_idx" ON "production_trace_claim" USING btree ("claimed_at") WHERE "production_trace_claim"."status" = 'claimed';--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "variant_id";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "watch_production";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "production_cursor";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "webhook_registered_at";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "webhook_delivered_at";--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_agent_platform_allowed" CHECK ("connection"."agent_platform" in ('retell', 'livekit_agents'));--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_kind_allowed" CHECK ("connection"."connection_kind" in ('retell_chat_api', 'phone_number', 'livekit_room'));--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_access_variant_allowed" CHECK ("connection"."access_variant" in ('retell_chat_api.api_key', 'phone_number.public_e164', 'livekit_room.project_credentials', 'livekit_room.customer_token_endpoint'));
