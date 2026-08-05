-- The synthetic caller is a persona now (see the Postgres side's 0005), and the
-- span's version pin follows. A column rename is metadata only — no row of
-- `spans` is rewritten. IF EXISTS is what makes the statement survive a rerun:
-- a boot that finds the column already renamed finds nothing to do.

ALTER TABLE spans RENAME COLUMN IF EXISTS digital_human_version_id TO persona_version_id;
