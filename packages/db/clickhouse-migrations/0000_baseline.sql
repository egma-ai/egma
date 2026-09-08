-- CURRENT PRE-PRODUCTION BASELINE.
-- Creates only the current ClickHouse schema. Every statement is guarded
-- because ClickHouse has no transaction around a migration file and a boot
-- must be able to resume after a partial failure.

-- One row is one span. Usage evidence remains distinct on conflicts; exact
-- replays keep one identity. The shorter primary key serves trace reads.
CREATE TABLE IF NOT EXISTS spans
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
    payload                  String,
    content_hash             String,
    usage_identity_hash      String,
    usage_received_at        DateTime64(6, 'UTC'),
    usage_occurred_at        DateTime64(6, 'UTC'),
    usage_provider           LowCardinality(String),
    usage_model              LowCardinality(String),
    usage_operation          LowCardinality(String),
    usage_payment_source     LowCardinality(String),
    usage_measurement        LowCardinality(String),
    usage_provider_ref       String,
    usage_credential_ref     String,
    usage_unit               LowCardinality(String),
    usage_quantities         Map(String, Float64),
    usage_priced_by          Map(String, String),
    usage_amount_micros      UInt64,
    usage_evidence           String
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (organization_id, project_id, trace_id, span_id, usage_identity_hash, usage_received_at)
PRIMARY KEY (organization_id, project_id, trace_id)
SETTINGS non_replicated_deduplication_window = 1000
;
--> statement-breakpoint

-- The transcript read model deduplicates by span identity, so a replay is
-- one visible turn.
CREATE TABLE IF NOT EXISTS turns
(
    organization_id  LowCardinality(String),
    project_id       LowCardinality(String),
    trace_id         String,
    span_id          String,
    parent_span_id   String,
    started_at       DateTime64(6, 'UTC'),
    duration_ns      UInt64,
    kind             LowCardinality(String),
    source           LowCardinality(String),
    emitter          LowCardinality(String),
    environment      LowCardinality(String),
    connection_type  LowCardinality(String),
    provider_call_id String,
    agent_platform   LowCardinality(String),
    run_id           String,
    agent_id         String,
    text_preview     String
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (organization_id, project_id, trace_id, span_id)
PRIMARY KEY (organization_id, project_id, trace_id)
SETTINGS non_replicated_deduplication_window = 1000
;
--> statement-breakpoint

CREATE MATERIALIZED VIEW IF NOT EXISTS turns_mv TO turns AS
SELECT
    organization_id,
    project_id,
    trace_id,
    span_id,
    parent_span_id,
    started_at,
    duration_ns,
    kind,
    source,
    emitter,
    environment,
    connection_type,
    provider_call_id,
    agent_platform,
    run_id,
    agent_id,
    substring(text, 1, 1024) AS text_preview
FROM spans
WHERE startsWith(kind, 'turn:')
;
--> statement-breakpoint

-- One row is one completed grader result. Retries and regrades append rows.
CREATE TABLE IF NOT EXISTS grades
(
    organization_id            LowCardinality(String),
    project_id                 LowCardinality(String),
    source                     Enum8('simulation' = 1, 'production' = 2),
    trace_id                   String,
    trace_started_at           DateTime64(6, 'UTC'),
    run_id                     String,
    project_grader_id          String,
    grader_definition_id       String,
    grader_definition_version  UInt32,
    score                      Nullable(Float64),
    details                    JSON,
    grader_pass_threshold      Float64,
    grading_sequence           UInt32,
    graded_at                  DateTime64(6, 'UTC'),
    parameter_values           String,

    CONSTRAINT grade_score_is_normalized
      CHECK score IS NULL OR (score >= 0 AND score <= 1),
    CONSTRAINT grader_pass_threshold_is_normalized
      CHECK grader_pass_threshold >= 0 AND grader_pass_threshold <= 1,
    CONSTRAINT grading_sequence_is_positive
      CHECK grading_sequence > 0,
    CONSTRAINT grade_source_matches_run
      CHECK (source = 'simulation' AND run_id != '')
         OR (source = 'production' AND run_id = '')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(trace_started_at)
ORDER BY (
    organization_id,
    project_id,
    trace_id,
    project_grader_id,
    grading_sequence,
    graded_at
)
PRIMARY KEY (organization_id, project_id, trace_id)
;
--> statement-breakpoint

-- A production trace has no run plan. This row freezes the selected project
-- graders before temporary grading jobs can be removed.
CREATE TABLE IF NOT EXISTS production_grading_plans
(
    organization_id  LowCardinality(String),
    project_id       LowCardinality(String),
    trace_id         String,
    trace_started_at DateTime64(6, 'UTC'),
    plan_hash        FixedString(32),
    entries          Array(Tuple(
      project_grader_id String,
      grader_definition_id String,
      grader_definition_version UInt32,
      grader_pass_threshold Float64,
      parameter_values String
    )),

    CONSTRAINT production_plan_thresholds_are_normalized
      CHECK arrayAll(entry -> entry.4 >= 0 AND entry.4 <= 1, entries)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(trace_started_at)
ORDER BY (organization_id, project_id, trace_id, plan_hash)
PRIMARY KEY (organization_id, project_id, trace_id)
;
