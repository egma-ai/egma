-- THE RETELL PLAYGROUND: a chat door onto a Retell **voice** agent, and the
-- version each run conducts against.
--
-- **Destructive**, under the standing pre-launch allowance README.md sets out
-- in "Before launch": the connection row's two value checks are replaced rather
-- than widened beside their originals. The code that reads the new shape ships
-- in the same change, so the two are never apart.
--
-- Nothing here needs a backfill. The two new columns are nullable and null
-- means exactly one thing on every row already written: this run pinned no
-- platform version, which is true of every run there is.

-- The new door. `connection_type_allowed` is **the one gate on a
-- connection-type value** — checked against the live schema rather than
-- assumed: no other CHECK, no enum type, no domain and no trigger anywhere
-- compares one. The simulation row deliberately copies only modality from its
-- connection, so nothing on the evidence side gates the new value either.
ALTER TABLE "connection" DROP CONSTRAINT "connection_type_allowed";--> statement-breakpoint
ALTER TABLE "connection"
	ADD CONSTRAINT "connection_type_allowed"
	CHECK ("connection"."connection_type" in ('retell_chat_api', 'retell_playground', 'retell_web_call', 'phone_number', 'livekit_room'));--> statement-breakpoint

-- The access variant is a second value on the same row, gated by its own
-- check. Widened here because a new connection type arrives with the variant
-- that opens it — not because anything else gates the type.
ALTER TABLE "connection" DROP CONSTRAINT "connection_access_variant_allowed";--> statement-breakpoint
ALTER TABLE "connection"
	ADD CONSTRAINT "connection_access_variant_allowed"
	CHECK ("connection"."access_variant" in ('retell_chat_api.api_key', 'retell_playground.api_key', 'retell_web_call.api_key', 'phone_number.public_e164', 'livekit_room.project_credentials', 'livekit_room.customer_token_endpoint'));--> statement-breakpoint

-- What the run read at its start and conducts against: the serving version it
-- resolved once, the engine that version runs on, and the three-class coverage
-- stamp of that version's tools.
--
-- **Read, never written.** Unlike `mocked_world` beside it, nothing here was
-- put onto anybody's Retell account and nothing has to be put back — a
-- playground request carries its mocked answers with it, so this lane branches
-- no draft, pins no number and sweeps nothing. It is therefore inside the run
-- header's freeze rather than carved out of it: it is settled before the first
-- simulation is claimed and never moves again.
--
-- Nullable, and null means one thing: this run pinned no platform version.
ALTER TABLE "run" ADD COLUMN "conducted_world" jsonb;--> statement-breakpoint

-- The same version, on each conversation of the run.
--
-- Evidence pins at the evidence grain. A run's header says what the run
-- conducted; a simulation has to be able to say what **it** conducted from its
-- own row, because that is the row a result is read at and the row a grader's
-- reads start from. Copied from the one value the run resolved, in the same
-- transaction, so the two can never disagree.
--
-- Nullable for the same reason and with the same meaning as the column above.
ALTER TABLE "simulation" ADD COLUMN "conducted_agent_version" integer;--> statement-breakpoint

ALTER TABLE "simulation"
	ADD CONSTRAINT "simulation_conducted_agent_version_is_a_version"
	CHECK ("simulation"."conducted_agent_version" is null or "simulation"."conducted_agent_version" >= 0);
