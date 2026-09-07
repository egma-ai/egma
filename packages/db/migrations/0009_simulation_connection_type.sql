-- A SIMULATION RECORDS THE LANE IT RAN OVER, as it already records its modality.
--
-- Additive, and carried across by an explicit backfill: every simulation row
-- already names a connection by a foreign key, so the value it should have had
-- at execution is the one that connection holds now, and there is no row this
-- cannot fill. The column is added nullable, filled, and only then made
-- required — the three-step form, because `ADD COLUMN ... NOT NULL` with no
-- default refuses a table that already has rows.
--
-- Why the row keeps its own copy rather than joining: the three allowances a
-- month is measured in — chat simulations, web-call minutes, phone minutes —
-- are read off this column and the modality beside it. A connection can be
-- edited or archived after the conversation it carried, and a join would then
-- move last month's minutes from one allowance to another. This is a shared
-- column and not a `cloud_` one on purpose: which lane a conversation ran over
-- is a product fact every deployment records.
--
-- The index is the usage read's own shape: one organization's conversations
-- that began inside a period.

ALTER TABLE "simulation" ADD COLUMN "connection_type" text;--> statement-breakpoint
UPDATE "simulation"
  SET "connection_type" = "connection"."connection_type"
  FROM "connection"
  WHERE "connection"."id" = "simulation"."connection_id";--> statement-breakpoint
ALTER TABLE "simulation" ALTER COLUMN "connection_type" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "simulation_organization_id_started_at_idx" ON "simulation" USING btree ("organization_id","started_at");--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_connection_type_allowed" CHECK ("simulation"."connection_type" in ('retell_chat_api', 'retell_text_mode', 'retell_web_call', 'phone_number', 'livekit_room'));
