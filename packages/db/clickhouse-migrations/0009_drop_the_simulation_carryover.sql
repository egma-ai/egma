-- The carryover table has done its work: `0008` is recorded, so the simulation
-- evidence is back in `spans` and this copy is the only one left.
--
-- Its own file, and that is the whole reason there are three rather than two.
-- A ClickHouse migration file is recorded only after every statement in it has
-- succeeded, so a lost response on this drop re-runs the file that contains it.
-- Inside `0008` that would mean re-running the rebuild with its source table
-- already gone, and the simulation evidence would be lost to a dropped HTTP
-- response. Here it means re-running a drop that has nothing left to drop.

DROP TABLE IF EXISTS spans_carryover
