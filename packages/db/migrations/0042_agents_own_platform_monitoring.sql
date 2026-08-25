-- Prelaunch cleanup. The founder has confirmed that no older API build and no
-- rollback contract is supported past this file, so the removals below are
-- taken in one step and the prior build cannot run after it.
--
-- Agents own platform monitoring (ADR-0015). The agent gains its platform
-- binding and a sealed monitoring-only key, plus the declared pull switch, and
-- one partial unique index stops two switched-on agents naming one platform
-- agent. `monitoring_setup` and `retell_monitored_agent` are dropped whole with
-- no data carried across, and one machine-owned `monitoring_state` notebook per
-- agent takes their place. It keeps the polling control this store learned in
-- 0041 — two scan kinds, one `next_poll_at`, `regular_floor_at`,
-- `import_generation` — now per agent rather than per selected-agent row, and
-- it carries the provider cool-down that used to sit on the setup, so five
-- agents sharing one refused key each back off on their own.
--
-- `retell_call_retry` is re-keyed from the dropped selected-agent row to the
-- agent. Its rows are transient control state naming agents that stop existing
-- in this file — a retry budget of minutes, and a marker that expires in
-- fifteen — so they are emptied rather than carried, and the poller rebuilds
-- whatever it still needs on its next turn. That statement comes first because
-- the new key is NOT NULL and the new foreign key has to hold. One other
-- statement is hand-placed out of drizzle-kit's order too, and says why where
-- it stands.
--
-- Riding the same pass: `agent.description` is dropped, `connection_kind`
-- becomes `connection_type` (renamed in place, so rows survive), and
-- `revision` leaves `agent` and `connection` — concurrent edits become
-- last-writer-wins, accepted pre-launch. Grader library revisions are a
-- different system and are untouched.
--
-- Every agent must name its platform after this cutover. An old agent inherits
-- it only when its connections agree on one non-null platform. A bare agent or
-- an agent whose connections name different platforms stops this migration.
-- Migration 0038 stored LiveKit as `livekit_agents`; normalize that shipped
-- value before deciding whether the connections agree and before copying it.
-- This incompatibility is accepted prelaunch; there is no older API or data
-- contract to preserve.

TRUNCATE TABLE "retell_call_retry";--> statement-breakpoint
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
-- Hoisted above the drops by hand. drizzle-kit emits this with the constraint
-- drops below, where "DROP TABLE retell_monitored_agent CASCADE" has already
-- taken it and the statement fails outright. Regenerating this file loses the
-- fix, and the snapshot diff cannot see it.
ALTER TABLE "retell_call_retry" DROP CONSTRAINT "retell_call_retry_agent_tenant_fk";--> statement-breakpoint
ALTER TABLE "monitoring_setup" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "monitoring_setup" CASCADE;--> statement-breakpoint
DROP TABLE "retell_monitored_agent" CASCADE;--> statement-breakpoint
ALTER TABLE "connection" RENAME COLUMN "connection_kind" TO "connection_type";--> statement-breakpoint
ALTER TABLE "connection" DROP CONSTRAINT "connection_agent_platform_allowed";--> statement-breakpoint
ALTER TABLE "connection" DROP CONSTRAINT "connection_kind_allowed";--> statement-breakpoint
DROP INDEX "retell_call_retry_due_idx";--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "agent_platform" text;--> statement-breakpoint
UPDATE "agent"
SET "agent_platform" = "one_platform"."agent_platform"
FROM (
	SELECT
		"agent_id",
		min(CASE
			WHEN "agent_platform" = 'livekit_agents' THEN 'livekit'
			ELSE "agent_platform"
		END) AS "agent_platform"
	FROM "connection"
	WHERE "agent_platform" IS NOT NULL
	GROUP BY "agent_id"
	HAVING count(DISTINCT CASE
		WHEN "agent_platform" = 'livekit_agents' THEN 'livekit'
		ELSE "agent_platform"
	END) = 1
) AS "one_platform"
WHERE "agent"."id" = "one_platform"."agent_id";--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "agent_platform" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "platform_agent_id" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "monitoring_api_key" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "monitoring_api_key_hint" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "pull_production_calls" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "retell_call_retry" ADD COLUMN "agent_id" text COLLATE "C" NOT NULL;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitoring_state_due_idx" ON "monitoring_state" USING btree ("next_poll_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "monitoring_state_project_idx" ON "monitoring_state" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "retell_call_retry" ADD CONSTRAINT "retell_call_retry_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_pulled_platform_agent_unique" ON "agent" USING btree ("project_id","agent_platform","platform_agent_id") WHERE "agent"."pull_production_calls";--> statement-breakpoint
CREATE INDEX "retell_call_retry_due_idx" ON "retell_call_retry" USING btree ("agent_id","next_attempt_at") WHERE "retell_call_retry"."next_attempt_at" is not null;--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "agent_platform";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "retell_call_retry" DROP COLUMN "retell_monitored_agent_id";--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_platform_allowed" CHECK ("agent"."agent_platform" in ('retell', 'livekit'));--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_monitoring_key_hint_agrees" CHECK (("agent"."monitoring_api_key" is null) = ("agent"."monitoring_api_key_hint" is null));--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_monitoring_key_needs_platform" CHECK ("agent"."monitoring_api_key" is null or "agent"."agent_platform" is not null);--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_pull_needs_binding" CHECK ("agent"."pull_production_calls" = false or ("agent"."agent_platform" is not null and "agent"."platform_agent_id" is not null and "agent"."monitoring_api_key" is not null));--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_type_allowed" CHECK ("connection"."connection_type" in ('retell_chat_api', 'phone_number', 'livekit_room'));
