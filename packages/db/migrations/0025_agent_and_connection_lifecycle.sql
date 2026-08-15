-- Agents and connections gain Archive, live revisions, a stored variant, and a
-- capability record.
--
-- Four changes, one migration, because they are one change to what an agent and
-- a connection are:
--
--  * `deleted_at` becomes `archived_at`. Nothing about the rows moves — the
--    column is renamed rather than replaced, so every already-soft-deleted row
--    arrives as an archived one, which is what it always was. Archive keeps a
--    row readable and out of new work; the deletion that erased it was never
--    what the product offered.
--  * `revision` is what an edit says it was written against. Backfilled with a
--    fresh opaque value per row, so the first edit anybody makes after the
--    upgrade already has one to name.
--  * `variant_id` freezes the shape a connection is in. Existing rows are
--    migrated by the registry's discriminator **as it stands in this commit**:
--    a livekit connection whose config names `tokenEndpoint` is the
--    token-endpoint shape and every other livekit connection is the key-pair
--    shape, which is exactly what re-deriving the shape answered the moment
--    before this ran. No connection changes meaning.
--  * Every still-active connection under an agent that was already archived is
--    archived too. Under the old rule the parent's marker hid them, so a live
--    child row was harmless; under the new one Restore brings the parent back
--    and a child nobody archived would come back with it, live, carrying the
--    provider credential it was sealed with. Archiving them here is what makes
--    `restoreAgent`'s promise — that its connections stay archived — true of
--    installed data as well as of new data.
--  * The capability columns replace an unused `capabilities` blob with the
--    record the product actually reads: a state, the catalog keys an adapter
--    looked at, which of those it found, when, and by which adapter. Measured
--    and found are two columns rather than one because a single list cannot
--    say whether a key's absence is a settled fact or an unasked question, and
--    those are different skip reasons with different fixes. Every existing row
--    becomes `unknown`, which is the truth — nothing had ever measured any of
--    them.

ALTER TABLE "agent" RENAME COLUMN "deleted_at" TO "archived_at";--> statement-breakpoint
ALTER TABLE "connection" RENAME COLUMN "deleted_at" TO "archived_at";--> statement-breakpoint

DROP INDEX IF EXISTS "agent_project_id_name_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "agent_organization_id_project_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "connection_agent_id_name_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "connection_agent_id_idx";--> statement-breakpoint

CREATE UNIQUE INDEX "agent_project_id_name_unique" ON "agent" ("project_id","name") WHERE "agent"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "agent_organization_id_project_id_idx" ON "agent" ("organization_id","project_id") WHERE "agent"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_agent_id_name_unique" ON "connection" ("agent_id","name") WHERE "connection"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "connection_agent_id_idx" ON "connection" ("agent_id") WHERE "connection"."archived_at" is null;--> statement-breakpoint

ALTER TABLE "agent" ADD COLUMN "revision" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "revision" text COLLATE "C";--> statement-breakpoint

-- Hex is a subset of Crockford base32, so this backfill wears the same shape
-- `newId('rev')` mints and nothing downstream has two formats to read.
UPDATE "agent" SET "revision" = 'rev_' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 26)) WHERE "revision" is null;--> statement-breakpoint
UPDATE "connection" SET "revision" = 'rev_' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 26)) WHERE "revision" is null;--> statement-breakpoint

ALTER TABLE "agent" ALTER COLUMN "revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" ALTER COLUMN "revision" SET NOT NULL;--> statement-breakpoint

-- Data only, so nothing about the schema moves. It runs after the rename above,
-- which is what gives both tables the `archived_at` this reads and writes.
UPDATE "connection" SET "archived_at" = "agent"."archived_at"
  FROM "agent"
 WHERE "connection"."agent_id" = "agent"."id"
   AND "agent"."archived_at" is not null
   AND "connection"."archived_at" is null;--> statement-breakpoint

ALTER TABLE "connection" ADD COLUMN "variant_id" text;--> statement-breakpoint

UPDATE "connection" SET "variant_id" = CASE
  WHEN "type" = 'retell' THEN 'retell.api_key'
  WHEN "type" = 'phone' THEN 'phone.number'
  WHEN "type" = 'livekit' AND "config" ? 'tokenEndpoint' THEN 'livekit.token_endpoint'
  WHEN "type" = 'livekit' THEN 'livekit.key_pair'
END WHERE "variant_id" is null;--> statement-breakpoint

ALTER TABLE "connection" ALTER COLUMN "variant_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "connection" DROP COLUMN "capabilities";--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "capability_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "capabilities_measured" jsonb;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "capabilities_supported" jsonb;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "capabilities_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "capability_source" text;--> statement-breakpoint

ALTER TABLE "connection" ADD CONSTRAINT "connection_capability_state_allowed" CHECK ("connection"."capability_state" in ('unknown', 'known'));--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_capability_evidence_agrees" CHECK (("connection"."capability_state" = 'known') = ("connection"."capabilities_measured" is not null and "connection"."capabilities_supported" is not null and "connection"."capabilities_checked_at" is not null and "connection"."capability_source" is not null));--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_capabilities_supported_were_measured" CHECK ("connection"."capabilities_supported" is null or "connection"."capabilities_supported" <@ "connection"."capabilities_measured");
