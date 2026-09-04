-- THE TEST CARRIES ITS OWN WORLD: mock tools and env move onto the test
-- version, and the project-level machinery around them goes.
--
-- **Destructive**, under the standing pre-launch allowance README.md sets out
-- in "Before launch": two tables, three columns, two checks and two JSON keys
-- are removed in one step rather than stopped-reading now and dropped later.
-- The code that reads the new shape ships in the same change, so the two are
-- never apart.
--
-- What goes, and why each one has nowhere left to be read from:
--
--   * `mock_tool` and `mock_tool_agent` — the project's own answers and the
--     agents they were scoped to. A test answers for its own tools now, so
--     there is no project half to override and no scope to narrow.
--   * `connection.mock_tools_enabled` and its lane check — the switch that
--     said a run over this connection is mocked. What a run mocks is decided
--     by the tests it executes; a switch beside them would be a second answer
--     to one question, able to say no to a test that asked for a world.
--   * `run.mock_tool_snapshot` — the frozen copy of that project world. A
--     simulation pins an immutable test version, so there is nothing left that
--     could move underneath a run and nothing to freeze.
--   * `simulation.mock_tool_coverage` and its terminal check — the three name
--     lists saying which tools Egma answered for. Every answered call is on
--     the transcript already.
--   * the `mockOverrides` key inside `test_version.content`, and the
--     `mockToolsEnabled` key inside `run.connection_snapshot`.
--
-- **What is carried across is carried across.** Every override a test version
-- already holds becomes that version's own `mock_tools` entry, in the order it
-- was authored: `{"toolName": t, "answer": {"answer": v}}` becomes
-- `{"tool": t, "answer": v}`, and the error branch the same way. Nothing else
-- can be: a project mock tool applied to every test in the project and there is
-- no one test to give it to, a connection switch describes a lane rather than a
-- scenario, and a run's snapshot is a copy of the project world that is going.
--
-- **The delay does not survive, and that is the decision rather than an
-- oversight.** `delay_milliseconds` had one authored value in the old shape and
-- no place in the new one — a test says what a tool answers, never how slowly —
-- so an override that asked for a pause is carried across as its answer and the
-- pause is dropped. Latency injection returns as its own thing when it is
-- designed, not as a field nobody could see.
--
-- **One trigger is held back for exactly one statement**, and it is the run
-- header's freeze. That guard exists so a finished run's numbers can never be
-- rewritten, and it refuses every update to a finished row — including the one
-- below, which removes a word from the frozen snapshot rather than changing
-- anything the run says. `mockToolsEnabled` names a column that no longer
-- exists and a switch no code reads, so a run carrying it would be a run
-- claiming a fact nobody can act on. The guard is disabled for that statement
-- and put back in the same transaction, and no other trigger is touched:
-- `test_version` guards only its `test_id`, which the backfill never writes.

-- The two new columns first, so the backfill below has somewhere to write.
--
-- Nullable, and null is the whole meaning: this test mocks nothing, or asks for
-- nothing. An empty list is stored as null too, so the claim gate can ask
-- `mock_tools is not null` and never read a value to learn whether a run owes
-- itself a mocked world.
ALTER TABLE "test_version" ADD COLUMN "mock_tools" jsonb;--> statement-breakpoint
ALTER TABLE "test_version" ADD COLUMN "env" jsonb;--> statement-breakpoint

-- Every override a version already holds, in the order it was authored.
UPDATE "test_version"
   SET "mock_tools" = (
         SELECT jsonb_agg(
                  CASE
                    WHEN jsonb_exists(entry -> 'answer', 'error')
                      THEN jsonb_build_object(
                             'tool', entry ->> 'toolName',
                             'error', entry -> 'answer' -> 'error')
                    ELSE jsonb_build_object(
                             'tool', entry ->> 'toolName',
                             'answer', entry -> 'answer' -> 'answer')
                  END
                  ORDER BY entry_index)
           FROM jsonb_array_elements("content" -> 'mockOverrides')
                WITH ORDINALITY AS overridden(entry, entry_index)
          WHERE jsonb_typeof(entry) = 'object'
            AND jsonb_typeof(entry -> 'answer') = 'object'
            AND jsonb_typeof(entry -> 'toolName') = 'string')
 WHERE jsonb_typeof("content" -> 'mockOverrides') = 'array'
   AND jsonb_array_length("content" -> 'mockOverrides') > 0;--> statement-breakpoint

-- The key itself, now that what it said lives in its own column. A version's
-- content is the scenario and the expected behaviors, and nothing else.
UPDATE "test_version"
   SET "content" = "content" - 'mockOverrides'
 WHERE jsonb_exists("content", 'mockOverrides');--> statement-breakpoint

-- The switch inside every run's frozen connection, for the same reason: the
-- fact is gone, so a run that still carried it would be a run claiming
-- something no reader could act on.
ALTER TABLE "run" DISABLE TRIGGER "run_lifecycle_guard";--> statement-breakpoint
UPDATE "run"
   SET "connection_snapshot" = "connection_snapshot" - 'mockToolsEnabled'
 WHERE jsonb_exists("connection_snapshot", 'mockToolsEnabled');--> statement-breakpoint
ALTER TABLE "run" ENABLE TRIGGER "run_lifecycle_guard";--> statement-breakpoint

-- The project's own mocked world, and the agents it was scoped to.
ALTER TABLE "mock_tool" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mock_tool_agent" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "mock_tool" CASCADE;--> statement-breakpoint
DROP TABLE "mock_tool_agent" CASCADE;--> statement-breakpoint

-- The two checks that only existed to guard the two columns below them.
ALTER TABLE "connection" DROP CONSTRAINT "connection_mock_tools_lanes";--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_mock_tool_coverage_only_when_ended";--> statement-breakpoint

-- The switch, the frozen world, and the coverage stamp.
--
-- The four columns the temporary copy is tracked by — `agent_version`,
-- `temp_mock_agent_version`, `temp_mock_agent_version_cleanup` and
-- `mock_metadata` — are deliberately untouched, with their checks, their
-- partial index and the run-header freeze's carve-out for the cleanup pair. A
-- web-call run still branches a copy of the customer's agent when its tests ask
-- for a mocked world; what changed is who says so.
ALTER TABLE "connection" DROP COLUMN "mock_tools_enabled";--> statement-breakpoint
ALTER TABLE "run" DROP COLUMN "mock_tool_snapshot";--> statement-breakpoint
ALTER TABLE "simulation" DROP COLUMN "mock_tool_coverage";
