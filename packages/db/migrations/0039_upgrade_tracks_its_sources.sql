-- The upgrade tracks the rows it copied from, and remembers what it wrote.
--
-- Two columns, and both exist because a legacy key can still be rotated while
-- the compatibility period lasts: `writePlatformSettings` and
-- `editJudgeCredential` are open doors, and an operator who rotates a spent key
-- through either of them expects the next simulation to spend the new one.
--
--  * `model_credential_candidate.source_changed_at` is the source row's own
--    `updated_at` at the moment of the copy. It is what tells a later boot that
--    the source has moved — asked of the source rather than worked out by
--    comparing what is inside two envelopes, which this upgrade may not read
--    and which would answer "changed" every time anyway, because the sealing
--    nonce is fresh on every write.
--  * `model_provider_credential.upgraded_from` names the candidate a credential
--    is *tracking*, or null for a key an administrator typed. It is what lets a
--    rotation reach the credential the upgrade wrote, and what stops the
--    upgrade ever reaching one an administrator wrote: storing a key through
--    Model providers clears it, and from that moment their choice is the only
--    answer. Not a foreign key, because it is a record of where a secret came
--    from rather than a pointer anything follows.
--
-- Additive, and the backfill is deliberately none: an existing candidate takes
-- the epoch, so the first boot after this migration refreshes it from its
-- source once and settles. An existing credential takes null, which reads as
-- "an administrator's" — the safe direction, because the cost of being wrong
-- that way is a rotation somebody has to repeat rather than a choice Egma
-- overwrote.

ALTER TABLE "model_provider_credential" ADD COLUMN "upgraded_from" text COLLATE "C";--> statement-breakpoint
-- Added with the epoch as a default so a deployment that already applied 0037
-- keeps its candidates, then the default is dropped so the live column matches
-- the one the application declares. The epoch is the honest value: it says the
-- copy is older than anything the source can report, so the first boot after
-- this refreshes it once from its source and every boot after that writes
-- nothing.
ALTER TABLE "model_credential_candidate" ADD COLUMN "source_changed_at" timestamp with time zone NOT NULL DEFAULT to_timestamp(0);--> statement-breakpoint
ALTER TABLE "model_credential_candidate" ALTER COLUMN "source_changed_at" DROP DEFAULT;