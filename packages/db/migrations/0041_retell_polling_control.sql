-- Prelaunch cleanup exception: the founder confirmed that no older API or
-- rollback contract is supported for this cutover. The prior build cannot run
-- after this migration, and that is deliberate — the columns and tables removed
-- here are read by code this release deletes.
--
-- Retell keeps a bookmark, not a payload archive. What goes:
--
--   * "production_trace_claim", the row that held a complete provider document
--     for every successful call. Provider-call deduplication now belongs to the
--     trace store's immutable span identity, so Postgres stops growing by one
--     large row for every production conversation.
--   * "retell_ingestion_failure", the permanent per-call failure row and its
--     customer-facing replay. A call that cannot be fetched now costs one
--     short-lived retry row and, at the end of its bounded budget, one
--     identity-only marker that expires by itself.
--   * The seven reconciliation columns and the two checks over them. There is
--     no daily 30-day rescan and no scan kind for one, so the two remaining
--     kinds are the whole state machine, and one next-poll time covers a
--     resumed scan, the next regular poll and provider backoff together.
--
-- What arrives: "retell_call_retry" for the two transient shapes above,
-- "import_generation" so that selecting an agent again is a new observation
-- rather than a repeat of an old one, and "regular_floor_at" so that the first
-- regular window after this cutover cannot reach behind it.

ALTER TABLE "production_trace_claim" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retell_ingestion_failure" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "production_trace_claim" CASCADE;--> statement-breakpoint
DROP TABLE "retell_ingestion_failure" CASCADE;--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" DROP CONSTRAINT "retell_monitored_agent_reconciliation_agrees";--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" DROP CONSTRAINT "retell_monitored_agent_scan_kind_allowed";--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" DROP COLUMN "reconciliation_from";--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" DROP COLUMN "reconciliation_through";--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" DROP COLUMN "reconciliation_pagination_key";--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" DROP COLUMN "reconciliation_pagination_trail";--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" DROP COLUMN "reconciliation_needs_regular";--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" DROP COLUMN "next_regular_poll_at";--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" DROP COLUMN "next_reconciliation_at";--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" ADD CONSTRAINT "retell_monitored_agent_scan_kind_allowed" CHECK ("retell_monitored_agent"."scan_kind" in ('historical_import', 'regular'));--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" ADD COLUMN "regular_floor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retell_monitored_agent" ADD COLUMN "import_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

CREATE TABLE "retell_call_retry" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"retell_monitored_agent_id" text COLLATE "C" NOT NULL,
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
ALTER TABLE "retell_call_retry" ADD CONSTRAINT "retell_call_retry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retell_call_retry" ADD CONSTRAINT "retell_call_retry_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retell_call_retry" ADD CONSTRAINT "retell_call_retry_agent_tenant_fk" FOREIGN KEY ("retell_monitored_agent_id","project_id","organization_id") REFERENCES "public"."retell_monitored_agent"("id","project_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Every already-selected agent starts again at this instant.
--
-- The scan, cursor, trail and lease go, because they describe a window this
-- build no longer runs. `completed_through` and `next_poll_at` become the
-- cutover instant, so the first poll after the deploy is a regular one that
-- reaches no further back than the release itself — and `regular_floor_at`
-- holds that bound against the ordinary five-minute overlap, which would
-- otherwise subtract its way into evidence this release deleted. The floor is
-- cleared by the first window that completes above it, and later polls regain
-- the overlap.
--
-- No new 30-day import is started. Selecting the agent again is the explicit
-- way to ask for one, and it must stay a customer's decision.
UPDATE "retell_monitored_agent" SET
	"scan_kind" = null,
	"scan_from" = null,
	"scan_through" = null,
	"pagination_key" = null,
	"pagination_trail" = '[]',
	"lease_owner" = null,
	"lease_expires_at" = null,
	"completed_through" = now(),
	"next_poll_at" = now(),
	"regular_floor_at" = now(),
	"updated_at" = now();--> statement-breakpoint

CREATE INDEX "retell_call_retry_due_idx" ON "retell_call_retry" USING btree ("retell_monitored_agent_id","next_attempt_at") WHERE "retell_call_retry"."next_attempt_at" is not null;
