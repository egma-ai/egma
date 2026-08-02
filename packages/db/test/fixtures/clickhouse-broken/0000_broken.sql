-- A migration that cannot apply. Boot has to stop on it rather than carry on
-- against a schema that is missing whatever this file was meant to add.
CREATE TABLE IF NOT EXISTS never_lands
(
    trace_id String
)
ENGINE = NoSuchEngine
ORDER BY trace_id;
