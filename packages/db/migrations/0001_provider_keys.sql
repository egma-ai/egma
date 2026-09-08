CREATE TABLE "provider_key" (
	"organization_id" text COLLATE "C" NOT NULL,
	"provider" text NOT NULL,
	"credentials" text NOT NULL,
	"hint" text NOT NULL,
	"revision" text COLLATE "C" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_key_organization_id_provider_pk" PRIMARY KEY("organization_id","provider"),
	CONSTRAINT "provider_key_provider_allowed" CHECK ("provider_key"."provider" in ('openai', 'deepgram', 'cartesia')),
	CONSTRAINT "provider_key_revision_prefix" CHECK ("provider_key"."revision" ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "provider_key_hint_shape" CHECK (char_length("provider_key"."hint") = 8)
);
--> statement-breakpoint
ALTER TABLE "run_event" DROP CONSTRAINT "run_event_reason_agrees";--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_ending_reason_allowed";--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_ending_reason_agrees";--> statement-breakpoint
ALTER TABLE "provider_key" ADD CONSTRAINT "provider_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_reason_agrees" CHECK ("run_event"."reason" is null
        or ("run_event"."status" = 'completed' and "run_event"."reason" in ('persona_concluded', 'agent_ended', 'limit_reached'))
        or ("run_event"."status" = 'failed' and "run_event"."reason" in ('agent_never_joined', 'not_answered', 'capacity', 'simulator_error', 'orphaned', 'dispatch_failed', 'provider_key_unavailable')));--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_ending_reason_allowed" CHECK ("simulation"."ending_reason" is null or "simulation"."ending_reason" in ('persona_concluded', 'agent_ended', 'limit_reached', 'agent_never_joined', 'not_answered', 'capacity', 'simulator_error', 'orphaned', 'dispatch_failed', 'provider_key_unavailable'));--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_ending_reason_agrees" CHECK (case "simulation"."status"
        when 'completed' then "simulation"."ending_reason" in ('persona_concluded', 'agent_ended', 'limit_reached')
        when 'failed' then "simulation"."ending_reason" in ('agent_never_joined', 'not_answered', 'capacity', 'simulator_error', 'orphaned', 'dispatch_failed', 'provider_key_unavailable')
        else "simulation"."ending_reason" is null
      end);