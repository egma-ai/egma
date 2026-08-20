-- The verdicts table: what a grader said about one judged dimension of one
-- conversation.
--
-- Designed alongside `spans` and deliberately left unbuilt until something wrote
-- to it, on the same rule the rest of the product follows: a schema with no
-- writer is a contract nobody has checked. There is a writer now, so it arrives
-- as one additive migration. Nothing above is touched — `spans` and its view are
-- exactly what the first file left behind, and a migration that would rewrite
-- `spans` is evidence the change is wrong.
--
-- **A row is one judged dimension** — one expected behavior, or the single check
-- a one-check grader makes. There is deliberately no row for a grader's overall
-- answer, none for a conversation's, and none for a run's. Those are folded from
-- these rows at read time by one shared function, so a headline can never
-- disagree with the evidence underneath it: there is no stored rollup for it to
-- disagree with.
--
-- Definitions live in Postgres and instances live here. The row carries version
-- **identifiers** and never version contents, which is enough precisely because
-- what they point at is immutable — the danger was never the pointer, it was
-- pointing at something editable.

CREATE TABLE IF NOT EXISTS verdicts
(
    -- Tenancy, resolved server-side from the credential and never from anything
    -- a caller passed, and leading the filing order for the same reason it does
    -- on `spans`: it is how a query prunes and how a narrow permission grant
    -- will one day filter.
    organization_id   LowCardinality(String),
    project_id        LowCardinality(String) DEFAULT 'default',

    -- What was judged. `trace_id` is the conversation, adopted from the wire on
    -- the same terms as on `spans`. `dimension` is what inside the grader was
    -- judged, named by the grader itself and opaque to the store; the read layer
    -- only ever compares it for equality.
    trace_id          String,
    grader_id         String,
    grader_version_id String,
    dimension         String,

    -- Classification. `source` is the same word `spans.source` carries and keeps
    -- the same type, because comparing a simulation against a production
    -- conversation is the premise of the product and a word that meant two
    -- things on two tables would make that impossible.
    source            LowCardinality(String),

    -- Who judged: a judge model, `engine` for the deterministic graders that
    -- need no model at all, or `human`. It is part of the identity below, which
    -- is what puts a person's disagreement *beside* the machine's judgment
    -- rather than over it.
    judged_by         LowCardinality(String),

    -- The judgment. `verdict` and `priority` are enumerations rather than
    -- strings because both vocabularies are closed and settled, and an enum is
    -- how a store refuses a fifth word instead of quietly filing it. `skipped`
    -- and `errored` are load-bearing and must never be collapsed into `failed`:
    -- a test that could not run is not a test that failed, and a check that did
    -- not apply did not fail either.
    verdict           Enum8('passed' = 1, 'failed' = 2, 'skipped' = 3, 'errored' = 4),

    -- Between nothing and everything, and the constraint says so rather than
    -- leaving every reader to hope. The fold divides with this, so a row outside
    -- the range would not be a wrong number in one place, it would be a wrong
    -- number everywhere the row is ever counted.
    score             Float64,

    -- One line saying why, and the spans it is saying it about — a judgment
    -- nobody can audit against the conversation is an opinion. Neither is ever
    -- truncated: unlike a span, which keeps the provider's whole payload beside
    -- its normalised columns, a verdict has no second copy of itself, so a cap
    -- here would cost data rather than presentation.
    rationale         String,
    cited_span_ids    Array(String),

    -- The priority in effect **at the moment of judging**, snapshotted rather
    -- than read from the grader later, so that promoting a check to P0 today
    -- does not reinterpret yesterday's warnings.
    priority          Enum8('P0' = 0, 'P1' = 1, 'P2' = 2),

    -- Where the conversation came from. `run_id` is empty for a production
    -- trace, which has no run and never will. The agent and its version ride the
    -- row because they are known when the judgment is written and because they
    -- turn "how did v7 do against v8 under this grader" into one scan of this
    -- small table with no reach back into span data.
    run_id            String,
    agent_id          String,
    agent_version_id  String,

    -- When the judgment was made, and the version this engine keeps rows by.
    event_ts          DateTime64(6, 'UTC'),

    CONSTRAINT score_is_a_proportion CHECK score >= 0 AND score <= 1
)
-- The dedup burden of the whole trace store lands here, on the small table, and
-- `spans` — the big one — pays nothing. That is deliberate and it is the exact
-- inversion of the mistake that stranded other people's self-hosters.
--
-- The sorting key **is** the identity, and every part of it earns its place:
--
--   grader version — production grading at a newer current version writes beside
--     the old row, which makes "v3 said pass, v4 says fail" a comparison rather
--     than a loss; simulation re-grades reuse their pinned version;
--   dimension      — one behavior's verdict is not another's;
--   source         — the same grader judges simulations and production traffic,
--     and those are two answers about two different conversations;
--   judged by      — a person disagreeing writes their own row, and the
--     machine's stays underneath as the ground truth a future measurement of
--     judge accuracy is made of.
--
-- What collapses, then, is only a literal rewrite of the identical thing: the
-- same grader at the same version judging the same dimension again, which is
-- what a re-run after a transient error is. The later `event_ts` wins.
ENGINE = ReplacingMergeTree(event_ts)
ORDER BY (organization_id, project_id, trace_id, grader_id, grader_version_id, dimension, source, judged_by)
-- The index only has to prune, and what a read prunes on is the customer and the
-- conversation; the rest of the sorting key is there to collapse rows, which
-- happens after the granule has been found. So the primary key stops where the
-- pruning stops and the index stays small.
PRIMARY KEY (organization_id, project_id, trace_id)
-- **No partition key at all**, and this is the one place this table deliberately
-- departs from `spans`.
--
-- A ReplacingMergeTree collapses rows inside a partition and never across one.
-- Partitioning by a clock — the only clock on this row being when the judging
-- happened — would mean a re-run after a transient error that landed a month
-- later stayed two rows forever, and every read would depend on a setting to
-- paper over it. That is a trap laid under the table's whole purpose. Nothing is
-- lost by declining it: a conversation produces one row per judged dimension
-- against roughly a hundred and thirty spans, so this table does not need the
-- pruning `spans` cannot live without, and the per-organization deletes the
-- retention design calls for are the same statement either way.
;
