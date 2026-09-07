-- MEASURING WHAT EGMA'S WORK COSTS: the rate card, and the usage record.
--
-- Additive: two new tables, referenced by nothing that already exists. Code
-- that does not know them never sees them.
--
-- `rate_card` is append-only in practice rather than by trigger: the boot
-- upsert inserts and never updates, and a price change is a new row with a
-- later `effective_from`. The unique key on (provider, model, usage_type,
-- effective_from) is what makes that upsert idempotent across every instance
-- booting at once.
--
-- `usage_record` keeps its deterministic identity in `dedupe_key`, unique,
-- rather than in the primary key: Egma's identifiers are prefixed and
-- time-sortable and a hash is neither. Its tenancy edges are closed the way
-- every other table's are — the project is of the organization, the simulation
-- and the run are of the project — and each of the last two is nullable,
-- because a composite key with a null column matches nothing, which is exactly
-- what a grading job on a production trace needs. There is no foreign key to
-- `grading_job`, on purpose: that row is deleted once its grades are durable,
-- and a key would either take the spend with it or refuse the delete.

CREATE TABLE "rate_card" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"usage_type" text NOT NULL,
	"unit" text NOT NULL,
	"usd_per_million" numeric(24, 12) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"read_at" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_card_price_identity_unique" UNIQUE("provider","model","usage_type","effective_from"),
	CONSTRAINT "rate_card_id_prefix" CHECK ("rate_card"."id" ~ '^rat_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "rate_card_usage_type_allowed" CHECK ("rate_card"."usage_type" in ('input_tokens', 'cached_input_tokens', 'output_tokens', 'audio_input_tokens', 'text_input_tokens', 'audio_seconds', 'characters')),
	CONSTRAINT "rate_card_unit_allowed" CHECK ("rate_card"."unit" in ('tokens', 'seconds', 'characters')),
	CONSTRAINT "rate_card_price_is_not_negative" CHECK ("rate_card"."usd_per_million" >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_record" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"run_id" text COLLATE "C",
	"work_kind" text NOT NULL,
	"simulation_id" text COLLATE "C",
	"grading_job_id" text COLLATE "C",
	"attempt" bigint DEFAULT 0 NOT NULL,
	"trace_id" text,
	"span_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"operation" text NOT NULL,
	"unit" text NOT NULL,
	"quantities" jsonb NOT NULL,
	"measurement" text NOT NULL,
	"provider_ref" text,
	"payment_source" text NOT NULL,
	"credential_ref" text,
	"raw_usage" jsonb NOT NULL,
	"amount_micros" bigint NOT NULL,
	"priced_by" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_record_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "usage_record_id_prefix" CHECK ("usage_record"."id" ~ '^usg_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "usage_record_work_kind_allowed" CHECK ("usage_record"."work_kind" in ('simulation', 'grading')),
	CONSTRAINT "usage_record_provider_allowed" CHECK ("usage_record"."provider" in ('openai', 'deepgram', 'cartesia')),
	CONSTRAINT "usage_record_operation_allowed" CHECK ("usage_record"."operation" in ('openai_chat_completions', 'openai_realtime', 'deepgram', 'cartesia_manual', 'cartesia', 'openai')),
	CONSTRAINT "usage_record_unit_allowed" CHECK ("usage_record"."unit" in ('tokens', 'seconds', 'characters')),
	CONSTRAINT "usage_record_measurement_allowed" CHECK ("usage_record"."measurement" in ('provider_reported', 'client_measured')),
	CONSTRAINT "usage_record_payment_source_allowed" CHECK ("usage_record"."payment_source" in ('platform', 'customer')),
	CONSTRAINT "usage_record_work_kind_names_its_control_record" CHECK (case "usage_record"."work_kind"
        when 'simulation' then "usage_record"."simulation_id" is not null and "usage_record"."grading_job_id" is null
        when 'grading' then "usage_record"."grading_job_id" is not null
        else false
      end),
	CONSTRAINT "usage_record_attempt_is_counted" CHECK ("usage_record"."attempt" >= 0),
	CONSTRAINT "usage_record_amount_is_not_negative" CHECK ("usage_record"."amount_micros" >= 0),
	CONSTRAINT "usage_record_quantities_are_an_object" CHECK (jsonb_typeof("usage_record"."quantities") = 'object'
        and "usage_record"."quantities" <> '{}'::jsonb),
	CONSTRAINT "usage_record_raw_usage_is_an_object" CHECK (jsonb_typeof("usage_record"."raw_usage") = 'object'),
	CONSTRAINT "usage_record_priced_by_is_an_object" CHECK (jsonb_typeof("usage_record"."priced_by") = 'object'),
	CONSTRAINT "usage_record_dedupe_key_is_not_blank" CHECK (btrim("usage_record"."dedupe_key") <> '')
);
--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_simulation_project_fk" FOREIGN KEY ("simulation_id","project_id") REFERENCES "public"."simulation"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_run_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."run"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_card_effective_idx" ON "rate_card" USING btree ("provider","model","effective_from");--> statement-breakpoint
CREATE INDEX "usage_record_organization_id_project_id_idx" ON "usage_record" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "usage_record_simulation_id_idx" ON "usage_record" USING btree ("simulation_id");