-- WHAT EGMA'S WORK COSTS, AND WHO PAYS FOR IT: the rate card, the usage
-- record, the lane a conversation ran over, and the four cloud billing tables.
--
-- Additive throughout — six new tables and one new column — and the column is
-- carried across by an explicit backfill. Code that does not know any of it
-- never sees it.
--
-- **The rate card and the usage record.** `rate_card` is append-only in
-- practice rather than by trigger: the boot upsert inserts and never updates,
-- and a price change is a new row with a later `effective_from`. The unique
-- key on (provider, model, usage_type, effective_from) is what makes that
-- upsert idempotent across every instance booting at once. `usage_record`
-- keeps its deterministic identity in `dedupe_key`, unique, rather than in the
-- primary key: Egma's identifiers are prefixed and time-sortable and a hash is
-- neither. Its tenancy edges are closed the way every other table's are — the
-- project is of the organization, the simulation and the run are of the
-- project — and each of the last two is nullable, because a composite key with
-- a null column matches nothing, which is exactly what a grading job on a
-- production trace needs. There is no foreign key to `grading_job`, on
-- purpose: that row is deleted once its grades are durable, and a key would
-- either take the spend with it or refuse the delete.
--
-- **The lane a simulation ran over**, as it already records its modality.
-- Every simulation row names a connection by a foreign key, so the value it
-- should have had at execution is the one that connection holds now, and there
-- is no row this cannot fill. The column is added nullable, filled, and only
-- then made required — the three-step form, because `ADD COLUMN ... NOT NULL`
-- with no default refuses a table that already has rows.
--
-- Why the row keeps its own copy rather than joining: the three allowances a
-- month is measured in — chat simulations, web-call minutes, phone minutes —
-- are read off this column and the modality beside it. A connection can be
-- edited or archived after the conversation it carried, and a join would then
-- move last month's minutes from one allowance to another. This is a shared
-- column and not a `cloud_` one on purpose: which lane a conversation ran over
-- is a product fact every deployment records.
--
-- The lifecycle guard is stood down for the backfill and put straight back.
-- It refuses every update to a terminal simulation, which is exactly right for
-- the product — a completed conversation is written once — and exactly wrong
-- for a migration filling in a column that did not exist when the row was
-- written. Both statements are inside this file's transaction, so a failure
-- anywhere in it leaves the guard on. The index beside them is the usage
-- read's own shape: one organization's conversations that began inside a
-- period.
--
-- **The four cloud billing tables**: the plans, the accounts, the ledger and
-- the Stripe events Egma has already applied. Every one of them is
-- `cloud_`-prefixed and lives here, in the shared tree, so one schema serves
-- every deployment. They reference `organization` and `usage_record`; nothing
-- shared references them, and no shared code reads them — every read and write
-- lives in the commercially licensed `ee/` package. A self-hoster therefore
-- carries these four tables empty, and dropping them can break nothing. See
-- ADR-0024.
--
-- The two rows in `cloud_plan` are written on boot from a file in `ee/`, the
-- way the rate card is written from its own, so a price change is a row change
-- and not a deploy.
--
-- One key here refuses a delete rather than following one: the ledger's edge
-- into `usage_record`. A charge is money that moved and is summed into the
-- account's materialised balance, so a cascade would leave that balance
-- disagreeing with the ledger it caches. Nothing in the product deletes a
-- usage record today; the day something does, this key makes somebody decide
-- what happens to the charge.
--
-- **The Stripe objects a plan is sold through**: the product, the three
-- prices, and the two meters the overage prices read. A meter is the one
-- Stripe object that cannot be recreated from nothing, because Stripe's
-- test-data deletion does not remove one — so the meter id is kept here as the
-- proof that this deployment already has it, found by event name and created
-- once. All six stay nullable: Hobby has no Stripe object of any kind, a
-- deployment whose sandbox has not been set up has none either, and the
-- allowances are enforced from Egma's own rows and never from Stripe.
--
-- **Where the hourly overage job resumes from.**
-- `cloud_billing_account.overage_reported_through` is that mark. The job posts
-- whole minutes as the difference between two running totals, so an hour that
-- was never posted would have its minutes swallowed by the next hour's
-- "before" — the arithmetic that loses nothing inside a period loses
-- everything about a gap. The mark moves only after Stripe has taken an hour,
-- or refused it as one it already has; a replay is safe either way, because a
-- meter event's identifier is the meter, the organization and the hour.
--
-- **Which subscription event an account is already at.**
-- `cloud_billing_account.stripe_subscription_event_at` is that mark. Stripe
-- does not promise the order it delivers webhooks in, and the plan, the status
-- and the anchor are written from whichever subscription event turns up — so
-- an older `customer.subscription.updated` arriving after a newer
-- `customer.subscription.deleted` put a customer who had cancelled back on Pro
-- and left them there until Stripe sent something else. This column holds the
-- `created` instant of the last subscription event applied, and an event
-- stamped no later than it is recorded as seen and changes nothing.
--
-- Both marks start null, which is the right start for each: a Pro account's
-- overage mark is set the first time the job reports it, at the hour that had
-- just closed, so switching billing on never back-bills a month that was free,
-- and a Hobby account that never buys a plan keeps a null subscription mark
-- for ever.

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
CREATE INDEX "usage_record_simulation_id_idx" ON "usage_record" USING btree ("simulation_id");--> statement-breakpoint
ALTER TABLE "simulation" ADD COLUMN "connection_type" text;--> statement-breakpoint
ALTER TABLE "simulation" DISABLE TRIGGER "simulation_lifecycle_guard";--> statement-breakpoint
UPDATE "simulation"
  SET "connection_type" = "connection"."connection_type"
  FROM "connection"
  WHERE "connection"."id" = "simulation"."connection_id";--> statement-breakpoint
ALTER TABLE "simulation" ENABLE TRIGGER "simulation_lifecycle_guard";--> statement-breakpoint
ALTER TABLE "simulation" ALTER COLUMN "connection_type" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "simulation_organization_id_started_at_idx" ON "simulation" USING btree ("organization_id","started_at");--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_connection_type_allowed" CHECK ("simulation"."connection_type" in ('retell_chat_api', 'retell_text_mode', 'retell_web_call', 'phone_number', 'livekit_room'));--> statement-breakpoint
CREATE TABLE "cloud_billing_account" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"plan_code" text NOT NULL,
	"period_anchor" timestamp with time zone NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_subscription_status" text,
	"stripe_subscription_event_at" timestamp with time zone,
	"balance_micros" bigint DEFAULT 0 NOT NULL,
	"overage_reported_through" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_billing_account_organization_unique" UNIQUE("organization_id"),
	CONSTRAINT "cloud_billing_account_stripe_customer_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "cloud_billing_account_stripe_subscription_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "cloud_billing_account_id_prefix" CHECK ("cloud_billing_account"."id" ~ '^cba_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "cloud_billing_account_plan_code_allowed" CHECK ("cloud_billing_account"."plan_code" in ('hobby', 'pro')),
	CONSTRAINT "cloud_billing_account_subscription_status_allowed" CHECK ("cloud_billing_account"."stripe_subscription_status" is null
        or "cloud_billing_account"."stripe_subscription_status" in ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused')),
	CONSTRAINT "cloud_billing_account_subscription_needs_a_customer" CHECK ("cloud_billing_account"."stripe_subscription_id" is null
        or "cloud_billing_account"."stripe_customer_id" is not null),
	CONSTRAINT "cloud_billing_account_subscription_status_needs_a_subscription" CHECK ("cloud_billing_account"."stripe_subscription_status" is null
        or "cloud_billing_account"."stripe_subscription_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "cloud_ledger_entry" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"kind" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"reference_kind" text NOT NULL,
	"reference_id" text NOT NULL,
	"usage_record_id" text COLLATE "C",
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_ledger_entry_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "cloud_ledger_entry_id_prefix" CHECK ("cloud_ledger_entry"."id" ~ '^cle_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "cloud_ledger_entry_kind_allowed" CHECK ("cloud_ledger_entry"."kind" in ('welcome_credit', 'purchased_credit', 'inference_charge', 'correction')),
	CONSTRAINT "cloud_ledger_entry_reference_kind_allowed" CHECK ("cloud_ledger_entry"."reference_kind" in ('organization', 'usage_record', 'checkout_session', 'operator')),
	CONSTRAINT "cloud_ledger_entry_reference_id_is_not_blank" CHECK (btrim("cloud_ledger_entry"."reference_id") <> ''),
	CONSTRAINT "cloud_ledger_entry_idempotency_key_is_not_blank" CHECK (btrim("cloud_ledger_entry"."idempotency_key") <> ''),
	CONSTRAINT "cloud_ledger_entry_kind_names_its_cause" CHECK (case "cloud_ledger_entry"."kind"
        when 'welcome_credit' then "cloud_ledger_entry"."reference_kind" = 'organization'
        when 'purchased_credit' then "cloud_ledger_entry"."reference_kind" = 'checkout_session'
        when 'inference_charge' then "cloud_ledger_entry"."reference_kind" = 'usage_record'
        else true
      end),
	CONSTRAINT "cloud_ledger_entry_charge_names_its_usage_record" CHECK (case when "cloud_ledger_entry"."reference_kind" = 'usage_record'
        then "cloud_ledger_entry"."usage_record_id" = "cloud_ledger_entry"."reference_id"
        else "cloud_ledger_entry"."usage_record_id" is null
      end),
	CONSTRAINT "cloud_ledger_entry_sign_follows_its_kind" CHECK (case "cloud_ledger_entry"."kind"
        when 'welcome_credit' then "cloud_ledger_entry"."amount_micros" > 0
        when 'purchased_credit' then "cloud_ledger_entry"."amount_micros" > 0
        when 'inference_charge' then "cloud_ledger_entry"."amount_micros" <= 0
        else "cloud_ledger_entry"."amount_micros" <> 0
      end)
);
--> statement-breakpoint
CREATE TABLE "cloud_plan" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"fee_micros" bigint NOT NULL,
	"chat_simulations_allowance" bigint,
	"web_call_minutes_allowance" bigint,
	"phone_minutes_allowance" bigint,
	"web_call_overage_micros_per_minute" bigint NOT NULL,
	"phone_overage_micros_per_minute" bigint NOT NULL,
	"stripe_product_id" text,
	"stripe_fee_price_id" text,
	"stripe_web_call_meter_price_id" text,
	"stripe_phone_meter_price_id" text,
	"stripe_web_call_meter_id" text,
	"stripe_phone_meter_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_plan_code_unique" UNIQUE("code"),
	CONSTRAINT "cloud_plan_id_prefix" CHECK ("cloud_plan"."id" ~ '^cpl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "cloud_plan_code_allowed" CHECK ("cloud_plan"."code" in ('hobby', 'pro')),
	CONSTRAINT "cloud_plan_name_is_not_blank" CHECK (btrim("cloud_plan"."name") <> ''),
	CONSTRAINT "cloud_plan_fee_is_not_negative" CHECK ("cloud_plan"."fee_micros" >= 0),
	CONSTRAINT "cloud_plan_allowances_are_not_negative" CHECK (coalesce("cloud_plan"."chat_simulations_allowance", 0) >= 0
        and coalesce("cloud_plan"."web_call_minutes_allowance", 0) >= 0
        and coalesce("cloud_plan"."phone_minutes_allowance", 0) >= 0),
	CONSTRAINT "cloud_plan_overage_prices_are_not_negative" CHECK ("cloud_plan"."web_call_overage_micros_per_minute" >= 0
        and "cloud_plan"."phone_overage_micros_per_minute" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cloud_stripe_event" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_stripe_event_id_is_not_blank" CHECK (btrim("cloud_stripe_event"."id") <> ''),
	CONSTRAINT "cloud_stripe_event_type_is_not_blank" CHECK (btrim("cloud_stripe_event"."type") <> '')
);
--> statement-breakpoint
ALTER TABLE "cloud_billing_account" ADD CONSTRAINT "cloud_billing_account_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_billing_account" ADD CONSTRAINT "cloud_billing_account_plan_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."cloud_plan"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_ledger_entry" ADD CONSTRAINT "cloud_ledger_entry_usage_record_id_usage_record_id_fk" FOREIGN KEY ("usage_record_id") REFERENCES "public"."usage_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_ledger_entry" ADD CONSTRAINT "cloud_ledger_entry_account_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."cloud_billing_account"("organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_ledger_entry_organization_idx" ON "cloud_ledger_entry" USING btree ("organization_id","id");