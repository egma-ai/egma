-- Watching a Retell agent: the per-connection switch, its cursor, and the
-- ledger that makes a production trace land exactly once.
--
--  * `watch_production` is the opt-in, and it defaults to false so that every
--    connection that already exists stays off. A team connected an agent so
--    egma could test it; that must never quietly become egma storing their
--    customers' conversations.
--  * `production_cursor` is the poller's per-connection state — everything at
--    or before it is durably stored. It is null until the first conversation
--    is written, which is what makes a freshly switched-on connection ask for
--    conversations from the moment it was switched on rather than for history.
--  * `webhook_registered_at` and `webhook_delivered_at` are the two facts the
--    transport mix is decided from: whether egma registered its endpoint with
--    the provider, and whether deliveries are actually arriving. Both null is
--    the ordinary state of a deployment behind NAT, and it is not a fault.
--  * `production_trace_claim` is the ledger. Unique on the trace identity, so
--    two transports racing on one conversation are settled by the constraint
--    rather than by timing; the payload rides the row so a sweep can replay a
--    conversation whose append never landed, byte for byte.
--  * `retell_webhook_refusal` counts what was turned away. Four rows at most,
--    ever: the endpoint is reachable by anybody, so a row per delivery would
--    be an unauthenticated write.

ALTER TABLE "connection" ADD COLUMN "watch_production" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "production_cursor" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "webhook_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "webhook_delivered_at" timestamp with time zone;--> statement-breakpoint

CREATE TABLE "production_trace_claim" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"connection_id" text COLLATE "C" NOT NULL,
	"trace_id" text NOT NULL,
	"provider_call_id" text NOT NULL,
	"transport" text NOT NULL,
	"payload" text NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"written_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_trace_claim_trace_id_unique" UNIQUE("trace_id"),
	CONSTRAINT "production_trace_claim_id_prefix" CHECK ("production_trace_claim"."id" ~ '^ptc_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "production_trace_claim_status_allowed" CHECK ("production_trace_claim"."status" in ('claimed', 'written')),
	CONSTRAINT "production_trace_claim_transport_allowed" CHECK ("production_trace_claim"."transport" in ('webhook', 'pull')),
	CONSTRAINT "production_trace_claim_written_agrees" CHECK (("production_trace_claim"."status" = 'written') = ("production_trace_claim"."written_at" is not null))
);--> statement-breakpoint

ALTER TABLE "production_trace_claim" ADD CONSTRAINT "production_trace_claim_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_trace_claim" ADD CONSTRAINT "production_trace_claim_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_trace_claim" ADD CONSTRAINT "production_trace_claim_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "production_trace_claim_unwritten_idx" ON "production_trace_claim" ("claimed_at") WHERE "production_trace_claim"."status" = 'claimed';--> statement-breakpoint

CREATE TABLE "retell_webhook_refusal" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"how_many" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retell_webhook_refusal_reason_unique" UNIQUE("reason"),
	CONSTRAINT "retell_webhook_refusal_id_prefix" CHECK ("retell_webhook_refusal"."id" ~ '^rwr_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "retell_webhook_refusal_reason_allowed" CHECK ("retell_webhook_refusal"."reason" in ('unknown_agent', 'switched_off', 'bad_signature', 'other_kind'))
);
