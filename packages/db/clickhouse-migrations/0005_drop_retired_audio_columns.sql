-- Prelaunch cleanup approved without an older API or rollback contract.
-- The prior build cannot append spans after this migration.
-- The raw OTLP payload remains the only persisted copy of these native facts.

ALTER TABLE spans
    DROP COLUMN IF EXISTS audio_sample_rate_hz
;
--> statement-breakpoint
ALTER TABLE spans
    DROP COLUMN IF EXISTS audio_encoding
;
