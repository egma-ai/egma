-- The P0/P1/P2 ladder retires. Scoring is binary: every assertion of every
-- applicable grader has to pass, so there is nothing left for a priority to say
-- and nothing that reads one.
--
-- Dropped rather than left standing unused, and dropped plainly: the product is
-- pre-launch, so a column nobody writes is only a word the next reader has to
-- ask about. The behaviors half of the same retirement needs no statement here —
-- a test version is frozen the moment a run can pin it, so the priority a stored
-- version still carries beside each sentence is read past rather than rewritten.
ALTER TABLE "grader" DROP CONSTRAINT "grader_priority_allowed";--> statement-breakpoint
ALTER TABLE "grader" DROP COLUMN "priority";
