-- Prelaunch cleanup exception: the founder confirmed that no older API or
-- rollback contract is supported for this cutover. The prior build cannot run
-- after this migration, and that is deliberate — the tables and columns removed
-- here are read by code this release deletes.
--
-- Monitoring configuration collapses into the agent. What goes:
--
--   * "monitoring_setup", the per-(project, platform) integration object and
--     its account-wide health machine. There is no second front door beside the
--     agent roster, and no key-wide gate: a rate-limited key is discovered
--     independently by each agent's poller and bounded by per-agent backoff.
--   * "retell_monitored_agent", the selected-agent row. Its machine columns
--     move to "monitoring_state", keyed by the agent and platform-neutral, so a
--     second platform's pull reuses the table unchanged.
--   * "retell_call_retry", recreated as "monitoring_failure" keyed by the agent
--     and named neutrally so a future push-side failure record has a home. The
--     bounded budget, the terminal marker and the one-schedule check are
--     carried over exactly.
--   * "connection"."agent_platform". Which platform a connection reaches is
--     answered by the connection type where the type pins one, and by the
--     agent's own binding where it does not.
--
-- What arrives on "agent": the platform binding, the sealed monitoring-only key
-- and its hint, and "pull_production_calls" — the one monitoring choice in the
-- product. Its checks make the switch unable to be true over a binding that
-- cannot be used, and the partial unique index makes two agents polling one
-- platform agent unrepresentable rather than merely discouraged.
--
-- Three housekeeping cuts ride the same pass: "agent"."description" goes,
-- "connection_kind" becomes "connection_type" — the glossary's word — and the
-- "revision" columns go from both tables, which makes two browsers editing one
-- row last-writer-wins. Pre-launch, chosen.

CREATE TABLE "monitoring_failure" (
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
	CONSTRAINT "monitoring_failure_project_call_unique" UNIQUE("project_id","provider_call_id"),
	CONSTRAINT "monitoring_failure_id_prefix" CHECK ("monitoring_failure"."id" ~ '^mnf_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "monitoring_failure_one_schedule" CHECK (("monitoring_failure"."next_attempt_at" is null) <> ("monitoring_failure"."expires_at" is null)),
	CONSTRAINT "monitoring_failure_attempts_bounded" CHECK ("monitoring_failure"."attempts" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "monitoring_state" (
	"agent_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"scan_kind" text,
	"scan_from" timestamp with time zone,
	"scan_through" timestamp with time zone,
	"pagination_key" text,
	"pagination_trail" text DEFAULT '[]' NOT NULL,
	"completed_through" timestamp with time zone,
	"next_poll_at" timestamp with time zone NOT NULL,
	"import_generation" integer DEFAULT 1 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_state_agent_id_project_id_unique" UNIQUE("agent_id","project_id"),
	CONSTRAINT "monitoring_state_agent_id_prefix" CHECK ("monitoring_state"."agent_id" ~ '^agt_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "monitoring_state_scan_kind_allowed" CHECK ("monitoring_state"."scan_kind" in ('historical_import', 'regular')),
	CONSTRAINT "monitoring_state_scan_agrees" CHECK (("monitoring_state"."scan_kind" is null and "monitoring_state"."scan_from" is null and "monitoring_state"."scan_through" is null and "monitoring_state"."pagination_key" is null) or ("monitoring_state"."scan_kind" is not null and "monitoring_state"."scan_from" is not null and "monitoring_state"."scan_through" is not null)),
	CONSTRAINT "monitoring_state_lease_agrees" CHECK (("monitoring_state"."lease_owner" is null) = ("monitoring_state"."lease_expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "monitoring_setup" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retell_call_retry" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "monitoring_setup" CASCADE;--> statement-breakpoint
DROP TABLE "retell_call_retry" CASCADE;--> statement-breakpoint
DROP TABLE "retell_monitored_agent" CASCADE;--> statement-breakpoint
ALTER TABLE "connection" DROP CONSTRAINT "connection_agent_platform_allowed";--> statement-breakpoint
ALTER TABLE "connection" DROP CONSTRAINT "connection_kind_allowed";--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "agent_platform" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "platform_agent_id" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "monitoring_api_key" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "monitoring_api_key_hint" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "pull_production_calls" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "connection_type" text;--> statement-breakpoint
UPDATE "connection" SET "connection_type" = "connection_kind";--> statement-breakpoint
ALTER TABLE "connection" ALTER COLUMN "connection_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "monitoring_failure" ADD CONSTRAINT "monitoring_failure_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_failure" ADD CONSTRAINT "monitoring_failure_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_failure" ADD CONSTRAINT "monitoring_failure_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_state" ADD CONSTRAINT "monitoring_state_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitoring_failure_due_idx" ON "monitoring_failure" USING btree ("agent_id","next_attempt_at") WHERE "monitoring_failure"."next_attempt_at" is not null;--> statement-breakpoint
CREATE INDEX "monitoring_state_due_idx" ON "monitoring_state" USING btree ("next_poll_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "monitoring_state_project_idx" ON "monitoring_state" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_pulled_platform_agent_unique" ON "agent" USING btree ("project_id","agent_platform","platform_agent_id") WHERE "agent"."pull_production_calls";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "agent_platform";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "connection_kind";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_agent_platform_allowed" CHECK ("agent"."agent_platform" in ('retell', 'livekit_agents'));--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_monitoring_key_hint_agrees" CHECK (("agent"."monitoring_api_key" is null) = ("agent"."monitoring_api_key_hint" is null));--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_monitoring_key_needs_platform" CHECK ("agent"."monitoring_api_key" is null or "agent"."agent_platform" is not null);--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_pull_needs_binding" CHECK ("agent"."pull_production_calls" = false or ("agent"."agent_platform" is not null and "agent"."platform_agent_id" is not null and "agent"."monitoring_api_key" is not null));--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_type_allowed" CHECK ("connection"."connection_type" in ('retell_chat_api', 'phone_number', 'livekit_room'));