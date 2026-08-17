-- OTLP service spans may carry native codec and sample-rate attributes. They
-- remain whole in `payload`; copying them into two Egma-normalised query
-- columns made a transport-specific projection look universal. Connection type
-- stays because it is Egma attribution rather than a copied native value.
--
-- The base migration forbids rewriting the settled engine, partition key, or
-- filing order. This is the narrow exception for two copied data columns: the
-- raw payload remains complete, and this metadata operation changes none of
-- that settled storage shape.
--
-- Keep the retired names as EPHEMERAL inputs for one compatibility window.
-- ClickHouse accepts an EPHEMERAL value during INSERT but neither stores it nor
-- permits it in SELECT. An older API replica can therefore finish a rolling
-- deploy without its JSONEachRow inserts failing after the first new replica
-- applies this migration. The raw OTLP payload is the only persisted copy.

ALTER TABLE spans
    MODIFY COLUMN IF EXISTS audio_sample_rate_hz UInt32 EPHEMERAL
;
--> statement-breakpoint
ALTER TABLE spans
    MODIFY COLUMN IF EXISTS audio_encoding LowCardinality(String) EPHEMERAL
;
