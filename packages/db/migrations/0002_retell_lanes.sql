-- THE RETELL LANES: the two doors Egma opens itself onto a Retell **voice**
-- agent — a text exchange and a web call.
--
-- **Destructive**, under the standing pre-launch allowance README.md sets out
-- in "Before launch": the connection row's two value checks are replaced rather
-- than widened beside their originals. The code that reads the new shape ships
-- in the same change, so the two are never apart.
--
-- Nothing here needs a backfill. Two connection-type values become admissible
-- and no row already written changes meaning.

-- The two new doors. `connection_type_allowed` is **the one gate on a
-- connection-type value** — checked against the live schema rather than
-- assumed: no other CHECK, no enum type, no domain and no trigger anywhere
-- compares one. The simulation row deliberately copies only modality from its
-- connection, so nothing on the evidence side gates the new values either.
--
-- `retell_text_mode` is the text door: Retell's own dashboard tests a voice
-- agent in text, and this is that lane, so a chat suite and a voice suite can
-- run against one agent. `retell_web_call` is the voice call Egma places over
-- the internet against a named agent version, which is what makes a temporary
-- version reachable at all — the customer's published number is never dialled
-- for a mocked run.
ALTER TABLE "connection" DROP CONSTRAINT "connection_type_allowed";--> statement-breakpoint
ALTER TABLE "connection"
	ADD CONSTRAINT "connection_type_allowed"
	CHECK ("connection"."connection_type" in ('retell_chat_api', 'retell_text_mode', 'retell_web_call', 'phone_number', 'livekit_room'));--> statement-breakpoint

-- The access variant is a second value on the same row, gated by its own
-- check. Widened here because a new connection type arrives with the variant
-- that opens it — not because anything else gates the type.
ALTER TABLE "connection" DROP CONSTRAINT "connection_access_variant_allowed";--> statement-breakpoint
ALTER TABLE "connection"
	ADD CONSTRAINT "connection_access_variant_allowed"
	CHECK ("connection"."access_variant" in ('retell_chat_api.api_key', 'retell_text_mode.api_key', 'retell_web_call.api_key', 'phone_number.public_e164', 'livekit_room.project_credentials', 'livekit_room.customer_token_endpoint'));
