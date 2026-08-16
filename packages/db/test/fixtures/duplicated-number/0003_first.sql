-- A fixture, never applied. Two files in this directory wear the number 0003,
-- which is the shape of the mistake `packages/db/test/support/migration-numbers.ts`
-- exists to catch: two efforts each took the next free number from where they
-- were standing, and a merge put both in one directory.
CREATE TABLE IF NOT EXISTS first_arrival (id String) ENGINE = MergeTree ORDER BY id;
