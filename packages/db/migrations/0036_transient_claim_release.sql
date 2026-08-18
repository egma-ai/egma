-- A provider preflight can fail before a claimed simulation is handed to a
-- simulator. A temporary provider outage says nothing about the simulation or
-- the agent, so the claim path gives that lease back and a later claim retries
-- it. This is the only backwards lifecycle edge: the row must satisfy the
-- queued-shape checks in the same update, which means all claim facts are
-- cleared with the status.
CREATE OR REPLACE FUNCTION guard_simulation_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'canceled', 'skipped') THEN
    RAISE EXCEPTION 'simulation % is %, and a terminal simulation is written once',
      OLD.id, OLD.status;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'queued'  AND NEW.status IN ('claimed', 'canceled'))
  OR (OLD.status = 'claimed' AND NEW.status IN ('queued', 'running', 'failed', 'canceled'))
  OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'canceled'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'simulation % may not move from % to %',
    OLD.id, OLD.status, NEW.status;
END
$$;
