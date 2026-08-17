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

- **Add freely.** New tables, new nullable columns, new indexes — code that
  does not know them never sees them.
- **Prelaunch cleanup is the explicit exception.** A one-step removal is allowed
  only when the founder confirms that no older API or rollback contract is
  supported. Record that decision in the migration and accept that the prior
  build cannot run after the change.
- **Remove in two releases, not one.** Stop reading the thing first and ship
  that; drop it in a later release than the one that stopped using it. A
  rename is an add and a remove, in that order, never one statement.
- **Never rewrite an applied file.** The runner refuses a changed file
  rather than skipping it (`packages/db/src/migrate.ts`), so the history
  here is what production actually ran.
- **ClickHouse migrations must resume safely.** There is no transaction around
  a file, so every statement uses `IF EXISTS` or `IF NOT EXISTS` and survives a
  second run after a partial failure.

A change that cannot follow the rule in one step — a type change, a backfill
that must rewrite — ships as expand, migrate, contract across releases, and
the contract step waits until nothing supported still reads the old shape.
