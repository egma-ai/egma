-- THE CLOUD BILLING TABLES: the plans, the accounts, the ledger and the Stripe
-- events Egma has already applied.
--
-- Purely additive: four new tables and nothing else. No existing table gains a
-- column, so the code running before this migration sees exactly the schema it
-- saw before, and a rollback leaves four empty tables that nothing reads.
--
-- Every one of them is `cloud_`-prefixed and lives here, in the shared tree,
-- so one schema serves every deployment. They reference `organization` and
-- `usage_record`; nothing shared references them, and no shared code reads
-- them — every read and write lives in the commercially licensed `ee/`
-- package. A self-hoster therefore carries these four tables empty, and
-- dropping them can break nothing. See ADR-0024.
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

CREATE TABLE "cloud_billing_account" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"plan_code" text NOT NULL,
	"period_anchor" timestamp with time zone NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_subscription_status" text,
	"balance_micros" bigint DEFAULT 0 NOT NULL,
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
	"stripe_fee_price_id" text,
	"stripe_web_call_meter_price_id" text,
	"stripe_phone_meter_price_id" text,
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