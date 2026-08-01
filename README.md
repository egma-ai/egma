# egma

The first open-source platform purpose-built to help teams shipping voice agents
gain trust in the agent they ship to production.

## Running it

You need Docker with Compose. Nothing else.

```bash
docker compose up
```

That starts three services and applies the database schema. Nobody runs a
migration step, because there isn't one — the API applies its migrations while
it boots.

| Service | URL |
| --- | --- |
| Web application | http://localhost:3101 |
| API | http://localhost:3100 |
| Postgres | `postgres://egma:egma@localhost:5433/egma` |

`GET /health` on the API and `GET /api/health` on the web application are what
the container health checks poll.

Ports and Postgres credentials come from the environment; see `.env.example` for
the names and their defaults.

## Working on it

Node 24 and pnpm 10.

```bash
pnpm install
pnpm db:up        # Postgres on 5433, which the tests need
pnpm test
pnpm typecheck
pnpm build
```

Tests run against a real Postgres. Each test file creates a database of its own
and drops it afterwards, so `pnpm test` needs a Postgres it may create databases
on. `pnpm db:up` starts one; point `TEST_DATABASE_URL` somewhere else if you
would rather use your own.

## Layout

```
apps/api        Fastify API. Applies migrations on boot, then serves.
apps/web        Next.js web application.
packages/db     Drizzle schema, the migration files, and the Postgres client.
packages/ids    The identifier generator.
```

## Changing the schema

Edit the Drizzle schema under `packages/db/src/schema`, then:

```bash
pnpm db:generate
```

That writes a new numbered `.sql` file into `packages/db/migrations`. Those files
are what actually runs, so read the generated SQL before committing it. An
applied migration is immutable — the migration runner refuses to boot against a
file that changed after it was applied, so corrections go in a new file.
