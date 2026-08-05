-- A migration that cannot apply, put deliberately after a statement that can.
-- There is no transaction to take the first statement back, so a boot that runs
-- this leaves the file half-applied: `lands_first` exists, the ledger records
-- nothing, and the next boot runs the whole file again — sailing past the table
-- that already exists and failing on the same second statement. Boot has to
-- stop on it rather than carry on against a schema that is missing whatever
-- this file was meant to add.
CREATE TABLE IF NOT EXISTS lands_first
(
    trace_id String
)
ENGINE = MergeTree
ORDER BY trace_id;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS never_lands
(
    trace_id String
)
ENGINE = NoSuchEngine
ORDER BY trace_id;
