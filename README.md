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
pnpm lint
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
packages/db     The data-access module: schema, migrations, and every read
                and write there is.
packages/ids    The identifier generator.
packages/lint   Build-time rules that hold the data-access boundary in place.
```

## Reading and writing data

`packages/db` owns the Postgres connection, and it is the only way anything
reads or writes. Two rules follow from that, and both fail the build rather than
a review:

- **No file outside `packages/db/src` imports a database driver.** If you have
  just written `import pg from "pg"` somewhere and the build is refusing it,
  this is why. Add what you need to `packages/db/src/access` instead.
- **Every exported function that touches a customer's data takes an
  `AuthContext` first**, and builds the organization and project filters from
  it. Nothing exported accepts a filter of its own, so there is no way to widen
  one and no way to leave one out.

Both processes hold a connection — the API and the web application — and both go
through the same functions. The point is not which process talks to Postgres, it
is that nobody hand-writes the tenancy filter.

Every test that touches this uses **two** organizations. A test with one
organization passes whether or not the filter is there.

## Changing the schema

Edit the Drizzle schema under `packages/db/src/schema`, then:

```bash
pnpm db:generate
```

That writes a new numbered `.sql` file into `packages/db/migrations`. Those files
are what actually runs, so read the generated SQL before committing it. An
applied migration is immutable — the migration runner refuses to boot against a
file that changed after it was applied, so corrections go in a new file.
