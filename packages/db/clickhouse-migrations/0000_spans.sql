-- The trace store's one wide table, and the turn-grain view over it.
--
-- A row is a span: any timed thing inside one trace — a turn, a tool
-- call, a model call, a speech-to-text step, a text-to-speech step. Trace-level
-- facts are repeated on every row rather than joined from a second table, so a
-- simulation and a production trace are one shape and every query, grader and
-- page is written once.
--
-- The filing order and the partition key are settled and effectively
-- irreversible: changing either rewrites every row ever stored. Nothing in this
-- chain may ever rewrite `spans` — a migration that would is evidence the change
-- is wrong.

CREATE TABLE IF NOT EXISTS spans
(
    -- Identity. `trace_id` and `span_id` are adopted from the wire rather than
    -- minted here: OpenTelemetry ids are fixed-width binary, which egma's own
    -- id format cannot be encoded in, and egma's runtime emits OTLP through the
    -- same door a customer's agent does. So they are the one exception to the
    -- prefixed-id rule, and they carry no format guarantee.
    trace_id                 String,
    span_id                  String,
    parent_span_id           String,

    -- Tenancy, resolved server-side from the credential and never from the
    -- payload. Both lead the filing order, because both are how a query prunes
    -- and how a narrow permission grant will one day filter.
    organization_id          LowCardinality(String),
    project_id               LowCardinality(String) DEFAULT 'default',

    -- Classification. `source` is explicit rather than inferred from an empty
    -- `run_id`: comparing a simulation against a production trace is the
    -- premise of the product, so the two dimensions compose instead of sharing
    -- a slot. `emitter` says which side measured this — egma's outside view and
    -- the agent's inside view are different measurements and must never be
    -- averaged together. Environments are discovered on first ingest rather
    -- than declared, which is what makes a throwaway one free.
    source                   LowCardinality(String),
    emitter                  LowCardinality(String),
    environment              LowCardinality(String) DEFAULT 'default',

    -- Timing. `started_at` is stamped by the writer when the span opened and is
    -- replayed byte-identically on a retry; nothing downstream re-derives it.
    -- Microsecond precision: OTLP arrives as `start_time_unix_nano` and ingest
    -- divides by 1000. The sub-microsecond digits are dropped here on purpose —
    -- full-nanosecond latency lives in `duration_ns`, and the exact precision of
    -- `started_at` decides nothing about where a row lands: the settled sort key
    -- buckets it to the minute.
    started_at               DateTime64(6, 'UTC'),
    duration_ns              UInt64,

    -- Content.
    name                     String,
    kind                     LowCardinality(String),
    status                   LowCardinality(String) DEFAULT 'unset',
    text                     String,
    audio_url                String,
    tool_name                LowCardinality(String),
    tool_arguments           String,
    tool_result              String,

    -- Correlation. There is no way to propagate trace context across an audio
    -- channel, so the provider's own identifier is the only join between the
    -- agent's spans and egma's.
    provider_call_id         String,

    -- Comparability. 8 kHz mu-law over the phone and 48 kHz over WebRTC produce
    -- different units: the codec destroys what audio grading reads and inflates
    -- every latency number. Without these an aggregate that mixes connection
    -- types is silently meaningless. The sample rate is the measured one, never
    -- the declared one.
    connection_type          LowCardinality(String),
    audio_sample_rate_hz     UInt32,
    audio_encoding           LowCardinality(String),

    -- Version pins. Identifiers only — Postgres holds what a version actually
    -- was, and holds it immutably, which is what makes a pointer enough. Grader
    -- version deliberately does not ride a span: grading happens afterwards and
    -- several graders apply, so it belongs on a verdict row instead.
    run_id                   String,
    agent_id                 String,
    agent_version_id         String,
    test_version_id          String,
    digital_human_version_id String,

    -- The provider's own payload, exactly as it arrived. Insurance against the
    -- one class of mistake no later migration can undo: data that was never
    -- captured cannot be recovered.
    payload                  String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (organization_id, project_id, toStartOfMinute(started_at), xxHash32(trace_id), span_id)
-- Nothing is ever deduplicated at read time on this table: no ReplacingMergeTree,
-- no FINAL, no LIMIT 1 BY. The obligation not to send twice sits with the
-- writer. This is the backstop under it — a repeat of a byte-identical insert
-- block is dropped — and it earns its keep on the production path, which egma
-- does not own and where an exporter's retry is byte-identical by design.
-- The window is a count of recent insert blocks, not a span of time, and 1000
-- sits generously above any plausible number of in-flight insert batches for
-- one deployment, so a delayed retry still lands inside it. On a
-- ReplicatedMergeTree this setting is a no-op; a replicated deployment gets the
-- same backstop from `replicated_deduplication_window`, which is on by default
-- with a window of 100 — recorded here so that deployment does not rediscover it.
SETTINGS non_replicated_deduplication_window = 1000;

--> statement-breakpoint

-- The turn-grain view. A transcript and a trace list read this rather than the
-- wide table: they want one row per thing somebody said, with enough text to
-- render a preview and none of the payload. The untruncated text stays on
-- `spans`, which is where the detail page goes for it.
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
    run_id           String,
    agent_id         String,
    text_preview     String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (organization_id, project_id, toStartOfMinute(started_at), xxHash32(trace_id), span_id)
-- The same backstop, and it is needed separately: a materialised view runs on
-- the block that arrived, before the base table has decided whether to keep it,
-- so a retry `spans` drops would otherwise still reach `turns` and show the
-- human saying the same thing twice. The derived block is a function of the
-- arriving one, so a byte-identical repeat produces a byte-identical repeat here.
-- Sized and caveated exactly as on `spans`: a count of blocks, not a time
-- window, and a no-op under a replicated engine.
SETTINGS non_replicated_deduplication_window = 1000;

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
    run_id,
    agent_id,
    substring(text, 1, 1024) AS text_preview
FROM spans
WHERE startsWith(kind, 'turn:');
