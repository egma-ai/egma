# Database migrations

PostgreSQL and ClickHouse each have one `0000_baseline.sql` that creates the
complete current schema in an empty database. They use different SQL dialects,
so each store has its own file. PostgreSQL's Drizzle snapshot and journal describe
that same baseline. New migrations start at `0001`.

Egma is pre-launch. The baseline defines the final schema directly, without
historical backfills, temporary columns or old-schema conversion paths. Rebuild
disposable development databases when their baseline changes. The application
does not convert or erase an existing database.

## Startup and history

The API applies Postgres migrations before it serves requests. An advisory lock
allows one instance to apply a migration; each file and its ledger entry commit
in one transaction. A failed file can be retried after the failure is corrected.

Both stores refuse changed checksums and any recorded migration missing from the
build. Run a build that contains the database's complete migration history. An
older image does not restore an older schema.

After launch, preserve shipped migration files and append changes. Keep schema
changes compatible with code still running during deployment. Destructive
changes then require a coordinated release plan.

## ClickHouse

ClickHouse has no transaction around a migration file. Every schema statement
must support replay after partial or concurrent startup: use `IF EXISTS`,
`IF NOT EXISTS` or `CREATE OR REPLACE`. Separate statements with
`--> statement-breakpoint`; record the file only after all statements finish.
Tests must prove replay from every interruption point preserves existing rows.

Pack compatible changes to one table into one `ALTER`. If statements must be
separate, keep them ordered; the runner retries only the specific replica
metadata conflict and cloud wake timeout it recognizes.

## Verification

Run fresh-database schema and product-contract tests, repeated and concurrent
startup checks, checksum refusal checks and transaction/replay checks. Use the
Postgres and ClickHouse versions pinned in the root `docker-compose.yml`, which
are the hosted compatibility floor. Keep named constraints, functions, triggers,
indexes and Drizzle metadata consistent with the application schema.
