-- The ending-reason vocabulary gains `dispatch_failed`: the honest landing
-- for a claimed simulation the platform could not turn into a spec worth
-- handing over. A failed-class word beside `orphaned`, and like `orphaned`
-- one only the platform writes — the access layer keeps it out of what a
-- simulator may report. Three checks widen and nothing else moves: the
-- landing is `claimed → failed`, which the lifecycle trigger already allows.
ALTER TABLE "run_event" DROP CONSTRAINT "run_event_reason_agrees";--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_ending_reason_allowed";--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_ending_reason_agrees";--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_reason_agrees" CHECK ("run_event"."reason" is null
        or ("run_event"."status" = 'completed' and "run_event"."reason" in ('persona_concluded', 'agent_ended', 'limit_reached'))
        or ("run_event"."status" = 'failed' and "run_event"."reason" in ('agent_never_joined', 'not_answered', 'capacity', 'simulator_error', 'orphaned', 'dispatch_failed')));--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_ending_reason_allowed" CHECK ("simulation"."ending_reason" is null or "simulation"."ending_reason" in ('persona_concluded', 'agent_ended', 'limit_reached', 'agent_never_joined', 'not_answered', 'capacity', 'simulator_error', 'orphaned', 'dispatch_failed'));--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_ending_reason_agrees" CHECK (case "simulation"."status"
        when 'completed' then "simulation"."ending_reason" in ('persona_concluded', 'agent_ended', 'limit_reached')
        when 'failed' then "simulation"."ending_reason" in ('agent_never_joined', 'not_answered', 'capacity', 'simulator_error', 'orphaned', 'dispatch_failed')
        else "simulation"."ending_reason" is null
      end);