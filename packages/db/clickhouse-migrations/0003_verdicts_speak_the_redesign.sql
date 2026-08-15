-- The verdicts table, recreated with the redesign's identity: one row per
-- **assertion**, with no priority and no `judged_by`.
--
-- **Dropped and rebuilt rather than altered, and that is the cheap answer
-- here.** A ClickHouse sorting key is fixed at creation, and this change takes
-- two columns out of it — so no `ALTER` reaches it and a rebuild is the only
-- statement that exists. The product is pre-launch, the table is small, and
-- there is no deployment whose verdicts have to survive: an expand–contract
-- dance to carry rows nobody will ever read would cost more than the rows are
-- worth. Re-grading is what refills it, and it was always able to.
--
-- What changed from the file above, and why each one:
--
--   `dimension` is now `assertion` — one word at every layer including
--     storage. The old word is banned by the domain model, and a column that
--     went on carrying it would be the one place the ban did not reach.
--   `priority` is gone — the P0/P1/P2 ladder is retired. Scoring is binary:
--     every assertion of every applicable grader has to pass, so there is
--     nothing left for a priority to say.
--   `judged_by` is gone, from the columns and from the sorting key — human
--     corrections leave v0 and return as the reserved `human` grader type,
--     which writes its own rows under its own grader id and needs no column to
--     stand beside the machine's.
--
-- Everything else is the file above, verbatim, including the reasoning for the
-- engine, the primary key and the deliberate absence of a partition key.

DROP TABLE IF EXISTS verdicts
;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS verdicts
(
    -- Tenancy, resolved server-side from the credential and never from anything
    -- a caller passed, and leading the filing order for the same reason it does
    -- on `spans`: it is how a query prunes and how a narrow permission grant
    -- will one day filter.
    organization_id   LowCardinality(String),
    project_id        LowCardinality(String) DEFAULT 'default',

    -- What was judged. `trace_id` is the conversation, adopted from the wire on
    -- the same terms as on `spans`. `assertion` is the **key** of the one
    -- 0-or-1 check inside the grader that this row answers — the behavior's
    -- position in the pinned test version, the config entry's index — and never
    -- the content, which is read from the pinned versions at display time. The
    -- store is opaque to it; the read layer only ever compares it for equality.
    trace_id          String,
    grader_id         String,
    grader_version_id String,
    assertion         String,

    -- Classification. `source` is the same word `spans.source` carries and keeps
    -- the same type, because comparing a simulation against a production
    -- conversation is the premise of the product and a word that meant two
    -- things on two tables would make that impossible.
    source            LowCardinality(String),

    -- The judgment. `verdict` is an enumeration rather than a string because the
    -- vocabulary is closed and settled, and an enum is how a store refuses a
    -- fifth word instead of quietly filing it. `skipped` and `errored` are
    -- load-bearing and must never be collapsed into `failed`: a test that could
    -- not run is not a test that failed, and a check that did not apply did not
    -- fail either.
    verdict           Enum8('passed' = 1, 'failed' = 2, 'skipped' = 3, 'errored' = 4),

    -- Between nothing and everything, and the constraint says so rather than
    -- leaving every reader to hope. The fold divides with this, so a row outside
    -- the range would not be a wrong number in one place, it would be a wrong
    -- number everywhere the row is ever counted.
    score             Float64,

    -- One line saying why, and the spans it is saying it about — a judgment
    -- nobody can audit against the conversation is an opinion. On an `errored`
    -- row it is the plain-prose reason judging broke, which is the only place
    -- that sentence is ever written down. Neither is ever truncated: unlike a
    -- span, which keeps the provider's whole payload beside its normalised
    -- columns, a verdict has no second copy of itself, so a cap here would cost
    -- data rather than presentation.
    rationale         String,
    cited_span_ids    Array(String),

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
--   grader version — re-grading at a tightened grader writes rows beside the old
--     ones instead of over them, which is what makes "v3 said pass, v4 says
--     fail" a comparison rather than a loss;
--   assertion      — one assertion's verdict is not another's;
--   source         — the same grader judges simulations and production traffic,
--     and those are two answers about two different conversations.
--
-- It **ends at `source`**: there is no `judged_by` any more, because there is no
-- second voice to keep beside the machine's. A human judgment returns as a
-- grader of its own — the reserved `human` type — and a grader of its own
-- carries its own `grader_id`, which is already in the key.
--
-- What collapses, then, is only a literal rewrite of the identical thing: the
-- same grader at the same version judging the same assertion again, which is
-- what a re-run after a transient error is. The later `event_ts` wins.
ENGINE = ReplacingMergeTree(event_ts)
ORDER BY (organization_id, project_id, trace_id, grader_id, grader_version_id, assertion, source)
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
-- lost by declining it: a conversation produces one row per judged assertion
-- against roughly a hundred and thirty spans, so this table does not need the
-- pruning `spans` cannot live without, and the per-organization deletes the
-- retention design calls for are the same statement either way.
;
