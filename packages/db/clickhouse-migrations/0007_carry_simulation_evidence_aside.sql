-- Simulation evidence, held aside while `spans` and `turns` are rebuilt on the
-- immutable span identity. The rebuild is the next file; this one only copies,
-- and `0009` only drops what it made — three files rather than one because a
-- ClickHouse migration has no transaction, so a lost response on the drop must
-- never be able to strand the rebuild with its source table already gone.
--
-- Only `source = 'simulation'` is carried. Production evidence is deleted by
-- construction: it is not copied here and the table it lives in is dropped in
-- `0008`.
--
-- Re-run safe on both statements. The table guard is `IF NOT EXISTS`, and the
-- copy collapses on the identity below, so a second run of a file that failed
-- halfway ends at the same rows.

CREATE TABLE IF NOT EXISTS spans_carryover
(
    trace_id                 String,
    span_id                  String,
    parent_span_id           String,
    organization_id          LowCardinality(String),
    project_id               LowCardinality(String) DEFAULT 'default',
    source                   LowCardinality(String),
    emitter                  LowCardinality(String),
    environment              LowCardinality(String) DEFAULT 'default',
    started_at               DateTime64(6, 'UTC'),
    duration_ns              UInt64,
    name                     String,
    kind                     LowCardinality(String),
    status                   LowCardinality(String) DEFAULT 'unset',
    text                     String,
    audio_url                String,
    tool_name                LowCardinality(String),
    tool_arguments           String,
    tool_result              String,
    provider_call_id         String,
    agent_platform           LowCardinality(String),
    platform_agent_id        String,
    platform_agent_name      String,
    platform_agent_version   String,
    connection_type          LowCardinality(String),
    run_id                   String,
    agent_id                 String,
    agent_version_id         String,
    test_version_id          String,
    persona_version_id       String,
    payload                  String
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (organization_id, project_id, trace_id, span_id)
;
--> statement-breakpoint

INSERT INTO spans_carryover
(
    trace_id, span_id, parent_span_id, organization_id, project_id, source,
    emitter, environment, started_at, duration_ns, name, kind, status, text,
    audio_url, tool_name, tool_arguments, tool_result, provider_call_id,
    agent_platform, platform_agent_id, platform_agent_name,
    platform_agent_version, connection_type, run_id, agent_id,
    agent_version_id, test_version_id, persona_version_id, payload
)
SELECT
    trace_id, span_id, parent_span_id, organization_id, project_id, source,
    emitter, environment, started_at, duration_ns, name, kind, status, text,
    audio_url, tool_name, tool_arguments, tool_result, provider_call_id,
    agent_platform, platform_agent_id, platform_agent_name,
    platform_agent_version, connection_type, run_id, agent_id,
    agent_version_id, test_version_id, persona_version_id, payload
FROM spans
WHERE source = 'simulation'
