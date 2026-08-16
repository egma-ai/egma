-- A third file, so the guard has to report the repeated number rather than
-- merely notice that the count and the highest number disagree.
CREATE TABLE IF NOT EXISTS after_them (id String) ENGINE = MergeTree ORDER BY id;
