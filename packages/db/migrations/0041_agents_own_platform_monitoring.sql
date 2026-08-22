-- Prelaunch cleanup. The founder has confirmed that no older API build and no
-- rollback contract is supported past this file, so the removals below are
-- taken in one step and the prior build cannot run after it.
--
-- Agents own platform monitoring (ADR-0015). The agent gains its platform
-- binding and a sealed monitoring-only key, plus the declared pull switch;
-- `monitoring_setup` and `retell_monitored_agent` are dropped whole with no
-- data carried across, and one machine-owned `monitoring_state` notebook per
-- agent takes their place. `retell_ingestion_failure` is recreated as
-- `monitoring_failure`, keyed by agent. `production_trace_claim` is untouched:
-- it is the receipt book that makes this destructive change safe for stored
-- conversations.
--
-- Riding the same pass: `agent.description` is dropped, `connection_kind`
-- becomes `connection_type` (renamed in place, so rows survive), and
-- `revision` leaves `agent` and `connection` — concurrent edits become
-- last-writer-wins, accepted pre-launch. Grader library revisions are a
-- different system and are untouched.

CREATE TABLE "monitoring_failure" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
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
	CONSTRAINT "monitoring_failure_project_call_unique" UNIQUE("project_id","provider_call_id"),
	CONSTRAINT "monitoring_failure_id_prefix" CHECK ("monitoring_failure"."id" ~ '^mnf_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "monitoring_failure_status_allowed" CHECK ("monitoring_failure"."status" in ('open', 'resolved')),
	CONSTRAINT "monitoring_failure_resolved_agrees" CHECK (("monitoring_failure"."status" = 'resolved') = ("monitoring_failure"."resolved_at" is not null)),
	CONSTRAINT "monitoring_failure_replay_lease_agrees" CHECK (("monitoring_failure"."replay_lease_owner" is null) = ("monitoring_failure"."replay_lease_expires_at" is null))
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
	"last_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_state_agent_unique" UNIQUE("agent_id"),
	CONSTRAINT "monitoring_state_id_tenant_unique" UNIQUE("id","project_id","organization_id"),
	CONSTRAINT "monitoring_state_id_prefix" CHECK ("monitoring_state"."id" ~ '^mst_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "monitoring_state_scan_kind_allowed" CHECK ("monitoring_state"."scan_kind" in ('historical_import', 'regular', 'reconciliation')),
	CONSTRAINT "monitoring_state_scan_agrees" CHECK (("monitoring_state"."scan_kind" is null and "monitoring_state"."scan_from" is null and "monitoring_state"."scan_through" is null and "monitoring_state"."pagination_key" is null) or ("monitoring_state"."scan_kind" is not null and "monitoring_state"."scan_from" is not null and "monitoring_state"."scan_through" is not null)),
	CONSTRAINT "monitoring_state_reconciliation_agrees" CHECK (("monitoring_state"."reconciliation_from" is null and "monitoring_state"."reconciliation_through" is null and "monitoring_state"."reconciliation_pagination_key" is null and "monitoring_state"."reconciliation_needs_regular" = false) or ("monitoring_state"."reconciliation_from" is not null and "monitoring_state"."reconciliation_through" is not null)),
	CONSTRAINT "monitoring_state_lease_agrees" CHECK (("monitoring_state"."lease_owner" is null) = ("monitoring_state"."lease_expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "monitoring_setup" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retell_ingestion_failure" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "monitoring_setup" CASCADE;--> statement-breakpoint
DROP TABLE "retell_ingestion_failure" CASCADE;--> statement-breakpoint
DROP TABLE "retell_monitored_agent" CASCADE;--> statement-breakpoint
ALTER TABLE "connection" DROP CONSTRAINT "connection_agent_platform_allowed";--> statement-breakpoint
ALTER TABLE "connection" DROP CONSTRAINT "connection_kind_allowed";--> statement-breakpoint
ALTER TABLE "connection" RENAME COLUMN "connection_kind" TO "connection_type";--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "agent_platform" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "platform_agent_id" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "monitoring_api_key" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "monitoring_api_key_hint" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "pull_production_calls" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "monitoring_failure" ADD CONSTRAINT "monitoring_failure_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_failure" ADD CONSTRAINT "monitoring_failure_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_failure" ADD CONSTRAINT "monitoring_failure_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitoring_failure_open_idx" ON "monitoring_failure" USING btree ("agent_id","last_attempt_at") WHERE "monitoring_failure"."status" = 'open';--> statement-breakpoint
CREATE INDEX "monitoring_state_due_idx" ON "monitoring_state" USING btree ("next_poll_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "monitoring_state_project_idx" ON "monitoring_state" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_pulled_platform_agent_unique" ON "agent" USING btree ("project_id","agent_platform","platform_agent_id") WHERE "agent"."pull_production_calls";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "agent_platform";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_platform_allowed" CHECK ("agent"."agent_platform" in ('retell', 'livekit_agents'));--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_monitoring_key_hint_agrees" CHECK (("agent"."monitoring_api_key" is null) = ("agent"."monitoring_api_key_hint" is null));--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_monitoring_key_needs_platform" CHECK ("agent"."monitoring_api_key" is null or "agent"."agent_platform" is not null);--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_pull_needs_binding" CHECK ("agent"."pull_production_calls" = false or ("agent"."agent_platform" is not null and "agent"."platform_agent_id" is not null and "agent"."monitoring_api_key" is not null));--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_type_allowed" CHECK ("connection"."connection_type" in ('retell_chat_api', 'phone_number', 'livekit_room'));