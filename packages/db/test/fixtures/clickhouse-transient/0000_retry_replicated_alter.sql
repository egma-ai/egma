CREATE TABLE IF NOT EXISTS retry_probe
(
    id UInt8
)
ENGINE = MergeTree
ORDER BY id
;
--> statement-breakpoint
ALTER TABLE retry_probe
    ADD COLUMN IF NOT EXISTS caught_up UInt8
;
