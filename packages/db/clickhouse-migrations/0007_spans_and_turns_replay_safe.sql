-- `spans` and `turns`, rebuilt so that a replay of one span is the same span.
--
-- **This file rewrites `spans`, which `0000_spans.sql:9-12` says nothing in this
-- chain may ever do.** That claim is amended here rather than there: an applied
-- migration is immutable and the runner refuses a file whose bytes changed
-- (`pendingMigrations` in `src/migrate.ts`), so the correction belongs in a new
-- file. What the old claim was protecting is still protected — the filing order
-- and the partition key are settled and effectively irreversible, and this is
-- the one moment before launch when they can be settled *correctly*.
--
-- The old filing order was
-- `(organization_id, project_id, toStartOfMinute(started_at), xxHash32(trace_id), span_id)`.
-- Under a collapsing engine the sorting key *is* the replacement key, and that
-- one is not the span's identity: a 32-bit trace-id hash collides, and a
-- timestamp in the key means the same span filed a microsecond apart is two
-- spans. A ClickHouse sorting key is fixed at creation, so no `ALTER` reaches
-- it and the table has to be built again — the verdict store's own rebuild
-- (`0003_verdicts_speak_the_redesign.sql`) took the same step for the same
-- reason.
--
-- **Prelaunch cleanup, taken with no older API and no rollback contract.** The
-- prior build cannot read or append spans after this migration.
--
-- **One instance applies this release, and that is a requirement rather than a
-- habit.** Every other file in this chain survives several instances booting at
-- once, because each of their statements is idempotent and the ledger collapses
-- a repeated record. This one cannot be made to: it replaces two tables and
-- refills them, so two instances rebuilding together can have one empty what the
-- other has just put back, and no ordering of idempotent statements fixes that —
-- only a lock would, and ClickHouse has none to take. The cutover already
-- requires it: the writers are stopped before shared storage changes.
--
-- **A file is recorded once every statement in it has succeeded, so a crash
-- anywhere re-runs the whole of it.** There is no ledger between the phases
-- below and no transaction around them, so their order carries the resume
-- safety on its own:
--
--   1. the carryover table, made whether or not it is already there;
--   2. the simulation evidence copied into it, read through columns `spans`
--      carries in both the shape this file starts from and the shape it leaves,
--      and collapsing on the span identity;
--   3. the view dropped, the two tables replaced, the view rebuilt;
--   4. the refill;
--   5. the carryover dropped, **last**, so every earlier crash leaves the
--      refill's source table standing.
--
-- That order closes both ends. A re-run that arrives after 3 finds the copy in 2
-- reading the replaced `spans` — holding either nothing yet or exactly what the
-- refill put there — and writing it onto the identities already in the
-- carryover. A re-run that arrives after 5 finds the refilled `spans` and makes
-- the carryover from it again. Either way the file ends with one visible copy of
-- the same evidence.
--
-- What survives: simulation evidence, carried aside and refilled below. What
-- does not: production spans and the turns derived from them, deleted **by
-- construction** — only `source = 'simulation'` is carried across, and the
-- tables holding the rest are replaced whole. No `ALTER TABLE ... DELETE` is
-- needed and none is written.
--
-- **`verdicts` and `grading_job` are not named by this file and are not touched
-- by it.** That is deliberate, not an oversight: grader-owned storage belongs to
-- the grader effort, and production verdicts left pointing at deleted traces are
-- that effort's cleanup to make. `0006_production_platform_identity.sql` deleted
-- from `verdicts` alongside the trace tables; this file does not repeat that.

-- Where the simulation evidence waits while the tables under it are replaced.
--
-- `ReplacingMergeTree` on the span identity and **no partition key**: rows
-- collapse inside a partition and never across one, so a single partition
-- collapses a re-inserted identity unconditionally. That is what makes the copy
-- below safe to run again — one identity written twice is one visible row,
-- whatever the run before it managed to write.
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
ORDER BY (organization_id, project_id, trace_id, span_id)
;
--> statement-breakpoint

-- Only `source = 'simulation'` is carried. Production evidence is not copied,
-- and the table holding it is replaced whole below, which is the whole of its
-- removal.
--
-- **Every column named here belongs to both shapes of `spans`** — the one this
-- file starts from and the one it leaves behind, which adds `content_hash` and
-- takes nothing away. So the statement parses and means the same thing on a
-- re-run that arrives after the replacement: it reads the refilled rows back and
-- writes them onto themselves. Columns are named on both sides rather than
-- `SELECT *` for exactly that reason.
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
;
--> statement-breakpoint

-- The view goes first and comes back further down, because it is defined over
-- the two tables between here and there and both are about to be replaced.
DROP VIEW IF EXISTS turns_mv
;
--> statement-breakpoint

-- **`CREATE OR REPLACE`, not `DROP` then `CREATE`.** There is no lock around a
-- ClickHouse migration and no transaction. A `DROP` followed by a `CREATE`
-- leaves an instant in which `spans` does not exist, and a crash inside that
-- instant has nowhere to go: every statement below names `spans`, and so does
-- the carry-aside above that a re-run starts from. A replace is atomic and
-- leaves no such instant. It does not make the file safe to apply twice at once,
-- which nothing could; it takes away the one failure that has nothing to do with
-- rebuilding.
CREATE OR REPLACE TABLE spans
(
    -- Identity, and now the whole of it. `trace_id` and `span_id` are adopted
    -- from the wire rather than minted here: OpenTelemetry ids are fixed-width
    -- binary, which egma's own id format cannot be encoded in. `parent_span_id`
    -- is shape rather than identity and stays out of the filing order.
    trace_id                 String,
    span_id                  String,
    parent_span_id           String,

    -- Tenancy, resolved server-side from the credential and never from the
    -- payload. Both lead the filing order, because both are how a query prunes
    -- and because a span id means nothing outside the customer that sent it.
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
    -- replayed byte-identically; nothing downstream re-derives it. That is what
    -- keeps a replay inside the partition its first arrival landed in, which a
    -- collapsing engine requires: rows in two partitions never collapse.
    -- Microsecond precision, because OTLP arrives as `start_time_unix_nano` and
    -- ingest divides by 1000. Full-nanosecond latency lives in `duration_ns`.
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

    -- Which product or framework produced this evidence, and the platform's own
    -- reference to the agent when it supplies one.
    agent_platform           LowCardinality(String),
    platform_agent_id        String,
    platform_agent_name      String,
    platform_agent_version   String,

    -- Comparability. 8 kHz mu-law over the phone and 48 kHz over WebRTC produce
    -- different units, so an aggregate that mixes connection types without this
    -- is silently meaningless.
    connection_type          LowCardinality(String),

    -- Version pins. Identifiers only — Postgres holds what a version actually
    -- was, and holds it immutably, which is what makes a pointer enough. Grader
    -- version deliberately does not ride a span: grading happens afterwards and
    -- several graders apply, so it belongs on a verdict row instead.
    run_id                   String,
    agent_id                 String,
    agent_version_id         String,
    test_version_id          String,
    persona_version_id       String,

    -- The provider's own payload, exactly as it arrived. Insurance against the
    -- one class of mistake no later migration can undo: data that was never
    -- captured cannot be recovered.
    payload                  String,

    -- The fingerprint of everything above, computed by the writer over the
    -- canonical evidence and stored rather than derived. It is what a replay is
    -- checked against before a row is written, and it is deliberately **outside
    -- the filing order**: two different contents under one identity must land on
    -- the same key so the check can see the conflict, not beside each other as
    -- two rows nobody compares.
    --
    -- Empty on the simulation rows carried aside above, which were written
    -- before the hash existed. It is also the one column the carryover does not
    -- hold, which is why the copies on both sides of the replacement name their
    -- columns.
    content_hash             String
)
-- **Plain `ReplacingMergeTree()`, with no version column, on purpose.** With a
-- version column the later row wins, and a later row must never win here: the
-- existing evidence for an identity stays authoritative, and evidence that
-- disagrees with it is an integrity defect rather than an update. Conflicts are
-- refused by the batched pre-insert integrity check, before any row is written.
-- The engine is not the conflict authority and is never asked to settle one; it
-- collapses exact replays and nothing else.
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (organization_id, project_id, trace_id, span_id)
-- The index only has to prune, and what a read prunes on is the customer and
-- the conversation; the span id is in the sorting key to collapse rows, which
-- happens after the granule has been found. So the primary key stops where the
-- pruning stops and the index stays small. This is the `verdicts` shape.
PRIMARY KEY (organization_id, project_id, trace_id)
-- The fast shield in front of the engine, unchanged in size and meaning from the
-- table this replaces: a repeat of a byte-identical insert block is dropped
-- while it is still in the recent window. It is a count of blocks rather than a
-- span of time, and it is a shield rather than the guarantee — the guarantee is
-- the identity above, which holds forever. On a ReplicatedMergeTree this setting
-- is a no-op and `replicated_deduplication_window` does the same job.
SETTINGS non_replicated_deduplication_window = 1000
;
--> statement-breakpoint

-- The turn-grain view's table. A transcript and a trace list read this rather
-- than the wide table: they want one row per thing somebody said, with enough
-- text to render a preview and none of the payload.
CREATE OR REPLACE TABLE turns
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
    -- New here, and the rebuild is the one moment it can be added without a
    -- second rewrite: a turn-grain read that has to know which platform produced
    -- a turn should not have to reach back to `spans` for one cheap word. The
    -- other three `platform_agent_*` columns stay off until a read needs them.
    agent_platform   LowCardinality(String),
    run_id           String,
    agent_id         String,
    text_preview     String
)
-- The same engine and the same identity, and it is needed separately: a
-- materialised view runs on the block that arrived, before the base table has
-- decided anything, and it may process one replay more than once. A derived row
-- is a pure function of the span it came from, so the span's identity is the
-- turn's identity too.
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (organization_id, project_id, trace_id, span_id)
PRIMARY KEY (organization_id, project_id, trace_id)
SETTINGS non_replicated_deduplication_window = 1000
;
--> statement-breakpoint

-- Created **before** the refill below, so that the refill repopulates `turns`
-- through it rather than leaving the turn grain empty.
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

-- The simulation evidence, back where it belongs. Re-run safe because both
-- destinations now collapse on the span identity and the copy is a pure function
-- of the source: a second run writes the same rows onto themselves. `FINAL`
-- because the carryover may hold a re-inserted identity twice until it merges,
-- and this reads it once.
INSERT INTO spans
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
FROM spans_carryover FINAL
;
--> statement-breakpoint

-- Last, and that placement is the point: until this statement the refill's
-- source is still standing, so a crash at any statement above re-runs a file
-- that can still put the evidence back. A crash on this one re-runs a file whose
-- carry-aside reads the refilled `spans` and builds the carryover again.
DROP TABLE IF EXISTS spans_carryover
