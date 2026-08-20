ALTER TABLE "retell_ingestion_failure" ADD COLUMN "replay_lease_owner" text;--> statement-breakpoint
ALTER TABLE "retell_ingestion_failure" ADD COLUMN "replay_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retell_ingestion_failure" ADD CONSTRAINT "retell_ingestion_failure_replay_lease_agrees" CHECK (("retell_ingestion_failure"."replay_lease_owner" is null) = ("retell_ingestion_failure"."replay_lease_expires_at" is null));
