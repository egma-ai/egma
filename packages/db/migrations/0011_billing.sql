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
CREATE TABLE "cloud_billing_account" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"plan_code" text NOT NULL,
	"period_anchor" timestamp with time zone NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_subscription_status" text,
	"stripe_subscription_refreshed_at" timestamp with time zone,
	"stripe_period_started_at" timestamp with time zone,
	"stripe_period_ends_at" timestamp with time zone,
	"stripe_failed_at" timestamp with time zone,
	"stripe_failure_version" bigint DEFAULT 0 NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"inference_settled_through" timestamp with time zone,
	"settlement_failed_at" timestamp with time zone,
	"balance_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_billing_account_organization_unique" UNIQUE("organization_id"),
	CONSTRAINT "cloud_billing_account_stripe_customer_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "cloud_billing_account_stripe_subscription_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "cloud_billing_account_id_prefix" CHECK ("cloud_billing_account"."id" ~ '^cba_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "cloud_billing_account_plan_code_allowed" CHECK ("cloud_billing_account"."plan_code" in ('hobby', 'pro')),
	CONSTRAINT "cloud_billing_account_stripe_failure_version_is_exact" CHECK ("cloud_billing_account"."stripe_failure_version" >= 0 and "cloud_billing_account"."stripe_failure_version" <= 9007199254740991),
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
	"interval_started_at" timestamp with time zone,
	"interval_ended_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_ledger_entry_organization_interval_unique" UNIQUE("organization_id","interval_started_at","interval_ended_at"),
	CONSTRAINT "cloud_ledger_entry_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "cloud_ledger_entry_id_prefix" CHECK ("cloud_ledger_entry"."id" ~ '^cle_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "cloud_ledger_entry_kind_allowed" CHECK ("cloud_ledger_entry"."kind" in ('welcome_credit', 'purchased_credit', 'inference_charge', 'correction')),
	CONSTRAINT "cloud_ledger_entry_reference_kind_allowed" CHECK ("cloud_ledger_entry"."reference_kind" in ('organization', 'settlement_interval', 'checkout_session', 'operator')),
	CONSTRAINT "cloud_ledger_entry_reference_id_is_not_blank" CHECK (btrim("cloud_ledger_entry"."reference_id") <> ''),
	CONSTRAINT "cloud_ledger_entry_idempotency_key_is_not_blank" CHECK (btrim("cloud_ledger_entry"."idempotency_key") <> ''),
	CONSTRAINT "cloud_ledger_entry_kind_names_its_cause" CHECK (case "cloud_ledger_entry"."kind"
        when 'welcome_credit' then "cloud_ledger_entry"."reference_kind" = 'organization'
        when 'purchased_credit' then "cloud_ledger_entry"."reference_kind" = 'checkout_session'
        when 'inference_charge' then "cloud_ledger_entry"."reference_kind" = 'settlement_interval'
        else true
      end),
	CONSTRAINT "cloud_ledger_entry_interval_matches_kind" CHECK (case when "cloud_ledger_entry"."kind" = 'inference_charge'
        then "cloud_ledger_entry"."interval_started_at" is not null and "cloud_ledger_entry"."interval_ended_at" is not null
          and "cloud_ledger_entry"."interval_started_at" < "cloud_ledger_entry"."interval_ended_at"
        else "cloud_ledger_entry"."interval_started_at" is null and "cloud_ledger_entry"."interval_ended_at" is null end),
	CONSTRAINT "cloud_ledger_entry_sign_follows_its_kind" CHECK (case "cloud_ledger_entry"."kind"
        when 'welcome_credit' then "cloud_ledger_entry"."amount_micros" > 0
        when 'purchased_credit' then "cloud_ledger_entry"."amount_micros" > 0
        when 'inference_charge' then "cloud_ledger_entry"."amount_micros" < 0
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
	"billing_activated_at" timestamp with time zone,
	"stripe_payments_ready" boolean DEFAULT false NOT NULL,
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
CREATE TABLE "cloud_meter_period" (
	"organization_id" text COLLATE "C" NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"period_started_at" timestamp with time zone NOT NULL,
	"period_ends_at" timestamp with time zone NOT NULL,
	"channel" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"meter_id" text NOT NULL,
	"event_name" text NOT NULL,
	"price_id" text NOT NULL,
	"invoice_id" text,
	"observed_through_hour" timestamp with time zone,
	"accepted_seconds" bigint DEFAULT 0 NOT NULL,
	"uncertain_seconds" bigint DEFAULT 0 NOT NULL,
	"last_observed_seconds" bigint DEFAULT 0 NOT NULL,
	"pending_identifier" text,
	"pending_seconds" bigint,
	"pending_value" numeric(30, 12),
	"pending_timestamp" timestamp with time zone,
	"pending_hour" timestamp with time zone,
	"pending_first_sent_at" timestamp with time zone,
	"state" text DEFAULT 'open' NOT NULL,
	"last_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_meter_period_pk" PRIMARY KEY("organization_id","stripe_subscription_id","period_started_at","period_ends_at","channel"),
	CONSTRAINT "cloud_meter_period_channel_allowed" CHECK ("cloud_meter_period"."channel" in ('web_call_minutes', 'phone_minutes')),
	CONSTRAINT "cloud_meter_period_state_allowed" CHECK ("cloud_meter_period"."state" in ('open', 'needs_attention', 'closed')),
	CONSTRAINT "cloud_meter_period_outcome_allowed" CHECK ("cloud_meter_period"."last_outcome" is null or "cloud_meter_period"."last_outcome" in ('accepted', 'duplicate', 'uncertain', 'invoice_closed', 'timestamp_expired')),
	CONSTRAINT "cloud_meter_period_subscription_not_blank" CHECK (btrim("cloud_meter_period"."stripe_subscription_id") <> ''),
	CONSTRAINT "cloud_meter_period_customer_not_blank" CHECK (btrim("cloud_meter_period"."stripe_customer_id") <> ''),
	CONSTRAINT "cloud_meter_period_meter_not_blank" CHECK (btrim("cloud_meter_period"."meter_id") <> ''),
	CONSTRAINT "cloud_meter_period_event_not_blank" CHECK (btrim("cloud_meter_period"."event_name") <> ''),
	CONSTRAINT "cloud_meter_period_price_not_blank" CHECK (btrim("cloud_meter_period"."price_id") <> ''),
	CONSTRAINT "cloud_meter_period_bounds" CHECK ("cloud_meter_period"."period_ends_at" > "cloud_meter_period"."period_started_at"),
	CONSTRAINT "cloud_meter_period_seconds_counted" CHECK (
      "cloud_meter_period"."accepted_seconds" between 0 and 9007199254740991
      and "cloud_meter_period"."uncertain_seconds" between 0 and 9007199254740991
      and "cloud_meter_period"."last_observed_seconds" between 0 and 9007199254740991
    ),
	CONSTRAINT "cloud_meter_period_pending_complete" CHECK (
      num_nonnulls("cloud_meter_period"."pending_identifier", "cloud_meter_period"."pending_seconds", "cloud_meter_period"."pending_value",
        "cloud_meter_period"."pending_timestamp", "cloud_meter_period"."pending_hour", "cloud_meter_period"."pending_first_sent_at") in (0, 6)
    ),
	CONSTRAINT "cloud_meter_period_pending_valid" CHECK ("cloud_meter_period"."pending_identifier" is null or (
      btrim("cloud_meter_period"."pending_identifier") <> ''
      and "cloud_meter_period"."pending_seconds" between 1 and 9007199254740991
      and "cloud_meter_period"."pending_value" > 0
      and "cloud_meter_period"."pending_timestamp" >= "cloud_meter_period"."period_started_at"
      and "cloud_meter_period"."pending_timestamp" < "cloud_meter_period"."period_ends_at"
    ))
);
--> statement-breakpoint
ALTER TABLE "simulation" ADD COLUMN "connection_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_billing_account" ADD CONSTRAINT "cloud_billing_account_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_billing_account" ADD CONSTRAINT "cloud_billing_account_plan_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."cloud_plan"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_ledger_entry" ADD CONSTRAINT "cloud_ledger_entry_account_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."cloud_billing_account"("organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_meter_period" ADD CONSTRAINT "cloud_meter_period_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_card_effective_idx" ON "rate_card" USING btree ("provider","model","effective_from");--> statement-breakpoint
CREATE INDEX "cloud_ledger_entry_organization_idx" ON "cloud_ledger_entry" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "simulation_organization_id_started_at_idx" ON "simulation" USING btree ("organization_id","started_at");--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_connection_type_allowed" CHECK ("simulation"."connection_type" in ('retell_chat_api', 'retell_text_mode', 'retell_web_call', 'phone_number', 'livekit_room'));