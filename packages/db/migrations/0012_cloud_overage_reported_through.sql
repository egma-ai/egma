-- WHERE THE HOURLY OVERAGE JOB RESUMES FROM.
--
-- Purely additive: one nullable column on `cloud_billing_account`. The code
-- running before this migration never selects it, and a rollback leaves an
-- empty column nothing reads.
--
-- The job posts whole minutes as the difference between two running totals, so
-- an hour that was never posted would have its minutes swallowed by the next
-- hour's "before" — the arithmetic that loses nothing inside a period loses
-- everything about a gap. This column is the mark the job resumes from. It
-- moves only after Stripe has taken an hour, or refused it as one it already
-- has; a replay is safe either way, because a meter event's identifier is the
-- meter, the organization and the hour.
--
-- Null on every existing row, which is the right start: a Pro account's mark is
-- set the first time the job reports it, at the hour that had just closed, so
-- switching billing on never back-bills a month that was free.

ALTER TABLE "cloud_billing_account" ADD COLUMN "overage_reported_through" timestamp with time zone;
