-- ARCHIVED AGENTS RELEASE THE PRODUCTION WATCH.
--
-- Archiving set only `archived_at`, so an agent archived with its pull
-- switch on kept the one-watcher claim (`agent_pulled_platform_agent_unique`
-- carries no archived condition) and kept being polled: a watcher no screen
-- can list, refusing every living agent bound to the same platform agent —
-- and the refusal named whichever active agent shared the platform id,
-- usually the very agent being started.
--
-- The sweep turns those switches off, and must run before the constraint or
-- an existing archived-and-on row fails the ALTER. The constraint then makes
-- the state unrepresentable, so no future code path can mint another one.
-- The sweep is a data mutation on rows nothing can reach, allowed plainly
-- under "Before launch" in this directory's README.
UPDATE "agent" SET "pull_production_calls" = false WHERE "archived_at" IS NOT NULL AND "pull_production_calls";--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_archived_releases_pull" CHECK ("agent"."pull_production_calls" = false or "agent"."archived_at" is null);
