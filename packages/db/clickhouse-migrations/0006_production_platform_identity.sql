-- Production traces identify the agent platform independently from any saved
-- simulation connection. Provider agent identity is optional and stays empty
-- when the platform does not supply it.
ALTER TABLE spans
    ADD COLUMN IF NOT EXISTS agent_platform LowCardinality(String) AFTER provider_call_id,
    ADD COLUMN IF NOT EXISTS platform_agent_id String AFTER agent_platform,
    ADD COLUMN IF NOT EXISTS platform_agent_name String AFTER platform_agent_id,
    ADD COLUMN IF NOT EXISTS platform_agent_version String AFTER platform_agent_name
;
--> statement-breakpoint

-- Pre-launch direct cutover: old production trace rows are not compatible
-- with the new identity contract. Wait for each idempotent source-filtered
-- mutation to finish before this migration can be recorded.
ALTER TABLE spans DELETE WHERE source = 'production' SETTINGS mutations_sync = 2
;
--> statement-breakpoint
ALTER TABLE turns DELETE WHERE source = 'production' SETTINGS mutations_sync = 2
;
--> statement-breakpoint
ALTER TABLE verdicts DELETE WHERE source = 'production' SETTINGS mutations_sync = 2
;
