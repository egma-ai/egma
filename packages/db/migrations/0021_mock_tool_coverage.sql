-- The coverage stamp, off the report's terminal facts and onto the row: which
-- of the agent's tools mock tools answered for, and which reached their real
-- implementations. A simulation whose tools were answered by mock tools and one
-- whose tools ran for real are different units, exactly as two audio bands are,
-- so this sits beside the measured band and is read the same way — off the one
-- simulation, with nothing else to consult and nothing editable to ask.
--
-- Nullable, and the null is a sentence rather than a gap: the agent was never
-- asked what tools it has, so nothing was learned and nothing is claimed. Every
-- row written before this migration says exactly that, truthfully. Three empty
-- lists is the other absence — the asking happened and no tool came back.
ALTER TABLE "simulation" ADD COLUMN "mock_tool_coverage" jsonb;--> statement-breakpoint
-- A terminal fact, like the report and summary columns beside it — an additive
-- guard for an additive column, so neither existing check is rewritten.
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_mock_tool_coverage_only_when_ended" CHECK ("simulation"."ended_at" is not null or "simulation"."mock_tool_coverage" is null);
