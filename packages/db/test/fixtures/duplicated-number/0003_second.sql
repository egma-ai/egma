-- The other 0003. See `0003_first.sql`.
CREATE TABLE IF NOT EXISTS second_arrival (id String) ENGINE = MergeTree ORDER BY id;
