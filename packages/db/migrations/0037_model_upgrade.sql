-- The upgrade onto model selections: what it found, what it would not decide,
-- and the stamp that says it has finished.
--
--  * `model_credential_candidate` is one legacy provider key, copied here
--    sealed exactly as it was stored. Copied and not moved, because the row it
--    came from keeps working through the compatibility period. One row per
--    source and never per secret: two sources holding one key are two
--    candidates, because calling them the same key would mean comparing
--    plaintext, ciphertext or hints, and none of the three may be used to infer
--    that two keys are equal. A sole candidate for a provider may become that
--    organization's active credential; two mean an administrator chooses.
--  * `model_upgrade_action` is a decision the upgrade refused to make on
--    somebody's behalf — a provider with two candidates, a persona whose voice
--    provider disagrees with the deployment's, a grader with no effective
--    legacy model, an organization on a deployment that copies nothing into it.
--    One row per subject, so the list does not grow every time a container
--    restarts. Its sentence is Egma's own writing and carries no secret.
--  * `model_upgrade_completion` is one row belonging to the whole deployment,
--    on `platform_instance`'s terms. It is written the first time every current
--    persona and grader carries explicit selections and no queued, claimed or
--    grading work still depends on the old contract or an old credential
--    reference — and it is what the later removal reads before it takes the
--    legacy paths out.
--
-- Additive. Nothing is dropped, nothing is backfilled here, and every read that
-- worked before this file still works after it. The collection itself is a boot
-- act rather than a statement in this file, because it has to copy sealed
-- envelopes, mint persona and grader versions, and write sentences a person
-- reads — none of which belongs in SQL that cannot be tested a case at a time.

CREATE TABLE "model_credential_candidate" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"source_name" text NOT NULL,
	"credentials" text NOT NULL,
	"credentials_hint" text NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_credential_candidate_one_per_source" UNIQUE("organization_id","provider","source","source_name"),
	CONSTRAINT "model_credential_candidate_id_prefix" CHECK ("model_credential_candidate"."id" ~ '^mcc_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "model_credential_candidate_source_allowed" CHECK ("model_credential_candidate"."source" in ('platform_setting', 'judge_credential', 'judge_configuration'))
);
--> statement-breakpoint
CREATE TABLE "model_upgrade_action" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"detail" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_upgrade_action_one_per_subject" UNIQUE("organization_id","kind","subject"),
	CONSTRAINT "model_upgrade_action_id_prefix" CHECK ("model_upgrade_action"."id" ~ '^mua_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "model_upgrade_action_kind_allowed" CHECK ("model_upgrade_action"."kind" in ('select_model_provider_credential', 'select_persona_models', 'select_grader_model', 'set_up_model_access'))
);
--> statement-breakpoint
CREATE TABLE "model_upgrade_completion" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_upgrade_completion_is_one_row" CHECK ("model_upgrade_completion"."singleton")
);
--> statement-breakpoint
ALTER TABLE "model_credential_candidate" ADD CONSTRAINT "model_credential_candidate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_upgrade_action" ADD CONSTRAINT "model_upgrade_action_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;