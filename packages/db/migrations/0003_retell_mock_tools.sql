-- MOCK TOOLS: one switch per connection, and the four things a run has to
-- remember so somebody's Retell account can be put back the way it was found.
--
-- **Destructive**, under the standing pre-launch allowance README.md sets out
-- in "Before launch": the run lifecycle guard is rewritten rather than added
-- beside its original. The code that reads the new shape ships in the same
-- change, so the two are never apart.
--
-- Nothing here needs a backfill, and nothing here disables a trigger. The
-- switch arrives off for every connection that exists, which is what it means,
-- and the four run columns arrive null, which is their honest value on every
-- run already written: none of them conducted against a named version and none
-- of them made a temporary copy.

-- The switch, on the connection rather than on the agent.
--
-- A run's lane is what decides whether it can be mocked at all, and the lane
-- **is** the connection: a text exchange and a web call are conversations Egma
-- creates against a named agent version, and a phone call is the real carrier
-- leg reaching the customer's real tools. An agent-level tick would govern one
-- of those three and silently misdescribe the other two.
ALTER TABLE "connection" ADD COLUMN "mock_tools_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- What a run conducted against: the serving version it resolved once, named on
-- every request from then on. Retell's own default is "the newest version", and
-- the newest version is exactly the one a concurrent edit has just made — so a
-- suite that leaned on the default could be testing two different agents
-- halfway through.
--
-- Set on every text-mode and web-call run, mocked or not. Null on a phone run,
-- where Egma names no version at all.
ALTER TABLE "run" ADD COLUMN "agent_version" integer;--> statement-breakpoint

-- The temporary copy this run branched, where it branched one.
ALTER TABLE "run" ADD COLUMN "temp_mock_agent_version" integer;--> statement-breakpoint

-- Whether the account has been put back: null when no copy was made, false
-- while a cleanup is owed, true once the account is as it was found.
--
-- **A real column rather than a key inside the note below**, because the claim
-- searches by it: before a run branches anything, one indexed query asks
-- whether this agent has a run whose cleanup is still owed, and that cleanup is
-- finished first or the new run is refused rather than branched.
ALTER TABLE "run" ADD COLUMN "temp_mock_agent_version_cleanup" boolean;--> statement-breakpoint

-- The put-it-back note: the serving engine capture the verify step compares
-- against, and each touched number's binding verbatim — nothing else. A
-- number's entry is `{"number": "+15550100", "was": "latest", "pinned_to": 8}`:
-- where it pointed, and what Egma pinned it to. A restore reads where the
-- number points **now** and writes only where it still points at `pinned_to`,
-- so a late retry can never move a binding the customer has since changed.
ALTER TABLE "run" ADD COLUMN "mock_metadata" jsonb;--> statement-breakpoint

-- The claim's own query, and the only read the cleanup flag is for: which runs
-- of this agent still owe the account a cleanup. Partial, because the answer is
-- almost always none.
CREATE INDEX "run_mock_tools_cleanup_owed_idx" ON "run" USING btree ("organization_id","agent_id") WHERE "run"."temp_mock_agent_version_cleanup" = false;--> statement-breakpoint

-- The switch can only be on where a mocked run is a conversation Egma creates
-- itself. `phone_number` can never hold true: the phone lane is the unmocked
-- true-telephony lane, never dialled for a mocked run, so a ticked phone
-- connection would be a box promising isolation no run could keep.
ALTER TABLE "connection" ADD CONSTRAINT "connection_mock_tools_lanes" CHECK ("connection"."mock_tools_enabled" = false
        or "connection"."connection_type" in ('retell_text_mode', 'retell_web_call'));--> statement-breakpoint

-- A version is a whole number of versions, on both of the version columns.
ALTER TABLE "run" ADD CONSTRAINT "run_agent_version_is_a_version" CHECK ("run"."agent_version" is null or "run"."agent_version" >= 0);--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_temp_mock_agent_version_is_a_version" CHECK ("run"."temp_mock_agent_version" is null
        or "run"."temp_mock_agent_version" >= 0);--> statement-breakpoint

-- A copy that was branched always carries a cleanup flag — owed or settled.
-- The other direction is deliberately open: the flag is written the moment the
-- run claims the account, which is before there is anything to clean up.
ALTER TABLE "run" ADD CONSTRAINT "run_temp_mock_agent_version_owes_cleanup" CHECK ("run"."temp_mock_agent_version" is null
        or "run"."temp_mock_agent_version_cleanup" is not null);--> statement-breakpoint

-- The run header freezes when its counts land, and the cleanup bookkeeping is
-- carved out of that freeze.
--
-- It has to be. A run that crashed before its teardown leaves a temporary
-- version on somebody's Retell account and, where it pinned one, a number held
-- to a version the customer did not choose. Clearing that is by definition
-- something that happens after the run is over, and the sweep that does it has
-- to be able to say it is done — otherwise it sweeps the same run forever.
--
-- The carve-out is exact: on a finished run, a write is admitted only when
-- `temp_mock_agent_version_cleanup` and `mock_metadata` are the only columns
-- that moved. The comparison is over the whole row rather than a list of
-- columns, so a column added later is inside the freeze without anybody
-- remembering to add it here.
CREATE OR REPLACE FUNCTION public.guard_run_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- The counts and finished_at land together, once; after that the header is
  -- frozen and a retry is a new run. The one carve-out below is the cleanup
  -- bookkeeping, which is about somebody's Retell account rather than about
  -- this run's numbers.
  IF OLD.finished_at IS NOT NULL THEN
    IF (NEW.temp_mock_agent_version_cleanup IS DISTINCT FROM OLD.temp_mock_agent_version_cleanup
        OR NEW.mock_metadata IS DISTINCT FROM OLD.mock_metadata)
       AND (to_jsonb(NEW) - 'temp_mock_agent_version_cleanup' - 'mock_metadata')
         = (to_jsonb(OLD) - 'temp_mock_agent_version_cleanup' - 'mock_metadata')
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
