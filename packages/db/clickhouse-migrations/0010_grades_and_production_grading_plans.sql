-- One row is one completed grader result for one trace. A retry or regrade is
-- another row. Nothing in this table replaces or collapses an older result.
-- The product is pre-launch, so the assertion-grain verdict store is removed
-- instead of translated into a result shape it never held.

-- Postgres migration 0042 removes every pre-cutover run and simulation because
-- their grading plans point at the retired grader-version model. Remove the
-- matching simulation evidence in the same release. ClickHouse migration 0006
-- already removed the pre-cutover production evidence.
ALTER TABLE spans DELETE WHERE source = 'simulation' SETTINGS mutations_sync = 2
;
--> statement-breakpoint
ALTER TABLE turns DELETE WHERE source = 'simulation' SETTINGS mutations_sync = 2
;
--> statement-breakpoint
DROP TABLE IF EXISTS verdicts
;
--> statement-breakpoint
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
-- A production trace has no run plan. This compact row records which project
-- graders were selected before temporary worker work can be deleted. An empty
-- entries array is a real decision and does not create a fake grade.
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
      grader_pass_threshold Float64
    )),

    CONSTRAINT production_plan_thresholds_are_normalized
      CHECK arrayAll(entry -> entry.4 >= 0 AND entry.4 <= 1, entries)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(trace_started_at)
ORDER BY (organization_id, project_id, trace_id, plan_hash)
PRIMARY KEY (organization_id, project_id, trace_id)
;
