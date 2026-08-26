# The migration rule

## Current baseline

PostgreSQL and ClickHouse each start from one `0000_baseline.sql` file. New
migrations start at `0001`.

Every migration ledger starts at this exact baseline. A build refuses unknown
rows without that marker. With it, an older build may ignore rows appended by a
newer build so a normal additive rollback can still boot.

One rule keeps every deploy and every rollback safe, and it binds both
stores — the Postgres files here and the ClickHouse files in
`../clickhouse-migrations/`:

**By default, a migration may never break the code that is currently running.**

That default is suspended before launch, which is where Egma is today. Read
**Before launch** at the end of this file before applying the rest.

The platform deploys on every green merge, and the API applies these files
on boot, before the new code serves — so for a moment the *old* code runs
against the *new* schema. A rollback is the same moment held open: it
redeploys old code against a schema that stays, because applied migrations
are immutable and are never undone. Both are survivable only while every
migration is additive from the running code's point of view.

In practice:

- **Test on the hosted compatibility floor.** Local development and CI use the
  oldest Postgres and ClickHouse feature versions the hosted platform still
  runs. Never move a test image ahead of its hosted vendor. The exact public
  images are pinned in the root `docker-compose.yml`; the real database-backed
  product tests run on those images.
- **Add freely.** New tables, new nullable columns, new indexes — code that
  does not know them never sees them.
- **Remove in two releases, not one.** Stop reading the thing first and ship
  that; drop it in a later release than the one that stopped using it. A
  rename is an add and a remove, in that order, never one statement.
- **Freeze shipped history, not local state.** Before merge, a migration may be
  rewritten or squashed even if a local development database applied it;
  repair that local ledger. After merge or use outside local development, add
  a new file instead; the runner refuses a changed recorded file.
- **ClickHouse migrations must resume safely.** There is no transaction around
  a file, so every schema statement uses `IF EXISTS`, `IF NOT EXISTS` or
  `CREATE OR REPLACE`, and survives a second run after a partial failure. An
  approved data mutation must be idempotent and may name only a table
  guaranteed by an earlier immutable migration, or one an idempotent `CREATE`
  earlier in the same file guarantees. Pre-merge verification re-runs that
  file safely from every point inside it, because the ledger records a file and
  never a statement; ClickHouse has no `IF EXISTS` form for `ALTER TABLE ...
  DELETE`.
- **A rebuild is applied by one instance.** There is no advisory lock on this
  side either, so several instances normally boot together and arrive at the
  same schema because every statement is idempotent. A file that replaces a
  table and refills it cannot reach that: two instances doing it together can
  have one empty what the other has just put back. Such a file says so in its
  header and ships in a release applied by a single instance.
- **Pack compatible ClickHouse changes to one table into one `ALTER`.** If they
  must be separate, keep them ordered and let the runner retry only
  `517 CANNOT_ASSIGN_ALTER` while table metadata catches up.

A change that cannot follow the rule in one step — a type change, a backfill
that must rewrite — ships as expand, migrate, contract across releases, and
the contract step waits until nothing supported still reads the old shape.

## Before launch

Egma has not launched. There is no deployed build to keep working and no
rollback to keep bootable, so until it launches:

- **A migration may be destructive.** Dropping a column, a table, a trigger, a
  function or a constraint in one step is allowed.
- **A migration may break the commit before it.** The code that reads the new
  shape ships in the same change, so the two are never apart.
- **Prefer the clean cut.** Nothing is deprecated in place, no column is kept
  "just in case", and no contract accepts two shapes at once. Expand, migrate,
  contract is what a launched product needs and is more machinery than this one
  is paying for.

What does **not** change: existing data is still carried across by an explicit
backfill wherever a backfill can carry it. A development database somebody has
to rebuild by hand is a real cost before launch as well as after it, and a
migration that drops data it could have kept is a migration to send back.

A destructive migration says so in its own header and points at this section.
When Egma launches, this section goes and the rule above stands on its own.
