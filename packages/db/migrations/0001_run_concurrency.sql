ALTER TABLE public.run
  ADD COLUMN concurrency integer DEFAULT 4 NOT NULL;

ALTER TABLE public.run DISABLE TRIGGER run_lifecycle_guard;

UPDATE public.run
SET concurrency = CASE
  WHEN connection_snapshot->>'modality' = 'chat' THEN 10
  ELSE 4
END;

CREATE OR REPLACE FUNCTION public.guard_run_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

  IF NEW.concurrency <> OLD.concurrency THEN
    RAISE EXCEPTION 'run % concurrency is set once at start', OLD.id;
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
$$;

ALTER TABLE public.run ENABLE TRIGGER run_lifecycle_guard;

ALTER TABLE public.run
  ADD CONSTRAINT run_concurrency_positive CHECK (concurrency > 0);
