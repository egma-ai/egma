-- THE MOCKED WORLD ON RETELL: the tick, the web-call lane, and what a run has
-- to remember to put an account back the way it found it.
--
-- **Destructive**, under the standing pre-launch allowance README.md sets out
-- in "Before launch": two CHECK constraints are replaced rather than widened
-- beside their originals, and the run lifecycle guard is rewritten. The code
-- that reads the new shape ships in the same change, so the two are never
-- apart.
--
-- Existing data is carried by the one backfill below and by nothing else: every
-- coverage stamp already on a simulation gains the two lists this change adds,
-- as the empty lists that are its honest value on the seam that wrote it.

-- The tick. Off for every agent that exists, which is what it means.
ALTER TABLE "agent"
	ADD COLUMN "mock_tools_during_simulations" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- The same promise the pull switch is held to: the tick can only be on when
-- there is a platform agent to branch a version of and a sealed key to branch
-- it with.
ALTER TABLE "agent"
	ADD CONSTRAINT "agent_mock_tools_need_platform_key"
	CHECK ("agent"."mock_tools_during_simulations" = false or ("agent"."platform_agent_id" is not null and "agent"."monitoring_api_key" is not null));--> statement-breakpoint

-- The new lane: a Retell web call is a call Egma creates itself against a
-- named agent version, so the customer's published number is never dialled and
-- never rebound for a mocked run.
ALTER TABLE "connection" DROP CONSTRAINT "connection_type_allowed";--> statement-breakpoint
ALTER TABLE "connection"
	ADD CONSTRAINT "connection_type_allowed"
	CHECK ("connection"."connection_type" in ('retell_chat_api', 'retell_web_call', 'phone_number', 'livekit_room'));--> statement-breakpoint

ALTER TABLE "connection" DROP CONSTRAINT "connection_access_variant_allowed";--> statement-breakpoint
ALTER TABLE "connection"
	ADD CONSTRAINT "connection_access_variant_allowed"
	CHECK ("connection"."access_variant" in ('retell_chat_api.api_key', 'retell_web_call.api_key', 'phone_number.public_e164', 'livekit_room.project_credentials', 'livekit_room.customer_token_endpoint'));--> statement-breakpoint

-- What a run has to remember: the version it branched from, the temporary
-- version it minted, the engine that version runs on, every touched number's
-- inbound bindings verbatim, and the three-class coverage stamp of the
-- configuration the temporary version was built from.
--
-- Nullable, and null means one thing: this run built no mocked world.
ALTER TABLE "run" ADD COLUMN "mocked_world" jsonb;--> statement-breakpoint

-- The coverage stamp learns two lists, so it can say *why* a tool was not
-- answered for and not only that it was not. Every stamp already stored was
-- written by the in-process seam, where every tool the agent declares is
-- reachable and nothing is un-interceptable by construction — so the empty
-- lists below are that seam's honest answer rather than a placeholder.
--
-- **The guard has to come off around it, and only around it.**
-- `simulation_lifecycle_guard` refuses *every* update to a row that has landed
-- `completed`, `failed` or `canceled` — which is the whole point of it, and
-- which is also every row this backfill touches: a coverage stamp is a terminal
-- fact, and `simulation_mock_tool_coverage_only_when_ended` means a row cannot
-- carry one until it has ended. So on any database that has ever finished a
-- stamped simulation this statement raises, the migration rolls back, and the
-- API cannot boot — an empty development database is the only place it would
-- have appeared to work.
--
-- Disabling the trigger is therefore not a shortcut around the invariant, it is
-- the invariant being told that this one additive backfill is not a rewrite of
-- history: no lifecycle column moves, and the two lists are added empty, so
-- every terminal row means afterwards exactly what it meant before.
--
-- The runner sends the whole file inside one `begin`/`commit`, and disabling a
-- trigger is itself transactional in Postgres — so a failure anywhere in the
-- backfill rolls the disable back with it. The guard cannot be left off by a
-- migration that did not finish.
ALTER TABLE "simulation" DISABLE TRIGGER "simulation_lifecycle_guard";--> statement-breakpoint

UPDATE "simulation"
SET "mock_tool_coverage" = "mock_tool_coverage" || '{"notInterceptable": [], "notInThisVersion": []}'::jsonb
WHERE "mock_tool_coverage" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "simulation" ENABLE TRIGGER "simulation_lifecycle_guard";--> statement-breakpoint

-- The run header freezes when its counts land, and the mocked world is carved
-- out of that freeze.
--
-- It has to be. A run that crashed before its teardown leaves a temporary
-- version on somebody's Retell account and, where it pinned one, a number held
-- to a version the customer did not choose. Clearing that is by definition
-- something that happens after the run is over, and the sweep that does it has
-- to be able to say it is done — otherwise it sweeps the same run forever.
--
-- The carve-out is exact: on a finished run, a write is admitted only when
-- `mocked_world` is the single column that moved. The comparison is over the
-- whole row rather than a list of columns, so a column added later is inside
-- the freeze without anybody remembering to add it here.
CREATE OR REPLACE FUNCTION public.guard_run_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- The counts and finished_at land together, once; after that the header is
  -- frozen and a retry is a new run. The one carve-out below is the mocked
  -- world, which is bookkeeping about somebody's Retell account rather than
  -- about this run's numbers.
  IF OLD.finished_at IS NOT NULL THEN
    IF NEW.mocked_world IS DISTINCT FROM OLD.mocked_world
       AND (to_jsonb(NEW) - 'mocked_world') = (to_jsonb(OLD) - 'mocked_world')
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'run % is finished, and a finished run''s header is written once',
      OLD.id;
  END IF;

  IF NEW.expected_simulation_count <> OLD.expected_simulation_count THEN
    RAISE EXCEPTION 'run % expected % simulations, and the expectation is set once at start',
      OLD.id, OLD.expected_simulation_count;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'pending' AND NEW.status IN ('running', 'canceled'))
  OR (OLD.status = 'running' AND NEW.status IN ('completed', 'canceled'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'run % may not move from % to %', OLD.id, OLD.status, NEW.status;
END
$function$;
