# The migration rule

One rule keeps every deploy and every rollback safe, and it binds both
stores — the Postgres files here and the ClickHouse files in
`../clickhouse-migrations/`:

**By default, a migration may never break the code that is currently running.**

The platform deploys on every green merge, and the API applies these files
on boot, before the new code serves — so for a moment the *old* code runs
against the *new* schema. A rollback is the same moment held open: it
redeploys old code against a schema that stays, because applied migrations
are immutable and are never undone. Both are survivable only while every
migration is additive from the running code's point of view.

In practice:

- **Test on the hosted compatibility floor.** Local development and CI use the
  oldest Postgres and ClickHouse feature versions the hosted platform still
  runs. Never move a test image ahead of its hosted vendor. The exact hosted
  builds, compatibility lines, and pinned public images live in
  `../src/engine-versions.ts`; an integration test holds Compose and the live
  test stores to that contract.
- **Add freely.** New tables, new nullable columns, new indexes — code that
  does not know them never sees them.
- **Prelaunch cleanup is the explicit exception.** A one-step removal is allowed
  only when the founder confirms that no older API or rollback contract is
  supported. Record that decision in the migration and accept that the prior
  build cannot run after the change.
- **Remove in two releases, not one.** Stop reading the thing first and ship
  that; drop it in a later release than the one that stopped using it. A
  rename is an add and a remove, in that order, never one statement.
- **Freeze shipped history, not local state.** Before merge, a migration may be
  rewritten or squashed even if a local development database applied it;
  repair that local ledger. After merge or use outside local development, add
  a new file instead; the runner refuses a changed recorded file.
- **ClickHouse migrations must resume safely.** There is no transaction around
  a file, so every schema statement uses `IF EXISTS` or `IF NOT EXISTS` and
  survives a second run after a partial failure. An approved data mutation must
  be idempotent and may name only a table guaranteed by an earlier immutable
  migration; ClickHouse has no `IF EXISTS` form for `ALTER TABLE ... DELETE`.
- **Pack compatible ClickHouse changes to one table into one `ALTER`.** If they
  must be separate, keep them ordered and let the runner retry only
  `517 CANNOT_ASSIGN_ALTER` while table metadata catches up.

A change that cannot follow the rule in one step — a type change, a backfill
that must rewrite — ships as expand, migrate, contract across releases, and
the contract step waits until nothing supported still reads the old shape.
