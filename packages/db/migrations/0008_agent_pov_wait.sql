-- GRADING'S WAIT FOR THE AGENT'S POV, WRITTEN ON THE ROW IT IS ABOUT.
--
-- A simulation stores two accounts of one conversation (ADR-0015): the
-- persona's, which egma measured itself, and the agent's, which arrives after
-- the conversation ends — pushed by the egma SDK from inside a LiveKit room, or
-- pulled from Retell's API. Grading waits for that second account, and stops
-- waiting 30 seconds after completion so a broken exporter or a failed pull
-- cannot hold a simulation open forever.
--
-- This column is how that wait ends: `filed` when the agent's own account was
-- query-visible, `incomplete` when the bound expired first. Null while the wait
-- is still open, and null forever on a lane that produces no agent POV at all —
-- a `phone_number` connection has no second account coming.
--
-- **Additive**, and nothing existing reads it. Every row already stored keeps
-- null, which reads as "nothing waited for this one" — correct for everything
-- graded before the wait existed.
--
-- **The terminal freeze gains one carve-out**, and it is deliberately the
-- narrowest one that works. `guard_simulation_lifecycle` refuses every write to
-- a completed, failed or canceled row, because a conversation's record is
-- written once. The wait ends *after* the row is terminal, so the guard would
-- refuse the one write that says how it ended. It now lets exactly this through:
-- `agent_pov` moving off null on a completed row, with the status unchanged and
-- with no other column of that row different. Everything else about a terminal
-- simulation is still written once, `agent_pov` still cannot be rewritten once
-- it says something, and the "written once" rule is what makes the wait settle
-- once — of two sweeps reaching one row, the second finds it settled and asks
-- for no second grading.

ALTER TABLE "simulation" ADD COLUMN "agent_pov" text;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_agent_pov_allowed" CHECK ("simulation"."agent_pov" is null or "simulation"."agent_pov" in ('filed', 'incomplete'));--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_agent_pov_only_when_completed" CHECK ("simulation"."agent_pov" is null or "simulation"."status" = 'completed');--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.guard_simulation_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	IF OLD.status IN ('completed', 'failed', 'canceled') THEN
		-- The one write a terminal row still accepts: how grading's wait for
		-- the agent's own POV ended. It is not a fact about the conversation —
		-- the conversation is over and its record is closed — it is a fact
		-- about a second account that had not arrived yet when the row closed.
		-- A completed row only, off null only, status unchanged, and every
		-- other column identical, so nothing else can ride in beside it. The
		-- completed-row half repeats what `simulation_agent_pov_only_when_
		-- completed` says, on purpose: a write the guard would wave through and
		-- the check would then refuse would answer with the wrong sentence, and
		-- the sentence is what a reader is given.
		IF OLD.status = 'completed'
			AND OLD.agent_pov IS NULL
			AND NEW.agent_pov IS NOT NULL
			AND NEW.status = OLD.status
			AND to_jsonb(NEW) - 'agent_pov' = to_jsonb(OLD) - 'agent_pov'
		THEN
			RETURN NEW;
		END IF;

		RAISE EXCEPTION 'simulation % is %, and a terminal simulation is written once',
			OLD.id, OLD.status;
	END IF;

	IF NEW.status = OLD.status THEN
		RETURN NEW;
	END IF;

	IF (OLD.status = 'queued' AND NEW.status IN ('claimed', 'canceled'))
	OR (OLD.status = 'claimed' AND NEW.status IN ('queued', 'running', 'failed', 'canceled'))
	OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'canceled'))
	THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'simulation % may not move from % to %',
		OLD.id, OLD.status, NEW.status;
END
$function$;
