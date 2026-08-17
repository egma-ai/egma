-- Customer-owned model access: who pays for an organization's model traffic,
-- the keys that authorize it when the organization pays, and the selections a
-- persona and a grader make independently of both.
--
--  * `model_access` is the organization's one binary choice. A missing row is
--    `customer-owned`, which is the honest reading of "nothing was connected to
--    Egma's provider accounts" — so this migration writes no rows and decides
--    nothing on anybody's behalf.
--  * `model_provider_credential` is the organization's own key for one
--    provider, sealed with the same master key and the same envelope every
--    other credential in this schema uses. Unique on (organization, provider),
--    so "which key does this simulation spend from" is answered by the
--    constraint rather than by a rule somebody would have to write.
--  * `persona_version.models` and `grader_version.grader_model` are nullable
--    and stay nullable. Null is the compatibility path: a version authored
--    before the model catalog existed keeps resolving through the deployment's
--    own settings exactly as it did, and no immutable version is rewritten
--    here. They fill in as personas and graders are edited, and by the later
--    migration that gives each current version an explicit successor.
--  * `simulation.ending_detail` and `simulation.ending_repair` are what a
--    person reads when a claimed simulation was never handed over. The reason
--    word says `dispatch_failed` and nothing else; the sentence says which
--    model job named which provider, and the repair word says which screen
--    fixes it. Both are Egma's own writing — no customer content, no secret —
--    and both are null on every simulation that ran.
--
-- Every part of this is additive. Nothing is dropped, nothing is backfilled,
-- and every read that worked before this file still works after it.

CREATE TABLE "model_access" (
	"organization_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"updated_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_access_organization_id_prefix" CHECK ("model_access"."organization_id" ~ '^org_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "model_access_mode_allowed" CHECK ("model_access"."mode" in ('managed', 'customer-owned'))
);
--> statement-breakpoint
CREATE TABLE "model_provider_credential" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"provider" text NOT NULL,
	"credentials" text NOT NULL,
	"credentials_hint" text NOT NULL,
	"revision" text COLLATE "C" NOT NULL,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_provider_credential_one_per_provider" UNIQUE("organization_id","provider"),
	CONSTRAINT "model_provider_credential_id_prefix" CHECK ("model_provider_credential"."id" ~ '^mpc_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "model_provider_credential_revision_prefix" CHECK ("model_provider_credential"."revision" ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "model_provider_credential_provider_allowed" CHECK ("model_provider_credential"."provider" in ('openai', 'deepgram', 'cartesia'))
);
--> statement-breakpoint
ALTER TABLE "persona_version" ADD COLUMN "models" jsonb;--> statement-breakpoint
ALTER TABLE "grader_version" ADD COLUMN "grader_model" jsonb;--> statement-breakpoint
ALTER TABLE "simulation" ADD COLUMN "ending_detail" text;--> statement-breakpoint
ALTER TABLE "simulation" ADD COLUMN "ending_repair" text;--> statement-breakpoint
ALTER TABLE "model_access" ADD CONSTRAINT "model_access_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_access" ADD CONSTRAINT "model_access_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_credential" ADD CONSTRAINT "model_provider_credential_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_credential" ADD CONSTRAINT "model_provider_credential_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_ending_repair_allowed" CHECK ("simulation"."ending_repair" is null or "simulation"."ending_repair" in ('model_providers'));--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_ending_repair_has_a_reason_to_exist" CHECK ("simulation"."ending_repair" is null or "simulation"."ending_detail" is not null);